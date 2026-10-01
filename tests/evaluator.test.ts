import assert from 'node:assert/strict';
import test from 'node:test';
import type { Preview } from '../src/contracts.js';
import { EXPECTED_CAPTURE, EXPECTED_CSV, EXPECTED_PREVIEW } from './fixtures/expected.js';
import { assertCapture, assertCsv, assertPreview, parseCsv } from './oracle.js';

// Health fixtures substitute explanatory messages without using product logic.
const healthyPreview = (): Preview => ({ ...structuredClone(EXPECTED_PREVIEW), rows: EXPECTED_PREVIEW.rows.map(row => row.map(cell => ({
  ...cell, ...(cell.error ? { error: 'fixture diagnostic' } : {}), ...(cell.protection ? { protection: 'fixture formula protection' } : {}),
}))) } as Preview);

test('oracle health: hand-authored correct capture, preview, and CSV pass', () => {
  assertCapture(structuredClone(EXPECTED_CAPTURE), EXPECTED_CAPTURE);
  assertPreview(healthyPreview(), EXPECTED_PREVIEW);
  assertCsv(new TextEncoder().encode(EXPECTED_CSV), EXPECTED_CSV, EXPECTED_PREVIEW);
});

test('oracle health: changing a date is rejected', () => {
  const actual = healthyPreview(); actual.rows[0][0].logical = '2026-01-10';
  assert.throws(() => assertPreview(actual, EXPECTED_PREVIEW), /logical/);
});
test('oracle health: changing a monetary digit is rejected', () => {
  const actual = healthyPreview(); actual.rows[0][2].output = '1234.51';
  assert.throws(() => assertPreview(actual, EXPECTED_PREVIEW), /output/);
});
test('oracle health: dropping one same-value transaction is rejected', () => {
  const actual = structuredClone(EXPECTED_CAPTURE); actual.rows.splice(6, 1);
  assert.throws(() => assertCapture(actual, EXPECTED_CAPTURE), /row count/);
});
test('oracle health: wrong source identity is rejected', () => {
  const actual = structuredClone(EXPECTED_CAPTURE); actual.tableKey = 'id:unselected';
  assert.throws(() => assertCapture(actual, EXPECTED_CAPTURE), /provenance/);
});
test('oracle health: wrong reported count and omitted selected field are rejected', () => {
  const preview = healthyPreview(); preview.sourceCount = 7;
  assert.throws(() => assertPreview(preview, EXPECTED_PREVIEW), /sourceCount/);
  const capture = structuredClone(EXPECTED_CAPTURE); capture.rows[0].pop();
  assert.throws(() => assertCapture(capture, EXPECTED_CAPTURE), /selected fields/);
});
test('oracle health: missing values and zero-vs-blank errors are rejected', () => {
  const actual = healthyPreview(); actual.rows[2][2].output = '';
  assert.throws(() => assertPreview(actual, EXPECTED_PREVIEW), /output/);
});
test('independent CSV reader rejects missing BOM, unquoted fields, and wrong record separators', () => {
  assert.throws(() => parseCsv(new TextEncoder().encode('"x"\r\n')), /BOM/);
  assert.throws(() => parseCsv(new TextEncoder().encode('\uFEFFx\r\n')), /quoted/);
  assert.throws(() => parseCsv(new TextEncoder().encode('\uFEFF"x"\n')), /CRLF/);
});
