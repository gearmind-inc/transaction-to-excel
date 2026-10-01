import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { Capture, ColumnConfig, InspectRequest, InspectResult, Preset } from '../src/contracts';
import { buildPreview } from '../src/transform';
import { generateCsv } from '../src/csv';

// Exercise the actual bundled workspace and its DOM event handlers. Delayed
// Chrome replies are independent scheduling inputs, not copies of UI logic.
const bundled = build({ entryPoints: ['src/workspace.ts'], bundle: true, write: false, format: 'iife', target: 'es2022' });
const sourceBundled = build({ entryPoints: ['src/panel-source.ts'], bundle: true, write: false, format: 'iife', globalName: 'PanelSourceSubject', target: 'es2022' });
const html = readFile('workspace.html', 'utf8');
const sourceUrl = 'https://fixture.example/transactions';

type Call = {
  target: { tabId: number; frameIds?: number[]; documentIds?: string[] };
  request: InspectRequest;
  resolve(value: chrome.scripting.InjectionResult<InspectResult>[]): void;
  reject(error: Error): void;
};
type StorageWrite = { values: Record<string, unknown>; resolve(): void; reject(error: Error): void };
type Activation = { tabId: number; activationId: string };
type SessionRead = { resolve(): void; reject(error: Error): void };
type TabLookup = { id: number; resolve(): void; reject(error: Error): void };
type ScreenOptions = { native?: boolean; activation?: Activation | null; deferSessionRead?: boolean; expectedInitialCalls?: number };

async function screen(options: ScreenOptions = {}) {
  const dom = new JSDOM(await html, { url: `https://extension.example/workspace.html${options.native ? '' : '?tab=7'}`, runScripts: 'outside-only' });
  const win = dom.window;
  const calls: Call[] = [];
  const stored: Record<string, unknown> = {};
  const storageWrites: StorageWrite[] = [];
  const sessionStored: Record<string, unknown> = options.activation === null ? {} : { 'panelActivationV1:11': options.activation ?? { tabId: 7, activationId: 'initial-7' } };
  const sessionReads: SessionRead[] = [];
  const storageListeners: Array<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void> = [];
  const activatedListeners: Array<(info: { tabId: number; windowId: number }) => void> = [];
  const updatedListeners: Array<(id: number, change: chrome.tabs.OnUpdatedInfo, tab: Partial<chrome.tabs.Tab>) => void> = [];
  const removedListeners: Array<(id: number, info: { windowId: number; isWindowClosing: boolean }) => void> = [];
  const downloads: Array<{ url: string; filename: string }> = [];
  const tabUpdates: number[] = [];
  const tabLookups: TabLookup[] = [];
  const deferredTabIds = new Set<number>();
  const digestCalls: Array<{ bytes: Uint8Array; resolve(): void }> = [];
  let activeTabId = options.activation?.tabId ?? 7;
  let deferredDigest = false;
  let deferredWrites = false;
  // Chrome serializes storage/messages back into the receiving JS realm. A
  // Node structuredClone would incorrectly manufacture foreign prototypes.
  const clone = <T>(value: T): T => value === undefined ? value : win.JSON.parse(win.JSON.stringify(value));
  Object.defineProperty(win.crypto, 'randomUUID', { value: randomUUID });
  Object.defineProperty(win.crypto, 'subtle', { value: {
    digest: (_algorithm: string, input: Uint8Array) => new Promise<ArrayBuffer>(resolve => {
      const complete = () => resolve(new Uint8Array(32).buffer);
      digestCalls.push({ bytes: new Uint8Array(input), resolve: complete });
      if (!deferredDigest) complete();
    }),
  } });
  Object.defineProperty(win.navigator, 'locks', { value: { request: (_name: string, work: () => unknown) => work() } });
  Object.defineProperty(win.URL, 'createObjectURL', { value: () => 'blob:https://extension.example/generated-csv' });
  Object.defineProperty(win.URL, 'revokeObjectURL', { value: () => {} });
  class FixtureWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    terminated = false;
    postMessage(data: { requestId: string; capture: Capture; columns: ColumnConfig[] }) {
      const preview = buildPreview(data.capture, data.columns);
      const bytes = generateCsv(preview);
      setTimeout(() => { if (!this.terminated) this.onmessage?.({ data: { requestId: data.requestId, preview: clone(preview), bytes: new win.Uint8Array(bytes) } }); }, 0);
    }
    terminate() { this.terminated = true; }
  }
  Object.assign(win, {
    structuredClone: clone,
    TextEncoder,
    Worker: FixtureWorker,
    chrome: {
      runtime: { getURL: (path: string) => `https://extension.example/${path}` },
      windows: { getCurrent: async () => ({ id: 11 }) },
      storage: { onChanged: {
        addListener: (listener: typeof storageListeners[number]) => storageListeners.push(listener),
        removeListener: (listener: typeof storageListeners[number]) => { const index = storageListeners.indexOf(listener); if (index >= 0) storageListeners.splice(index, 1); },
      }, session: {
        get: () => new Promise<Record<string, unknown>>((resolve, reject) => {
          const snapshot = clone(sessionStored);
          const complete = () => resolve(snapshot);
          sessionReads.push({ resolve: complete, reject });
          if (!options.deferSessionRead) complete();
        }),
      }, local: {
        QUOTA_BYTES: 10 * 1024 * 1024,
        setAccessLevel: async () => {},
        get: async () => clone(stored),
        getBytesInUse: async (key?: string) => new TextEncoder().encode(JSON.stringify(key ? stored[key] ?? null : stored)).length,
        set: (values: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
          const copy = clone(values);
          const commit = () => { Object.assign(stored, copy); resolve(); };
          storageWrites.push({ values: copy, resolve: commit, reject });
          if (!deferredWrites) commit();
        }),
      } },
      downloads: {
        onChanged: { addListener() {}, removeListener() {} },
        download: async (value: { url: string; filename: string }) => { downloads.push(value); return 91; },
        search: async ({ id }: { id: number }) => [{ id, state: 'in_progress' }],
      },
      tabs: {
        get: (id: number) => {
          const tab = { id, windowId: 11, url: sourceUrl, active: id === activeTabId };
          if (!deferredTabIds.delete(id)) return Promise.resolve(tab);
          return new Promise((resolve, reject) => { tabLookups.push({ id, resolve: () => resolve(tab), reject }); });
        },
        query: async () => [{ id: activeTabId, windowId: 11, url: sourceUrl, active: true }],
        update: async (id: number) => { tabUpdates.push(id); return {}; },
        onActivated: { addListener: (listener: typeof activatedListeners[number]) => activatedListeners.push(listener), removeListener() {} },
        onUpdated: { addListener: (listener: typeof updatedListeners[number]) => updatedListeners.push(listener), removeListener() {} },
        onRemoved: { addListener: (listener: typeof removedListeners[number]) => removedListeners.push(listener), removeListener() {} },
      },
      scripting: {
        executeScript: (options: { target: Call['target']; args: [InspectRequest] }) => new Promise((resolve, reject) => {
          calls.push({ target: options.target, request: options.args[0], resolve, reject });
        }),
      },
    },
  });
  win.eval((await bundled).outputFiles![0].text);
  const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  async function waitForCalls(count: number) {
    for (let tries = 0; tries < 30 && calls.length < count; tries++) await tick();
    assert.equal(calls.length, count, 'the production UI must issue the expected request');
  }
  async function waitForWrites(count: number) {
    for (let tries = 0; tries < 30 && storageWrites.length < count; tries++) await tick();
    assert.equal(storageWrites.length, count, 'the production preset port must issue the expected write');
  }
  async function waitForSessionReads(count: number) {
    for (let tries = 0; tries < 30 && sessionReads.length < count; tries++) await tick();
    assert.equal(sessionReads.length, count, 'a native panel must read its window activation metadata');
  }
  async function waitForDigest(count: number) {
    for (let tries = 0; tries < 30 && digestCalls.length < count; tries++) await tick();
    assert.equal(digestCalls.length, count, 'saving must reach the controlled digest scheduling boundary');
  }
  async function waitForTabLookups(count: number) {
    for (let tries = 0; tries < 30 && tabLookups.length < count; tries++) await tick();
    assert.equal(tabLookups.length, count, 'source validation must reach the controlled tab lookup boundary');
  }
  const button = (id: string) => win.document.getElementById(id) as HTMLButtonElement;
  const status = () => win.document.getElementById('status')!.textContent;
  function reply(call: Call, documentId: string) {
    call.resolve([{ frameId: 0, documentId, result: {
      schemaVersion: 1, requestId: call.request.requestId, url: sourceUrl,
      tables: [{ index: 0, key: 'id:transactions', headers: ['ID'], rowCount: 1 }],
    } }]);
  }
  await waitForCalls(options.expectedInitialCalls ?? (options.deferSessionRead ? 0 : 1));
  async function selectTable() {
    reply(calls[0], 'current-document'); await tick();
    const table = win.document.getElementById('table') as HTMLSelectElement;
    table.value = '0'; table.dispatchEvent(new win.Event('change'));
  }
  const settings = () => stored.presetsV1 as Preset[] | undefined;
  const activation = (value: Activation, windowId = 11) => {
    if (windowId === 11) activeTabId = value.tabId;
    const key = `panelActivationV1:${windowId}`, oldValue = clone(sessionStored[key]);
    sessionStored[key] = clone(value);
    storageListeners.forEach(listener => listener({ [key]: { oldValue, newValue: clone(value) } }, 'session'));
  };
  const activateTab = (id: number, windowId = 11) => {
    if (windowId === 11) activeTabId = id;
    activatedListeners.forEach(listener => listener({ tabId: id, windowId }));
  };
  const updateTab = (id: number, change: chrome.tabs.OnUpdatedInfo, windowId = 11) => updatedListeners.forEach(listener => listener(id, change, { id, windowId, url: change.url ?? sourceUrl }));
  const removeTab = (id: number, windowId = 11) => removedListeners.forEach(listener => listener(id, { windowId, isWindowClosing: false }));
  function replyCapture(call: Call, documentId = 'current-document') {
    call.resolve([{ frameId: 0, documentId, result: {
      schemaVersion: 1, requestId: call.request.requestId, url: sourceUrl,
      capture: { schemaVersion: 1, requestId: call.request.requestId, tableKey: call.request.tableKey!, headers: [...call.request.headers!], sourceIndexes: [...call.request.sourceIndexes!], rows: [['keep-raw-id']], scope: 'current-page', capturedAt: '2026-10-01T00:00:00.000Z' },
    } }]);
  }
  async function previewTable() {
    await selectTable(); button('capture').click(); await waitForCalls(2);
    replyCapture(calls[1]);
    for (let tries = 0; tries < 30 && !win.document.getElementById('preview')!.textContent?.includes('keep-raw-id'); tries++) await tick();
    assert.ok(win.document.getElementById('preview')!.textContent?.includes('keep-raw-id'), 'a real captured table must reach the preview');
    const confirm = win.document.getElementById('confirm') as HTMLInputElement;
    confirm.checked = true; confirm.dispatchEvent(new win.Event('change'));
    assert.equal(button('save').disabled, false, 'the fixture must be reviewable and saveable before lifecycle events');
  }
  return { dom, win, calls, tick, waitForCalls, button, status, reply, selectTable, previewTable, replyCapture, stored, settings, storageWrites, waitForWrites, sessionReads, waitForSessionReads, activation, activateTab, updateTab, removeTab, digestCalls, waitForDigest, downloads, tabUpdates, tabLookups, waitForTabLookups, deferTabLookup: (id: number) => { deferredTabIds.add(id); }, deferDigest: () => { deferredDigest = true; }, deferWrites: () => { deferredWrites = true; } };
}

test('a stopped scan cannot unlock controls belonging to a later pending scan', async () => {
  const ui = await screen();
  try {
    ui.button('stop').click();
    ui.button('scan').click();
    await ui.waitForCalls(2);
    ui.reply(ui.calls[0], 'same-document');
    await ui.tick();
    assert.equal(ui.button('scan').disabled, true, 'the later scan is still in flight');
    assert.equal(ui.button('stop').disabled, false, 'the later scan must remain cancellable');
    ui.reply(ui.calls[1], 'same-document');
    await ui.tick();
    assert.match(ui.status() ?? '', /表を選び/);
    assert.equal(ui.button('scan').disabled, false);
  } finally { ui.dom.window.close(); }
});

test('a stopped old-document scan cannot poison new-document provenance', async t => {
  for (const order of ['old-first', 'new-first'] as const) {
    await t.test(order, async () => {
      const ui = await screen();
      try {
        ui.button('stop').click();
        ui.button('scan').click();
        await ui.waitForCalls(2);
        const first = order === 'old-first' ? 0 : 1, second = 1 - first;
        ui.reply(ui.calls[first], first === 0 ? 'old-document' : 'new-document');
        await ui.tick();
        ui.reply(ui.calls[second], second === 0 ? 'old-document' : 'new-document');
        await ui.tick();
        assert.match(ui.status() ?? '', /表を選び/, 'the newer valid page must remain selectable');
        const table = ui.win.document.getElementById('table') as HTMLSelectElement;
        table.value = '0'; table.dispatchEvent(new ui.win.Event('change'));
        ui.button('show-source').click();
        await ui.waitForCalls(3);
        assert.deepEqual(Array.from(ui.calls[2].target.documentIds ?? []), ['new-document']);
        ui.reply(ui.calls[2], 'new-document');
        await ui.tick();
      } finally { ui.dom.window.close(); }
    });
  }
});

test('an error from a stopped scan cannot replace a later scan status', async () => {
  const ui = await screen();
  try {
    ui.button('stop').click();
    ui.button('scan').click();
    await ui.waitForCalls(2);
    const activeStatus = ui.status();
    ui.calls[0].reject(new Error('STALE_SCAN_ERROR'));
    await ui.tick();
    assert.equal(ui.status(), activeStatus, 'a stale rejection must not be presented as the current result');
    assert.equal(ui.button('scan').disabled, true);
    ui.reply(ui.calls[1], 'new-document');
    await ui.tick();
    assert.match(ui.status() ?? '', /表を選び/);
  } finally { ui.dom.window.close(); }
});

test('rapid first-preset saves write one version and prevent source edits until completion', async () => {
  const ui = await screen();
  try {
    await ui.selectTable(); ui.deferWrites();
    const name = ui.win.document.getElementById('preset-name') as HTMLInputElement;
    name.value = '初めての設定';
    ui.button('save-preset').click(); ui.button('save-preset').click();
    // Even an already queued activation must respect the in-flight guard.
    ui.button('save-preset').dispatchEvent(new ui.win.Event('click'));
    await ui.waitForWrites(1);
    assert.equal(ui.button('save-preset').disabled, true);
    assert.equal(ui.button('scan').disabled, true);
    assert.equal((ui.win.document.getElementById('table') as HTMLSelectElement).disabled, true);
    assert.equal(name.disabled, true);
    assert.equal((ui.win.document.querySelector('#columns fieldset') as HTMLFieldSetElement).disabled, true);
    ui.button('scan').click(); await ui.tick();
    assert.equal(ui.calls.length, 1, 'the current source cannot change during the settings write');
    ui.storageWrites[0].resolve(); await ui.tick();
    assert.equal(ui.settings()?.length, 1);
    assert.equal(ui.settings()?.[0].version, 1);
    const firstId = ui.settings()![0].id;
    assert.match(ui.win.document.getElementById('preset-status')!.textContent ?? '', /設定をローカルに保存しました/);
    assert.equal(ui.button('save-preset').disabled, false);
    assert.equal(ui.button('scan').disabled, false);
    name.value = '更新した設定'; ui.button('save-preset').click();
    await ui.waitForWrites(2); ui.storageWrites[1].resolve(); await ui.tick();
    assert.equal(ui.settings()?.length, 1, 'an explicit later save updates the same settings record');
    assert.equal(ui.settings()?.[0].id, firstId);
    assert.equal(ui.settings()?.[0].version, 2);
  } finally { ui.dom.window.close(); }
});

test('failed preset update leaves the old durable version intact and restores controls for explicit retry', async () => {
  const ui = await screen();
  try {
    await ui.selectTable();
    const name = ui.win.document.getElementById('preset-name') as HTMLInputElement;
    name.value = '保存済みの設定'; ui.button('save-preset').click();
    await ui.waitForWrites(1); await ui.tick();
    const previous = JSON.stringify(ui.settings());
    const firstId = ui.settings()![0].id;
    ui.deferWrites(); name.value = '保存に失敗する更新'; ui.button('save-preset').click();
    await ui.waitForWrites(2); ui.storageWrites[1].reject(new Error('SYNTHETIC_STORAGE_WRITE_FAILED')); await ui.tick();
    assert.equal(JSON.stringify(ui.settings()), previous);
    assert.equal(ui.button('save-preset').disabled, false);
    assert.equal(ui.button('scan').disabled, false);
    assert.equal(name.disabled, false);
    assert.equal((ui.win.document.getElementById('table') as HTMLSelectElement).disabled, false);
    ui.button('save-preset').click(); await ui.waitForWrites(3);
    ui.storageWrites[2].resolve(); await ui.tick();
    assert.equal(ui.settings()?.length, 1);
    assert.equal(ui.settings()?.[0].id, firstId);
    assert.equal(ui.settings()?.[0].version, 2, 'a failed write does not consume a durable version');
  } finally { ui.dom.window.close(); }
});

test('failed preset deletion preserves selection and old settings; successful deletion restores controls', async () => {
  const ui = await screen();
  try {
    await ui.selectTable();
    (ui.win.document.getElementById('preset-name') as HTMLInputElement).value = '削除する設定';
    ui.button('save-preset').click(); await ui.waitForWrites(1); await ui.tick();
    const previous = JSON.stringify(ui.settings()), firstId = ui.settings()![0].id;
    const choices = ui.win.document.getElementById('preset') as HTMLSelectElement;
    assert.equal(choices.value, firstId);
    ui.deferWrites(); ui.button('delete-preset').click(); ui.button('delete-preset').click();
    await ui.waitForWrites(2);
    assert.equal(ui.button('delete-preset').disabled, true);
    assert.equal(ui.button('scan').disabled, true);
    ui.storageWrites[1].reject(new Error('SYNTHETIC_DELETE_FAILED')); await ui.tick();
    assert.equal(JSON.stringify(ui.settings()), previous);
    assert.equal(choices.value, firstId);
    assert.equal(ui.button('delete-preset').disabled, false);
    assert.equal(ui.button('save-preset').disabled, false);
    assert.equal(ui.button('scan').disabled, false);
    ui.button('delete-preset').click(); await ui.waitForWrites(3);
    ui.storageWrites[2].resolve(); await ui.tick();
    assert.equal(ui.settings()?.length, 0);
    assert.equal(choices.value, '');
    assert.equal(ui.button('delete-preset').disabled, true, 'there is no selected setting left to delete');
    assert.equal(ui.button('save-preset').disabled, false);
    assert.equal(ui.button('scan').disabled, false);
    assert.equal((ui.win.document.getElementById('table') as HTMLSelectElement).disabled, false);
  } finally { ui.dom.window.close(); }
});

test('choosing new settings after an existing save creates a new record instead of overwriting the old one', async () => {
  const ui = await screen();
  try {
    await ui.selectTable();
    const name = ui.win.document.getElementById('preset-name') as HTMLInputElement;
    const choices = ui.win.document.getElementById('preset') as HTMLSelectElement;
    name.value = '残す設定'; ui.button('save-preset').click();
    await ui.waitForWrites(1); await ui.tick();
    const oldId = ui.settings()![0].id, oldRecord = JSON.stringify(ui.settings()![0]);
    choices.value = ''; choices.dispatchEvent(new ui.win.Event('change'));
    name.value = '別に作る設定'; ui.button('save-preset').click();
    await ui.waitForWrites(2); await ui.tick();
    assert.equal(ui.settings()?.length, 2, 'the explicit new-settings choice must not edit the previously loaded preset');
    assert.equal(JSON.stringify(ui.settings()!.find(value => value.id === oldId)), oldRecord);
    const created = ui.settings()!.find(value => value.id !== oldId)!;
    assert.equal(created.name, '別に作る設定');
    assert.equal(created.version, 1);
    assert.equal(choices.value, created.id);
  } finally { ui.dom.window.close(); }
});

test('a native side panel without a query parameter binds only its current window activation', async () => {
  const ui = await screen({ native: true });
  try {
    assert.equal(ui.calls[0].target.tabId, 7, 'the side panel must take its source from the current window session record');
    await ui.waitForSessionReads(1);
    ui.reply(ui.calls[0], 'current-document'); await ui.tick();
    assert.equal(ui.button('scan').disabled, false);
  } finally { ui.dom.window.close(); }
});

test('a native panel without an activation waits for the toolbar instead of guessing an active source', async () => {
  const ui = await screen({ native: true, activation: null, expectedInitialCalls: 0 });
  try {
    await ui.waitForSessionReads(1); await ui.tick();
    assert.equal(ui.calls.length, 0, 'opening an unbound panel does not authorize reading a tab');
    assert.equal(ui.button('capture').disabled, true);
    ui.button('scan').click(); await ui.tick();
    assert.equal(ui.calls.length, 0, 'a scan button does not grant access to a guessed tab');
    ui.activation({ tabId: 9, activationId: 'first-toolbar' }); await ui.waitForCalls(1);
    assert.equal(ui.calls[0].target.tabId, 9);
    ui.reply(ui.calls[0], 'new-document'); await ui.tick();
  } finally { ui.dom.window.close(); }
});

test('a session change delivered during the initial read wins over the stale initial snapshot', async () => {
  const ui = await screen({ native: true, deferSessionRead: true });
  try {
    await ui.waitForSessionReads(1);
    ui.activation({ tabId: 9, activationId: 'new-9' });
    ui.sessionReads[0].resolve();
    await ui.waitForCalls(1);
    assert.equal(ui.calls[0].target.tabId, 9, 'the newer authorized activation must own the panel');
    ui.reply(ui.calls[0], 'new-document'); await ui.tick(); await ui.tick();
    assert.equal(ui.calls.length, 1, 'the stale initial tab must never be scanned after the newer activation');
  } finally { ui.dom.window.close(); }
});

test('a stale initial session read failure cannot remove the newer source subscription or guidance', async () => {
  const ui = await screen({ native: true, deferSessionRead: true });
  try {
    await ui.waitForSessionReads(1);
    ui.activation({ tabId: 9, activationId: 'new-before-read-error' }); await ui.waitForCalls(1);
    ui.reply(ui.calls[0], 'new-document'); await ui.tick();
    const currentStatus = ui.status();
    ui.sessionReads[0].reject(new Error('STALE_SESSION_READ_FAILURE')); await ui.tick();
    assert.equal(ui.status(), currentStatus, 'an older session read failure cannot replace current guidance');
    ui.activation({ tabId: 10, activationId: 'still-subscribed' }); await ui.waitForCalls(2);
    assert.equal(ui.calls[1].target.tabId, 10, 'the source subscription must survive a superseded initial read');
    ui.reply(ui.calls[1], 'later-document'); await ui.tick();
  } finally { ui.dom.window.close(); }
});

test('an old toolbar tab lookup rejection cannot invalidate the newer selected source', async () => {
  const ui = await screen({ native: true });
  try {
    await ui.selectTable(); ui.deferTabLookup(7);
    ui.activation({ tabId: 7, activationId: 'old-delayed-lookup' }); await ui.waitForTabLookups(1);
    ui.activation({ tabId: 9, activationId: 'new-source' }); await ui.waitForCalls(2);
    assert.equal(ui.calls[1].target.tabId, 9);
    ui.reply(ui.calls[1], 'new-document'); await ui.tick();
    const currentStatus = ui.status();
    ui.tabLookups[0].reject(new Error('OLD_TAB_CLOSED')); await ui.tick();
    assert.equal(ui.status(), currentStatus, 'the old Chrome failure may not replace the new source guidance');
    assert.equal(ui.button('scan').disabled, false, 'the new authorized source remains usable');
    assert.equal(ui.button('pick').disabled, false);
  } finally { ui.dom.window.close(); }
});

test('a current tab lookup failure stops reading while preserving the subscription for a later toolbar action', async () => {
  const ui = await screen({ native: true });
  try {
    await ui.selectTable(); ui.deferTabLookup(9);
    ui.activation({ tabId: 9, activationId: 'missing-current-tab' }); await ui.waitForTabLookups(1);
    ui.tabLookups[0].reject(new Error('CURRENT_TAB_CLOSED')); await ui.tick();
    assert.equal(ui.button('scan').disabled, true, 'a source that cannot be validated may not remain readable');
    assert.equal(ui.button('capture').disabled, true);
    ui.activation({ tabId: 10, activationId: 'explicit-recovery' }); await ui.waitForCalls(2);
    assert.equal(ui.calls[1].target.tabId, 10);
    ui.reply(ui.calls[1], 'recovered-document'); await ui.tick();
    assert.equal(ui.button('scan').disabled, false);
  } finally { ui.dom.window.close(); }
});

test('disposed source watchers and stale activation callbacks cannot invalidate a current screen', async t => {
  for (const failure of ['disposed-lookup', 'old-callback', 'current-callback'] as const) await t.test(failure, async () => {
    const ui = await screen();
    try {
      const api = ui.win.eval((await sourceBundled).outputFiles![0].text + '\nPanelSourceSubject;') as { watchPanelSource(activate: (id: number) => Promise<void>, invalidate: () => void): Promise<() => void> };
      const activated: number[] = [];
      let invalidations = 0, failActivation = false, rejectCallback: ((error: Error) => void) | undefined;
      const dispose = await api.watchPanelSource(async id => {
        activated.push(id);
        if (failActivation) { failActivation = false; await new Promise<void>((_resolve, reject) => { rejectCallback = reject; }); }
      }, () => { invalidations++; });
      if (failure === 'disposed-lookup') {
        ui.deferTabLookup(7); ui.activation({ tabId: 7, activationId: 'lookup-before-dispose' });
        await ui.waitForTabLookups(1); dispose();
        ui.tabLookups[0].reject(new Error('CLOSED_WATCHER_LOOKUP'));
      } else {
        failActivation = true; ui.activation({ tabId: 7, activationId: 'delayed-callback' }); await ui.tick();
        assert.ok(rejectCallback, 'the activation callback must be in flight');
        if (failure === 'old-callback') { ui.activation({ tabId: 9, activationId: 'replacement-callback' }); await ui.tick(); }
        rejectCallback(new Error('ACTIVATION_CALLBACK_FAILED'));
      }
      await ui.tick();
      assert.equal(invalidations, failure === 'current-callback' ? 1 : 0, 'only the current live activation failure may invalidate the source');
      if (failure === 'old-callback') assert.deepEqual(activated, [7, 7, 9]);
      dispose();
    } finally { ui.dom.window.close(); }
  });
});

test('an old highlight response cannot activate a changed source or replace its current guidance', async t => {
  for (const outcome of ['resolve', 'reject'] as const) await t.test(outcome, async () => {
    const ui = await screen({ native: true });
    try {
      await ui.selectTable(); ui.button('show-source').click(); await ui.waitForCalls(2);
      const oldHighlight = ui.calls[1];
      ui.activation({ tabId: 9, activationId: 'after-highlight' }); await ui.waitForCalls(3);
      ui.reply(ui.calls[2], 'new-document'); await ui.tick();
      const currentStatus = ui.status();
      if (outcome === 'resolve') ui.reply(oldHighlight, 'current-document');
      else oldHighlight.reject(new Error('OLD_HIGHLIGHT_FAILED'));
      await ui.tick();
      assert.equal(ui.status(), currentStatus, 'stale highlight outcomes may not replace the current source guidance');
      assert.deepEqual(ui.tabUpdates, [], 'a stale highlight may not activate either the old or the new source tab');
    } finally { ui.dom.window.close(); }
  });
});

test('a successful current highlight activates the same tab that supplied its document', async () => {
  const ui = await screen({ native: true });
  try {
    await ui.selectTable(); ui.button('show-source').click(); await ui.waitForCalls(2);
    assert.equal(ui.calls[1].target.tabId, 7);
    ui.reply(ui.calls[1], 'current-document'); await ui.tick();
    assert.deepEqual(ui.tabUpdates, [7], 'highlight and activation must refer to the same captured source identity');
  } finally { ui.dom.window.close(); }
});

test('session and tab events from another window cannot replace or invalidate this panel source', async () => {
  const ui = await screen({ native: true });
  try {
    await ui.previewTable();
    const previous = ui.win.document.getElementById('preview')!.textContent;
    ui.activation({ tabId: 25, activationId: 'other-window' }, 12);
    ui.activateTab(25, 12); ui.updateTab(25, { status: 'loading' }, 12); ui.removeTab(25, 12);
    await ui.tick(); await ui.tick();
    assert.equal(ui.calls.length, 2, 'other windows may not start source inspection');
    assert.equal(ui.win.document.getElementById('preview')!.textContent, previous, 'other windows may not clear this window preview');
    assert.equal(ui.button('save').disabled, false);
  } finally { ui.dom.window.close(); }
});

test('an old source capture cannot supply rows or unlock a newer toolbar activation', async () => {
  const ui = await screen({ native: true });
  try {
    await ui.selectTable(); ui.button('capture').click(); await ui.waitForCalls(2);
    const oldCapture = ui.calls[1];
    ui.activation({ tabId: 9, activationId: 'replace-source' }); await ui.waitForCalls(3);
    assert.equal(ui.calls[2].target.tabId, 9);
    ui.replyCapture(oldCapture); await ui.tick();
    assert.equal(ui.win.document.getElementById('preview')!.textContent, '', 'the old captured values must not enter the new preview');
    assert.equal(ui.button('scan').disabled, true, 'the new pending scan must remain the current operation');
    ui.reply(ui.calls[2], 'new-document'); await ui.tick();
    assert.equal(ui.button('scan').disabled, false);
    assert.equal(ui.button('save').disabled, true);
    const table = ui.win.document.getElementById('table') as HTMLSelectElement;
    table.value = '0'; table.dispatchEvent(new ui.win.Event('change'));
    ui.button('show-source').click(); await ui.waitForCalls(4);
    assert.deepEqual(Array.from(ui.calls[3].target.documentIds ?? []), ['new-document'], 'the old capture must not poison document provenance');
    ui.reply(ui.calls[3], 'new-document'); await ui.tick();
  } finally { ui.dom.window.close(); }
});

test('tab switching, source navigation, and source closure discard the old preview until another toolbar action', async t => {
  for (const lifecycle of ['switch-tab', 'loading', 'url-change', 'close-tab'] as const) await t.test(lifecycle, async () => {
    const ui = await screen({ native: true });
    try {
      await ui.previewTable();
      if (lifecycle === 'switch-tab') ui.activateTab(9);
      if (lifecycle === 'loading') ui.updateTab(7, { status: 'loading' });
      if (lifecycle === 'url-change') ui.updateTab(7, { url: 'https://fixture.example/another-page' });
      if (lifecycle === 'close-tab') ui.removeTab(7);
      await ui.tick(); await ui.tick();
      assert.equal(ui.win.document.getElementById('preview')!.textContent, '', 'a changed source invalidates previously confirmed values');
      assert.equal((ui.win.document.getElementById('confirm') as HTMLInputElement).checked, false);
      assert.equal(ui.button('save').disabled, true);
      ui.button('scan').click(); ui.button('capture').click(); await ui.tick();
      assert.equal(ui.calls.length, 2, 'page lifecycle events must not authorize another source inspection');
    } finally { ui.dom.window.close(); }
  });
});

test('saving blocks source activation and editing before the asynchronous digest produces a save record', async () => {
  const ui = await screen({ native: true });
  try {
    await ui.previewTable(); ui.deferDigest(); ui.button('save').click();
    await ui.waitForDigest(1);
    assert.equal(ui.stored.saveAttemptV1, undefined, 'the fixture must be before the durable save intention');
    assert.equal(ui.button('save').disabled, true, 'save-starting is already a blocked UI state');
    assert.equal(ui.button('scan').disabled, true);
    assert.equal(ui.button('capture').disabled, true);
    assert.equal(ui.button('save-preset').disabled, true);
    assert.equal((ui.win.document.getElementById('table') as HTMLSelectElement).disabled, true);
    assert.equal((ui.win.document.querySelector('#columns fieldset') as HTMLFieldSetElement).disabled, true);
    ui.activateTab(9); ui.activation({ tabId: 9, activationId: 'during-digest' });
    ui.button('scan').click(); ui.button('save').click(); await ui.tick();
    assert.equal(ui.calls.length, 2, 'an activation during save-starting must not scan a replacement source');
    assert.ok(ui.win.document.getElementById('preview')!.textContent?.includes('keep-raw-id'), 'the exact held export remains in the preview');
    ui.digestCalls[0].resolve();
    for (let tries = 0; tries < 30 && ui.downloads.length === 0; tries++) await ui.tick();
    assert.equal(ui.downloads.length, 1, 'the original controller must survive the blocked activation');
    const storedAttempt = ui.stored.saveAttemptV1 as unknown as { downloadId: number; state: string };
    assert.equal(storedAttempt.downloadId, 91);
    assert.equal(storedAttempt.state, 'saving');
    assert.equal(ui.calls.length, 2, 'a rejected activation must not be replayed while saving');
  } finally { ui.dom.window.close(); }
});
