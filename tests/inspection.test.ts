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

test('content descriptions accept meaningful source headers and composite source layouts', () => {
  const describe: InspectRequest = { mode: 'describe', kind: 'content', expectedUrl: FIXTURE_URL, requestId: REQUEST_ID, tableKey: 'content:id:article', limits: LIMITS };
  for (const candidate of [
    { index: 0, key: describe.tableKey!, kind: 'content' as const, headers: ['期間', '平均出力'], rowCount: 2, contentSignature: 'structure:2:7abc' },
    { index: 0, key: describe.tableKey!, kind: 'content' as const, layout: 'composite' as const, headers: ['列1', '列2'], rowCount: 4, contentSignature: 'structure:4:9def' },
  ]) {
    const results = [{ frameId: 0, documentId: 'doc-1', result: { schemaVersion: 1 as const, requestId: REQUEST_ID, url: FIXTURE_URL, tables: [candidate] } }];
    assert.deepEqual(acceptInspection(results, describe, 'doc-1').data.tables?.[0], candidate);
  }
});

test('content structure signatures reject whitespace, punctuation and arbitrary unicode', () => {
  const contentRequest: InspectRequest = { ...request, kind: 'content', tableKey: 'content:id:article', headers: ['タイトル', '内容'], sourceIndexes: [0, 1], contentSignature: 'structure:1:abc' };
  for (const signature of ['structure with spaces', 'structure:1:abc\n', '構造:1:abc', 'structure/1/abc', '<script>']) {
    const results = [{ frameId: 0, documentId: 'doc-1', result: { schemaVersion: 1 as const, requestId: REQUEST_ID, url: FIXTURE_URL, capture: { ...structuredClone(EXPECTED_CAPTURE), tableKey: contentRequest.tableKey!, headers: contentRequest.headers!, sourceIndexes: [0, 1], rows: [['章', '本文']], contentSignature: signature } } }];
    assert.throws(() => acceptInspection(results, { ...contentRequest, contentSignature: signature }, 'doc-1'));
  }
});

test('only supported content layouts cross the boundary and captures retain the chosen layout', () => {
  const contentRequest = { ...request, kind: 'content' as const, layout: 'composite' as const, tableKey: 'content:id:article', headers: ['列1', '列2'], sourceIndexes: [0, 1], contentSignature: 'structure:2:abc' };
  const envelope = () => [{ frameId: 0, documentId: 'doc-1', result: { schemaVersion: 1 as const, requestId: REQUEST_ID, url: FIXTURE_URL, capture: { ...structuredClone(EXPECTED_CAPTURE), tableKey: contentRequest.tableKey, layout: 'composite' as const, headers: contentRequest.headers, sourceIndexes: contentRequest.sourceIndexes, rows: [['出力', '表示中の出力を確認します。'], ['期間', '平均出力'], ['10分', '200 W']], contentSignature: contentRequest.contentSignature } } }];
  assert.deepEqual(acceptInspection(envelope(), contentRequest, 'doc-1').data.capture?.rows, envelope()[0].result.capture.rows);
  for (const layout of [undefined, 'unknown', 1]) {
    const results = envelope();
    Object.assign(results[0].result.capture, { layout });
    assert.throws(() => acceptInspection(results, contentRequest, 'doc-1'), 'layout mismatches must not become accepted captures');
  }
  const ordinary = result(); Object.assign(ordinary[0].result.capture!, { layout: 'composite' });
  assert.throws(() => acceptInspection(ordinary, { ...request, layout: 'composite' } as InspectRequest, 'doc-1'), 'ordinary tables cannot claim a content layout');
  for (const layout of ['unknown', 1]) assert.throws(() => acceptInspection(envelope(), { ...contentRequest, layout } as InspectRequest, 'doc-1'));
});

test('candidate layouts are bounded and composite source headers retain positional names', () => {
  const describe: InspectRequest = { mode: 'describe', kind: 'content', expectedUrl: FIXTURE_URL, requestId: REQUEST_ID, tableKey: 'content:id:article', limits: LIMITS };
  const envelope = () => [{ frameId: 0, documentId: 'doc-1', result: { schemaVersion: 1 as const, requestId: REQUEST_ID, url: FIXTURE_URL, tables: [{ index: 0, key: describe.tableKey!, kind: 'content' as const, layout: 'composite' as const, headers: ['列1', '列2'], rowCount: 2, contentSignature: 'structure:2:abc' }] } }];
  assert.equal(acceptInspection(envelope(), { ...describe, layout: 'composite' } as InspectRequest, 'doc-1').data.tables?.length, 1);
  for (const invalid of [{ layout: 'unknown' }, { headers: ['列2', '列1'] }, { headers: ['列1', '列3'] }, { headers: ['出力', '列2'] }]) {
    const results = envelope(); Object.assign(results[0].result.tables[0], invalid);
    assert.throws(() => acceptInspection(results, describe, 'doc-1'));
  }
  const ordinary = [{ frameId: 0, documentId: 'doc-1', result: { schemaVersion: 1 as const, requestId: REQUEST_ID, url: FIXTURE_URL, tables: [{ index: 0, key: 'id:table', layout: 'composite' as const, headers: ['A'], rowCount: 1 }] } }];
  assert.throws(() => acceptInspection(ordinary, { ...describe, kind: undefined, tableKey: 'id:table' }, 'doc-1'));
});

test('matching invalid source indexes cannot bypass capture column bounds', () => {
  for (const indexes of [[], [0, 0], [-1], [HEADERS.length], [0.5], ['0']]) {
    const values = result();
    Object.assign(values[0].result.capture!, { sourceIndexes: indexes, rows: [Array(indexes.length).fill('value')] });
    const invalidRequest = { ...request, sourceIndexes: indexes } as InspectRequest;
    assert.throws(() => acceptInspection(values, invalidRequest, 'doc-1'));
  }
  const values = result(); values[0].result.capture!.sourceIndexes = [1, 0]; values[0].result.capture!.rows = [['2026/10/01', '00001']];
  assert.deepEqual(acceptInspection(values, { ...request, sourceIndexes: [1, 0] }, 'doc-1').data.capture?.rows, [['2026/10/01', '00001']]);
});
