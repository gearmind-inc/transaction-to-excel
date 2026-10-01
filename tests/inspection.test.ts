import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptInspection } from '../src/inspection';
import { LIMITS, type InspectRequest, type InspectResult } from '../src/contracts';
import { EXPECTED_CAPTURE, FIXTURE_URL, HEADERS, REQUEST_ID } from './fixtures/expected';

const request: InspectRequest = { mode: 'capture', expectedUrl: FIXTURE_URL, requestId: REQUEST_ID, tableIndex: 1, tableKey: 'id:transactions', headers: HEADERS, sourceIndexes: [0, 1, 2, 3, 4], limits: LIMITS };
const data: InspectResult = { schemaVersion: 1, requestId: REQUEST_ID, url: FIXTURE_URL, capture: EXPECTED_CAPTURE };
const result = () => [{ frameId: 0, documentId: 'doc-1', result: structuredClone(data) }];

test('content descriptions validate kind, signature, warnings and exact selected identity', () => {
  const describe: InspectRequest = { mode: 'describe', kind: 'content', expectedUrl: FIXTURE_URL, requestId: REQUEST_ID, tableKey: 'content:id:article', limits: LIMITS };
  const candidate = { index: 0, key: describe.tableKey!, kind: 'content' as const, headers: ['タイトル', '内容'], rowCount: 2, contentSignature: 'heading-fingerprint', warnings: ['図形のデータは含みません。'] };
  const envelope = () => [{ frameId: 0, documentId: 'doc-1', result: { schemaVersion: 1 as const, requestId: REQUEST_ID, url: FIXTURE_URL, tables: [structuredClone(candidate)] } }];
  assert.equal(acceptInspection(envelope(), describe, 'doc-1').data.tables?.[0].key, candidate.key);
  for (const mutate of [
    (value: Record<string, unknown>) => { value.kind = 'table'; },
    (value: Record<string, unknown>) => { value.key = 'content:id:another'; },
    (value: Record<string, unknown>) => { value.contentSignature = ''; },
    (value: Record<string, unknown>) => { value.contentSignature = 'x'.repeat(129); },
    (value: Record<string, unknown>) => { value.warnings = [123]; },
    (value: Record<string, unknown>) => { value.rowCount = 5001; },
  ]) {
    const values = envelope(); mutate(values[0].result.tables[0]);
    assert.throws(() => acceptInspection(values, describe, 'doc-1'), 'malformed or foreign region descriptions must be refused');
  }
  const empty = envelope(); empty[0].result.tables = [];
  assert.throws(() => acceptInspection(empty, describe, 'doc-1'));
});

test('content capture must retain the selected heading signature and bounded exclusions', () => {
  const contentRequest: InspectRequest = { ...request, kind: 'content', tableKey: 'content:id:article', headers: ['タイトル', '内容'], sourceIndexes: [0, 1], contentSignature: 'heading-fingerprint' };
  const envelope = () => [{ frameId: 0, documentId: 'doc-1', result: { schemaVersion: 1 as const, requestId: REQUEST_ID, url: FIXTURE_URL, capture: { ...structuredClone(EXPECTED_CAPTURE), tableKey: contentRequest.tableKey!, headers: ['タイトル', '内容'], sourceIndexes: [0, 1], rows: [['章', '本文']], contentSignature: 'heading-fingerprint', warnings: ['図形のデータは含みません。'] } } }];
  assert.equal(acceptInspection(envelope(), contentRequest, 'doc-1').data.capture?.rows[0][1], '本文');
  const wrong = envelope(); wrong[0].result.capture.contentSignature = 'another';
  assert.throws(() => acceptInspection(wrong, contentRequest, 'doc-1'));
  const invalid = envelope(); invalid[0].result.capture.warnings = Array(51).fill('unexpected');
  assert.throws(() => acceptInspection(invalid, contentRequest, 'doc-1'));
});
test('only the requested browser document and exact capture schema cross the boundary', () => {
  assert.equal(acceptInspection(result(), request, 'doc-1').data.capture?.rows.length, 8);
  assert.throws(() => acceptInspection([], request));
  assert.throws(() => acceptInspection([...result(), ...result()], request));
  assert.throws(() => acceptInspection(result(), request, 'doc-other'));
  assert.throws(() => acceptInspection([{ ...result()[0], frameId: 2 }], request));
  assert.throws(() => acceptInspection([{ ...result()[0], documentId: '' }], request));
});
test('foreign request/URL/source/headers/column scope cannot be accepted as the current capture', () => {
  for (const mutate of [
    (value: InspectResult) => { value.requestId = 'another'; },
    (value: InspectResult) => { value.url = 'https://other.example/'; },
    (value: InspectResult) => { value.capture!.tableKey = 'id:other'; },
    (value: InspectResult) => { value.capture!.headers.reverse(); },
    (value: InspectResult) => { value.capture!.sourceIndexes = [0]; },
    (value: InspectResult) => { value.capture!.scope = 'all-pages' as 'current-page'; },
    (value: InspectResult) => { value.capture!.capturedAt = 'not a date'; },
  ]) {
    const values = result(); mutate(values[0].result); assert.throws(() => acceptInspection(values, request, 'doc-1'));
  }
});
test('invalid lengths and oversized/untyped payloads cannot silently bypass extraction bounds', () => {
  for (const mutate of [
    (value: InspectResult) => { value.capture!.rows[0].pop(); },
    (value: InspectResult) => { value.capture!.rows[0][0] = 123 as unknown as string; },
    (value: InspectResult) => { value.capture!.rows[0][0] = 'x'.repeat(10001); },
    (value: InspectResult) => { value.capture!.rows = Array.from({ length: 5001 }, () => Array(5).fill('')); },
    (value: InspectResult) => { value.capture!.rows = Array.from({ length: 5000 }, () => Array(5).fill('x'.repeat(81))); },
  ]) {
    const values = result(); mutate(values[0].result); assert.throws(() => acceptInspection(values, request, 'doc-1'));
  }
});
