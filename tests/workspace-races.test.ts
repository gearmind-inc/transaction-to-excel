import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { InspectRequest, InspectResult, Preset } from '../src/contracts';

// Exercise the actual bundled workspace and its DOM event handlers. Delayed
// Chrome replies are independent scheduling inputs, not copies of UI logic.
const bundled = build({ entryPoints: ['src/workspace.ts'], bundle: true, write: false, format: 'iife', target: 'es2022' });
const html = readFile('workspace.html', 'utf8');
const sourceUrl = 'https://fixture.example/transactions';

type Call = {
  target: { tabId: number; frameIds?: number[]; documentIds?: string[] };
  request: InspectRequest;
  resolve(value: chrome.scripting.InjectionResult<InspectResult>[]): void;
  reject(error: Error): void;
};
type StorageWrite = { values: Record<string, unknown>; resolve(): void; reject(error: Error): void };

async function screen() {
  const dom = new JSDOM(await html, { url: 'https://extension.example/workspace.html?tab=7', runScripts: 'outside-only' });
  const win = dom.window;
  const calls: Call[] = [];
  const stored: Record<string, unknown> = {};
  const storageWrites: StorageWrite[] = [];
  let deferredWrites = false;
  // Chrome serializes storage/messages back into the receiving JS realm. A
  // Node structuredClone would incorrectly manufacture foreign prototypes.
  const clone = <T>(value: T): T => value === undefined ? value : win.JSON.parse(win.JSON.stringify(value));
  Object.defineProperty(win.crypto, 'randomUUID', { value: randomUUID });
  Object.defineProperty(win.navigator, 'locks', { value: { request: (_name: string, work: () => unknown) => work() } });
  Object.assign(win, {
    structuredClone: clone,
    TextEncoder,
    chrome: {
      storage: { local: {
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
      downloads: { onChanged: { addListener() {}, removeListener() {} } },
      tabs: { get: async () => ({ url: sourceUrl }), update: async () => ({}) },
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
  const button = (id: string) => win.document.getElementById(id) as HTMLButtonElement;
  const status = () => win.document.getElementById('status')!.textContent;
  function reply(call: Call, documentId: string) {
    call.resolve([{ frameId: 0, documentId, result: {
      schemaVersion: 1, requestId: call.request.requestId, url: sourceUrl,
      tables: [{ index: 0, key: 'id:transactions', headers: ['ID'], rowCount: 1 }],
    } }]);
  }
  await waitForCalls(1);
  async function selectTable() {
    reply(calls[0], 'current-document'); await tick();
    const table = win.document.getElementById('table') as HTMLSelectElement;
    table.value = '0'; table.dispatchEvent(new win.Event('change'));
  }
  const settings = () => stored.presetsV1 as Preset[] | undefined;
  return { dom, win, calls, tick, waitForCalls, button, status, reply, selectTable, stored, settings, storageWrites, waitForWrites, deferWrites: () => { deferredWrites = true; } };
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
