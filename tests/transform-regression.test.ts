import assert from 'node:assert/strict';
import test from 'node:test';
import type { AmountFormat, Capture, ColumnConfig, Preview } from '../src/contracts.js';
import { buildPreview } from '../src/transform.js';
import { generateCsv } from '../src/csv.js';
import { parseCsv } from './oracle.js';

const column: ColumnConfig = { sourceIndex: 0, outputName: '値', kind: 'text', required: false,
  dateFormat: 'YYYY-MM-DD', dateOutput: 'YYYY-MM-DD', amount: { symbol: '', grouping: '', decimal: '.', negative: 'minus' } };
function preview(value: string, changes: Partial<ColumnConfig> = {}): Preview {
  const capture: Capture = { schemaVersion: 1, requestId: 'regression', tableKey: 'id:table', headers: ['値'], sourceIndexes: [0], rows: [[value]], scope: 'current-page', capturedAt: '2026-10-01T00:00:00.000Z' };
  return buildPreview(capture, [{ ...column, ...changes }]);
}

test('transformation maps original column indexes after capture reordering without modifying input', () => {
  const capture: Capture = { schemaVersion: 1, requestId: 'regression', tableKey: 'id:table', headers: ['A', 'B', 'C'], sourceIndexes: [2, 0], rows: [['Cの値', 'Aの値'], ['Cの値', 'Aの値']], scope: 'current-page', capturedAt: '2026-10-01T00:00:00.000Z' };
  const columns = [{ ...column, sourceIndex: 0, outputName: '先頭' }, { ...column, sourceIndex: 2, outputName: '最後' }];
  const before = structuredClone({ capture, columns });
  const actual = buildPreview(capture, columns);
  assert.deepEqual(actual.rows.map(row => row.map(cell => cell.output)), [['Aの値', 'Cの値'], ['Aの値', 'Cの値']]);
  assert.deepEqual({ capture, columns }, before);
  assert.equal(actual.sourceCount, 2);
});

test('every declared amount symbol, separator pair and negative convention is explicit', () => {
  const numericForms = [
    { grouping: '', decimal: '.', body: '1234.50' },
    { grouping: '', decimal: ',', body: '1234,50' },
    { grouping: ',', decimal: '.', body: '1,234.50' },
    { grouping: '.', decimal: ',', body: '1.234,50' },
  ] as const;
  for (const symbol of ['', '¥', '円', '$', '€'] as const) {
    for (const numeric of numericForms) {
      for (const negative of ['minus', 'parentheses'] as const) {
        const amount: AmountFormat = { symbol, grouping: numeric.grouping, decimal: numeric.decimal, negative };
        const positive = symbol === '円' ? numeric.body + symbol : symbol + numeric.body;
        const signed = negative === 'minus' ? '-' + positive : '(' + positive + ')';
        for (const [raw, expected] of [[positive, '1234.50'], [signed, '-1234.50']]) {
          const actual = preview(raw, { kind: 'amount', amount });
          assert.equal(actual.errorCount, 0, JSON.stringify({ raw, amount }));
          assert.equal(actual.rows[0][0].output, expected);
          assert.equal(actual.protectionCount, 0);
        }
      }
    }
  }
});

test('decimal grammar refuses partial digits, repeated signs and mixed explicit currencies', () => {
  for (const raw of ['.50', '50.', '--50', '+50', '(50)', '1 000', '1,000', '1e3', '10円', '¥10']) {
    const actual = preview(raw, { kind: 'amount' });
    assert.equal(actual.errorCount, 1, raw);
    assert.equal(actual.rows[0][0].raw, raw);
    assert.throws(() => generateCsv(actual));
  }
  assert.equal(preview('-0.00', { kind: 'amount' }).rows[0][0].output, '-0.00');
});

test('Gregorian century boundaries and Japanese single-digit dates do not use local time', () => {
  assert.equal(preview('0400-02-29', { kind: 'date' }).rows[0][0].output, '0400-02-29');
  assert.equal(preview('0100-02-29', { kind: 'date' }).errorCount, 1);
  assert.equal(preview('2026年1月2日', { kind: 'date', dateFormat: 'YYYY年M月D日', dateOutput: 'YYYY/MM/DD' }).rows[0][0].output, '2026/01/02');
  assert.equal(preview('2026-04-31', { kind: 'date' }).errorCount, 1);
});

test('invisible Unicode prefixes and existing tabs preserve originals and add one protective tab', () => {
  for (const raw of ['\u3000＝1', '\u200b=1', '\u2060@name', '\t=1']) {
    const actual = preview(raw);
    assert.equal(actual.rows[0][0].raw, raw);
    assert.equal(actual.rows[0][0].logical, raw);
    assert.equal(actual.rows[0][0].output, '\t' + raw);
    assert.deepEqual(parseCsv(generateCsv(actual))[1], ['\t' + raw]);
  }
});

test('valid emoji encode exactly, while broken Unicode and C1 controls remain visible errors', () => {
  const actual = preview('日本語😀\r\n次の行');
  assert.equal(actual.errorCount, 0);
  assert.deepEqual(parseCsv(generateCsv(actual)), [['値'], ['日本語😀\r\n次の行']]);
  for (const raw of ['\ud800', '\udc00', 'x\u0085y']) {
    const broken = preview(raw);
    assert.equal(broken.errorCount, 1);
    assert.equal(broken.rows[0][0].raw, raw);
    assert.throws(() => generateCsv(broken));
  }
});

test('CSV rejects forged diagnostics, unprotected formulas, inconsistent counts and uneven rows', () => {
  const error = preview('not-a-date', { kind: 'date' });
  error.errorCount = 0;
  assert.throws(() => generateCsv(error));
  const formula = preview('=1+2');
  formula.rows[0][0].output = '=1+2';
  assert.throws(() => generateCsv(formula));
  const fakeAmount = preview('=1+2');
  fakeAmount.rows[0][0].kind = 'amount';
  fakeAmount.rows[0][0].output = '=1+2';
  delete fakeAmount.rows[0][0].protection;
  fakeAmount.protectionCount = 0;
  assert.throws(() => generateCsv(fakeAmount));
  const incorrectCount = preview('ordinary');
  incorrectCount.sourceCount = 2;
  assert.throws(() => generateCsv(incorrectCount));
  const uneven = preview('ordinary');
  uneven.rows[0].push({ raw: '', logical: '', output: '', kind: 'text' });
  assert.throws(() => generateCsv(uneven));
});

test('zero rows retain the protected header and do not fabricate an empty transaction', () => {
  const capture: Capture = { schemaVersion: 1, requestId: 'regression', tableKey: 'id:table', headers: ['値'], sourceIndexes: [0], rows: [], scope: 'current-page', capturedAt: '2026-10-01T00:00:00.000Z' };
  const actual = buildPreview(capture, [{ ...column, outputName: '@見出し' }]);
  assert.equal(actual.sourceCount, 0);
  assert.equal(actual.protectionCount, 1);
  assert.deepEqual(parseCsv(generateCsv(actual)), [['\t@見出し']]);
});
