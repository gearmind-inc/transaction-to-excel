import assert from 'node:assert/strict';
import test from 'node:test';
import { screen } from './workspace-harness';
import { parseCsv } from './oracle';

const headers = ['ID', '金額', 'メモ'];
const rows = [['0001', '0', '日本語\n続き'], ['12345678901234567890', '', '=1+1'], ['0003', '¥1,200', '末尾']];
type UI = Awaited<ReturnType<typeof screen>>;
const matrix = (ui: UI) => Array.from(ui.win.document.querySelectorAll('#preview tbody tr')).map(row => Array.from(row.querySelectorAll('td')).slice(1).map(cell => cell.querySelector('.cell-value')?.textContent));
const names = (ui: UI) => Array.from(ui.win.document.querySelectorAll('#preview th[data-source-index] button')).map(button => button.firstChild?.textContent);
async function current(ui: UI): Promise<void> { for (let i = 0; i < 500 && (ui.win.document.getElementById('confirm') as HTMLInputElement).disabled; i++) await ui.tick(); assert.equal((ui.win.document.getElementById('confirm') as HTMLInputElement).disabled, false); }
async function setup(native = false): Promise<UI> {
  const ui = await screen({ native, tables: [{ index: 0, key: 'id:fixture', headers, rowCount: 3 }], rows });
  await ui.selectTable(); await ui.waitForCalls(2); ui.replyCapture(ui.calls[1]); await current(ui); return ui;
}
test('the three-step workspace keeps deferred conversion and preset controls out of the product UI', async () => {
  const ui = await setup();
  try { ui.openColumn(); for (const id of ['column-kind', 'column-required', 'preset', 'save-preset']) assert.equal(ui.win.document.getElementById(id), null, `${id} belongs to a later release`); assert.ok(ui.button('transpose')); assert.ok(ui.button('undo')); assert.equal(ui.win.document.querySelector('#preview')!.compareDocumentPosition(ui.win.document.querySelector('#column-editor')!) & ui.win.Node.DOCUMENT_POSITION_FOLLOWING, ui.win.Node.DOCUMENT_POSITION_FOLLOWING); }
  finally { ui.dom.window.close(); }
});
test('continuous structure edits preserve literal cells, undo transpose, and save the complete protected CSV', async () => {
  const ui = await setup();
  try {
    ui.openColumn(2); ui.button('column-left').click(); await current(ui);
    ui.openColumn(0); ui.button('column-hide').click(); await current(ui);
    ui.win.document.querySelector<HTMLButtonElement>('#hidden-columns [data-restore-index="0"]')!.click(); await current(ui);
    ui.win.document.querySelector<HTMLButtonElement>('#preview [data-hide-row="1"]')!.click(); await current(ui);
    assert.deepEqual(matrix(ui), [['0001', '日本語\n続き', '0'], ['0003', '末尾', '¥1,200']]);
    ui.win.document.querySelector<HTMLButtonElement>('#hidden-rows [data-restore-row="1"]')!.click(); await current(ui);
    ui.button('transpose').click(); await current(ui);
    assert.deepEqual(names(ui), ['元の列', '元の行1', '元の行2', '元の行3']);
    assert.deepEqual(matrix(ui), [['ID', '0001', '12345678901234567890', '0003'], ['メモ', '日本語\n続き', '=1+1', '末尾'], ['金額', '0', '［空欄］', '¥1,200']]);
    ui.button('undo').click(); await current(ui);
    assert.deepEqual(names(ui), ['ID', 'メモ', '金額']);
    assert.deepEqual(matrix(ui), [['0001', '日本語\n続き', '0'], ['12345678901234567890', '=1+1', '［空欄］'], ['0003', '末尾', '¥1,200']]);
    const confirm = ui.win.document.getElementById('confirm') as HTMLInputElement; confirm.checked = true; confirm.dispatchEvent(new ui.win.Event('change'));
    ui.deferDigest(); ui.button('save').click(); await ui.waitForDigest(1);
    assert.deepEqual(parseCsv(ui.digestCalls[0].bytes), [['ID', 'メモ', '金額'], ['0001', '日本語\n続き', '0'], ['12345678901234567890', '\t=1+1', ''], ['0003', '末尾', '¥1,200']]);
    ui.digestCalls[0].resolve(); await ui.tick(); await ui.tick(); assert.equal(ui.calls.length, 2);
  } finally { ui.dom.window.close(); }
});
test('source changes revoke acquisition while preserving reviewed local editing and output', async () => {
  const ui = await setup(true);
  try { const before = matrix(ui); ui.activateTab(9); await ui.tick(); assert.deepEqual(matrix(ui), before); assert.equal(ui.button('pick').disabled, true); const name = ui.openColumn(0); name.value = '番号'; name.dispatchEvent(new ui.win.Event('input')); await current(ui); assert.deepEqual(names(ui), ['番号', '金額', 'メモ']); const confirm = ui.win.document.getElementById('confirm') as HTMLInputElement; confirm.checked = true; confirm.dispatchEvent(new ui.win.Event('change')); assert.equal(ui.button('save').disabled, false); assert.equal(ui.calls.length, 2); }
  finally { ui.dom.window.close(); }
});
test('cancelled or failed replacement acquisition leaves the old edited table intact', async () => {
  const ui = await setup();
  try { const name = ui.openColumn(0); name.value = '保持する番号'; name.dispatchEvent(new ui.win.Event('input')); await current(ui); const before = matrix(ui); ui.button('capture').click(); await ui.waitForCalls(3); assert.deepEqual(matrix(ui), before); ui.calls[2].reject(new Error('CAPTURE_FAILED')); await ui.tick(); assert.deepEqual(names(ui), ['保持する番号', '金額', 'メモ']); assert.deepEqual(matrix(ui), before); ui.button('pick').click(); await ui.waitForCalls(4); ui.button('stop').click(); assert.deepEqual(matrix(ui), before); assert.deepEqual(names(ui), ['保持する番号', '金額', 'メモ']); }
  finally { ui.dom.window.close(); }
});
test('save reconciliation is hidden before an attempt and disabled reasons are visible', async () => {
  const ui = await screen();
  try { assert.equal(ui.button('reconcile').hidden, true); assert.equal(ui.button('cancel-save').hidden, true); assert.equal(ui.button('save').disabled, true); assert.match(ui.win.document.getElementById('save-help')?.textContent ?? '', /範囲|表/); assert.ok(ui.win.document.getElementById('edit-help')); }
  finally { ui.dom.window.close(); }
});

test('undo refreshes the open column name while preserving its focused input during ordinary recalculation', async () => {
  const ui = await setup();
  try {
    const input = ui.openColumn(0); input.value = '変更後'; input.focus(); input.setSelectionRange(2, 2);
    input.dispatchEvent(new ui.win.Event('input')); await current(ui);
    assert.equal(ui.win.document.activeElement, input); assert.equal(input.selectionStart, 2);
    ui.button('undo').click(); await current(ui);
    assert.deepEqual(names(ui), ['ID', '金額', 'メモ']);
    assert.equal(input.value, 'ID', 'the displayed input must match the restored table');
    assert.match(ui.win.document.querySelector('#column-editor h3')!.textContent!, /ID/);
    assert.equal(ui.win.document.getElementById('column-name'), input, 'undo updates the existing input without replacing it');
  } finally { ui.dom.window.close(); }
});

function confirm(ui: UI): void { const control = ui.win.document.getElementById('confirm') as HTMLInputElement; control.checked = true; control.dispatchEvent(new ui.win.Event('change')); }
async function settled(ui: UI, state: string): Promise<void> {
  for (let i = 0; i < 500 && (ui.stored.saveAttemptV1 as { state?: string } | undefined)?.state !== state; i++) await ui.tick();
  assert.equal((ui.stored.saveAttemptV1 as { state?: string } | undefined)?.state, state);
  await ui.tick();
}

test('saving freezes every structure edit; completion remains visible until a real edit enables a fresh export', async () => {
  const ui = await setup();
  try {
    ui.openColumn(0); confirm(ui); ui.deferDigest(); ui.button('save').click(); await ui.waitForDigest(1);
    const firstBytes = Array.from(ui.digestCalls[0].bytes), before = matrix(ui);
    for (const id of ['undo', 'transpose', 'column-left', 'column-right', 'column-hide']) ui.button(id).dispatchEvent(new ui.win.Event('click'));
    ui.win.document.querySelector<HTMLButtonElement>('[data-hide-row="0"]')!.dispatchEvent(new ui.win.Event('click'));
    assert.deepEqual(matrix(ui), before); assert.equal(ui.workerCalls.length, 1);
    assert.equal(ui.button('save').disabled, true); assert.match(ui.win.document.getElementById('save-help')!.textContent!, /保存を開始/);
    ui.digestCalls[0].resolve(); await settled(ui, 'saving');
    ui.downloadResult('complete'); await settled(ui, 'saved');
    assert.deepEqual(matrix(ui), before); assert.equal(ui.button('save').disabled, true); assert.equal(ui.button('reconcile').hidden, true);
    assert.match(ui.win.document.getElementById('save-status')!.textContent!, /CSVを保存しました/);
    ui.openColumn(0); await ui.tick(); assert.match(ui.win.document.getElementById('save-status')!.textContent!, /CSVを保存しました/, 'opening an editor is not a content edit');
    const input = ui.win.document.getElementById('column-name') as HTMLInputElement; input.value = '再出力番号'; input.dispatchEvent(new ui.win.Event('input')); await current(ui); confirm(ui);
    assert.equal(ui.button('save').disabled, false); ui.button('save').click(); await ui.waitForDigest(2);
    assert.notDeepEqual(Array.from(ui.digestCalls[1].bytes), firstBytes);
    assert.deepEqual(parseCsv(ui.digestCalls[1].bytes), [['再出力番号', '金額', 'メモ'], ['0001', '0', '日本語\n続き'], ['12345678901234567890', '', '\t=1+1'], ['0003', '¥1,200', '末尾']]);
    ui.digestCalls[1].resolve(); await settled(ui, 'saving'); ui.downloadResult('complete'); await settled(ui, 'saved'); assert.equal(ui.downloads.length, 2);
  } finally { ui.dom.window.close(); }
});

test('cancelled and interrupted saves retain the table and permit explicit retry or subsequent editing', async t => {
  for (const result of ['cancelled', 'interrupted'] as const) await t.test(result, async () => {
    const ui = await setup();
    try {
      confirm(ui); const before = matrix(ui); ui.button('save').click(); await settled(ui, 'saving');
      if (result === 'cancelled') ui.button('cancel-save').click(); else ui.downloadResult('interrupted', 'NETWORK_FAILED');
      await settled(ui, result); assert.deepEqual(matrix(ui), before); assert.equal(ui.button('save').disabled, false);
      assert.match(ui.win.document.getElementById('save-status')!.textContent!, result === 'cancelled' ? /保存を取り消しました/ : /失敗/);
      ui.button('save').click(); await settled(ui, 'saving'); assert.equal(ui.downloads.length, 2);
      ui.downloadResult('interrupted', 'USER_CANCELED'); await settled(ui, 'cancelled');
      const input = ui.openColumn(0); input.value = '取消後も編集'; input.dispatchEvent(new ui.win.Event('input')); await current(ui);
      assert.deepEqual(names(ui), ['取消後も編集', '金額', 'メモ']); assert.deepEqual(matrix(ui), before); assert.equal(ui.calls.length, 2);
    } finally { ui.dom.window.close(); }
  });
});

test('a failed save-intention write preserves reviewed bytes and controls for an explicit retry', async () => {
  const ui = await setup();
  try {
    confirm(ui); const before = matrix(ui); ui.deferWrites(); ui.button('save').click(); ui.button('save').dispatchEvent(new ui.win.Event('click'));
    await ui.waitForWrites(1); assert.equal(ui.downloads.length, 0); assert.equal(ui.button('transpose').disabled, true);
    ui.storageWrites[0].reject(new Error('SYNTHETIC_WRITE_FAILED'));
    for (let i = 0; i < 500 && ui.button('save').disabled; i++) await ui.tick();
    assert.equal(ui.button('save').disabled, false); assert.deepEqual(matrix(ui), before); assert.equal(ui.downloads.length, 0);
    ui.button('save').click(); await ui.waitForWrites(2); ui.storageWrites[1].resolve(); await ui.waitForWrites(3); ui.storageWrites[2].resolve(); await settled(ui, 'saving');
    assert.equal(ui.downloads.length, 1); assert.equal(ui.digestCalls.length, 1, 'retry uses the exact held artifact');
  } finally { ui.dom.window.close(); }
});

test('acquisition candidates from another origin cannot relabel the retained table until a replacement succeeds', async () => {
  const ui = await setup(true);
  try {
    const oldCoverage = ui.win.document.getElementById('coverage')!.textContent;
    assert.match(oldCoverage!, /https:\/\/fixture\.example/);
    ui.setTabUrl(9, 'https://replacement.example/new?private_token=secret#private');
    ui.activation({ tabId: 9, activationId: 'other-origin' }); await ui.waitForCalls(3);
    assert.match(ui.win.document.getElementById('source')!.textContent!, /https:\/\/replacement\.example/);
    assert.equal(ui.win.document.getElementById('coverage')!.textContent, oldCoverage);
    ui.reply(ui.calls[2], 'new-document'); await ui.tick();
    const table = ui.win.document.getElementById('table') as HTMLSelectElement; table.value = '0'; table.dispatchEvent(new ui.win.Event('change')); await ui.waitForCalls(4);
    ui.calls[3].reject(new Error('NEW_CAPTURE_FAILED')); await ui.tick();
    assert.equal(ui.win.document.getElementById('coverage')!.textContent, oldCoverage); assert.deepEqual(matrix(ui), rows.map(row => row.map(value => value || '［空欄］')));
    table.value = '0'; table.dispatchEvent(new ui.win.Event('change')); await ui.waitForCalls(5);
    ui.replyCapture(ui.calls[4], 'new-document', [['new-capture', '', '']]); await ui.waitForWorkers(2); await current(ui);
    assert.match(ui.win.document.getElementById('coverage')!.textContent!, /https:\/\/replacement\.example/);
    assert.ok(!ui.win.document.getElementById('coverage')!.textContent!.includes('private_token'));
    assert.ok(!ui.win.document.getElementById('source')!.textContent!.includes('private_token'));
  } finally { ui.dom.window.close(); }
});

test('stopping a pending editor calculation restores the last displayed snapshot and its exact bytes without another source read', async () => {
  const ui = await setup();
  try {
    const before = matrix(ui), input = ui.openColumn(0); ui.deferWorkers(); input.value = '中止する名前'; input.dispatchEvent(new ui.win.Event('input')); await ui.waitForWorkers(2);
    ui.button('stop').click(); assert.deepEqual(matrix(ui), before); assert.equal(input.value, 'ID'); assert.equal(ui.button('stop').disabled, true);
    ui.workerCalls[1].complete(); await ui.tick(); assert.deepEqual(names(ui), ['ID', '金額', 'メモ']);
    confirm(ui); assert.equal(ui.button('save').disabled, false); ui.deferDigest(); ui.button('save').click(); await ui.waitForDigest(1);
    assert.deepEqual(parseCsv(ui.digestCalls[0].bytes), [['ID', '金額', 'メモ'], ['0001', '0', '日本語\n続き'], ['12345678901234567890', '', '\t=1+1'], ['0003', '¥1,200', '末尾']]);
    ui.digestCalls[0].resolve(); await settled(ui, 'saving'); assert.equal(ui.calls.length, 2);
  } finally { ui.dom.window.close(); }
});

test('excluding and restoring rows or columns returns keyboard focus to the resulting table position', async () => {
  const ui = await setup();
  try {
    ui.openColumn(0); ui.button('column-hide').focus(); ui.button('column-hide').click(); await current(ui);
    assert.equal(ui.win.document.activeElement, ui.win.document.querySelector('th[data-source-index="1"] button'), 'excluding a column focuses its next visible neighbour');
    const column = ui.win.document.querySelector<HTMLButtonElement>('#hidden-columns [data-restore-index="0"]')!;
    column.focus(); column.click(); await current(ui);
    assert.equal(ui.win.document.activeElement, ui.win.document.querySelector('th[data-source-index="0"] button'), 'restoring a column focuses its own header');
    const row = ui.win.document.querySelector<HTMLButtonElement>('[data-hide-row="1"]')!; row.focus(); row.click(); await current(ui);
    assert.equal(ui.win.document.activeElement, ui.win.document.querySelector('[data-hide-row="2"]'), 'excluding a row focuses its next visible neighbour');
    const restored = ui.win.document.querySelector<HTMLButtonElement>('#hidden-rows [data-restore-row="1"]')!; restored.focus(); restored.click(); await current(ui);
    assert.equal(ui.win.document.activeElement, ui.win.document.querySelector('[data-hide-row="1"]'), 'restoring a row focuses its own row control');
  } finally { ui.dom.window.close(); }
});

test('excluding the last column keeps focus on its restore control and restoring it focuses the new header', async () => {
  const ui = await screen();
  try {
    await ui.previewTable(); ui.openColumn(0); ui.button('column-hide').focus(); ui.button('column-hide').click();
    for (let i = 0; i < 500 && ui.win.document.getElementById('preview')!.getAttribute('aria-busy') === 'true'; i++) await ui.tick();
    const restore = ui.win.document.querySelector<HTMLButtonElement>('#hidden-columns [data-restore-index="0"]')!;
    assert.equal(ui.win.document.activeElement, restore, 'the last excluded column remains reachable from the keyboard');
    restore.click(); await current(ui); assert.equal(ui.win.document.activeElement, ui.win.document.querySelector('th[data-source-index="0"] button'));
  } finally { ui.dom.window.close(); }
});

test('a delayed restore calculation does not steal focus after another input is selected', async () => {
  const ui = await setup();
  try {
    const row = ui.win.document.querySelector<HTMLButtonElement>('[data-hide-row="1"]')!; row.click(); await current(ui);
    ui.deferWorkers(); const restored = ui.win.document.querySelector<HTMLButtonElement>('#hidden-rows [data-restore-row="1"]')!; restored.focus(); restored.click(); await ui.waitForWorkers(3);
    const input = ui.openColumn(0); input.focus(); ui.workerCalls[2].complete(); await ui.tick();
    assert.equal(ui.win.document.activeElement, input, 'the user moved focus while the calculation was pending');
  } finally { ui.dom.window.close(); }
});

test('excluding the last row keeps focus on restoration and restores its original values and row control', async () => {
  const ui = await screen();
  try {
    await ui.previewTable(); const hide = ui.win.document.querySelector<HTMLButtonElement>('[data-hide-row="0"]')!; hide.focus(); hide.click(); await current(ui);
    const restore = ui.win.document.querySelector<HTMLButtonElement>('#hidden-rows [data-restore-row="0"]')!; assert.equal(ui.win.document.activeElement, restore);
    restore.click(); await current(ui); assert.equal(ui.win.document.activeElement, ui.win.document.querySelector('[data-hide-row="0"]')); assert.deepEqual(matrix(ui), [['keep-raw-id']]);
  } finally { ui.dom.window.close(); }
});

test('a rejected column rename restores the actual name without invalidating its reviewed artifact', async () => {
  const ui = await setup();
  try {
    confirm(ui); const input = ui.openColumn(0); input.value = 'a'.repeat(101); input.dispatchEvent(new ui.win.Event('input')); await ui.tick();
    assert.equal(input.value, 'ID'); assert.deepEqual(names(ui), ['ID', '金額', 'メモ']);
    assert.match(ui.status()!, /100/); assert.equal(ui.workerCalls.length, 1); assert.equal(ui.button('save').disabled, false);
  } finally { ui.dom.window.close(); }
});

test('a rename rejected at the complete text budget leaves the field, preview and reviewed CSV unchanged', async () => {
  // One-character header plus 1,999,999 literal data characters is the exact limit.
  const raw = Array.from({ length: 200 }, (_, index) => ['x'.repeat(index === 199 ? 9_999 : 10_000)]);
  const ui = await screen({ tables: [{ index: 0, key: 'id:budget', headers: ['H'], rowCount: 200 }], rows: raw });
  try {
    await ui.selectTable(); await ui.waitForCalls(2); ui.replyCapture(ui.calls[1]); await current(ui); confirm(ui);
    const input = ui.openColumn(0); input.value = 'HH'; input.dispatchEvent(new ui.win.Event('input')); await ui.tick();
    assert.equal(input.value, 'H'); assert.deepEqual(names(ui), ['H']); assert.match(ui.status()!, /文字数.*上限/);
    assert.equal(ui.workerCalls.length, 1); assert.equal(ui.button('save').disabled, false);
    assert.equal(ui.win.document.querySelector('.cell-value')!.textContent, 'x'.repeat(10_000));
  } finally { ui.dom.window.close(); }
});

test('stopping a first calculation retains the 100-row capture and offers local display recovery without another page read', async () => {
  const raw = Array.from({ length: 100 }, (_, index) => [String(index)]);
  const ui = await screen({ tables: [{ index: 0, key: 'id:fixture', headers: ['A'], rowCount: 100 }], rows: raw });
  try {
    ui.deferWorkers(); await ui.selectTable(); await ui.waitForCalls(2); ui.replyCapture(ui.calls[1]); await ui.waitForWorkers(1);
    ui.button('stop').click(); await ui.tick();
    assert.equal(ui.win.document.querySelectorAll('#preview th button').length, 0);
    assert.equal(ui.button('resume')?.hidden, false, 'the retained capture must have an explicit recovery control');
    assert.equal(ui.button('resume').disabled, false); assert.match(ui.status()!, /表を編集/);
    assert.match(ui.win.document.getElementById('summary')!.textContent!, /100/);
    ui.button('resume').click(); await ui.waitForWorkers(2); ui.workerCalls[0].complete(); await ui.tick();
    assert.equal(ui.win.document.querySelectorAll('#preview tbody tr').length, 0, 'the stopped callback is stale');
    ui.workerCalls[1].complete(); await current(ui); assert.deepEqual(matrix(ui), raw); assert.deepEqual(names(ui), ['A']);
    assert.equal(ui.button('resume').hidden, true); assert.equal(ui.calls.length, 2, 'display recovery must use only the retained capture');
    const input = ui.openColumn(0); input.value = '復旧した表'; input.dispatchEvent(new ui.win.Event('input')); await ui.waitForWorkers(3); ui.workerCalls[2].complete(); await current(ui); confirm(ui); assert.equal(ui.button('save').disabled, false);
  } finally { ui.dom.window.close(); }
});

test('a failed replacement Worker can recover the new successful capture without stale old headers or another acquisition', async () => {
  const ui = await setup();
  try {
    ui.deferWorkers(); ui.button('capture').click(); await ui.waitForCalls(3); ui.replyCapture(ui.calls[2], 'current-document', [['new', '0', 'replacement']]); await ui.waitForWorkers(2);
    ui.workerCalls[1].fail(); await ui.tick();
    assert.equal(ui.win.document.querySelectorAll('#preview tbody tr').length, 0);
    assert.equal(ui.button('resume')?.hidden, false); assert.equal(ui.button('resume').disabled, false);
    assert.match(ui.win.document.getElementById('summary')!.textContent!, /取得 1件/);
    ui.button('resume').click(); await ui.waitForWorkers(3); ui.workerCalls[2].complete(); await current(ui);
    assert.deepEqual(matrix(ui), [['new', '0', 'replacement']]); assert.deepEqual(names(ui), ['ID', '金額', 'メモ']); assert.equal(ui.calls.length, 3);
  } finally { ui.dom.window.close(); }
});

test('a first Worker failure is recoverable from the held capture after source permission is revoked', async () => {
  const raw = Array.from({ length: 100 }, (_, index) => [String(index)]);
  const ui = await screen({ native: true, tables: [{ index: 0, key: 'id:fixture', headers: ['A'], rowCount: 100 }], rows: raw });
  try {
    ui.deferWorkers(); await ui.selectTable(); await ui.waitForCalls(2); ui.replyCapture(ui.calls[1]); await ui.waitForWorkers(1); ui.workerCalls[0].fail(); await ui.tick();
    assert.equal(ui.button('resume').hidden, false);
    ui.activateTab(9); await ui.waitForWorkers(2); ui.workerCalls[1].fail(); await ui.tick();
    assert.equal(ui.button('pick').disabled, true); assert.equal(ui.button('resume').disabled, false); assert.equal(ui.button('resume').hidden, false);
    ui.button('resume').click(); await ui.waitForWorkers(3); ui.workerCalls[2].complete(); await current(ui);
    assert.deepEqual(matrix(ui), raw); assert.equal(ui.calls.length, 2); confirm(ui); assert.equal(ui.button('save').disabled, false);
  } finally { ui.dom.window.close(); }
});
