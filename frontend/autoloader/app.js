/* PiouAutoLoader — autoloader UI controller
 *
 * Responsibilities:
 *   - pick the right WebKit exploit chain for the console's firmware;
 *   - arm it inside a hidden same-origin iframe;
 *   - mirror the chain's own log into a staged, animated progress view;
 *   - report success/failure and offer a retry when a run stalls.
 *
 * Compatibility: written for the PS5 WebKit browser — ES5 only (var/function,
 * no arrow functions, no template literals) and defensive try/catch around
 * every cross-document access, because AppCache/iframe timing is the main
 * source of flakiness on that browser.
 */
(function () {
  'use strict';

  /* ── element handles ──────────────────────────────────────────────────── */
  var doc = document;
  var logContainer = doc.getElementById('log');
  var logView = logContainer ? logContainer.parentNode : null;
  var barFill = doc.getElementById('barFill');
  var barLabel = doc.getElementById('barLabel');
  var stepsEl = doc.getElementById('steps');
  var fwPill = doc.getElementById('fwPill');
  var statePill = doc.getElementById('statePill');
  var subtitle = doc.getElementById('subtitle');
  var timerEl = doc.getElementById('timer');
  var retryWrap = doc.getElementById('retryWrap');
  var retryBtn = doc.getElementById('retryBtn');
  var exploitEl = doc.getElementById('exploit');

  var MAX_LOG_LINES = 200;
  var STALL_MS = 120000; /* no new log line for 2 minutes -> flag a stall */

  var finished = false;
  var chainStarted = false;
  var stalled = false;
  var lastFrameUrl = '';
  var mirrorTimer = 0;
  var tickTimer = 0;
  var startedAt = Date.now();
  var lastActivity = startedAt;

  /* ── staged progress model ────────────────────────────────────────────── */
  /* Five checkpoints, mirrored by the dots in index.html. Progress is
     monotonic: a chain never makes the bar jump backwards. */
  var STAGE_PCT = [4, 18, 45, 78, 94];
  var currentStage = -1;

  function setStepClasses() {
    if (!stepsEl) return;
    var items = stepsEl.getElementsByTagName('li');
    for (var i = 0; i < items.length; i++) {
      var cls = items[i].className;
      if (i < currentStage) cls = 'done';
      else if (i === currentStage) cls = 'active';
      else cls = '';
      if (items[i].className !== cls) items[i].className = cls;
    }
  }

  function setProgress(percent, message) {
    if (typeof percent === 'number') {
      if (percent < 0) percent = 0;
      if (percent > 100) percent = 100;
      if (barFill) barFill.style.width = percent + '%';
      var bar = doc.getElementById('bar');
      if (bar && bar.setAttribute) bar.setAttribute('aria-valuenow', String(percent));
    }
    if (message && barLabel) {
      barLabel.textContent = message;
    }
  }

  /* Move the run forward to checkpoint n (0..4). Never regresses. Returns
     true when the stage actually advanced. */
  function setStage(n) {
    if (n <= currentStage) return false;
    if (n > STAGE_PCT.length - 1) n = STAGE_PCT.length - 1;
    currentStage = n;
    setStepClasses();
    setProgress(STAGE_PCT[n]);
    touch();
    return true;
  }

  function setState(text) {
    if (statePill) statePill.textContent = text;
  }

  function touch() {
    lastActivity = Date.now();
  }

  function markDone() {
    bodyClass('is-done');
    setState('Ready');
    currentStage = STAGE_PCT.length;
    setStepClasses();
    setProgress(100, 'Autoload finished.');
    if (timerEl) timerEl.textContent = elapsedLabel();
  }

  function markError(message) {
    bodyClass('is-error');
    setState('Failed');
    if (barLabel && message) barLabel.textContent = message;
    showRetry();
  }

  function bodyClass(name) {
    var body = doc.body;
    if (!body || !body.className) { if (body) body.className = name; return; }
    if (body.className.indexOf(name) === -1) {
      body.className = body.className + ' ' + name;
    }
  }

  function clearBodyClass(name) {
    var body = doc.body;
    if (!body || !body.className) return;
    body.className = body.className
      .replace(new RegExp('(^|\\s)' + name + '(\\s|$)', 'g'), ' ')
      .replace(/^\s+|\s+$/g, '');
  }

  function showRetry() {
    if (retryWrap) retryWrap.hidden = false;
  }

  function elapsedLabel() {
    var s = Math.floor((Date.now() - startedAt) / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ── logging ──────────────────────────────────────────────────────────── */
  function scrollLogToBottom() {
    if (logView) logView.scrollTop = logView.scrollHeight;
  }

  function uiLog(message, type, deferScroll) {
    if (!logContainer) return null;
    type = type || 'info';
    var entry = doc.createElement('div');
    entry.className = 'line ' + type;
    entry.textContent = message;
    logContainer.appendChild(entry);
    while (logContainer.childElementCount > MAX_LOG_LINES) {
      logContainer.removeChild(logContainer.firstChild);
    }
    if (!deferScroll) scrollLogToBottom();
    return entry;
  }

  /* Kept for backwards compatibility with any patched exploit that calls the
     parent helpers directly. */
  window.uiLog = uiLog;
  window.updateProgress = setProgress;

  /* ── build-time exploit override ──────────────────────────────────────── */
  /* "auto" (firmware table), "umtx2" (FW 1.00-5.50), "poops" (FW 7.00-12.00)
     or "relapse" (FW 7.00-13.60). Replaced by tools/gen_file_registry.py /
     build_host.py / dev_server.py from the FORCE_EXPLOIT env (default
     "auto"); left as the raw placeholder when served straight from source.
     A ?force= query on this page overrides it at runtime. */
  var EXPLOIT_MODE = '[[EXPLOIT_MODE]]';
  if (EXPLOIT_MODE.indexOf('[[') === 0) EXPLOIT_MODE = 'auto';

  /* Firmware support table:
     - <= 5.50: umtx2 (offline)
     - 7.00 - 12.00: poops (offline)
     - 7.00 - 13.60 (except 9.05, 11.40): relapse (needs network) */
  function isUmtx2Supported(num) {
    var n = typeof num === 'number' ? num : parseFloat(num);
    return n > 0 && n <= 5.50;
  }

  function isPoopsSupported(num) {
    var n = typeof num === 'number' ? num : parseFloat(num);
    return n >= 7.00 && n <= 12.00;
  }

  function isRelapseSupported(num, str) {
    var n = typeof num === 'number' ? num : parseFloat(num);
    var s = str || (typeof num === 'string' ? num : '');
    var isExcluded = (s === '9.05' || s === '11.40' ||
                      Math.abs(n - 9.05) < 0.001 || Math.abs(n - 11.40) < 0.001);
    return n >= 7.00 && n <= 13.60 && !isExcluded;
  }

  /* Keep in sync with gen_file_registry.py iframe URLs — the AppCache
     manifest lists these exact URLs so the console can serve them offline
     (AppCache matches URLs including the query string). */
  var UMTX2_URL =
    'umtx2/index.html?autoload=payload.elf&v=1';
  var POOPS_URL =
    'slopkit/slopkit/poops.html?go=1&auto=1&production=1&trigger=netcontrol&attempts=8&only=ps0_preflight,ps1_prepare,ps3_stage0,ps4_validate,ps5_stage1,ps6_stage2,ps8_stage3,ps9_stage4,ps10_stage5&log=debug&payload=1&autoload=payload.elf&v=final';
  var RELAPSE_URL =
    'relapse/index.html?autoload=payload.elf';

  var EXPLOIT_LABEL = {
    umtx2: 'umtx2 (offline)',
    poops: 'poops (offline)',
    relapse: 'relapse (network)'
  };

  /* The slopkit chain (poops 7.00-12.00) keeps a one-shot latch and its
     "stopped at ..." marker in sessionStorage under shared "slopkit-poops:*"
     keys. On the PS5 browser the shortcut session can outlive a console
     reboot, so a previous interrupted run would otherwise block every retry.
     Clear them right before arming so the full chain restarts from the top. */
  function clearSlopkitState() {
    try {
      sessionStorage.removeItem('slopkit-poops:next');
      sessionStorage.removeItem('slopkit-poops:latch');
    } catch (e) { }
  }

  var exploitMode = null;

  /* ── firmware / chain selection ───────────────────────────────────────── */
  function detectFirmware() {
    var m = /PlayStation 5\/(\d+\.\d+)/.exec(navigator.userAgent);
    if (!m) return null;
    return { str: m[1], num: parseFloat(m[1]) };
  }

  /* Choose which exploit to arm. Forced modes (build-time EXPLOIT_MODE or a
     ?force= query) bypass the firmware table so a specific chain can be
     exercised on any firmware — the exploit page's own firmware guard still
     applies. Returns 'umtx2' | 'poops' | 'relapse' | null. */
  function pickExploit() {
    var fw = detectFirmware();
    if (fwPill) fwPill.textContent = 'FW ' + (fw ? fw.str : 'unknown');

    var forced = null;
    try {
      var q = new URLSearchParams(window.location.search).get('force');
      if (q === 'umtx2' || q === 'poops' || q === 'relapse') forced = q;
    } catch (e) { }
    if (forced) {
      uiLog('[force] using ' + forced + ' on firmware ' + (fw ? fw.str : 'unknown'), 'warning');
      return forced;
    }
    if (EXPLOIT_MODE === 'umtx2' || EXPLOIT_MODE === 'poops' || EXPLOIT_MODE === 'relapse') {
      uiLog('[force] using ' + EXPLOIT_MODE + ' on firmware ' + (fw ? fw.str : 'unknown'), 'warning');
      return EXPLOIT_MODE;
    }
    if (!fw) {
      uiLog('[ERROR] Not a PlayStation 5 browser.', 'error');
      return null;
    }
    if (isUmtx2Supported(fw.num)) return 'umtx2';

    var hasPoops = isPoopsSupported(fw.num);
    var hasRelapse = isRelapseSupported(fw.num, fw.str);

    if (hasPoops && hasRelapse) {
      var stored = null;
      try {
        stored = localStorage.getItem('piou_exploit');
      } catch (e) { }
      if (!stored) {
        try {
          var xhr = new XMLHttpRequest();
          xhr.open('GET', 'selected_exploit', false);
          xhr.send();
          if (xhr.status === 200 && xhr.responseText) {
            stored = xhr.responseText.trim();
          }
        } catch (e) { }
      }
      if (stored === 'relapse') return 'relapse';
      if (stored === 'poops') return 'poops';
      return 'relapse'; /* default to relapse on dual firmwares */
    }

    if (hasRelapse) return 'relapse';
    if (hasPoops) return 'poops';

    uiLog('[ERROR] Unsupported firmware ' + fw.str +
      ' (supported: 1.00-5.50 via umtx2, 7.00-12.00 via poops, 7.00-13.60 via relapse).', 'error');
    return null;
  }

  /* ── autoload result ──────────────────────────────────────────────────── */
  function onAutoloadResult(data) {
    if (finished) return;
    if (exploitMode === 'poops') {
      mirrorSlopkit();
    } else {
      mirrorConsole(exploitMode);
    }
    finished = true;

    /* Success is terminal — stop mirroring so the page stays idle while the
       payload runs alongside it. On failure keep streaming the iframe's
       output into the log for diagnostics. */
    if (data.ok && mirrorTimer) {
      clearInterval(mirrorTimer);
      mirrorTimer = 0;
    }
    if (data.ok) {
      uiLog('Payload loaded (' + data.bytes + ' bytes sent to elfldr).', 'success');
      markDone();
      setTimeout(function () {
        uiLog('Payload running on the console. You can close this page.', 'success');
      }, 1200);

      /* Payload is running as its own process now — unload the iframe to
         free the memory it held and avoid a browser OOM dialog.
         NOTE: only safe for umtx2. relapse's document has to stay open: its
         ROP worker is still parked on a hijacked return slot, and tearing
         the document down would unwind that thread. */
      if (exploitMode === 'umtx2') {
        try { exploitEl.src = 'about:blank'; } catch (e) { }
      }
    } else {
      uiLog('[ERROR] Autoload failed: ' + (data.why || 'unknown error'), 'error');
      markError('Autoload failed: ' + (data.why || 'unknown error'));
    }
  }

  /* ── log mirroring helpers ────────────────────────────────────────────── */
  var mirrorWarned = '';

  function consoleSeverity(text, cls) {
    if (/LOG-ERROR/.test(cls) || /^\[-\]/.test(text)) return 'error';
    if (/LOG-WARN/.test(cls)) return 'warning';
    if (/LOG-SUCCESS/.test(cls) || /^\[\+\]/.test(text)) return 'success';
    return 'info';
  }

  var lastLabel = '';
  function setProgressLabel(text) {
    var label = text.replace(/^\[[*+\-]\]\s*/, '').replace(/\s+/g, ' ');
    if (label.length > 76) label = label.slice(0, 73) + '...';
    if (label && label !== lastLabel) {
      lastLabel = label;
      if (barLabel) barLabel.textContent = label;
    }
  }

  /* Map a chain log line to a checkpoint. The patterns cover relapse's stage
     wording and generic umtx2 lines; unknown lines simply leave the bar. */
  function advanceStageFromText(text) {
    var t = text.toLowerCase();
    if (/starting webkit exploit|webkit exploit/.test(t)) setStage(1);
    else if (/arw ready|worker chain: ready|kernel: starting/.test(t)) setStage(2);
    else if (/read and write ready|privileges ready|payloads loaded|elfldr is listening|elfldr is up/.test(t)) setStage(3);
    else if (/sending|autoload|payload sent|elfldr is up, sending/.test(t)) setStage(4);
    else if (/kernel/.test(t)) setStage(2);
    else if (/elfldr|payload/.test(t)) setStage(3);
  }

  function advancePoopsProgress(text) {
    if (/STAGE0|STAGE 0|PREFLIGHT|OFFSETS-READY|WEBKIT-BASE|MODULE-BASES/i.test(text)) setStage(1);
    if (/STAGE1|STAGE 1|ALLPROC-CHECK|ALIASES-REPAIRED/i.test(text)) setStage(2);
    if (/STAGE2|STAGE 2|STAGE3|STAGE 3|SOCKETS|SPAWN/i.test(text)) setStage(3);
    if (/STAGE4|STAGE 4|STAGE5|STAGE 5|WAKEGATE|POOPS-COMPLETE|POOPS-VERDICT/i.test(text)) setStage(4);
  }

  /* Mirror a chain's live #console log (#console > div) from the same-origin
     exploit iframe into our own log view.

     Both chains append to #console, so one mirror covers them. umtx2 marks
     severity with a class (LOG-ERROR / LOG-WARN / LOG-SUCCESS) and relapse
     with a text prefix ([+] info/success, [-] error, [*] log). Both also
     rewrite their last line in place for progress messages, so we update our
     matching last line in place too. */
  var consoleMirror = { lines: 0, lastEntry: null, lastText: '' };

  function mirrorConsole(prefix) {
    var frameDoc;
    try {
      frameDoc = exploitEl.contentDocument;
    } catch (e) {
      return;
    }
    if (!frameDoc) return;

    /* Detect iframe navigation/reload: reset the mirror so a fresh document
       streams its log from the top. */
    var frameUrl = '';
    try {
      frameUrl = exploitEl.contentWindow.location.href;
    } catch (e) { }
    if (frameUrl !== lastFrameUrl) {
      lastFrameUrl = frameUrl;
      consoleMirror = { lines: 0, lastEntry: null, lastText: '' };
    }
    /* The iframe is intentionally empty until the chain is armed. */
    if (!chainStarted) return;

    var lines;
    try {
      lines = frameDoc.querySelectorAll('#console > div');
    } catch (e) {
      return;
    }
    if (lines.length === 0) {
      /* #console is created by the exploit page's own script, so it is absent
         while the document parses, and on any page that is not the exploit
         (a 404, an AppCache fallback, or a crash). Warn once per document
         once it has finished loading. Never re-arm from here: both chains
         start the moment they load, so a second load would race the first. */
      if (frameDoc.readyState === 'complete' && mirrorWarned !== frameUrl) {
        mirrorWarned = frameUrl;
        uiLog('[iframe] no exploit log at "' + (frameUrl || 'about:blank')
          + '" — the chain may not have started. Use Retry if nothing happens.',
          'warning');
      }
      return;
    }

    /* If the log shrank (the exploit caps it, or a fresh document replaced
       it), re-anchor the counter WITHOUT re-logging. */
    if (lines.length < consoleMirror.lines) {
      consoleMirror.lines = lines.length;
    }
    var mirroredAny = false;
    for (; consoleMirror.lines < lines.length; consoleMirror.lines++) {
      var el = lines[consoleMirror.lines];
      var text = (el.textContent || '').trim();
      if (!text) continue;
      var severity = consoleSeverity(text, el.className || '');
      consoleMirror.lastEntry = uiLog('[' + prefix + '] ' + text, severity, true);
      consoleMirror.lastText = text;
      mirroredAny = true;
      touch();
      advanceStageFromText(text);
      if (severity === 'info' || severity === 'success') setProgressLabel(text);
    }
    if (mirroredAny) scrollLogToBottom();

    /* Live-update the last mirrored line when the chain rewrites it in place. */
    if (lines.length > 0 && consoleMirror.lastEntry
      && consoleMirror.lastEntry === logContainer.lastChild) {
      var last = lines[lines.length - 1];
      var lastText = (last.textContent || '').trim();
      if (lastText && lastText !== consoleMirror.lastText) {
        consoleMirror.lastEntry.textContent = '[' + prefix + '] ' + lastText;
        consoleMirror.lastText = lastText;
        touch();
        advanceStageFromText(lastText);
        if (consoleSeverity(lastText, last.className || '') !== 'error') {
          setProgressLabel(lastText);
        }
        scrollLogToBottom();
      }
    }
  }

  /* ── slopkit (poops) mirror ───────────────────────────────────────────── */
  var slopkitMirroredLines = 0;
  var slopkitLastStageText = '';
  var slopkitLastStageCls = '';
  var slopkitLastSummaryText = '';
  var slopkitRepairCount = 0;
  var slopkitEarlyLinesLogged = 0;

  function mirrorSlopkit() {
    var frameDoc;
    try {
      frameDoc = exploitEl.contentDocument;
    } catch (e) {
      return;
    }
    if (!frameDoc) return;

    var frameUrl = '';
    try {
      frameUrl = exploitEl.contentWindow.location.href;
    } catch (e) { }
    if (frameUrl !== lastFrameUrl) {
      lastFrameUrl = frameUrl;
      slopkitMirroredLines = 0;
      slopkitLastStageText = '';
      slopkitLastStageCls = '';
      slopkitLastSummaryText = '';
      slopkitEarlyLinesLogged = 0;
    }
    if (!chainStarted) return;

    var scr;
    try {
      scr = frameDoc.getElementById('scr');
    } catch (e) {
      return;
    }
    if (!scr) {
      var isArmedUrl = frameUrl.length > POOPS_URL.length &&
        frameUrl.slice(-POOPS_URL.length) === POOPS_URL;
      if (frameUrl === 'about:blank' || frameDoc.readyState !== 'complete' || isArmedUrl) {
        return;
      }
      var arm = frameDoc.getElementById('arm');
      var start = frameDoc.getElementById('start');
      var isSlopkitPage = !!start || (arm && !arm.hidden);
      if (chainStarted && isSlopkitPage && slopkitRepairCount < 5) {
        slopkitRepairCount++;
        uiLog('[iframe] re-arming (attempt ' + slopkitRepairCount + '): ' + POOPS_URL, 'info');
        try {
          exploitEl.src = POOPS_URL;
        } catch (e) {
          uiLog('[iframe] re-arm failed: ' + (e && e.message ? e.message : e), 'error');
        }
      }
      return;
    }

    var lines = scr.textContent.split('\n');
    if (lines.length < slopkitMirroredLines) {
      slopkitMirroredLines = lines.length;
    }
    var mirroredAny = false;
    for (; slopkitMirroredLines < lines.length; slopkitMirroredLines++) {
      var line = lines[slopkitMirroredLines].trim();
      if (!line) continue;
      if (/^>/.test(line) || /^\[\+\]/.test(line)
        || /^(STAGE[0-5]|ALLPROC-CHECK|ALIASES-REPAIRED|POOPS-COMPLETE|POOPS-VERDICT|LATCH-HELD|LATCH-READ|OFFSETS-READY|WEBKIT-BASE|MODULE-BASES|SOCKETS|SPAWN|WAKEGATE)/.test(line)) {
        uiLog('[poops] ' + line, 'info', true);
        advancePoopsProgress(line);
        mirroredAny = true;
        touch();
      } else if (/FAIL|ERROR|REFUSED|REBOOT|failed|panic|exception/i.test(line) || /^\[-\]/.test(line)) {
        uiLog('[poops] ' + line, 'error', true);
        mirroredAny = true;
        touch();
      }
    }

    var stage = frameDoc.getElementById('stage');
    if (stage && stage.textContent !== slopkitLastStageText) {
      slopkitLastStageText = stage.textContent;
      slopkitLastStageCls = stage.className || '';
      setProgressLabel(slopkitLastStageText);
      advancePoopsProgress(slopkitLastStageText);
      if (slopkitLastStageCls.indexOf('bad') !== -1) {
        uiLog('[stage] ' + slopkitLastStageText, 'error', true);
      } else if (slopkitLastStageCls.indexOf('ok') !== -1) {
        uiLog('[stage] ' + slopkitLastStageText, 'success', true);
      } else {
        uiLog('[stage] ' + slopkitLastStageText, 'info', true);
      }
      mirroredAny = true;
      touch();
    }

    var summary = frameDoc.getElementById('summary');
    if (summary && summary.textContent && summary.textContent !== slopkitLastSummaryText) {
      var summaryLines = summary.textContent.split('\n');
      for (var i = 0; i < summaryLines.length; i++) {
        var sline = summaryLines[i].trim();
        if (sline && /FAIL|ERROR|REFUSED|REBOOT|failed|panic/i.test(sline)) {
          uiLog('[summary] ' + sline, 'error', true);
          mirroredAny = true;
        }
      }
      slopkitLastSummaryText = summary.textContent;
    }

    var early = frameDoc.getElementById('early');
    if (early && early.textContent) {
      var earlyLines = early.textContent.split('\n');
      if (earlyLines.length < slopkitEarlyLinesLogged) {
        slopkitEarlyLinesLogged = 0;
      }
      for (; slopkitEarlyLinesLogged < earlyLines.length; slopkitEarlyLinesLogged++) {
        var eline = earlyLines[slopkitEarlyLinesLogged].trim();
        if (eline) {
          uiLog('[early] ' + eline, /ERROR|FAIL/i.test(eline) ? 'error' : 'info', true);
          mirroredAny = true;
          touch();
        }
      }
    }

    if (mirroredAny) scrollLogToBottom();
  }

  /* ── watchdog / timer ─────────────────────────────────────────────────── */
  function tick() {
    if (timerEl) timerEl.textContent = elapsedLabel();
    if (!chainStarted || finished || stalled) return;
    if (Date.now() - lastActivity < STALL_MS) return;
    stalled = true;
    setState('Stalled');
    uiLog('[watchdog] No progress for ' + Math.round(STALL_MS / 1000) +
      's. The chain may be stuck — use Retry to start a clean run.', 'warning');
    showRetry();
  }

  /* ── retry ────────────────────────────────────────────────────────────── */
  function doRetry() {
    if (mirrorTimer) { clearInterval(mirrorTimer); mirrorTimer = 0; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = 0; }
    /* A clean run means a clean slopkit latch, or the chain no-ops. */
    clearSlopkitState();
    try { window.location.reload(); } catch (e) { }
  }

  /* ── boot ─────────────────────────────────────────────────────────────── */
  function attachMessageListener() {
    window.addEventListener('message', function (event) {
      var data = event.data;
      if (!data || data.type !== 'piou') return;
      if (exploitEl && event.source !== exploitEl.contentWindow) return;
      if (data.kind === 'log' && exploitMode === 'relapse') {
        mirrorConsole(exploitMode);
        return;
      }
      if (data.kind === 'autoload') {
        onAutoloadResult(data);
      }
    });
  }

  function start() {
    if (retryBtn) retryBtn.onclick = doRetry;

    uiLog('PiouAutoLoader ' + (doc.title.split('v')[1] || ''), 'accent');
    uiLog('Detecting firmware…', 'dim');
    setProgress(0, 'Waiting to start…');
    setState('Booting');

    attachMessageListener();

    var picked = pickExploit();
    if (!picked) {
      setState('Unsupported');
      markError('Unsupported firmware.');
      return;
    }

    exploitMode = picked;
    if (subtitle) subtitle.textContent = EXPLOIT_LABEL[picked] + ' chain';
    uiLog('Selected chain: ' + EXPLOIT_LABEL[picked], 'accent');

    var exploitUrl = picked === 'umtx2' ? UMTX2_URL
      : picked === 'poops' ? POOPS_URL
      : RELAPSE_URL;

    if (picked === 'poops') {
      mirrorTimer = setInterval(mirrorSlopkit, 500);
      clearSlopkitState();
    } else {
      mirrorTimer = setInterval(function () { mirrorConsole(exploitMode); }, 500);
    }
    tickTimer = setInterval(tick, 1000);

    /* umtx2 auto-runs its chain on load when sessionStorage 'on_load_autorun'
       is set (it clears it itself once main() starts); clear it on the
       relapse/poops paths so a stale key never re-triggers it. */
    try {
      if (picked === 'umtx2') {
        sessionStorage.setItem('on_load_autorun', 'kernel');
        sessionStorage.setItem('piou_autoload', 'payload.elf');
      } else {
        sessionStorage.removeItem('on_load_autorun');
        sessionStorage.removeItem('piou_autoload');
      }
    } catch (e) { }

    setStage(0);
    setState('Running');
    chainStarted = true;
    uiLog('Arming chain…', 'dim');

    try {
      exploitEl.src = exploitUrl;
    } catch (e) {
      uiLog('[ERROR] Failed to arm iframe: ' + (e && e.message ? e.message : e), 'error');
      markError('Failed to arm the exploit iframe.');
    }
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
