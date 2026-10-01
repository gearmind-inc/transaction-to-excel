import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS, type Capture } from '../src/contracts';
import { canUndo, createEditor, EDIT_HISTORY_LIMIT, editTable, editorView, transposeProblem, type EditorState } from '../src/table-editor';
import { buildPreview } from '../src/transform';
import { generateCsv } from '../src/csv';
import { parseCsv } from './oracle';

const capture = (headers = ['名前', '金額'], rows = [['A社', '001'], ['B社', '0']]): Capture => ({ schemaVersion: 1, requestId: 'editor-fixture', tableKey: 'id:editor', headers, sourceIndexes: headers.map((_, index) => index), rows, scope: 'current-page', capturedAt: '2026-10-01T00:00:00.000Z' });
const cells = (state: EditorState) => { const view = editorView(state); return [view.headers, ...view.rows]; };

test('column move, row/column exclude, restore, transpose and undo preserve every fixed cell', () => {
  let state = createEditor(capture());
  state = editTable(state, { type: 'move-column', id: 1, toVisibleIndex: 0 });
  assert.deepEqual(cells(state), [['金額', '名前'], ['001', 'A社'], ['0', 'B社']]);
  state = editTable(state, { type: 'exclude-column', id: 0 });
  state = editTable(state, { type: 'exclude-row', id: 0 });
  assert.deepEqual(cells(state), [['金額'], ['0']]);
  state = editTable(state, { type: 'restore-column', id: 0 });
  state = editTable(state, { type: 'restore-row', id: 0 });
  assert.deepEqual(cells(state), [['金額', '名前'], ['001', 'A社'], ['0', 'B社']]);
  state = editTable(state, { type: 'transpose' });
  assert.deepEqual(cells(state), [['元の列', '元の行1', '元の行2'], ['金額', '001', '0'], ['名前', 'A社', 'B社']]);
  assert.deepEqual(editorView(state).rowLabels, ['元の列1', '元の列2']);
  assert.ok(canUndo(state));
  state = editTable(state, { type: 'undo' });
  assert.deepEqual(cells(state), [['金額', '名前'], ['001', 'A社'], ['0', 'B社']]);
  state = editTable(state, { type: 'undo' });
  assert.deepEqual(cells(state), [['金額', '名前'], ['0', 'B社']]);
});

test('transpose includes edited headers as ordinary values and never exports UI row numbers as cell data', () => {
  let state = createEditor(capture(['ID', 'メモ'], [['0001', '=SUM(1,2)'], ['', '改行\n日本語']]));
  state = editTable(state, { type: 'rename-column', id: 1, name: '説明' });
  state = editTable(state, { type: 'transpose' });
  assert.deepEqual(cells(state), [['元の列', '元の行1', '元の行2'], ['ID', '0001', ''], ['説明', '=SUM(1,2)', '改行\n日本語']]);
  assert.deepEqual(state.table.rows.map(row => row.sourceRow), [null, null]);
});

test('transpose acts on visible cells; undo restores excluded information and earlier history', () => {
  let state = createEditor(capture());
  state = editTable(state, { type: 'exclude-row', id: 0 });
  state = editTable(state, { type: 'exclude-column', id: 1 });
  const before = state;
  state = editTable(state, { type: 'transpose' });
  assert.deepEqual(cells(state), [['元の列', '元の行2'], ['名前', 'B社']]);
  assert.equal(state.history.length, before.history.length + 1);
  state = editTable(state, { type: 'undo' });
  assert.equal(state.table, before.table);
  state = editTable(state, { type: 'restore-row', id: 0 });
  state = editTable(state, { type: 'restore-column', id: 1 });
  assert.deepEqual(cells(state), [['名前', '金額'], ['A社', '001'], ['B社', '0']]);
});

test('all rows or columns can be excluded and restored, including an empty input table', () => {
  let state = createEditor(capture());
  state = editTable(state, { type: 'exclude-column', id: 0 });
  state = editTable(state, { type: 'exclude-column', id: 1 });
  assert.deepEqual(editorView(state).headers, []);
  assert.match(transposeProblem(state) ?? '', /列/);
  state = editTable(state, { type: 'restore-column', id: 1 });
  state = editTable(state, { type: 'exclude-row', id: 0 });
  state = editTable(state, { type: 'exclude-row', id: 1 });
  assert.deepEqual(cells(state), [['金額']]);
  state = editTable(state, { type: 'transpose' });
  assert.deepEqual(cells(state), [['元の列'], ['金額']]);
  assert.deepEqual(cells(editTable(createEditor(capture(['空表'], [])), { type: 'transpose' })), [['元の列'], ['空表']]);
});

test('source indexes and row identity survive hidden columns and adjacent moves without editing capture', () => {
  const input = capture(['非取得', '名称', '金額'], [['A', '01'], ['B', '0']]); input.sourceIndexes = [1, 2];
  const original = structuredClone(input);
  let state = createEditor(input);
  input.headers[1] = '元データを後から変更'; input.rows[0][0] = '書き換え';
  state = editTable(state, { type: 'exclude-column', id: 1 });
  state = editTable(state, { type: 'restore-column', id: 1 });
  state = editTable(state, { type: 'move-column', id: 2, toVisibleIndex: 0 });
  assert.deepEqual(cells(state), [['金額', '名称'], ['01', 'A'], ['0', 'B']]);
  assert.deepEqual(editorView(state).rowIds, [0, 1]);
  assert.deepEqual(original.rows, [['A', '01'], ['B', '0']]);
});

test('edits are immutable, no-op commands do not create history, and undo has a documented bounded history', () => {
  const initial = createEditor(capture());
  assert.equal(editTable(initial, { type: 'rename-column', id: 0, name: '名前' }), initial);
  assert.equal(editTable(initial, { type: 'move-column', id: 0, toVisibleIndex: 0 }), initial);
  assert.equal(editTable(initial, { type: 'undo' }), initial);
  let state = editTable(initial, { type: 'rename-column', id: 0, name: '取引先' });
  assert.deepEqual(cells(initial), [['名前', '金額'], ['A社', '001'], ['B社', '0']]);
  assert.equal(state.table.rows, initial.table.rows, 'header changes share immutable cell rows rather than copying transaction text');
  for (let index = 0; index < EDIT_HISTORY_LIMIT + 3; index++) state = editTable(state, { type: 'rename-column', id: 0, name: `名称${index}` });
  assert.equal(state.history.length, EDIT_HISTORY_LIMIT);
  assert.equal(state.discardedHistory, 4);
  for (let index = 0; index < EDIT_HISTORY_LIMIT; index++) state = editTable(state, { type: 'undo' });
  assert.equal(canUndo(state), false);
  assert.equal(editorView(state).headers[0], '名称2');
});

test('oversized transpose is rejected before mutation while 49 visible rows fit the 50 column boundary', () => {
  const large = createEditor(capture(['値'], Array.from({ length: 50 }, (_, index) => [String(index)])));
  assert.match(transposeProblem(large) ?? '', /50列/);
  assert.throws(() => editTable(large, { type: 'transpose' }), /50列/);
  assert.equal(large.history.length, 0);
  const smaller = editTable(large, { type: 'exclude-row', id: 49 });
  assert.equal(transposeProblem(smaller), undefined);
  assert.equal(editorView(editTable(smaller, { type: 'transpose' })).headers.length, 50);
  assert.deepEqual(cells(editTable(smaller, { type: 'undo' })), [['値'], ...Array.from({ length: 50 }, (_, index) => [String(index)])]);
});

test('invalid capture and edits reject safely, including the aggregate text budget', () => {
  assert.throws(() => createEditor(capture(['値'], [['A', 'extra']])), /行|形式/);
  assert.throws(() => createEditor(capture(['値'], [['A'.repeat(LIMITS.cellChars + 1)]])), /文字|上限/);
  const heavy = capture(['値'], Array.from({ length: 201 }, () => ['A'.repeat(LIMITS.cellChars)]));
  assert.throws(() => createEditor(heavy), /文字|上限/);
  const state = createEditor(capture());
  assert.throws(() => editTable(state, { type: 'rename-column', id: 0, name: 'A'.repeat(LIMITS.cellChars + 1) }), /文字|上限/);
  assert.throws(() => editTable(state, { type: 'move-column', id: 0, toVisibleIndex: 20 }), /位置/);
  assert.throws(() => editTable(state, { type: 'exclude-row', id: 999 }), /行/);
  assert.deepEqual(cells(state), [['名前', '金額'], ['A社', '001'], ['B社', '0']]);
});

test('hidden column slots and stable source labels survive multiple moves and restoration', () => {
  let state = createEditor(capture(['A', 'B', 'C', 'D'], [['a', 'b', 'c', 'd']]));
  state = editTable(state, { type: 'exclude-column', id: 1 });
  state = editTable(state, { type: 'move-column', id: 3, toVisibleIndex: 0 });
  assert.deepEqual(cells(state), [['D', 'A', 'C'], ['d', 'a', 'c']]);
  state = editTable(state, { type: 'restore-column', id: 1 });
  assert.deepEqual(cells(state), [['D', 'B', 'A', 'C'], ['d', 'b', 'a', 'c']]);
  assert.deepEqual(editorView(state).columnIds, [3, 1, 0, 2]);
  state = editTable(state, { type: 'transpose' });
  state = editTable(state, { type: 'exclude-row', id: editorView(state).rowIds[1] });
  state = editTable(state, { type: 'undo' });
  assert.deepEqual(cells(state), [['元の列', '元の行1'], ['D', 'd'], ['B', 'b'], ['A', 'a'], ['C', 'c']]);
});

test('default names retain existing blank, duplicate and long header behavior with source indexes', () => {
  const initial = capture(['非取得', '', '同じ', '同じ', 'あ'.repeat(120)], [['A', 'B', 'C', 'D']]); initial.sourceIndexes = [1, 2, 3, 4];
  const state = createEditor(initial);
  assert.deepEqual(editorView(state).headers, ['列2', '同じ', '同じ（2）', 'あ'.repeat(100)]);
  assert.deepEqual(editorView(state).rows, [['A', 'B', 'C', 'D']]);
});

test('header text moving into transpose data obeys the total text limit without changing the original state', () => {
  // Fifty fixed names total 141 characters; data leaves exactly that space.
  const initial = capture(Array.from({ length: 50 }, (_, index) => `列${index + 1}`), Array.from({ length: 4 }, (_, row) => Array.from({ length: 50 }, (_, column) => 'A'.repeat(row === 3 && column === 49 ? 9859 : 10000))));
  const state = createEditor(initial);
  assert.match(transposeProblem(state) ?? '', /文字数/);
  assert.throws(() => editTable(state, { type: 'transpose' }), /文字数/);
  assert.equal(state.history.length, 0);
  assert.equal(editorView(state).rows.length, 4);
  const smaller = editTable(state, { type: 'exclude-column', id: 49 });
  assert.equal(transposeProblem(smaller), undefined);
});

test('edited transpose output is independently parsed as every protected CSV cell, including empty, zero, IDs and Japanese lines', () => {
  const initial = capture(['ID', 'メモ', '値'], [['000012345678901234567', '=1+1', ''], ['0002', '改行\n日本語,"引用"', '0']]);
  let state = createEditor(initial);
  state = editTable(state, { type: 'rename-column', id: 1, name: '説明' });
  state = editTable(state, { type: 'transpose' });
  const view = editorView(state);
  const config = view.headers.map((outputName, sourceIndex) => ({ sourceIndex, outputName, kind: 'text' as const, required: false, dateFormat: 'YYYY-MM-DD' as const, dateOutput: 'YYYY-MM-DD' as const, amount: { symbol: '' as const, grouping: '' as const, decimal: '.' as const, negative: 'minus' as const } }));
  const preview = buildPreview({ ...initial, headers: view.headers, sourceIndexes: view.headers.map((_, index) => index), rows: view.rows }, config);
  assert.deepEqual(parseCsv(generateCsv(preview)), [['元の列', '元の行1', '元の行2'], ['ID', '000012345678901234567', '0002'], ['説明', '\t=1+1', '改行\n日本語,"引用"'], ['値', '', '0']]);
  assert.equal(preview.protectionCount, 1);
  assert.deepEqual(initial.rows, [['000012345678901234567', '=1+1', ''], ['0002', '改行\n日本語,"引用"', '0']]);
});
