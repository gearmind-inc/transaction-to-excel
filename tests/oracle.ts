import assert from 'node:assert/strict';
import type { Capture, Preview } from '../src/contracts.js';
import type { OraclePreview } from './fixtures/expected.js';

export function assertCapture(actual: Capture, expected: Capture): void {
  const { capturedAt, ...observed } = actual;
  const { capturedAt: _fixtureTime, ...wanted } = expected;
  assert.deepEqual(observed, wanted, 'capture values, row count, selected fields, and provenance must match');
  assert.equal(typeof capturedAt, 'string', 'capture time must exist');
  assert.match(capturedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'capture time must be ISO UTC');
  assert.ok(Number.isFinite(Date.parse(capturedAt)), 'capture time must represent a real instant');
}

export function assertPreview(actual: Preview, expected: OraclePreview): void {
  for (const key of ['headers', 'sourceCount', 'emptyCount', 'errorCount', 'protectionCount', 'scope', 'requestId'] as const) {
    assert.deepEqual(actual[key], expected[key], `preview ${key} must match`);
  }
  assert.equal(actual.rows.length, expected.rows.length, 'preview must retain every row, including identical-value separate rows');
  actual.rows.forEach((row, rowIndex) => {
    assert.equal(row.length, expected.rows[rowIndex].length, `row ${rowIndex + 1} must contain all configured columns`);
    row.forEach((cell, columnIndex) => {
      const wanted = expected.rows[rowIndex][columnIndex];
      for (const key of ['raw', 'logical', 'output', 'kind'] as const) assert.equal(cell[key], wanted[key], `row ${rowIndex + 1}, column ${columnIndex + 1}: ${key}`);
      for (const key of ['error', 'protection'] as const) {
        assert.equal(Boolean(cell[key]), Boolean(wanted[key]), `row ${rowIndex + 1}, column ${columnIndex + 1}: ${key}`);
        if (wanted[key]) assert.ok(typeof cell[key] === 'string' && cell[key]!.trim().length > 0, `${key} must explain the reason`);
      }
    });
  });
}

/** Independent strict reader: does not use any product CSV code. */
export function parseCsv(bytes: Uint8Array): string[][] {
  assert.deepEqual([...bytes.slice(0, 3)], [239, 187, 191], 'UTF-8 BOM is required');
  const csv = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(3));
  const records: string[][] = [];
  let offset = 0;
  while (offset < csv.length) {
    const record: string[] = [];
    while (true) {
      assert.equal(csv[offset++], '"', 'every field must be quoted');
      let field = '';
      let closed = false;
      while (offset < csv.length) {
        const char = csv[offset++];
        if (char !== '"') { field += char; continue; }
        if (csv[offset] === '"') { field += '"'; offset++; continue; }
        closed = true;
        break;
      }
      assert.ok(closed, 'quote must close');
      record.push(field);
      if (csv[offset] === ',') { offset++; continue; }
      assert.equal(csv.slice(offset, offset + 2), '\r\n', 'records must terminate with CRLF, including last record');
      offset += 2;
      break;
    }
    if (records.length) assert.equal(record.length, records[0].length, 'all CSV records need the same column count');
    records.push(record);
  }
  return records;
}

export function assertCsv(actual: Uint8Array, expectedLiteral: string, expected: OraclePreview): void {
  assert.deepEqual([...actual], [...new TextEncoder().encode(expectedLiteral)], 'CSV bytes must match the hand-authored UTF-8 BOM oracle');
  assert.deepEqual(parseCsv(actual), [expected.headers, ...expected.rows.map(row => row.map(cell => cell.output))], 'independent CSV readback must match confirmed preview');
}
