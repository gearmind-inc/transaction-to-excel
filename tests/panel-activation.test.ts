import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

// Run the real background listener. Unresolved Chrome API replies test the
// user-gesture boundary: opening must happen in the action's synchronous turn.
const bundled = build({ entryPoints: ['src/background.ts'], bundle: true, write: false, format: 'iife', target: 'es2022' });

async function background() {
  const dom = new JSDOM('', { url: 'https://extension.example/', runScripts: 'outside-only' });
  Object.defineProperty(dom.window.crypto, 'randomUUID', { value: randomUUID });
  const actions: Array<(tab: Partial<chrome.tabs.Tab>) => void> = [];
  const installed: Array<() => void> = [];
  const startup: Array<() => void> = [];
  const opens: Array<{ windowId?: number; tabId?: number }> = [];
  const created: unknown[] = [];
  const writes: Record<string, unknown>[] = [];
  const never = new Promise<void>(() => {});
  Object.assign(dom.window, { chrome: {
    runtime: {
      onInstalled: { addListener: (listener: () => void) => installed.push(listener) },
      onStartup: { addListener: (listener: () => void) => startup.push(listener) },
      getURL: (path: string) => `chrome-extension://fixture/${path}`,
    },
    action: { onClicked: { addListener: (listener: (tab: Partial<chrome.tabs.Tab>) => void) => actions.push(listener) } },
    storage: {
      local: { setAccessLevel: () => never },
      session: {
        setAccessLevel: () => never,
        set: (values: Record<string, unknown>) => { writes.push(JSON.parse(JSON.stringify(values))); return never; },
      },
    },
    sidePanel: {
      open: (options: { windowId?: number; tabId?: number }) => { opens.push({ ...options }); return never; },
      setPanelBehavior: async () => {},
    },
    tabs: { create: async (options: unknown) => { created.push(options); return {}; } },
  } });
  dom.window.eval((await bundled).outputFiles![0].text);
  assert.equal(actions.length, 1, 'there must be one toolbar action owner');
  const click = (tab: Partial<chrome.tabs.Tab>) => actions[0](tab);
  return { dom, click, opens, created, writes, installed, startup };
}

test('toolbar opens the current window side panel before pending storage replies and creates no tab', async () => {
  const app = await background();
  try {
    app.click({ id: 7, windowId: 11, url: 'https://fixture.example/page?session=do-not-store#private' });
    assert.deepEqual(app.opens, [{ windowId: 11 }], 'sidePanel.open must run during the original user gesture');
    assert.deepEqual(app.created, [], 'the requested flow must stay beside the original page');
  } finally { app.dom.window.close(); }
});

test('source activation persists only window-scoped tab metadata with a fresh identity for each click', async () => {
  const app = await background();
  try {
    app.click({ id: 7, windowId: 11, url: 'https://fixture.example/page?secret=do-not-store', title: 'do-not-store-page-title' });
    app.click({ id: 9, windowId: 12, url: 'https://other.example/', title: 'do-not-store-other-title' });
    app.click({ id: 7, windowId: 11 });
    assert.equal(app.writes.length, 3, 'every authorized source activation must be observable even when the panel is already open');
    const records = app.writes.map((write, position) => {
      const expectedWindow = position === 1 ? 12 : 11;
      assert.deepEqual(Object.keys(write), [`panelActivationV1:${expectedWindow}`]);
      const record = write[`panelActivationV1:${expectedWindow}`] as { tabId: number; activationId: string };
      assert.deepEqual(Object.keys(record).sort(), ['activationId', 'tabId']);
      assert.equal(record.tabId, position === 1 ? 9 : 7);
      assert.equal(typeof record.activationId, 'string');
      assert.ok(record.activationId.length > 0);
      return record;
    });
    assert.equal(new Set(records.map(record => record.activationId)).size, 3, 'reopening the same source is a new activation, not a stale replay');
    assert.ok(!JSON.stringify(app.writes).includes('do-not-store'));
    assert.equal(app.opens.length, 3);
  } finally { app.dom.window.close(); }
});

test('an action without a source tab cannot open or persist a guessed target', async () => {
  const app = await background();
  try {
    app.click({ windowId: 11 });
    assert.deepEqual(app.opens, []);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.created, []);
  } finally { app.dom.window.close(); }
});

test('startup and installation configure storage without automatically opening or activating a page', async () => {
  const app = await background();
  try {
    app.installed.forEach(listener => listener());
    app.startup.forEach(listener => listener());
    assert.deepEqual(app.opens, []);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.created, []);
  } finally { app.dom.window.close(); }
});
