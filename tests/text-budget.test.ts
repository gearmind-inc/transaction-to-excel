import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { LIMITS, type Capture, type ColumnConfig, type InspectRequest, type Preview } from '../src/contracts';
import { inspectPage } from '../src/extraction';
import { acceptInspection } from '../src/inspection';
import { createEditor, editTable, editorView, transposeProblem } from '../src/table-editor';
import { buildPreview } from '../src/transform';
import { generateCsv } from '../src/csv';
import { parseCsv } from './oracle';

// Hand-authored boundary: 199 * 10,000 + 9,999 data characters + H = 2,000,000.
const rowsAtLimit = () => [...Array.from({ length: 199 }, () => ['x'.repeat(10_000)]), ['x'.repeat(9_999)]];
const rowsOverLimit = () => Array.from({ length: 200 }, () => ['x'.repeat(10_000)]);
const capture = (headers = ['H'], rows = rowsAtLimit()): Capture => ({ schemaVersion: 1, requestId: 'budget-oracle', tableKey: 'id:budget', headers, sourceIndexes: headers.map((_, index) => index), rows, scope: 'current-page', capturedAt: '2026-10-01T00:00:00.000Z' });
const config = (outputName = 'H', sourceIndex = 0): ColumnConfig => ({ sourceIndex, outputName, kind: 'text', required: false, dateFormat: 'YYYY-MM-DD', dateOutput: 'YYYY-MM-DD', amount: { symbol: '', grouping: '', decimal: '.', negative: 'minus' } });
const budgetProblem = /文字数|文字|上限|不整合/;

function withPage(rows: string[][], action: () => void): void {
  const dom = new JSDOM('<table id="budget"><thead><tr><th>H</th></tr></thead><tbody>' + rows.map(row => `<tr><td>${row[0]}</td></tr>`).join('') + '</tbody></table>', { url: 'https://fixture.example/budget' });
  const keys = ['window', 'document', 'location', 'Node', 'HTMLElement', 'HTMLTableElement', 'getComputedStyle'] as const;
  const descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
  try { action(); } finally {
    for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    dom.window.close();
  }
}
const request = (mode: InspectRequest['mode'], content = false): InspectRequest => ({ mode, requestId: 'budget-oracle', expectedUrl: 'https://fixture.example/budget', tableIndex: 0, tableKey: content ? 'content:id:budget' : 'id:budget', headers: ['H'], sourceIndexes: [0], limits: LIMITS, ...(content ? { kind: 'content' as const } : {}) });

test('ordinary and content capture use the same header-inclusive exact limit and refuse one character more', () => {
  withPage(rowsAtLimit(), () => {
    const ordinary = inspectPage(request('capture'));
    assert.equal(ordinary.error, undefined);
    assert.deepEqual(ordinary.capture?.headers, ['H']);
    assert.deepEqual(ordinary.capture?.rows, rowsAtLimit());
    const described = inspectPage(request('describe', true));
    assert.equal(described.error, undefined);
    const content = inspectPage({ ...request('capture', true), contentSignature: described.tables![0].contentSignature });
    assert.equal(content.error, undefined);
    assert.deepEqual(content.capture?.rows, rowsAtLimit());
  });
  withPage(rowsOverLimit(), () => {
    assert.match(inspectPage(request('capture')).error ?? '', budgetProblem);
    assert.match(inspectPage(request('describe', true)).error ?? '', budgetProblem);
  });
});

test('inspection boundary counts every header including unselected columns', () => {
  const at = capture();
  const over = capture(['H', 'UNSELECTED']); over.sourceIndexes = [0];
  const envelope = (value: Capture) => [{ frameId: 0, documentId: 'budget-doc', result: { schemaVersion: 1 as const, requestId: value.requestId, url: request('capture').expectedUrl, capture: value } }];
  assert.equal(acceptInspection(envelope(at), request('capture')).data.capture, at);
  assert.throws(() => acceptInspection(envelope(over), { ...request('capture'), headers: over.headers }), budgetProblem);
});

test('editor raw capture boundary counts every header including unselected columns', () => {
  const over = capture(['H', 'UNSELECTED']); over.sourceIndexes = [0];
  assert.throws(() => createEditor(over), budgetProblem);
  assert.throws(() => createEditor(capture(['H'], rowsOverLimit())), budgetProblem);
});

test('preview raw capture boundary counts every header including unselected columns', () => {
  const over = capture(['H', 'UNSELECTED']); over.sourceIndexes = [0];
  assert.throws(() => buildPreview(over, [config()]), budgetProblem);
  assert.throws(() => buildPreview(capture(['H'], rowsOverLimit()), [config()]), budgetProblem);
});

test('renaming counts visible names and values before changing editor state or history', () => {
  const initial = createEditor(capture());
  assert.throws(() => editTable(initial, { type: 'rename-column', id: 0, name: 'HH' }), budgetProblem);
  assert.equal(initial.history.length, 0);
  assert.deepEqual(editorView(initial).headers, ['H']);
});

test('row restoration counts the edited name and preserves excluded rows when over budget', () => {
  const initial = createEditor(capture());
  const hidden = editTable(initial, { type: 'exclude-row', id: 199 });
  const renamed = editTable(hidden, { type: 'rename-column', id: 0, name: 'HH' });
  const before = editorView(renamed);
  assert.throws(() => editTable(renamed, { type: 'restore-row', id: 199 }), budgetProblem);
  assert.deepEqual(editorView(renamed), before);
  assert.equal(renamed.history.length, 2);
});

test('column restoration counts the edited name and preserves the hidden column when over budget', () => {
  // 100 two-cell rows: 1,999,998 data characters + two one-character headers.
  const rows = Array.from({ length: 100 }, (_, index) => ['x'.repeat(10_000), 'y'.repeat(index === 99 ? 9_998 : 10_000)]);
  let state = createEditor(capture(['A', 'B'], rows));
  state = editTable(state, { type: 'exclude-column', id: 1 });
  state = editTable(state, { type: 'rename-column', id: 0, name: 'AA' });
  assert.throws(() => editTable(state, { type: 'restore-column', id: 1 }), budgetProblem);
  assert.deepEqual(editorView(state).headers, ['AA']);
  assert.equal(state.history.length, 2);
});

test('transpose counts its generated header row before altering the current table', () => {
  // 200 cells minus 150 characters + fifty three-character names = exact limit.
  const headers = Array.from({ length: 50 }, (_, index) => `C${String(index + 1).padStart(2, '0')}`);
  const rows = Array.from({ length: 4 }, (_, row) => Array.from({ length: 50 }, (_, column) => 'x'.repeat(row === 3 && column === 49 ? 9_850 : 10_000)));
  const state = createEditor(capture(headers, rows));
  assert.match(transposeProblem(state) ?? '', budgetProblem);
  assert.throws(() => editTable(state, { type: 'transpose' }), budgetProblem);
  assert.equal(state.history.length, 0);
  assert.deepEqual(editorView(state).headers, headers);
  assert.deepEqual(editorView(state).rows, rows);
});

test('preview output counts renamed headers independently from raw capture headers', () => {
  assert.throws(() => buildPreview(capture(), [config('HH')]), budgetProblem);
  const preview = buildPreview(capture(), [config()]);
  assert.equal(preview.rows.length, 200);
  assert.deepEqual(parseCsv(generateCsv(preview)), [['H'], ...rowsAtLimit()]);
});

function protectedPreview(lastLength: number): Preview {
  const rawRows = [...Array.from({ length: 199 }, () => '=' + 'x'.repeat(9_999)), '=' + 'x'.repeat(lastLength - 1)];
  return { headers: ['\t\t=H'], rows: rawRows.map(raw => [{ raw, logical: raw, output: '\t' + raw, kind: 'text', protection: 'formula-oracle' }]), sourceCount: 200, emptyCount: 0, errorCount: 0, protectionCount: 201, scope: 'current-page', requestId: 'budget-oracle' };
}

test('CSV counts the original header tab and raw cells but excludes exactly one added protection tab', () => {
  // Logical header is the three-character original '\t=H'.
  const at = protectedPreview(9_997);
  const parsed = parseCsv(generateCsv(at));
  assert.deepEqual(parsed[0], ['\t\t=H']);
  assert.equal(parsed[1][0], '\t=' + 'x'.repeat(9_999));
  assert.equal(parsed[200][0], '\t=' + 'x'.repeat(9_996));
  assert.throws(() => generateCsv(protectedPreview(9_998)), budgetProblem);
});
