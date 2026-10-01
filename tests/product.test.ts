import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { LIMITS, type Capture, type ColumnConfig, type InspectRequest, type InspectResult, type Preview } from '../src/contracts.js';
import { COLUMNS, EXPECTED_CAPTURE, EXPECTED_CSV, EXPECTED_PREVIEW, FIXTURE_URL, HEADERS, REQUEST_ID } from './fixtures/expected.js';
import { assertCapture, assertCsv, assertPreview } from './oracle.js';

const emptyCapture: Capture = { schemaVersion: 1, requestId: REQUEST_ID, tableKey: '', headers: [], sourceIndexes: [], rows: [], scope: 'current-page', capturedAt: '2026-10-01T00:00:00.000Z' };
const emptyPreview: Preview = { headers: [], rows: [], sourceCount: 0, emptyCount: 0, errorCount: 0, protectionCount: 0, scope: 'current-page', requestId: REQUEST_ID };
// Only absent modules get a valid empty-result adapter. Syntax/import/runtime failures remain errors,
// and are never counted as the deliberately demonstrated semantic RED.
const extractionPath = new URL('../src/extraction.ts', import.meta.url);
const transformPath = new URL('../src/transform.ts', import.meta.url);
const csvPath = new URL('../src/csv.ts', import.meta.url);
const inspectPage: (request: InspectRequest) => InspectResult = existsSync(extractionPath)
  ? (await import(extractionPath.href)).inspectPage : request => ({ schemaVersion: 1, requestId: request.requestId, url: FIXTURE_URL, tables: [], capture: emptyCapture });
const buildPreview: (capture: Capture, columns: ColumnConfig[]) => Preview = existsSync(transformPath)
  ? (await import(transformPath.href)).buildPreview : () => emptyPreview;
const generateCsv: (preview: Preview) => Uint8Array = existsSync(csvPath)
  ? (await import(csvPath.href)).generateCsv : () => new Uint8Array();

function withPage<T>(html: string, action: () => T): T {
  const dom = new JSDOM(html, { url: FIXTURE_URL });
  const keys = ['window', 'document', 'location', 'Node', 'HTMLElement', 'HTMLTableElement', 'getComputedStyle'] as const;
  const descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
  try { return action(); } finally {
    for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    dom.window.close();
  }
}
const fixture = readFileSync(new URL('./fixtures/transactions.html', import.meta.url), 'utf8');
const request = (mode: InspectRequest['mode']): InspectRequest => ({ mode, expectedUrl: FIXTURE_URL, requestId: REQUEST_ID, tableIndex: 1, tableKey: 'id:transactions', headers: HEADERS, sourceIndexes: [0, 1, 2, 3, 4], limits: LIMITS });

test('MVP capture: selected table and fields exactly match the independent fixture', () => withPage(fixture, () => {
  const actual = inspectPage(request('capture'));
  assert.equal(actual.error, undefined);
  assertCapture(actual.capture ?? emptyCapture, EXPECTED_CAPTURE);
}));
test('MVP selection: two table candidates expose headers/counts without transaction values', () => withPage(fixture, () => {
  const actual = inspectPage(request('list'));
  assert.equal(actual.error, undefined);
  assert.equal(actual.tables?.length, 2, 'two normal tables must be independently selectable');
  assert.deepEqual(actual.tables?.[1], { index: 1, key: 'id:transactions', headers: HEADERS, rowCount: 8 });
  assert.ok(!JSON.stringify(actual).includes('do-not-capture-password'));
  assert.ok(!JSON.stringify(actual).includes('12345678901234567890'), 'candidate scan must not read transaction values');
}));
test('MVP preview: chosen order/name, explicit transformations, empty/zero, all rows, and protections', () => {
  assertPreview(buildPreview(structuredClone(EXPECTED_CAPTURE), structuredClone(COLUMNS)), EXPECTED_PREVIEW);
});
test('MVP CSV: exact BOM/quoted Unicode bytes and independent readback match preview', () => {
  // CSV is evaluated with independent correct preview input, not with transform output.
  const preview = { ...structuredClone(EXPECTED_PREVIEW), rows: EXPECTED_PREVIEW.rows.map(row => row.map(cell => ({
    ...cell, ...(cell.protection ? { protection: 'expected formula protection' } : {}),
  }))) } as Preview;
  assertCsv(generateCsv(preview), EXPECTED_CSV, EXPECTED_PREVIEW);
});

const simplePage = (body: string, heading = '<tr><th>A</th><th>B</th></tr>', attrs = '') => `<!doctype html><html><body><table id="transactions" ${attrs}>${heading}${body}</table></body></html>`;
const simpleRequest = (overrides: Partial<InspectRequest> = {}): InspectRequest => ({ mode: 'capture', expectedUrl: FIXTURE_URL, requestId: REQUEST_ID, tableIndex: 0, tableKey: 'id:transactions', headers: ['A', 'B'], sourceIndexes: [0, 1], limits: LIMITS, ...overrides });
function rejectsCapture(html: string, overrides: Partial<InspectRequest> = {}): void {
  withPage(html, () => {
    const result = inspectPage(simpleRequest(overrides));
    assert.ok(typeof result.error === 'string' && result.error.trim().length > 0, 'unsupported or changed input must explain why capture stopped');
    assert.equal(result.capture, undefined, 'failure must not expose partial capture');
  });
}

test('capture stops on changed URL, changed header, wrong table identity/index, and bad column selection', () => {
  const html = simplePage('<tr><td>x</td><td>y</td></tr>');
  rejectsCapture(html, { expectedUrl: 'https://fixture.example/login' });
  rejectsCapture(html, { headers: ['changed', 'B'] });
  rejectsCapture(html, { tableKey: 'id:other' });
  rejectsCapture(html, { tableIndex: 1 });
  rejectsCapture(html, { sourceIndexes: [0, 0] });
  rejectsCapture(html, { sourceIndexes: [2] });
  rejectsCapture(html, { sourceIndexes: [] });
});
test('capture refuses rowspan/colspan, nested tables, form controls, uneven cells and hidden tables', () => {
  rejectsCapture(simplePage('<tr><td rowspan="2">x</td><td>y</td></tr><tr><td>z</td></tr>'));
  rejectsCapture(simplePage('<tr><td colspan="2">x</td></tr>'));
  rejectsCapture(simplePage('<tr><td><table><tr><td>nested</td></tr></table></td><td>y</td></tr>'));
  rejectsCapture(simplePage('<tr><td><input value="secret"></td><td>y</td></tr>'));
  rejectsCapture(simplePage('<tr><td>x</td></tr>'));
  rejectsCapture(simplePage('<tr><td>x</td><td>y</td></tr>', undefined, 'hidden'));
  rejectsCapture(simplePage('<tr><td>x</td><td>y</td></tr>', undefined, 'style="display:none"'));
  rejectsCapture('<div style="visibility:hidden">' + simplePage('<tr><td>x</td><td>y</td></tr>') + '</div>');
});
test('span=1 cells remain selectable ordinary cells and preserve selected original values', () => withPage(simplePage(
  '<tr><td rowspan="1" colspan="1"> \t日本語"引用"<br>二行目</td><td rowspan="1" colspan="1">00001</td></tr>',
  '<tr><th rowspan="1" colspan="1">A</th><th rowspan="1" colspan="1">B</th></tr>',
), () => {
  const listed = inspectPage(simpleRequest({ mode: 'list' }));
  assert.equal(listed.error, undefined);
  assert.deepEqual(listed.tables, [{ index: 0, key: 'id:transactions', headers: ['A', 'B'], rowCount: 1 }]);
  assert.ok(!JSON.stringify(listed).includes('日本語'), 'candidate discovery must not read data values');
  const captured = inspectPage(simpleRequest({ sourceIndexes: [1, 0] }));
  assert.equal(captured.error, undefined);
  assert.deepEqual(captured.capture?.rows, [['00001', ' \t日本語"引用"\n二行目']]);
}));
test('rowspan=0 spans the remaining rows and is still rejected even when physical cell counts match', () => withPage(simplePage(
  '<tr><td rowspan="0">x</td><td>y</td></tr><tr><td>z</td><td>w</td></tr>',
), () => {
  const listed = inspectPage(simpleRequest({ mode: 'list' }));
  assert.match(listed.tables?.[0].error ?? '', /結合セル/);
  const captured = inspectPage(simpleRequest());
  assert.match(captured.error ?? '', /結合セル/);
  assert.equal(captured.capture, undefined, 'a true merged cell must not expose partial capture');
}));
test('empty table is a successful zero-row capture, not a read failure', () => withPage(simplePage(''), () => {
  const result = inspectPage(simpleRequest());
  assert.equal(result.error, undefined);
  assert.deepEqual(result.capture?.rows, []);
  assert.deepEqual(result.capture?.headers, ['A', 'B']);
}));
test('capture retains whitespace and reads only chosen text nodes, never attributes or link targets', () => withPage(simplePage('<tr><td> \t原文 <a href="https://secret.example/token" title="do-not-capture-title">リンク</a>\n</td><td>excluded-secret</td></tr>'), () => {
  const result = inspectPage(simpleRequest({ sourceIndexes: [0] }));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.capture?.rows, [[' \t原文 リンク\n']]);
  assert.ok(!JSON.stringify(result.capture).includes('excluded-secret'));
  assert.ok(!JSON.stringify(result.capture).includes('secret.example'));
  assert.ok(!JSON.stringify(result.capture).includes('do-not-capture-title'));
}));
test('capture does not truncate data beyond row/column/cell/total-text safety limits', () => {
  rejectsCapture(simplePage('<tr><td>x</td><td>y</td></tr>'.repeat(5001)));
  const headers = Array.from({ length: 51 }, (_, index) => `H${index}`);
  rejectsCapture(simplePage('<tr>' + '<td>x</td>'.repeat(51) + '</tr>', '<tr>' + headers.map(value => `<th>${value}</th>`).join('') + '</tr>'), { headers, sourceIndexes: [0] });
  rejectsCapture(simplePage(`<tr><td>${'x'.repeat(10001)}</td><td>y</td></tr>`));
  rejectsCapture(simplePage(`<tr><td>${'x'.repeat(401)}</td><td></td></tr>`.repeat(5000)), { sourceIndexes: [0] });
});

function oneCell(raw: string, overrides: Partial<ColumnConfig> = {}): Preview {
  const capture: Capture = { ...structuredClone(EXPECTED_CAPTURE), headers: ['value'], sourceIndexes: [0], rows: [[raw]] };
  return buildPreview(capture, [{ ...structuredClone(COLUMNS[0]), sourceIndex: 0, outputName: 'value', ...overrides }]);
}
function assertValue(raw: string, wanted: string, overrides: Partial<ColumnConfig>): void {
  const preview = oneCell(raw, overrides);
  assert.equal(preview.errorCount, 0, `explicit input should be accepted: ${raw}`);
  assert.equal(preview.rows[0][0].raw, raw);
  assert.equal(preview.rows[0][0].logical, wanted);
  assert.equal(preview.rows[0][0].output, wanted);
}
function assertRejectedValue(raw: string, overrides: Partial<ColumnConfig>): void {
  const preview = oneCell(raw, overrides);
  assert.equal(preview.errorCount, 1, `ambiguous/invalid input must not be guessed: ${JSON.stringify(raw)}`);
  assert.equal(preview.rows[0][0].raw, raw);
  assert.ok(preview.rows[0][0].error?.trim(), 'original value must have an explanatory error');
  assert.throws(() => generateCsv(preview), 'CSV generation must not export unresolved errors');
}

test('explicit date formats, leap years and year 1–9999 produce exact selected output', () => {
  assertValue('2026-10-01', '2026/10/01', { dateFormat: 'YYYY-MM-DD', dateOutput: 'YYYY/MM/DD' });
  assertValue('2026年10月1日', '2026-10-01', { dateFormat: 'YYYY年M月D日' });
  assertValue('10/01/2026', '2026-10-01', { dateFormat: 'MM/DD/YYYY' });
  assertValue('10/01/2026', '2026-01-10', { dateFormat: 'DD/MM/YYYY' });
  assertValue('0001/01/01', '0001-01-01', {});
  assertValue('9999/12/31', '9999-12-31', {});
  assertValue('2000/02/29', '2000-02-29', {});
});
test('ambiguous/missing date parts, impossible dates, whitespace and timestamps retain raw errors', () => {
  for (const value of ['2026/02/30', '1900/02/29', '0000/01/01', '10000/01/01', '10/01', '2026/1/1', '2026-10-01', ' 2026/10/01', '2026/10/01 ', '2026/10/01T12:00:00Z', '令和8年10月1日']) assertRejectedValue(value, {});
});
test('explicit amounts preserve negative sign, long decimal digits, trailing zeros, blank and zero', () => {
  const amount: ColumnConfig['amount'] = { symbol: '', grouping: ',', decimal: '.', negative: 'minus' };
  assertValue('9,007,199,254,740,993.123400', '9007199254740993.123400', { kind: 'amount', amount });
  assertValue('-00001.20', '-1.20', { kind: 'amount', amount: { ...amount, grouping: '' } });
  assertValue('0', '0', { kind: 'amount', amount });
  assertValue('', '', { kind: 'amount', required: false, amount });
  assertValue('(€1.234,50)', '-1234.50', { kind: 'amount', amount: { symbol: '€', grouping: '.', decimal: ',', negative: 'parentheses' } });
  assertValue('50,000円', '50000', { kind: 'amount', amount: { symbol: '円', grouping: ',', decimal: '.', negative: 'minus' } });
  assertValue('$10.20', '10.20', { kind: 'amount', amount: { symbol: '$', grouping: '', decimal: '.', negative: 'minus' } });
});
test('amount parser rejects wrong grouping/symbol, expression, fullwidth digits and guessed negatives', () => {
  const amount: ColumnConfig['amount'] = { symbol: '¥', grouping: ',', decimal: '.', negative: 'minus' };
  for (const value of ['¥12,34', '¥1,23,456', '¥１２３', '—', '¥-1+2', '¥100-', '(¥100)', '¥ 100', '¥100 ', '¥1.2.3', '100', '$100', '']) assertRejectedValue(value, { kind: 'amount', amount });
  assertRejectedValue('¥1,000', { kind: 'amount', amount: { ...amount, decimal: ',' } });
});
test('literal-safe protects formula-looking text (ASCII/fullwidth/whitespace), but not typed negative money', () => {
  for (const value of ['=1+2', '+81-90', '-330', '@name', '＝1+2', '＋1', '－1', '＠name', ' \t\r\n=1+2']) {
    const preview = oneCell(value, { kind: 'text' });
    assert.equal(preview.errorCount, 0);
    assert.equal(preview.rows[0][0].logical, value);
    assert.equal(preview.rows[0][0].output, '\t' + value);
    assert.ok(preview.rows[0][0].protection?.trim());
    assert.equal(preview.protectionCount, 1);
  }
  const money = oneCell('-¥330', { kind: 'amount' });
  assert.equal(money.rows[0][0].output, '-330');
  assert.equal(money.protectionCount, 0);
});
test('NUL and prohibited control characters are diagnosed rather than silently removed', () => {
  for (const value of ['a\0b', 'a\u0001b', 'a\u0008b', 'a\u007fb']) assertRejectedValue(value, { kind: 'text' });
});
test('text IDs keep exact digits and expose Excel auto-conversion warnings', () => {
  for (const value of ['0000123', '12345678901234567890', '1E10', '2026-10-01']) {
    const preview = oneCell(value, { kind: 'text' });
    assert.equal(preview.rows[0][0].output, value);
    assert.equal(preview.rows[0][0].logical, value);
    assert.ok(preview.rows[0][0].warning?.trim(), 'Excel type import warning must be visible');
  }
});
test('required blank is an error, optional blank remains blank, and text zero is not empty', () => {
  assertRejectedValue('', { kind: 'text', required: true });
  assertValue('', '', { kind: 'text', required: false });
  const zero = oneCell('0', { kind: 'text', required: true });
  assert.equal(zero.emptyCount, 0);
  assert.equal(zero.errorCount, 0);
  assert.equal(zero.rows[0][0].output, '0');
});
test('CSV headers receive formula protection and prohibited controls block generation', () => {
  const protectedHeader = oneCell('ordinary', { kind: 'text', outputName: '=header' });
  assert.deepEqual(protectedHeader.headers, ['\t=header']);
  assert.equal(protectedHeader.protectionCount, 1);
  const badHeader = oneCell('ordinary', { kind: 'text', outputName: 'bad\0header' });
  assert.ok(badHeader.errorCount > 0);
  assert.throws(() => generateCsv(badHeader));
});
