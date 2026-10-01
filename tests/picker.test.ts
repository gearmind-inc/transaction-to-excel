import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

type PickerRequest = { requestId: string; expectedUrl: string; kind?: 'content' };
type PickerResult = { schemaVersion: 1; requestId: string; url: string; kind?: 'table' | 'content'; key?: string; index?: number; error?: string };
type PickerApi = { pickRegion(request: PickerRequest): Promise<PickerResult>; cancelRegion(requestId?: string): void };
const sourceUrl = 'https://fixture.example/manual';
const fixture = readFileSync(new URL('./fixtures/page-content.html', import.meta.url), 'utf8');
const pickerPath = new URL('../src/picker.ts', import.meta.url);
// Only an absent module gets this valid unselected-result adapter. A present
// implementation's syntax, import, and runtime failures must stay visible.
const bundled = existsSync(pickerPath)
  ? build({ entryPoints: ['src/picker.ts'], bundle: true, write: false, format: 'iife', globalName: 'PickerSubject', target: 'es2022' })
  : undefined;

async function page() {
  const dom = new JSDOM(fixture, { url: sourceUrl, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  // JSDOM does not lay out documents. Supply visible geometry, while browser
  // tests remain responsible for real CSS/scroll/resize and native rendering.
  Object.defineProperty(win.HTMLElement.prototype, 'getBoundingClientRect', { value() {
    return { x: 20, y: 30, top: 30, left: 20, right: 520, bottom: 230, width: 500, height: 200, toJSON: () => ({}) };
  } });
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  win.setTimeout = ((callback: () => void, delay = 0) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; }) as typeof win.setTimeout;
  win.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof win.clearTimeout;
  const trackedTypes = new Set(['click', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick', 'dblclick', 'contextmenu', 'dragstart', 'touchstart', 'touchmove', 'touchend', 'wheel', 'keydown', 'keyup', 'visibilitychange', 'pagehide', 'scroll', 'resize', 'popstate', 'hashchange']);
  const listeners: Array<{ target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; capture: boolean }> = [];
  const trackedTargets = new WeakSet<EventTarget>();
  function track(target: EventTarget) {
    if (trackedTargets.has(target)) return; trackedTargets.add(target);
    const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
    target.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (trackedTypes.has(type)) listeners.push({ target, type, listener, capture: typeof options === 'boolean' ? options : !!options?.capture });
      add(type, listener, options);
    }) as typeof target.addEventListener;
    target.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      const capture = typeof options === 'boolean' ? options : !!options?.capture;
      const index = listeners.findIndex(value => value.target === target && value.type === type && value.listener === listener && value.capture === capture);
      if (index >= 0) listeners.splice(index, 1);
      remove(type, listener, options);
    }) as typeof target.removeEventListener;
  }
  for (const target of [win.document, win] as unknown as EventTarget[]) track(target);
  // This evaluator models pointer coordinates and separate iframe event
  // propagation. Actual top-layer hit testing remains a browser check.
  let hit: Element | null = null;
  Object.defineProperty(win.document, 'elementFromPoint', { configurable: true, value: () => hit });
  Object.defineProperty(win.HTMLDivElement.prototype, 'showPopover', { configurable: true, value() {} });
  const append = win.Element.prototype.append;
  win.Element.prototype.append = function (...nodes: (Node | string)[]) {
    append.apply(this, nodes);
    for (const frame of win.document.querySelectorAll<HTMLIFrameElement>('[data-transaction-to-excel-input-shield] iframe')) {
      if (frame.contentDocument) track(frame.contentDocument);
    }
  };
  let api: PickerApi;
  if (bundled) {
    win.eval((await bundled).outputFiles![0].text + '\nwindow.PickerSubject = PickerSubject;');
    const exports = (win as unknown as { PickerSubject: PickerApi }).PickerSubject;
    assert.equal(typeof exports.pickRegion, 'function');
    assert.equal(typeof exports.cancelRegion, 'function');
    // Chrome copies each injected function, not its module closure. Every
    // case below exercises that same detached-function runtime boundary.
    api = {
      pickRegion: win.eval(`(${exports.pickRegion.toString()})`) as PickerApi['pickRegion'],
      cancelRegion: win.eval(`(${exports.cancelRegion.toString()})`) as PickerApi['cancelRegion'],
    };
  } else {
    api = { pickRegion: async request => ({ schemaVersion: 1, requestId: request.requestId, url: sourceUrl, error: '範囲選択はまだ実装されていません。' }), cancelRegion() {} };
  }
  const request = (requestId = 'pick-current'): PickerRequest => ({ requestId, expectedUrl: sourceUrl });
  const start = (requestId = 'pick-current') => api.pickRegion(request(requestId));
  const element = (id: string) => win.document.getElementById(id)!;
  const input = () => win.document.querySelector<HTMLIFrameElement>('[data-transaction-to-excel-input-shield] iframe')?.contentDocument;
  const dispatch = (id: string, type: string) => {
    hit = element(id);
    const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
    (input()?.body ?? element(id)).dispatchEvent(event); return event;
  };
  const hover = (id: string) => {
    for (const type of ['pointerover', 'mouseover', 'pointermove', 'mousemove']) dispatch(id, type);
  };
  const click = (id: string) => dispatch(id, 'click');
  const key = (value: string) => {
    const event = new win.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
    (input() ?? win.document).dispatchEvent(event); return event;
  };
  const overlay = () => win.document.querySelector<HTMLElement>('[data-transaction-to-excel-picker]');
  const assertClean = () => {
    assert.equal(overlay(), null, 'selection must leave no overlay behind');
    assert.equal(input(), undefined, 'selection must remove its input surface');
    assert.equal(listeners.length, 0, 'selection must remove its page/window event listeners');
    assert.equal(timers.size, 0, 'selection must cancel its expiry timers');
  };
  const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  return { dom, win, api, start, request, hover, click, key, dispatch, overlay, assertClean, timers, tick };
}

function assertSelected(result: PickerResult, requestId: string, kind: 'table' | 'content', key?: string) {
  assert.equal(result.error, undefined, 'click must return a selected usable region');
  assert.equal(result.schemaVersion, 1); assert.equal(result.requestId, requestId); assert.equal(result.url, sourceUrl);
  assert.equal(result.kind, kind);
  assert.equal(typeof result.key, 'string'); assert.ok(result.key!.length > 0);
  if (key) assert.equal(result.key, key);
  assert.ok(Number.isSafeInteger(result.index) && result.index! >= 0);
}
function assertCancelled(result: PickerResult, requestId: string) {
  assert.equal(result.schemaVersion, 1); assert.equal(result.requestId, requestId);
  assert.ok(typeof result.error === 'string' && result.error.length > 0, 'cancellation must be an explained unselected result');
  assert.equal(result.kind, undefined); assert.equal(result.key, undefined); assert.equal(result.index, undefined);
}

test('hover identifies the source behind an isolated input surface; click selects the containing table', async () => {
  const p = await page();
  try {
    const pending = p.start(); p.hover('table-leaf'); await p.tick();
    assert.ok(p.overlay(), 'a visible region must be highlighted on hover');
    assert.equal(p.overlay()!.style.pointerEvents, 'none', 'the highlight must leave pointer input to the isolated iframe');
    p.click('table-leaf');
    assertSelected(await pending, 'pick-current', 'table', 'id:transactions'); p.assertClean();
  } finally { p.api.cancelRegion(); p.dom.window.close(); }
});

test('only the selection click blocks a page link; normal link clicks work again after cleanup', async () => {
  const p = await page();
  try {
    let clicks = 0;
    p.win.document.getElementById('source-link')!.addEventListener('click', () => { clicks++; });
    const pending = p.start(); p.hover('source-link'); await p.tick();
    const selecting = p.click('source-link');
    assert.equal(selecting.defaultPrevented, true, 'choosing a linked region must not navigate away');
    assert.equal(clicks, 0, 'page click handlers must not interpret selection as a business action');
    assertSelected(await pending, 'pick-current', 'content', 'content:id:source-link'); p.assertClean();
    const normal = p.click('source-link');
    assert.equal(normal.defaultPrevented, false); assert.equal(clicks, 1);
  } finally { p.api.cancelRegion(); p.dom.window.close(); }
});

test('selection prevents pointer and mouse business actions, then restores those same events after cleanup', async () => {
  const p = await page();
  try {
    const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup'];
    const received: string[] = [];
    const target = p.win.document.getElementById('menu-action')!;
    for (const type of events) target.addEventListener(type, () => received.push(type));
    const pending = p.start(); p.hover('menu-action'); await p.tick();
    for (const type of events) {
      const event = p.dispatch('menu-action', type);
      assert.equal(event.defaultPrevented, true, `${type} must not start the page's own action while choosing a region`);
    }
    assert.deepEqual(received, [], 'preventing only click is too late for pointer/mouse handlers');
    p.click('menu-action'); assertSelected(await pending, 'pick-current', 'content', 'content:id:menu-action'); p.assertClean();
    for (const type of events) {
      const event = new p.win.MouseEvent(type, { bubbles: true, cancelable: true });
      target.dispatchEvent(event); assert.equal(event.defaultPrevented, false);
    }
    assert.deepEqual(received, events, 'range selection must release the page back to normal operation');
  } finally { p.api.cancelRegion(); p.dom.window.close(); }
});

test('earlier page window/document handlers cannot receive selection input from the separate iframe document', async () => {
  const p = await page();
  try {
    const received: string[] = [];
    const add = p.win.EventTarget.prototype.addEventListener;
    for (const surface of [p.win, p.win.document]) for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'keydown']) {
      add.call(surface, type, () => received.push(type), true);
    }
    const pending = p.start(); p.hover('menu-action');
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) p.dispatch('menu-action', type);
    p.key('Enter'); p.click('menu-action');
    assertSelected(await pending, 'pick-current', 'content', 'content:id:menu-action');
    assert.deepEqual(received, []); p.assertClean();
    p.click('menu-action'); assert.deepEqual(received, ['click', 'click']);
  } finally { p.api.cancelRegion(); p.dom.window.close(); }
});

test('an unavailable safe input surface fails closed and cleans resources instead of receiving source-page clicks', async () => {
  const p = await page();
  try {
    Object.defineProperty(p.win.HTMLDivElement.prototype, 'showPopover', { value: undefined });
    const result = await p.start();
    assertCancelled(result, 'pick-current'); assert.match(result.error!, /安全に範囲を選べません/); p.assertClean();
  } finally { p.api.cancelRegion(); p.dom.window.close(); }
});

test('canceling selection restores the focused page control without exposing its field value', async () => {
  const p = await page();
  try {
    const input = p.win.document.getElementById('password')!; (input as HTMLElement).focus();
    const pending = p.start(); assert.notEqual(p.win.document.activeElement, input);
    p.key('Escape'); assertCancelled(await pending, 'pick-current');
    assert.equal(p.win.document.activeElement, input); p.assertClean();
  } finally { p.api.cancelRegion(); p.dom.window.close(); }
});

test('content mode lets the user choose a partial region inside a table rather than forcing the whole table', async () => {
  const p = await page();
  try {
    const pending = p.api.pickRegion({ ...p.request(), kind: 'content' });
    p.hover('table-leaf'); await p.tick();
    assert.ok(p.overlay(), 'table contents remain individually selectable in content mode');
    p.click('table-leaf'); assertSelected(await pending, 'pick-current', 'content', 'content:id:table-leaf'); p.assertClean();
  } finally { p.api.cancelRegion(); p.dom.window.close(); }
});

test('ArrowUp expands to the containing element; ArrowDown returns to the original hovered link', async t => {
  for (const restore of [false, true]) await t.test(restore ? 'restore original' : 'expand', async () => {
    const p = await page();
    try {
      const pending = p.start(); p.hover('source-link'); await p.tick();
      assert.equal(p.key('ArrowUp').defaultPrevented, true, 'range adjustment must not also scroll the page');
      if (restore) assert.equal(p.key('ArrowDown').defaultPrevented, true);
      p.hover('source-link'); await p.tick();
      p.click('source-link');
      assertSelected(await pending, 'pick-current', 'content', restore ? 'content:id:source-link' : 'content:id:notes-paragraph'); p.assertClean();
    } finally { p.api.cancelRegion(); p.dom.window.close(); }
  });
});

test('Escape, explicit cancel, pagehide, hidden tab, and expiry stop selection and clean every resource', async t => {
  for (const reason of ['escape', 'cancel', 'pagehide', 'hidden', 'expiry'] as const) await t.test(reason, async () => {
    const p = await page();
    try {
      const pending = p.start(); p.hover('source-link'); await p.tick();
      assert.ok(p.overlay(), 'each cancellation case must begin with a real active selection');
      if (reason === 'escape') p.key('Escape');
      if (reason === 'cancel') p.api.cancelRegion('pick-current');
      if (reason === 'pagehide') p.win.dispatchEvent(new p.win.Event('pagehide'));
      if (reason === 'hidden') {
        Object.defineProperty(p.win.document, 'hidden', { configurable: true, value: true });
        Object.defineProperty(p.win.document, 'visibilityState', { configurable: true, value: 'hidden' });
        p.win.document.dispatchEvent(new p.win.Event('visibilitychange'));
      }
      if (reason === 'expiry') {
        const expiry = Array.from(p.timers.values()).find(timer => timer.delay === 120_000);
        assert.ok(expiry, 'interactive range selection must expire after 120 seconds'); expiry.callback();
      }
      assertCancelled(await pending, 'pick-current'); p.assertClean();
    } finally { p.api.cancelRegion(); p.dom.window.close(); }
  });
});

test('a stale cancellation token cannot stop a newer picker; reinjection cancels only the previous selection', async () => {
  const p = await page();
  try {
    const old = p.start('pick-old'); p.hover('source-link'); await p.tick();
    assert.ok(p.overlay(), 'old selection must first be active');
    const current = p.start('pick-new');
    assertCancelled(await old, 'pick-old');
    p.hover('table-leaf'); await p.tick();
    p.api.cancelRegion('pick-old');
    assert.ok(p.overlay(), 'an old cancellation must not clear a new selection');
    p.click('table-leaf');
    assertSelected(await current, 'pick-new', 'table', 'id:transactions'); p.assertClean();
  } finally { p.api.cancelRegion(); p.dom.window.close(); }
});

test('changed SPA URL cannot be returned as a selection from the old requested page', async () => {
  const p = await page();
  try {
    const pending = p.start(); p.hover('source-link'); await p.tick();
    assert.ok(p.overlay(), 'the old page must first have an active range');
    p.win.history.replaceState(null, '', '/another-page'); p.click('source-link');
    assertCancelled(await pending, 'pick-current'); p.assertClean();
  } finally { p.api.cancelRegion(); p.dom.window.close(); }
});

test('a detached region cannot be silently replaced by a new node with the same ID', async () => {
  const p = await page();
  try {
    const pending = p.start(); p.hover('source-link'); await p.tick();
    assert.ok(p.overlay());
    const original = p.win.document.getElementById('source-link')!;
    const replacement = original.cloneNode(true); original.replaceWith(replacement);
    p.click('source-link');
    assertCancelled(await pending, 'pick-current'); p.assertClean();
  } finally { p.api.cancelRegion(); p.dom.window.close(); }
});

test('a visible form can be selected while the picker returns no field value', async () => {
  const p = await page();
  try {
    const pending = p.start(); p.hover('login'); await p.tick();
    assert.ok(p.overlay(), 'visible form labels remain within the user-selectable page');
    assert.equal(p.click('login').defaultPrevented, true, 'a selection click must not submit a form');
    const result = await pending;
    assertSelected(result, 'pick-current', 'content', 'content:id:login');
    assert.ok(!JSON.stringify(result).includes('do-not-read-password'), 'region selection must send identifiers, not input values');
    p.assertClean();
  } finally { p.api.cancelRegion(); p.dom.window.close(); }
});

test('navigation and button labels are selectable without restricting the page to article containers', async t => {
  for (const id of ['navigation', 'menu-action']) await t.test(id, async () => {
    const p = await page();
    try {
      const pending = p.start(); p.hover(id); await p.tick();
      assert.ok(p.overlay(), 'any visible HTML region can be selected');
      p.click(id); assertSelected(await pending, 'pick-current', 'content', `content:id:${id}`); p.assertClean();
    } finally { p.api.cancelRegion(); p.dom.window.close(); }
  });
});

test('a child with visible visibility can be selected inside a hidden-visibility ancestor', async () => {
  const p = await page();
  try {
    const parent = p.win.document.createElement('div'); parent.style.visibility = 'hidden';
    parent.innerHTML = '<span id="visible-child" style="visibility:visible">表示を戻した内容</span>';
    p.win.document.body.append(parent);
    const pending = p.start(); p.hover('visible-child'); await p.tick();
    assert.ok(p.overlay(), 'visibility can be overridden by the visible child');
    p.click('visible-child');
    assertSelected(await pending, 'pick-current', 'content', 'content:id:visible-child'); p.assertClean();
  } finally { p.api.cancelRegion(); p.dom.window.close(); }
});

test('a child cannot override ancestor display:none or opacity:0 to become a selectable visible range', async t => {
  for (const style of ['display:none', 'opacity:0']) await t.test(style, async () => {
    const p = await page();
    try {
      const parent = p.win.document.createElement('div'); parent.setAttribute('style', style);
      parent.innerHTML = '<span id="hidden-child" style="visibility:visible;display:block;opacity:1">見えていない内容</span>';
      p.win.document.body.append(parent);
      const pending = p.start(); p.hover('hidden-child'); await p.tick();
      assert.equal(p.overlay(), null, 'rendering blockers on ancestors cannot be undone by these child styles');
      assert.equal(p.click('hidden-child').defaultPrevented, false);
      p.api.cancelRegion('pick-current'); assertCancelled(await pending, 'pick-current'); p.assertClean();
    } finally { p.api.cancelRegion(); p.dom.window.close(); }
  });
});
