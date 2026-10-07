const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('frontend/autoloader/app.js', 'utf8');

function boot() {
  let now = 1000;
  const handlers = {};
  const intervals = new Map();
  const elements = {};
  function element() {
    return {
      textContent: '', className: '', hidden: true, style: {}, children: [],
      scrollHeight: 0, scrollTop: 0, clientHeight: 0,
      get childElementCount() { return this.children.length; },
      get firstChild() { return this.children[0]; },
      get lastChild() { return this.children[this.children.length - 1]; },
      appendChild(child) { this.children.push(child); },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
      getElementsByTagName() { return []; },
      setAttribute() {}, addEventListener() {}
    };
  }
  const document = {
    readyState: 'complete', title: 'PiouAutoLoader v0.5.2', body: element(),
    getElementById(id) { return elements[id] ||= element(); },
    createElement: element, addEventListener() {}
  };
  const frame = document.getElementById('exploit');
  frame.contentWindow = { location: { href: 'about:blank' } };
  frame.contentDocument = { getElementById() { return null; }, readyState: 'loading' };
  const storage = { length: 0, getItem() { return null; }, setItem() {}, removeItem() {} };
  const window = {
    location: { search: '?force=umtx2', reload() {} },
    addEventListener(type, fn) { handlers[type] = fn; }
  };
  const context = {
    document, window, navigator: { userAgent: 'desktop test' },
    sessionStorage: storage, localStorage: storage, URLSearchParams,
    Date: { now: () => now },
    setInterval(fn) { const id = intervals.size + 1; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); }, setTimeout() {}
  };
  vm.runInNewContext(source, context);
  return { elements, frame, handlers, intervals, window,
    advance(ms) { now += ms; for (const fn of [...intervals.values()]) fn(); } };
}

test('fatal errors remain terminal and elapsed time freezes in Details', () => {
  const app = boot();
  app.advance(5000);
  app.window.onerror('test failure', '', 42);
  assert.equal(app.elements.statePill.textContent, 'Failed');
  const elapsed = app.elements.timer.textContent;
  app.advance(150000);
  app.elements.detailsBtn.onclick();
  assert.equal(app.elements.statePill.textContent, 'Failed');
  assert.equal(app.elements.dTime.textContent, elapsed);
  assert.equal(app.elements.retryWrap.hidden, false);
});

test('result messages must come from the armed iframe', () => {
  const app = boot();
  const data = { type: 'piou', kind: 'autoload', ok: true };
  app.handlers.message({ data, source: {} });
  assert.equal(app.elements.statePill.textContent, 'Running');
  app.advance(3000);
  app.handlers.message({ data, source: app.frame.contentWindow });
  assert.equal(app.elements.statePill.textContent, 'Ready');
  assert.equal(app.intervals.size, 0);
  assert.equal(app.frame.src, 'about:blank');
});

test('large log bursts render only the bounded tail', () => {
  const app = boot();
  const children = Array.from({ length: 5000 }, (_, i) => ({ textContent: `line ${i}`, className: '' }));
  app.frame.contentDocument.getElementById = id => id === 'console' ? { children } : null;
  app.advance(500);
  assert.equal(app.elements.log.children.length, 200);
  assert.match(app.elements.log.firstChild.textContent, /line 4800$/);
  assert.match(app.elements.log.lastChild.textContent, /line 4999$/);
});
