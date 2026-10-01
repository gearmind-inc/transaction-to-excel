import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { SaveAttempt, SaveState } from '../src/contracts.js';
import { SaveController, validateSaveAttempt, type DownloadSnapshot, type SavePort } from '../src/save.js';

const bytes = new TextEncoder().encode('\ufeff"取引ID","金額"\r\n"000123","-1200"\r\n');
const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const valid = (changes: Partial<SaveAttempt> = {}): SaveAttempt => ({
  schemaVersion: 1,
  exportId: 'previous-export',
  digest: digest(bytes),
  state: 'saving',
  startedAt: '2026-10-01T00:00:00.000Z',
  downloadId: 41,
  ...changes,
});
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class MetadataPort implements SavePort {
  record: unknown;
  writes: SaveAttempt[] = [];
  failWrites = new Set<number>();
  readError = false;
  downloadError = false;
  downloads = 0;
  searches: number[] = [];
  cancels: number[] = [];
  items = new Map<number, DownloadSnapshot>();
  listeners = new Set<(id: number) => void>();
  private previous: Promise<unknown> = Promise.resolve();
  private nextExport = 0;

  constructor(record?: unknown) { this.record = record; }
  async read(): Promise<SaveAttempt | undefined> {
    if (this.readError) throw new Error('injected metadata read failure');
    return this.record === undefined ? undefined : structuredClone(this.record) as SaveAttempt;
  }
  async write(attempt: SaveAttempt): Promise<void> {
    this.writes.push(structuredClone(attempt));
    if (this.failWrites.has(this.writes.length)) throw new Error('injected metadata write failure');
    this.record = structuredClone(attempt);
  }
  async download(): Promise<number> {
    this.downloads++;
    if (this.downloadError) throw new Error('injected ambiguous download result');
    return 40 + this.downloads;
  }
  async search(id: number): Promise<DownloadSnapshot | undefined> {
    this.searches.push(id);
    const item = this.items.get(id);
    return item && structuredClone(item);
  }
  async cancel(id: number): Promise<void> { this.cancels.push(id); }
  listen(listener: (id: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(id: number): void { this.listeners.forEach((listener) => listener(id)); }
  now(): string { return '2026-10-01T00:00:00.000Z'; }
  uuid(): string { return `export-${++this.nextExport}`; }
  async digest(value: Uint8Array): Promise<string> { return digest(value); }
  withLock<T>(work: () => Promise<T>): Promise<T> {
    const next = this.previous.then(work);
    this.previous = next.catch(() => undefined);
    return next;
  }
}

test('save metadata accepts the existing fixture IDs and returns an independent record', () => {
  for (const exportId of ['previous-export', 'export-1', 'Export.1_abc', 'a'.repeat(128)]) {
    const input = valid({ exportId });
    const result = validateSaveAttempt(input);
    assert.deepEqual(result, input);
    assert.notEqual(result, input);
    result.state = 'saved';
    assert.equal(input.state, 'saving', 'caller cannot mutate the stored record through its validated copy');
  }
});

test('save metadata accepts every known state and safe optional values at their boundaries', () => {
  for (const state of ['generated', 'saving', 'saved', 'cancelled', 'interrupted', 'unknown'] as SaveState[]) {
    assert.equal(validateSaveAttempt(valid({ state })).state, state);
  }
  for (const downloadId of [0, Number.MAX_SAFE_INTEGER]) {
    assert.equal(validateSaveAttempt(valid({ downloadId })).downloadId, downloadId);
  }
  for (const reason of ['USER_CANCELED', 'FILE_NO_SPACE', 'STORAGE_READ_FAILED', 'ERROR_1', 'A'.repeat(128)]) {
    assert.equal(validateSaveAttempt(valid({ reason })).reason, reason);
  }
  const withoutOptional = valid();
  delete withoutOptional.downloadId;
  assert.deepEqual(validateSaveAttempt(withoutOptional), withoutOptional);
});

test('save metadata validates the schema, identifier, SHA-256 digest, and known state', async (t) => {
  const malformed: [string, unknown][] = [
    ['null', null], ['array', []], ['string', 'metadata'], ['boolean', true], ['empty object', {}],
    ['wrong schema', { ...valid(), schemaVersion: 2 }],
    ['string schema', { ...valid(), schemaVersion: '1' }],
    ['empty ID', valid({ exportId: '' })],
    ['oversized ID', valid({ exportId: 'a'.repeat(129) })],
    ['ID with spaces', valid({ exportId: 'private export' })],
    ['ID with newline', valid({ exportId: 'export\n1' })],
    ['path-like ID', valid({ exportId: '../private' })],
    ['leading separator', valid({ exportId: '_export' })],
    ['ID with source value', valid({ exportId: '取引000123' })],
    ['short digest', valid({ digest: 'a'.repeat(63) })],
    ['long digest', valid({ digest: 'a'.repeat(65) })],
    ['uppercase digest', valid({ digest: 'A'.repeat(64) })],
    ['non-hex digest', valid({ digest: 'g'.repeat(64) })],
    ['unknown state', { ...valid(), state: 'completed' }],
    ['non-string state', { ...valid(), state: 1 }],
  ];
  for (const [name, record] of malformed) {
    await t.test(name, () => assert.throws(() => validateSaveAttempt(record)));
  }
});

test('startedAt must be an exact canonical ISO UTC timestamp, not merely date-parseable', async (t) => {
  for (const startedAt of [
    '', 'not a date', '2026-10-01', '2026/10/01', '2026-10-01T00:00:00Z',
    '2026-10-01T00:00:00.000+00:00', '2026-10-01T09:00:00.000+09:00',
    '2026-10-01T00:00:00.000z', '2026-02-30T00:00:00.000Z',
    '2026-10-01T24:00:00.000Z', ' 2026-10-01T00:00:00.000Z',
  ]) {
    await t.test(JSON.stringify(startedAt), () => assert.throws(() => validateSaveAttempt(valid({ startedAt }))));
  }
  assert.equal(validateSaveAttempt(valid({ startedAt: '2024-02-29T23:59:59.999Z' })).startedAt,
    '2024-02-29T23:59:59.999Z');
});

test('downloadId accepts only safe nonnegative integers', async (t) => {
  for (const downloadId of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, '41', null]) {
    await t.test(String(downloadId), () => assert.throws(() => validateSaveAttempt({ ...valid(), downloadId })));
  }
});

test('reason accepts only bounded uppercase machine codes, never arbitrary diagnostic content', async (t) => {
  for (const reason of ['', 'A'.repeat(129), 'file_no_space', '_ERROR', '1ERROR', 'FILE ERROR',
    'FILE_ERROR\n', 'FILE_ERROR: private-folder', '取引000123', null, 41]) {
    await t.test(JSON.stringify(reason), () => assert.throws(() => validateSaveAttempt({ ...valid(), reason })));
  }
});

test('extra keys and private payloads are rejected instead of persisted or silently stripped', async (t) => {
  for (const [key, value] of [
    ['filename', '取引.csv'], ['bytes', bytes], ['rows', [['000123', '-1200']]],
    ['sourceUrl', 'https://private.example/account?id=000123'], ['cookie', 'credential'],
    ['diagnostic', 'source data'], ['futureField', undefined],
  ] as const) {
    await t.test(key, () => assert.throws(() => validateSaveAttempt({ ...valid(), [key]: value })));
  }
  const symbolPayload = { ...valid(), [Symbol('private')]: bytes };
  assert.throws(() => validateSaveAttempt(symbolPayload));
  const hiddenPayload = valid();
  Object.defineProperty(hiddenPayload, 'rows', { value: [['000123']], enumerable: false });
  assert.throws(() => validateSaveAttempt(hiddenPayload));
});

test('required metadata must be own properties of a plain record', async (t) => {
  for (const key of ['schemaVersion', 'exportId', 'digest', 'state', 'startedAt']) {
    await t.test(`missing ${key}`, () => {
      const record: Record<string, unknown> = { ...valid() };
      delete record[key];
      assert.throws(() => validateSaveAttempt(record));
    });
  }
  assert.throws(() => validateSaveAttempt(Object.create(valid())), 'inherited properties are not persisted evidence');
  const nonplain = Object.assign(Object.create({ privatePayload: bytes }), valid());
  assert.throws(() => validateSaveAttempt(nonplain));
  const nullPrototype = Object.assign(Object.create(null), valid());
  assert.deepEqual(validateSaveAttempt(nullPrototype), valid());
});

test('corrupt persisted records block every save path without overwriting or searching their IDs', async (t) => {
  const corrupt: [string, unknown][] = [
    ['invalid schema', { ...valid(), schemaVersion: 2 }],
    ['unsafe ID', valid({ exportId: 'private\nexport' })],
    ['invalid digest', valid({ digest: 'source data' })],
    ['unknown state', { ...valid(), state: 'complete' }],
    ['parseable non-ISO date', valid({ startedAt: '2026-10-01' })],
    ['arbitrary download ID', { ...valid(), downloadId: '999' }],
    ['private diagnostic reason', valid({ reason: '取引000123' })],
    ['private payload', { ...valid(), sourceValues: ['000123'] }],
  ];
  for (const [name, record] of corrupt) {
    await t.test(name, async () => {
      const port = new MetadataPort(record);
      const before = structuredClone(record);
      const controller = new SaveController(port);
      try {
        await controller.start(bytes, '取引.csv').catch(() => undefined);
        assert.equal(controller.attempt?.state, 'unknown');
        await controller.reconcile().catch(() => undefined);
        await controller.cancel().catch(() => undefined);
        await controller.confirmFile(bytes).catch(() => undefined);
        assert.equal(controller.attempt?.state, 'unknown');
        assert.equal(port.downloads, 0, 'corruption must never cause a new download');
        assert.deepEqual(port.writes, [], 'corruption must not overwrite the record');
        assert.deepEqual(port.searches, [], 'an unvalidated record must not authorize a history search');
        assert.deepEqual(port.cancels, [], 'an unvalidated record must not authorize cancellation');
        assert.deepEqual(port.record, before, 'the original corrupt evidence must remain unchanged');
      } finally { controller.dispose(); }
    });
  }
});

test('repeated matching download events resolve once and a fresh controller observes the same durable metadata', async () => {
  const port = new MetadataPort();
  const controller = new SaveController(port);
  let restored: SaveController | undefined;
  try {
    await controller.start(bytes, '取引.csv');
    const identity = controller.attempt?.exportId;
    port.items.set(41, { id: 41, state: 'complete' });
    port.emit(999);
    port.emit(41);
    port.emit(41);
    port.emit(41);
    await tick();
    await controller.reconcile();
    assert.equal(controller.attempt?.state, 'saved');
    assert.equal(port.downloads, 1);
    assert.deepEqual(port.searches, [41], 'queued duplicate events do not re-search a terminal record');
    assert.equal(port.writes.filter((record) => record.state === 'saved').length, 1);
    const durable = structuredClone(port.record);
    restored = new SaveController(port);
    await restored.reconcile();
    assert.deepEqual(restored.attempt, durable);
    assert.equal(restored.attempt?.exportId, identity);
    assert.equal(restored.attempt?.digest, digest(bytes));
    assert.equal(port.downloads, 1);
    assert.deepEqual(port.searches, [41], 'a fresh screen does not inspect unrelated or already terminal downloads');
  } finally {
    controller.dispose();
    restored?.dispose();
  }
});

test('an old screen refreshes the latest export and cannot overwrite its metadata with the old result', async () => {
  const port = new MetadataPort();
  const oldScreen = new SaveController(port);
  const newScreen = new SaveController(port);
  try {
    await oldScreen.start(bytes, '取引.csv');
    port.items.set(41, { id: 41, state: 'complete' });
    await oldScreen.reconcile();
    const oldIdentity = oldScreen.attempt?.exportId;
    const newBytes = new TextEncoder().encode('\ufeff"取引ID"\r\n"000456"\r\n');
    await newScreen.start(newBytes, '別取引.csv');
    port.items.set(42, { id: 42, state: 'in_progress' });
    const newMetadata = structuredClone(port.record);
    assert.notEqual(newScreen.attempt?.exportId, oldIdentity);
    assert.equal(newScreen.attempt?.downloadId, 42);
    const writeCount = port.writes.length;
    await oldScreen.reconcile();
    assert.deepEqual(oldScreen.attempt, newMetadata);
    assert.deepEqual(port.record, newMetadata);
    assert.equal(port.writes.length, writeCount, 'old saved evidence cannot replace a new in-progress export');
    assert.deepEqual(port.searches, [41, 42], 'after refresh only the current export download is searched');
    port.emit(41);
    await tick();
    assert.equal(port.writes.length, writeCount);
    assert.deepEqual(port.searches, [41, 42], 'late old-download events cannot act on the current export');
    assert.equal(port.downloads, 2);
  } finally {
    oldScreen.dispose();
    newScreen.dispose();
  }
});

test('a failed new intention preserves the same-screen immutable retry identity over a prior terminal record', async () => {
  const previous = valid({ state: 'saved', downloadId: 7 });
  const port = new MetadataPort(previous);
  port.failWrites.add(1);
  const controller = new SaveController(port);
  try {
    const callerBytes = new Uint8Array(bytes);
    await controller.start(callerBytes, '取引.csv');
    const firstIdentity = controller.attempt?.exportId;
    assert.equal(controller.attempt?.state, 'interrupted');
    assert.notEqual(firstIdentity, previous.exportId);
    assert.equal(port.downloads, 0, 'an unsuccessful intention write cannot start the download');
    assert.deepEqual(port.record, previous, 'the previous terminal record remains intact on disk');
    callerBytes.fill(120);
    await controller.start(bytes, '取引.csv');
    assert.equal(controller.attempt?.exportId, firstIdentity, 'explicit retry preserves its held export identity');
    assert.equal(controller.attempt?.digest, digest(bytes));
    assert.equal(port.downloads, 1);
    assert.equal(controller.attempt?.state, 'saving');
    assert.equal(port.writes[1]?.exportId, firstIdentity);
  } finally { controller.dispose(); }
});

test('read recovery: an initial failed empty-storage read clears its sentinel without persisting a fake digest', async () => {
  const port = new MetadataPort();
  port.readError = true;
  const controller = new SaveController(port);
  try {
    await controller.start(bytes, '取引.csv');
    assert.equal(controller.attempt?.state, 'unknown');
    assert.equal(port.downloads, 0);
    assert.deepEqual([...port.writes], []);
    port.readError = false;
    await controller.reconcile();
    const clearedAttempt = controller.attempt;
    assert.equal(clearedAttempt, undefined, 'successful empty reread disproves the synthetic unresolved attempt');
    assert.deepEqual([...port.writes], [], 'the synthetic zero digest must never become a durable save record');
    await controller.start(bytes, '取引.csv');
    assert.equal(port.downloads, 1);
    assert.equal(controller.attempt?.digest, digest(bytes));
    assert.ok(port.writes.every((record) => record.digest === digest(bytes)));
  } finally { controller.dispose(); }
});

test('read recovery: a successful empty read in start directly allows a genuine fresh save', async () => {
  const port = new MetadataPort();
  port.readError = true;
  const controller = new SaveController(port);
  try {
    await controller.start(bytes, '取引.csv');
    assert.equal(controller.attempt?.state, 'unknown');
    port.readError = false;
    await controller.start(bytes, '取引.csv');
    assert.equal(port.downloads, 1);
    assert.equal(controller.attempt?.state, 'saving');
    assert.equal(controller.attempt?.digest, digest(bytes));
    assert.ok(port.writes.length > 0);
    assert.ok(port.writes.every((record) => record.digest === digest(bytes)));
  } finally { controller.dispose(); }
});

test('read recovery: real durable unknown metadata survives transient read failure and still blocks retry', async (t) => {
  for (const withId of [true, false]) {
    await t.test(withId ? 'with download ID' : 'without download ID', async () => {
      const record = valid({ state: 'unknown' });
      if (!withId) delete record.downloadId;
      const port = new MetadataPort(record);
      port.readError = true;
      const controller = new SaveController(port);
      try {
        await controller.start(bytes, '取引.csv');
        assert.equal(controller.attempt?.state, 'unknown');
        assert.deepEqual([...port.writes], []);
        port.readError = false;
        await controller.reconcile();
        assert.equal(controller.attempt?.state, 'unknown');
        assert.equal(controller.attempt?.exportId, record.exportId);
        assert.equal(controller.attempt?.digest, record.digest);
        await controller.start(bytes, '取引.csv').catch(() => undefined);
        assert.equal(port.downloads, 0, 'real unresolved metadata is never cleared to permit a fresh download');
        assert.equal(controller.attempt?.exportId, record.exportId);
        assert.ok(port.writes.every((written) => written.digest === record.digest && written.exportId === record.exportId));
      } finally { controller.dispose(); }
    });
  }
});

test('read recovery: a definitely unwritten empty-storage intention remains an explicit same-identity retry', async (t) => {
  for (const transientReadFailure of [false, true]) {
    await t.test(transientReadFailure ? 'after transient read failure' : 'after successful empty reread', async () => {
      const port = new MetadataPort();
      port.failWrites.add(1);
      const controller = new SaveController(port);
      try {
        await controller.start(bytes, '取引.csv');
        const identity = controller.attempt?.exportId;
        assert.equal(controller.attempt?.state, 'interrupted');
        assert.equal(port.downloads, 0);
        assert.equal(port.record, undefined);
        if (transientReadFailure) {
          port.readError = true;
          await controller.reconcile();
          assert.equal(controller.attempt?.state, 'unknown');
          port.readError = false;
        }
        await controller.reconcile();
        assert.equal(controller.attempt?.state, 'interrupted', 'empty reread restores the proven no-download outcome');
        assert.equal(controller.attempt?.exportId, identity);
        assert.equal(port.downloads, 0);
        assert.equal(port.record, undefined);
        assert.equal(port.writes.length, 1, 'reconciliation does not persist sentinel or rewrite the failed intention');
        await controller.start(bytes, '取引.csv');
        assert.equal(controller.attempt?.exportId, identity);
        assert.equal(controller.attempt?.digest, digest(bytes));
        assert.equal(port.downloads, 1);
        assert.equal(controller.attempt?.state, 'saving');
      } finally { controller.dispose(); }
    });
  }
});

test('retry generation: a terminal observer never revives its old ID after an ambiguous same-export retry', async () => {
  const port = new MetadataPort();
  const owner = new SaveController(port);
  const observer = new SaveController(port);
  try {
    await owner.start(bytes, '取引.csv');
    const identity = owner.attempt?.exportId;
    port.items.set(41, { id: 41, state: 'interrupted', error: 'USER_CANCELED' });
    await owner.reconcile();
    await observer.reconcile();
    assert.equal(observer.attempt?.state, 'cancelled');
    assert.equal(observer.attempt?.downloadId, 41);
    port.downloadError = true;
    await owner.start(bytes, '取引.csv');
    const retry = port.record as SaveAttempt;
    assert.equal(retry.exportId, identity);
    assert.equal(retry.state, 'unknown');
    assert.equal(retry.downloadId, undefined);
    const searches = port.searches.length;
    await observer.reconcile();
    const observedRetry = observer.attempt;
    await observer.start(bytes, '取引.csv').catch(() => undefined);
    assert.equal(observedRetry?.state, 'unknown', 'the prior cancellation cannot settle the new ambiguous attempt');
    assert.equal(observedRetry?.downloadId, undefined, 'old terminal ID is not evidence of the new attempt');
    assert.equal(observedRetry?.exportId, identity);
    assert.equal(port.downloads, 2, 'observer must not start a third download while the retry remains unresolved');
    assert.equal(port.searches.length, searches, 'observer never searches the stale terminal ID');
    assert.deepEqual(port.record, retry);
  } finally { owner.dispose(); observer.dispose(); }
});

test('retry generation: an observer with a stale ordinary saving ID cannot attach it to a new ambiguous attempt', async () => {
  const port = new MetadataPort();
  const owner = new SaveController(port);
  const observer = new SaveController(port);
  try {
    await owner.start(bytes, '取引.csv');
    const identity = owner.attempt?.exportId;
    port.items.set(41, { id: 41, state: 'in_progress' });
    await observer.reconcile();
    assert.equal(observer.attempt?.state, 'saving');
    assert.equal(observer.attempt?.downloadId, 41);
    port.items.set(41, { id: 41, state: 'interrupted', error: 'USER_CANCELED' });
    await owner.reconcile();
    port.downloadError = true;
    await owner.start(bytes, '取引.csv');
    const retry = port.record as SaveAttempt;
    assert.equal(retry.state, 'unknown');
    assert.equal(retry.downloadId, undefined);
    const searches = port.searches.length;
    const writes = port.writes.length;
    await observer.reconcile();
    const observedRetry = observer.attempt;
    await observer.start(bytes, '取引.csv').catch(() => undefined);
    assert.equal(observedRetry?.state, 'unknown');
    assert.equal(observedRetry?.downloadId, undefined, 'a previously durable ID is not a private pending ID-write recovery');
    assert.equal(observedRetry?.exportId, identity);
    assert.equal(port.searches.length, searches, 'old in-progress evidence does not authorize a stale-ID search');
    assert.equal(port.downloads, 2);
    assert.equal(port.writes.length, writes, 'old cancellation cannot rewrite the new unknown result');
    assert.deepEqual(port.record, retry);
  } finally { owner.dispose(); observer.dispose(); }
});

test('retry generation: the private ID from a failed current ID-write remains recoverable in its owning screen', async () => {
  const port = new MetadataPort();
  port.failWrites.add(2);
  const owner = new SaveController(port);
  try {
    await owner.start(bytes, '取引.csv');
    const identity = owner.attempt?.exportId;
    assert.equal(owner.attempt?.state, 'unknown');
    assert.equal(owner.attempt?.downloadId, 41);
    assert.equal((port.record as SaveAttempt).downloadId, undefined);
    port.items.set(41, { id: 41, state: 'complete' });
    await owner.reconcile();
    assert.equal(owner.attempt?.state, 'saved');
    assert.equal(owner.attempt?.downloadId, 41);
    assert.equal(owner.attempt?.exportId, identity);
    assert.deepEqual(port.searches, [41]);
    assert.equal(port.downloads, 1);
    assert.equal((port.record as SaveAttempt).state, 'saved');
  } finally { owner.dispose(); }
});
