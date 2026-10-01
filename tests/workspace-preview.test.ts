import assert from 'node:assert/strict';
import test from 'node:test';
import { screen } from './workspace-harness';
import { EXPECTED_CAPTURE, HEADERS } from './fixtures/expected';
import { parseCsv } from './oracle';
import type { TableCandidate } from '../src/contracts';

// The input and expected output are the existing hand-authored public fixture.
// Chrome replies schedule the production UI; they do not manufacture its table.
const rawRows = EXPECTED_CAPTURE.rows.map(row => [...row, 'do-not-capture-excluded']);
const candidate: TableCandidate = { index: 0, key: 'id:transactions', headers: HEADERS, rowCount: 8 };
type UI = Awaited<ReturnType<typeof screen>>;

function node<T extends HTMLElement>(ui: UI, id: string): T {
  const value = ui.win.document.getElementById(id);
  assert.ok(value, `the ${id} control must exist after a valid capture`);
  return value as T;
}
async function wait(ui: UI, condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) await ui.tick();
  assert.ok(condition(), message);
}
const values = (ui: UI) => Array.from(ui.win.document.querySelectorAll('#preview tbody tr')).map(row =>
  Array.from(row.querySelectorAll('td')).slice(1).map(cell => cell.querySelector('.cell-value')?.textContent));
function change(ui: UI, id: string, value: string, event = 'change'): void {
  const input = node<HTMLInputElement | HTMLSelectElement>(ui, id); input.value = value;
  input.dispatchEvent(new ui.win.Event(event, { bubbles: true }));
}
function openColumn(ui: UI, sourceIndex: number): void {
  const button = ui.win.document.querySelector<HTMLButtonElement>(`#preview th[data-source-index="${sourceIndex}"] button`);
  assert.ok(button, 'each displayed column must be adjustable from its own table header');
  button.click();
  assert.equal(node(ui, 'column-editor').hidden, false, 'one column editor must be shown next to the preview');
}
async function automatic(ui: UI, selected = candidate, rows = rawRows): Promise<void> {
  ui.replyTables(ui.calls[0], [selected]); await ui.tick();
  const table = node<HTMLSelectElement>(ui, 'table'); table.value = '0';
  table.dispatchEvent(new ui.win.Event('change'));
  await ui.waitForCalls(2); // Semantic RED: the old UI issues no capture here.
  assert.equal(ui.calls[1].request.mode, 'capture', 'range selection must acquire immediately, without another button');
  assert.deepEqual(Array.from(ui.calls[1].request.sourceIndexes ?? []), selected.headers.map((_, index) => index), 'initial capture must retain every source column');
  ui.replyCapture(ui.calls[1], 'current-document', rows);
  await wait(ui, () => ui.win.document.querySelectorAll('#preview tbody tr').length === rows.length, 'the selected rows must appear automatically');
}
async function current(ui: UI): Promise<void> {
  await wait(ui, () => !node<HTMLInputElement>(ui, 'confirm').disabled, 'the newest valid column settings must finish calculating automatically');
}

test('range selection automatically captures all fields and displays one initial table, with no download or confirmation', async () => {
  const ui = await screen();
  try {
    await automatic(ui);
    assert.deepEqual(values(ui), rawRows.map(row => row.map(value => value === '' ? '［空欄］' : value)));
    assert.equal(ui.win.document.querySelectorAll('#columns fieldset').length, 0, 'column settings must not precede the table as a long fieldset list');
    assert.equal(node<HTMLInputElement>(ui, 'confirm').checked, false);
    assert.equal(ui.button('save').disabled, true);
    assert.equal(ui.downloads.length, 0);
    assert.deepEqual(ui.stored, {}, 'automatic preview must not persist source values');
  } finally { ui.dom.window.close(); }
});

test('table header adjustments update names, order and exclusions without converting original values and produce fixed CSV bytes', async () => {
  const ui = await screen();
  try {
    await automatic(ui);
    openColumn(ui, 5); ui.button('column-hide').click(); await current(ui);
    for (const [index, name] of [[0, '取引ID'], [1, '日付'], [2, '内容'], [3, '取引額'], [4, '任意メモ']] as const) {
      openColumn(ui, index); change(ui, 'column-name', name, 'input');
    }
    openColumn(ui, 0); ui.button('column-right').click(); ui.button('column-right').click(); ui.button('column-right').click();
    await current(ui);
    assert.equal(ui.calls.length, 2, 'column changes must not read a changing web page again');
    const expectedRows = [
      ['2026/10/01', '日本語,"引用"\n二行目', '¥1,234.50', '00001', ''],
      ['2024/02/29', '=SUM(1,2)', '-¥330', '12345678901234567890', '0'],
      ['2026/10/02', '+81-90-0000', '¥0', '00003', ''],
      ['2026/10/02', '@name', '¥12.00', '00004', ''],
      ['2026/10/03', ' \t＝1+2', '¥00001.2300', '00005', ''],
      ['2026/10/04', '同値の別取引', '¥20.00', '00777', ''],
      ['2026/10/04', '同値の別取引', '¥20.00', '00777', ''],
      ['2026/10/05', '-1+2', '-¥0.50', '00008', '備考'],
    ];
    assert.deepEqual(values(ui), expectedRows.map(row => row.map(value => value || '［空欄］')));
    assert.ok(!node(ui, 'preview').textContent?.includes('do-not-capture-excluded'), 'excluded values must disappear from the output table');
    const confirm = node<HTMLInputElement>(ui, 'confirm'); confirm.checked = true; confirm.dispatchEvent(new ui.win.Event('change'));
    ui.deferDigest(); ui.button('save').click(); await ui.waitForDigest(1);
    const expectedCsv = [
      ['日付', '内容', '取引額', '取引ID', '任意メモ'],
      ['2026/10/01', '日本語,"引用"\n二行目', '¥1,234.50', '00001', ''],
      ['2024/02/29', '\t=SUM(1,2)', '\t-¥330', '12345678901234567890', '0'],
      ['2026/10/02', '\t+81-90-0000', '¥0', '00003', ''],
      ['2026/10/02', '\t@name', '¥12.00', '00004', ''],
      ['2026/10/03', '\t \t＝1+2', '¥00001.2300', '00005', ''],
      ['2026/10/04', '同値の別取引', '¥20.00', '00777', ''],
      ['2026/10/04', '同値の別取引', '¥20.00', '00777', ''],
      ['2026/10/05', '\t-1+2', '\t-¥0.50', '00008', '備考'],
    ];
    assert.deepEqual(parseCsv(ui.digestCalls[0].bytes), expectedCsv, 'independent reader must preserve raw dates, currency and every protected cell');
    assert.equal(ui.downloads.length, 0, 'digest verification here is not a claim of native file saving');
    ui.digestCalls[0].resolve();
    await wait(ui, () => ui.downloads.length === 1 && (ui.stored.saveAttemptV1 as { downloadId?: number } | undefined)?.downloadId === 91, 'the mock save must settle before closing its UI');
    await ui.tick();
  } finally { ui.dom.window.close(); }
});

test('excluded columns can be restored without reacquisition, including when every column is excluded', async () => {
  const ui = await screen();
  try {
    await automatic(ui);
    for (let index = 0; index < HEADERS.length; index++) {
      openColumn(ui, index); ui.button('column-hide').click();
      if (index + 1 < HEADERS.length) await current(ui);
    }
    await wait(ui, () => ui.win.document.querySelectorAll('#preview tbody tr').length === 0, 'excluding all columns must show no output rows');
    assert.equal(ui.button('save').disabled, true);
    assert.equal(node<HTMLInputElement>(ui, 'confirm').disabled, true);
    assert.equal(ui.button('resume').hidden, true, 'excluding all columns requires restoration, rather than retrying a Worker');
    const restored = ui.win.document.querySelector<HTMLButtonElement>('#hidden-columns button[data-restore-index="0"]');
    assert.ok(restored, 'the last excluded field must remain recoverable'); restored.click(); await current(ui);
    assert.deepEqual(values(ui), rawRows.map(row => [row[0]]));
    assert.equal(ui.calls.length, 2);
  } finally { ui.dom.window.close(); }
});

test('normal cells show one value; requested details retain original, converted and exact protected CSV values', async () => {
  const ui = await screen();
  try {
    await automatic(ui);
    const cell = ui.win.document.querySelectorAll('#preview tbody tr')[1].querySelectorAll('td')[3];
    assert.equal(cell.querySelectorAll('.cell-value').length, 1);
    assert.equal(cell.querySelector('.cell-value')?.textContent, '=SUM(1,2)');
    assert.equal(cell.querySelectorAll('.cell-line').length, 0, 'three-stage values must not repeat in every normal cell');
    const detail = cell.querySelector('button'); assert.ok(detail); detail.click();
    const lines = Array.from(node(ui, 'cell-detail').querySelectorAll('.cell-line')).map(line => line.textContent);
    assert.deepEqual(lines, ['元の文字列：=SUM(1,2)', '表の値：=SUM(1,2)', 'CSV値：⟦TAB⟧=SUM(1,2)']);
    assert.match(node(ui, 'cell-detail').textContent ?? '', /保護用タブ/);
  } finally { ui.dom.window.close(); }
});

test('composite tables preserve local header rows and padding, allowing layout edits while types stay text', async () => {
  const ui = await screen();
  try {
    const mixed = { index: 0, key: 'content:id:manual', kind: 'content', layout: 'composite', headers: ['列1', '列2', '列3'], rowCount: 4, contentSignature: 'fixed-layout' } as TableCandidate;
    const rows = [['見出し', '本文', ''], ['日付', '金額', 'メモ'], ['2026/10/01', '¥1,200', 'A'], ['概要', '説明', '']];
    await automatic(ui, mixed, rows);
    openColumn(ui, 0);
    assert.equal(ui.win.document.getElementById('column-kind'), null, 'all MVP output keeps original text');
    assert.equal(ui.win.document.getElementById('column-required'), null, 'padding remains legitimate empty text');
    change(ui, 'column-name', '1列目', 'input'); await current(ui);
    assert.deepEqual(values(ui), rows.map(row => row.map(value => value || '［空欄］')));
    assert.equal(ui.calls.length, 2);
  } finally { ui.dom.window.close(); }
});

test('blank or duplicate edited column names block output and recover automatically after correction', async () => {
  const ui = await screen();
  try {
    await automatic(ui); openColumn(ui, 0); change(ui, 'column-name', '取引日', 'input');
    await wait(ui, () => !!node(ui, 'header-notice').textContent?.match(/重複/), 'duplicate names need an actionable column message');
    assert.equal(ui.button('save').disabled, true); assert.equal(node<HTMLInputElement>(ui, 'confirm').disabled, true);
    change(ui, 'column-name', '', 'input');
    await wait(ui, () => !!node(ui, 'header-notice').textContent?.match(/列名/), 'blank names need an actionable column message');
    change(ui, 'column-name', '番号', 'input'); await current(ui);
    assert.equal(node<HTMLInputElement>(ui, 'confirm').checked, false);
    assert.equal(ui.calls.length, 2);
  } finally { ui.dom.window.close(); }
});

test('automatic defaults make empty, duplicate and very long source headers usable without changing the source schema', async () => {
  const ui = await screen();
  try {
    const headers = ['', '金額', '金額', 'あ'.repeat(120)];
    await automatic(ui, { index: 0, key: 'id:transactions', headers, rowCount: 1 }, [['A', 'B', 'C', 'D']]);
    await current(ui);
    assert.deepEqual(Array.from(ui.calls[1].request.headers ?? []), headers, 'source headers are identity, not editable output names');
    const names: string[] = [];
    for (let index = 0; index < headers.length; index++) { openColumn(ui, index); names.push(node<HTMLInputElement>(ui, 'column-name').value); }
    assert.equal(new Set(names).size, 4); assert.ok(names.every(name => name.length <= 100 && name.trim() !== ''));
    assert.equal(names[0], '列1'); assert.equal(names[1], '金額');
    assert.deepEqual(values(ui), [['A', 'B', 'C', 'D']]);
  } finally { ui.dom.window.close(); }
});

test('structural edits keep the original content identity without persisting transaction values', async () => {
  const ui = await screen();
  try {
    const content = { index: 0, key: 'content:id:manual', kind: 'content', headers: ['項目', '値'], rowCount: 1, contentSignature: 'visible-labels-v1' } as TableCandidate;
    await automatic(ui, content, [['対象', 'CSV']]);
    openColumn(ui, 1); change(ui, 'column-name', '説明', 'input'); await current(ui);
    assert.deepEqual(values(ui), [['対象', 'CSV']]);
    assert.equal(ui.workerCalls.at(-1)!.request.capture.contentSignature, content.contentSignature);
    assert.equal(ui.calls.length, 2, 'edits use only the held capture');
    assert.equal(node<HTMLInputElement>(ui, 'confirm').checked, false);
    assert.deepEqual(ui.stored, {}, 'the editor never persists values or settings');
  } finally { ui.dom.window.close(); }
});
