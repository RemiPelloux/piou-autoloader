/* PiouAutoLoader — autoloader UI controller
 *
 * Responsibilities:
 *   - pick the right WebKit exploit chain for the console's firmware;
 *   - arm it inside a hidden same-origin iframe;
 *   - mirror the chain's own log into a staged, animated progress view;
 *   - report success/failure and keep a clear way out (Restart / Retry)
 *     when a run stalls or never starts.
 *
 * Compatibility: written for the PS5 WebKit browser — ES5 only (var/function,
 * no arrow functions, no template literals) and defensive try/catch around
 * every cross-document access, because AppCache/iframe timing is the main
 * source of flakiness on that browser.
 *
 * Stability rules baked in here (do not "simplify" them away):
 *   - window.onerror is trapped: a thrown error never leaves a dead UI.
 *   - the elapsed clock freezes at a terminal state instead of drifting.
 *   - the log only auto-scrolls while the user is already at the tail, so a
 *     user reading back-scroll is never yanked away.
 *   - two watchdogs: a soft "no output yet" hint well before the hard stall,
 *     plus a periodic heartbeat so a silent-but-alive run is distinguishable
 *     from a dead one.
 *   - the whole slopkit "slopkit-poops:*" sessionStorage namespace is cleared
 *     before arming so no stale latch/run-log can make a retry a no-op.
 */
(function () {
  'use strict';

  /* ── element handles ──────────────────────────────────────────────────── */
  var doc = document;
  var logContainer = doc.getElementById('log');
  /* #log is the scroller itself (it carries overflow-y:auto), not a wrapper. */
  var logView = logContainer;
  var barFill = doc.getElementById('barFill');
  var barLabel = doc.getElementById('barLabel');
  var stepsEl = doc.getElementById('steps');
  var fwPill = doc.getElementById('fwPill');
  var statePill = doc.getElementById('statePill');
  var subtitle = doc.getElementById('subtitle');
  var timerEl = doc.getElementById('timer');
  var retryWrap = doc.getElementById('retryWrap');
  var retryBtn = doc.getElementById('retryBtn');
  var restartBtn = doc.getElementById('restartBtn');
  var jumpBtn = doc.getElementById('jump');
  var detailsBtn = doc.getElementById('detailsBtn');
  var detailsEl = doc.getElementById('details');
  var detailsClose = doc.getElementById('detailsClose');
  var dFw = doc.getElementById('dFw');
  var dChain = doc.getElementById('dChain');
  var dState = doc.getElementById('dState');
  var dTime = doc.getElementById('dTime');
  var dEvent = doc.getElementById('dEvent');
  var dStages = doc.getElementById('dStages');
  var dUa = doc.getElementById('dUa');
  var exploitEl = doc.getElementById('exploit');

  var MAX_LOG_LINES = 200;
  var STALL_MS = 120000;      /* no new log line for 2 min -> hard stall */
  var FIRST_OUTPUT_MS = 30000; /* no chain output at all after 30 s -> hint */
  var HEARTBEAT_MS = 30000;    /* reassure the user a silent run is alive */

  var finished = false;
  var finishedAt = 0;
  var chainStarted = false;
  var stalled = false;
  var lastFrameUrl = '';
  var lastFrameDoc = null;
  var mirrorTimer = 0;
  var tickTimer = 0;
  var startedAt = Date.now();
  var lastActivity = startedAt;
  var armedAt = 0;
  var lastHeartbeatAt = 0;
  var firstOutputSeen = false;
  var firstOutputWarned = false;
  var lastEvent = '';
  var fwDetected = null;

  /* ── staged progress model ────────────────────────────────────────────── */
  /* Five checkpoints, mirrored by the dots in index.html. Progress is
     monotonic: a chain never makes the bar jump backwards. Each checkpoint
     also records when it was reached, shown under its label. */
  var STAGE_PCT = [4, 18, 45, 78, 94];
  var stageTimes = [null, null, null, null, null];
  var currentStage = -1;

  var STATE_LABEL = {
    boot: 'Booting',
    run: 'Running',
    stall: 'Stalled',
    done: 'Ready',
    err: 'Failed'
  };
  var STATE_CLASS = {
    boot: 'is-booting',
    run: 'is-running',
    stall: 'is-stalled',
    done: 'is-done',
    err: 'is-error'
  };
  var BODY_STATES = ['is-booting', 'is-running', 'is-stalled', 'is-done', 'is-error'];

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

  function spanIn(li, name) {
    if (!li) return null;
    var spans = li.getElementsByTagName('span');
    for (var i = 0; i < spans.length; i++) {
      if (spans[i].className === name) return spans[i];
    }
    return null;
  }

  function renderStageTimes() {
    if (!stepsEl) return;
    var items = stepsEl.getElementsByTagName('li');
    for (var i = 0; i < items.length && i < STAGE_PCT.length; i++) {
      var t = spanIn(items[i], 't');
      if (!t) continue;
      var ms = stageTimes[i];
      if (ms === null) { t.textContent = ''; continue; }
      var secs = Math.round((ms - startedAt) / 1000);
      if (secs < 0) secs = 0;
      t.textContent = '+' + secs + 's';
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
    if (finished) return false;
    if (n <= currentStage) return false;
    if (n > STAGE_PCT.length - 1) n = STAGE_PCT.length - 1;
    currentStage = n;
    if (stageTimes[n] === null) stageTimes[n] = Date.now();
    setStepClasses();
    setProgress(STAGE_PCT[n]);
    renderStageTimes();
    touch();
    return true;
  }

  function setState(key) {
    if (statePill) statePill.textContent = STATE_LABEL[key] || key;
    setBodyState(STATE_CLASS[key] || null);
    updateDetails();
  }

  function touch() {
    lastActivity = Date.now();
    if (stalled && !finished) {
      /* The chain woke back up after we flagged it — clear the warning so
         the UI never lies about the current state. */
      stalled = false;
      setState('run');
      if (retryWrap) retryWrap.hidden = true;
      setProgressLabel('Recovered — the chain is logging again.');
      uiLog('[watchdog] Output resumed — chain is alive again.', 'success');
    }
  }

  function finishRun() {
    finished = true;
    if (!finishedAt) finishedAt = Date.now();
    if (tickTimer) { clearInterval(tickTimer); tickTimer = 0; }
  }

  function markDone() {
    finishRun();
    setState('done');
    currentStage = STAGE_PCT.length;
    setStepClasses();
    setProgress(100, 'Payload running on the console.');
    if (timerEl) timerEl.textContent = elapsedLabel();
    if (restartBtn) restartBtn.hidden = true;
    if (retryWrap) retryWrap.hidden = true;
    if (jumpBtn) jumpBtn.hidden = true;
    renderStageTimes();
    updateDetails();
  }

  function markError(message) {
    finishRun();
    setState('err');
    if (barLabel && message) barLabel.textContent = message;
    if (timerEl) timerEl.textContent = elapsedLabel();
    renderStageTimes();
    showRetry();
  }

  function bodyClass(name) {
    var body = doc.body;
    if (!body) return;
    if (!body.className) { body.className = name; return; }
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

  function setBodyState(name) {
    for (var i = 0; i < BODY_STATES.length; i++) clearBodyClass(BODY_STATES[i]);
    if (name) bodyClass(name);
  }

  function showRetry() {
    if (retryWrap) retryWrap.hidden = false;
  }

  function elapsedLabel() {
    var s = Math.max(0, Math.floor(((finishedAt || Date.now()) - startedAt) / 1000));
    var m = Math.floor(s / 60);
    s = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ── diagnostics panel ────────────────────────────────────────────────── */
  function setDetail(el, text) {
    if (el) el.textContent = (text === null || text === undefined || text === '') ? '—' : String(text);
  }

  function updateDetails() {
    if (!detailsEl || detailsEl.hidden) return;
    setDetail(dFw, fwDetected ? fwDetected.str : 'unknown');
    setDetail(dChain, exploitMode ? (EXPLOIT_LABEL[exploitMode] || exploitMode) : 'not selected');
    setDetail(dState, statePill ? statePill.textContent : '');
    setDetail(dTime, elapsedLabel());
    setDetail(dEvent, lastEvent ? lastEvent.slice(0, 160) : 'none yet');
    var parts = [];
    for (var i = 0; i < STAGE_PCT.length; i++) {
      parts.push(stageTimes[i] === null ? '·' :
        Math.round((stageTimes[i] - startedAt) / 1000) + 's');
    }
    setDetail(dStages, parts.join('  '));
    setDetail(dUa, navigator.userAgent || 'unknown');
  }

  function toggleDetails(show) {
    if (!detailsEl) return;
    detailsEl.hidden = (show === undefined) ? !detailsEl.hidden : !show;
    updateDetails();
  }

  /* ── logging ──────────────────────────────────────────────────────────── */
  /* Auto-scroll only follows the tail while the user is already there, so a
     user scrolling back through the chain output is never yanked away. */
  var autoScroll = true;

  function atLogBottom() {
    if (!logView) return true;
    return (logView.scrollHeight - logView.scrollTop - logView.clientHeight) < 48;
  }

  function onLogScroll() {
    var bottom = atLogBottom();
    autoScroll = bottom;
    if (jumpBtn) jumpBtn.hidden = bottom;
  }

  function scrollLogToBottom() {
    if (!logView) return;
    if (!autoScroll) return;
    logView.scrollTop = logView.scrollHeight;
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
     Clear the WHOLE namespace (not a hard-coded key list) right before
     arming so a future upstream key can never be left behind. */
  function clearSlopkitState() {
    try {
      var doomed = [];
      for (var i = 0; i < sessionStorage.length; i++) {
        var k = sessionStorage.key(i);
        if (k && k.indexOf('slopkit-poops:') === 0) doomed.push(k);
      }
      for (var j = 0; j < doomed.length; j++) sessionStorage.removeItem(doomed[j]);
    } catch (e) { }
    try {
      sessionStorage.removeItem('slopkit-poops:next');
      sessionStorage.removeItem('slopkit-poops:last');
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

  function queryParam(name) {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch (e) {
      try {
        var m = new RegExp('[?&]' + name + '=([^&#]+)').exec(window.location.search);
        return m ? decodeURIComponent(m[1]) : null;
      } catch (e2) { }
    }
    return null;
  }

  /* Choose which exploit to arm. Forced modes (build-time EXPLOIT_MODE or a
     ?force= query) bypass the firmware table so a specific chain can be
     exercised on any firmware — the exploit page's own firmware guard still
     applies. Returns 'umtx2' | 'poops' | 'relapse' | null. */
  function pickExploit() {
    var fw = detectFirmware();
    fwDetected = fw;
    if (fwPill) fwPill.textContent = 'FW ' + (fw ? fw.str : 'unknown');

    var forced = null;
    var q = queryParam('force');
    if (q === 'umtx2' || q === 'poops' || q === 'relapse') forced = q;
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
      /* The installer passes the user's choice in the URL and mirrors it in
         localStorage; ask the on-console server as a last resort. */
      var stored = queryParam('exploit');
      if (stored !== 'poops' && stored !== 'relapse') {
        stored = null;
        try {
          stored = localStorage.getItem('piou_exploit');
        } catch (e) { }
      }
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
      if (stored === 'poops') return 'poops';
      if (stored === 'relapse') return 'relapse';
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
      var bytes = (typeof data.bytes === 'number' && data.bytes > 0) ? data.bytes : null;
      uiLog('Payload loaded' + (bytes ? ' (' + bytes + ' bytes sent to elfldr).' : '.'), 'success');
      lastEvent = 'payload loaded' + (bytes ? ' (' + bytes + ' bytes)' : '');
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
      var why = data.why || 'unknown error';
      uiLog('[ERROR] Autoload failed: ' + why, 'error');
      lastEvent = 'autoload failed: ' + why;
      markError('Autoload failed: ' + why);
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
    /* Once the run reached a terminal state, the label belongs to the verdict
       (success text / error reason) — never overwrite it with late chain noise. */
    if (finished) return;
    var label = text.replace(/^\[[*+\-]\]\s*/, '').replace(/\s+/g, ' ');
    if (label.length > 76) label = label.slice(0, 73) + '...';
    if (label && label !== lastLabel) {
      lastLabel = label;
      if (barLabel) barLabel.textContent = label;
      lastEvent = label;
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
    if (frameUrl !== lastFrameUrl || frameDoc !== lastFrameDoc) {
      lastFrameUrl = frameUrl;
      lastFrameDoc = frameDoc;
      consoleMirror = { lines: 0, lastEntry: null, lastText: '' };
    }
    /* The iframe is intentionally empty until the chain is armed. */
    if (!chainStarted) return;

    var lines;
    try {
      var consoleEl = frameDoc.getElementById('console');
      lines = consoleEl ? consoleEl.children : [];
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
          + '" — the chain may not have started. Use Restart if nothing happens.',
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
    /* Only the visible tail can survive our bounded log. Skip historical
       bursts instead of creating thousands of immediately discarded nodes. */
    consoleMirror.lines = Math.max(consoleMirror.lines, lines.length - MAX_LOG_LINES);
    for (; consoleMirror.lines < lines.length; consoleMirror.lines++) {
      var el = lines[consoleMirror.lines];
      var text = (el.textContent || '').trim();
      if (!text) continue;
      var severity = consoleSeverity(text, el.className || '');
      consoleMirror.lastEntry = uiLog('[' + prefix + '] ' + text, severity, true);
      consoleMirror.lastText = text;
      mirroredAny = true;
      firstOutputSeen = true;
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
        firstOutputSeen = true;
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
  var slopkitLastLog = '';
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
    if (frameUrl !== lastFrameUrl || frameDoc !== lastFrameDoc) {
      lastFrameUrl = frameUrl;
      lastFrameDoc = frameDoc;
      slopkitMirroredLines = 0;
      slopkitLastLog = '';
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

    /* Quiet polls must not split the entire accumulated log again. Keep the
       trailing partial line pending so its next append is not skipped. */
    var logText = scr.textContent || '';
    var lines = logText === slopkitLastLog ? [] : logText.split('\n');
    if (lines.length && logText !== slopkitLastLog) {
      if (logText.indexOf(slopkitLastLog) !== 0) slopkitMirroredLines = 0;
      slopkitLastLog = logText;
      slopkitMirroredLines = Math.max(slopkitMirroredLines, lines.length - MAX_LOG_LINES);
    }
    var mirroredAny = false;
    for (; slopkitMirroredLines < lines.length - 1; slopkitMirroredLines++) {
      var line = lines[slopkitMirroredLines].trim();
      if (!line) continue;
      if (/^>/.test(line) || /^\[\+\]/.test(line)
        || /^(STAGE[0-5]|ALLPROC-CHECK|ALIASES-REPAIRED|POOPS-COMPLETE|POOPS-VERDICT|LATCH-HELD|LATCH-READ|OFFSETS-READY|WEBKIT-BASE|MODULE-BASES|SOCKETS|SPAWN|WAKEGATE)/.test(line)) {
        uiLog('[poops] ' + line, 'info', true);
        advancePoopsProgress(line);
        mirroredAny = true;
        firstOutputSeen = true;
        touch();
      } else if (/FAIL|ERROR|REFUSED|REBOOT|failed|panic|exception/i.test(line) || /^\[-\]/.test(line)) {
        uiLog('[poops] ' + line, 'error', true);
        mirroredAny = true;
        firstOutputSeen = true;
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
      firstOutputSeen = true;
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
          firstOutputSeen = true;
          touch();
        }
      }
    }

    if (mirroredAny) scrollLogToBottom();
  }

  /* ── watchdog / timer ─────────────────────────────────────────────────── */
  function tick() {
    /* A terminal state freezes the clock: the elapsed time shown is the time
       the run actually took, not however long the tab has been open. */
    if (finished) return;
    if (timerEl) timerEl.textContent = elapsedLabel();
    if (detailsEl && !detailsEl.hidden) updateDetails();
    if (!chainStarted || stalled) return;

    var now = Date.now();

    if (!firstOutputSeen && !firstOutputWarned && armedAt && (now - armedAt) > FIRST_OUTPUT_MS) {
      firstOutputWarned = true;
      uiLog('[watchdog] The chain has not logged anything after ' +
        Math.round(FIRST_OUTPUT_MS / 1000) + 's. Some steps are naturally slow, ' +
        'but if this never starts, use Restart.', 'warning');
    }

    var idle = now - lastActivity;
    if (idle > STALL_MS) {
      stalled = true;
      setState('stall');
      setProgressLabel('Stalled — no progress for ' + Math.round(STALL_MS / 1000) +
        's. Use Retry to start a clean run.');
      uiLog('[watchdog] No progress for ' + Math.round(STALL_MS / 1000) +
        's. The chain looks stuck — use Retry to start a clean run.', 'warning');
      showRetry();
      return;
    }

    if (idle > HEARTBEAT_MS && (now - lastHeartbeatAt) > HEARTBEAT_MS) {
      lastHeartbeatAt = now;
      uiLog('[watchdog] still working — ' + Math.round(idle / 1000) +
        's since the last log line…', 'dim');
    }
  }

  /* ── retry ────────────────────────────────────────────────────────────── */
  function doRetry() {
    if (mirrorTimer) { clearInterval(mirrorTimer); mirrorTimer = 0; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = 0; }
    if (restartBtn) restartBtn.disabled = true;
    if (retryBtn) retryBtn.disabled = true;
    /* A clean run means a clean slopkit latch, or the chain no-ops. */
    clearSlopkitState();
    uiLog('Restarting…', 'accent');
    try {
      window.location.reload();
    } catch (e) {
      uiLog('[ERROR] Reload failed: ' + (e && e.message ? e.message : e) +
        '. Close this page and open the app again.', 'error');
      if (restartBtn) restartBtn.disabled = false;
      if (retryBtn) retryBtn.disabled = false;
      markError('Reload failed — close and reopen the app.');
    }
  }

  /* ── error traps ──────────────────────────────────────────────────────── */
  function installErrorHandlers() {
    window.onerror = function (msg, src, line) {
      try {
        if (!finished) {
          var text = String(msg === undefined ? 'unknown error' : msg);
          uiLog('[fatal] ' + text + (line ? ' (line ' + line + ')' : ''), 'error');
          lastEvent = 'script error: ' + text;
          markError('Script error: ' + text);
        }
      } catch (e) { }
      /* Swallow the default WebKit error console: the run is already over and
         a native dialog on top of it only hides the retry button. */
      return true;
    };
    if (window.addEventListener) {
      window.addEventListener('unhandledrejection', function (ev) {
        try {
          if (finished) return;
          var r = ev && ev.reason;
          var text = (r && r.message) ? r.message : String(r);
          uiLog('[fatal] unhandled rejection: ' + text, 'error');
          lastEvent = 'unhandled rejection: ' + text;
          markError('Unhandled error: ' + text);
        } catch (e) { }
      }, false);
    }
  }

  /* ── boot ─────────────────────────────────────────────────────────────── */
  function attachMessageListener() {
    window.addEventListener('message', function (event) {
      var data = event.data;
      if (!data || data.type !== 'piou') return;
      var src = null;
      try { src = exploitEl ? exploitEl.contentWindow : null; } catch (e) { src = null; }
      if (!src || event.source !== src || !chainStarted) return;
      if (data.kind === 'log' && exploitMode === 'relapse') {
        /* The 500 ms mirror batches log bursts; mirroring every message
           repeatedly scans the same growing console during startup. */
        return;
      }
      if (data.kind === 'autoload') {
        onAutoloadResult(data);
      }
    });
  }

  function versionLabel() {
    try {
      var m = /v([0-9][^\s]*)/.exec(doc.title);
      if (m) return ' ' + m[1];
    } catch (e) { }
    return '';
  }

  function start() {
    if (retryBtn) retryBtn.onclick = doRetry;
    if (restartBtn) restartBtn.onclick = doRetry;
    if (jumpBtn) jumpBtn.onclick = function () {
      autoScroll = true;
      jumpBtn.hidden = true;
      scrollLogToBottom();
    };
    if (detailsBtn) detailsBtn.onclick = function () { toggleDetails(); };
    if (detailsClose) detailsClose.onclick = function () { toggleDetails(false); };
    if (logView && logView.addEventListener) {
      logView.addEventListener('scroll', onLogScroll, false);
    }
    doc.addEventListener('keydown', function (ev) {
      if (!ev) return;
      var k = ev.key || ev.keyCode;
      if ((k === 'r' || k === 'R' || k === 82) && chainStarted && !ev.ctrlKey && !ev.metaKey) {
        doRetry();
      }
    }, false);

    /* A chain that navigates the iframe (or fails to) should still show up in
       the timeline, so the log never looks frozen for no reason. */
    if (exploitEl) {
      exploitEl.onload = function () {
        if (finished || !chainStarted) return;
        var url = '';
        try { url = exploitEl.contentWindow.location.href; } catch (e) { }
        uiLog('[iframe] loaded ' + (url || 'about:blank'), 'dim');
        touch();
      };
      exploitEl.onerror = function () {
        if (finished || !chainStarted) return;
        uiLog('[iframe] the chain page failed to load.', 'error');
      };
    }

    renderStageTimes();
    setState('boot');

    uiLog('PiouAutoLoader' + versionLabel(), 'accent');
    uiLog('Detecting firmware…', 'dim');
    setProgress(0, 'Waiting to start…');

    attachMessageListener();

    var picked = pickExploit();
    if (!picked) {
      markError('Unsupported firmware — nothing to run here.');
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
    setState('run');
    chainStarted = true;
    armedAt = Date.now();
    lastHeartbeatAt = armedAt;
    uiLog('Arming chain…', 'dim');

    try {
      exploitEl.src = exploitUrl;
    } catch (e) {
      uiLog('[ERROR] Failed to arm iframe: ' + (e && e.message ? e.message : e), 'error');
      markError('Failed to arm the exploit iframe.');
    }
  }

  installErrorHandlers();

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
