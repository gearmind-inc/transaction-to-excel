import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { Capture, ColumnConfig, InspectRequest, InspectResult, Preset, TableCandidate } from '../src/contracts';
import { buildPreview } from '../src/transform';
import { generateCsv } from '../src/csv';

// Exercise the actual bundled workspace and its DOM event handlers. Delayed
// Chrome replies are independent scheduling inputs, not copies of UI logic.
const bundled = build({ entryPoints: ['src/workspace.ts'], bundle: true, write: false, format: 'iife', target: 'es2022' });
export const sourceBundled = build({ entryPoints: ['src/panel-source.ts'], bundle: true, write: false, format: 'iife', globalName: 'PanelSourceSubject', target: 'es2022' });
const html = readFile('workspace.html', 'utf8');
export const sourceUrl = 'https://fixture.example/transactions';

export type Call = {
  target: { tabId: number; frameIds?: number[]; documentIds?: string[] };
  request: InspectRequest;
  resolve(value: chrome.scripting.InjectionResult<InspectResult>[]): void;
  reject(error: Error): void;
};
export type StorageWrite = { values: Record<string, unknown>; resolve(): void; reject(error: Error): void };
export type Activation = { tabId: number; activationId: string };
export type SessionRead = { resolve(): void; reject(error: Error): void };
export type TabLookup = { id: number; resolve(): void; reject(error: Error): void };
export type WorkerCall = {
  request: { requestId: string; capture: Capture; columns: ColumnConfig[] };
  complete(): void;
  fail(): void;
};
export type ScreenOptions = { native?: boolean; activation?: Activation | null; deferSessionRead?: boolean; expectedInitialCalls?: number; tables?: TableCandidate[]; rows?: string[][] };

export async function screen(options: ScreenOptions = {}) {
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
  const downloadListeners: Array<(change: { id: number }) => void> = [];
  let downloadState: 'in_progress' | 'complete' | 'interrupted' = 'in_progress', downloadError: string | undefined;
  const downloadSearches: number[] = [];
  const tabUpdates: number[] = [];
  const tabLookups: TabLookup[] = [];
  const deferredTabIds = new Set<number>();
  const digestCalls: Array<{ bytes: Uint8Array; resolve(): void }> = [];
  const workerCalls: WorkerCall[] = [];
  let activeTabId = options.activation?.tabId ?? 7;
  const tabUrls = new Map<number, string>();
  let deferredDigest = false;
  let deferredWrites = false;
  let deferredWorkers = false;
  let downloadMissing = false;
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
      // A real Worker receives an immutable serialized request. Explicit
      // completion can deliver a callback already queued before termination.
      const request = clone(data), message = this.onmessage, error = this.onerror;
      const job: WorkerCall = {
        request,
        complete: () => {
          try {
            const preview = buildPreview(request.capture, request.columns);
            const bytes = preview.errorCount ? undefined : generateCsv(preview);
            message?.({ data: { requestId: request.requestId, preview: clone(preview), bytes: bytes ? new win.Uint8Array(bytes) : undefined } });
          } catch {
            message?.({ data: { requestId: request.requestId, error: '設定または取得結果が不正です。再設定・再取得してください。' } });
          }
        },
        fail: () => error?.(),
      };
      workerCalls.push(job);
      if (!deferredWorkers) setTimeout(() => { if (!this.terminated) job.complete(); }, 0);
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
        onChanged: {
          addListener: (listener: typeof downloadListeners[number]) => downloadListeners.push(listener),
          removeListener: (listener: typeof downloadListeners[number]) => { const index = downloadListeners.indexOf(listener); if (index >= 0) downloadListeners.splice(index, 1); },
        },
        download: async (value: { url: string; filename: string }) => { downloads.push(value); downloadState = 'in_progress'; downloadError = undefined; return 91; },
        search: async ({ id }: { id: number }) => { downloadSearches.push(id); return downloadMissing ? [] : [{ id, state: downloadState, ...(downloadError ? { error: downloadError } : {}) }]; },
        cancel: async () => { downloadState = 'interrupted'; downloadError = 'USER_CANCELED'; },
      },
      tabs: {
        get: (id: number) => {
          const tab = { id, windowId: 11, url: tabUrls.get(id) || sourceUrl, active: id === activeTabId };
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
    assert.equal(storageWrites.length, count, 'the production storage port must issue the expected write');
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
  async function waitForWorkers(count: number) {
    // Allow a short production input debounce without controlling UI timers.
    for (let tries = 0; tries < 60 && workerCalls.length < count; tries++) await new Promise<void>(resolve => setTimeout(resolve, 10));
    assert.equal(workerCalls.length, count, 'the production UI must issue the expected calculation');
  }
  const button = (id: string) => win.document.getElementById(id) as HTMLButtonElement;
  const status = () => win.document.getElementById('status')!.textContent;
  function reply(call: Call, documentId: string) {
    replyTables(call, options.tables ?? [{ index: 0, key: 'id:transactions', headers: ['ID'], rowCount: 1 }], documentId);
  }
  function replyTables(call: Call, tables: TableCandidate[], documentId = 'current-document') {
    call.resolve([{ frameId: 0, documentId, result: {
      schemaVersion: 1, requestId: call.request.requestId, url: call.request.expectedUrl,
      tables,
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
  function replyCapture(call: Call, documentId = 'current-document', rows = options.rows ?? [['keep-raw-id']]) {
    call.resolve([{ frameId: 0, documentId, result: {
      schemaVersion: 1, requestId: call.request.requestId, url: call.request.expectedUrl,
      capture: { schemaVersion: 1, requestId: call.request.requestId, tableKey: call.request.tableKey!, headers: [...call.request.headers!], sourceIndexes: [...call.request.sourceIndexes!], rows: rows.map(row => call.request.sourceIndexes!.map(index => row[index])), scope: 'current-page', capturedAt: '2026-10-01T00:00:00.000Z', ...(call.request.contentSignature ? { contentSignature: call.request.contentSignature } : {}), ...('layout' in call.request ? { layout: call.request.layout } : {}) },
    } }]);
  }
  async function previewTable() {
    await selectTable(); await waitForCalls(2);
    replyCapture(calls[1]);
    for (let tries = 0; tries < 30 && !win.document.getElementById('preview')!.textContent?.includes('keep-raw-id'); tries++) await tick();
    assert.ok(win.document.getElementById('preview')!.textContent?.includes('keep-raw-id'), 'a real captured table must reach the preview');
    const confirm = win.document.getElementById('confirm') as HTMLInputElement;
    confirm.checked = true; confirm.dispatchEvent(new win.Event('change'));
    assert.equal(button('save').disabled, false, 'the fixture must be reviewable and saveable before lifecycle events');
  }
  function openColumn(index = 0) {
    const adjust = win.document.querySelector<HTMLButtonElement>(`#preview th[data-source-index="${index}"] button`);
    assert.ok(adjust, 'the preview header must expose its column adjustment');
    adjust.click();
    return win.document.getElementById('column-name') as HTMLInputElement;
  }
  function downloadResult(state: typeof downloadState, error?: string): void { downloadState = state; downloadError = error; downloadListeners.forEach(listener => listener({ id: 91 })); }
  return { dom, win, calls, tick, waitForCalls, button, status, reply, replyTables, selectTable, previewTable, replyCapture, openColumn, stored, settings, storageWrites, waitForWrites, sessionReads, waitForSessionReads, activation, activateTab, updateTab, removeTab, digestCalls, waitForDigest, downloads, downloadSearches, downloadResult, setTabUrl: (id: number, url: string) => tabUrls.set(id, url), missingDownload: () => { downloadMissing = true; }, tabUpdates, tabLookups, waitForTabLookups, workerCalls, waitForWorkers, deferWorkers: () => { deferredWorkers = true; }, deferTabLookup: (id: number) => { deferredTabIds.add(id); }, deferDigest: () => { deferredDigest = true; }, deferWrites: () => { deferredWrites = true; } };
}
