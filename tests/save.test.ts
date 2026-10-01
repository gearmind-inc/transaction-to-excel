import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import test from 'node:test';
import type { SaveAttempt } from '../src/contracts.js';

// This seam is fixed before the download controller implementation. Its only
// history read accepts our recorded ID, never an unbounded downloads query.
type DownloadSnapshot = { id: number; state: 'in_progress' | 'complete' | 'interrupted'; error?: string };
type SavePort = {
  read(): Promise<SaveAttempt | undefined>;
  write(attempt: SaveAttempt): Promise<void>;
  download(bytes: Uint8Array, filename: string): Promise<number>;
  search(id: number): Promise<DownloadSnapshot | undefined>;
  cancel(id: number): Promise<void>;
  listen(onChange: (id: number) => void): () => void;
  now(): string;
  uuid(): string;
  digest(bytes: Uint8Array): Promise<string>;
  withLock?<T>(work: () => Promise<T>): Promise<T>;
};
type Controller = {
  attempt?: SaveAttempt;
  start(bytes: Uint8Array, filename: string): Promise<void>;
  reconcile(): Promise<void>;
  cancel(): Promise<void>;
  confirmFile(bytes: Uint8Array): Promise<void>;
  dispose(): void;
};
type ControllerConstructor = new (port: SavePort, onChange?: () => void) => Controller;

// Missing product code is represented by a valid empty-result adapter. Module
// import errors are not mistaken for an acceptance failure. The explicit flag
// preserves a reproducible RED demonstration after the implementation exists.
class UnimplementedController implements Controller {
  attempt?: SaveAttempt;
  async start(): Promise<void> {}
  async reconcile(): Promise<void> {}
  async cancel(): Promise<void> {}
  async confirmFile(): Promise<void> {}
  dispose(): void {}
}
const implementation = new URL('../src/save.ts', import.meta.url);
const SaveController: ControllerConstructor = process.env.MVP_UNIMPLEMENTED === '1' || !existsSync(implementation)
  ? UnimplementedController
  : (await import(implementation.href)).SaveController;

const bytes = new TextEncoder().encode('\ufeff"取引ID","金額"\r\n"000123","-1200"\r\n');
const filename = '取引.csv';
const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const storedAttempt = (state: SaveAttempt['state'], downloadId?: number): SaveAttempt => ({
  schemaVersion: 1, exportId: 'previous-export', digest: digest(bytes), state,
  startedAt: '2026-10-01T00:00:00.000Z', ...(downloadId === undefined ? {} : { downloadId }),
});
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakePort implements SavePort {
  record?: SaveAttempt;
  writes: SaveAttempt[] = [];
  downloads: { bytes: Uint8Array; filename: string }[] = [];
  searches: number[] = [];
  cancels: number[] = [];
  events: string[] = [];
  listeners = new Set<(id: number) => void>();
  items = new Map<number, DownloadSnapshot>();
  failWrites = new Set<number>();
  searchError = false;
  downloadError = false;
  cancelError = false;
  readError = false;
  writeGate?: Promise<void>;
  downloadGate?: Promise<number>;
  withLock?: SavePort['withLock'];
  private id = 0;
  async read(): Promise<SaveAttempt | undefined> {
    this.events.push('read');
    if (this.readError) throw new Error('injected storage read failure');
    return this.record && structuredClone(this.record);
  }
  async write(attempt: SaveAttempt): Promise<void> {
    this.writes.push(structuredClone(attempt));
    this.events.push(`write:${attempt.state}:${attempt.downloadId ?? 'no-id'}`);
    if (this.writeGate) await this.writeGate;
    if (this.failWrites.has(this.writes.length)) throw new Error('injected storage write failure');
    this.record = structuredClone(attempt);
  }
  async download(value: Uint8Array, name: string): Promise<number> {
    this.events.push('download');
    this.downloads.push({ bytes: new Uint8Array(value), filename: name });
    if (this.downloadError) throw new Error('start result unavailable');
    return this.downloadGate ?? 41;
  }
  async search(id: number): Promise<DownloadSnapshot | undefined> {
    this.events.push(`search:${id}`);
    this.searches.push(id);
    if (this.searchError) throw new Error('injected search failure');
    const item = this.items.get(id);
    return item && structuredClone(item);
  }
  async cancel(id: number): Promise<void> {
    this.events.push(`cancel:${id}`);
    this.cancels.push(id);
    if (this.cancelError) throw new Error('injected cancel failure');
  }
  listen(callback: (id: number) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  emit(id: number): void { for (const listener of this.listeners) listener(id); }
  now(): string { return '2026-10-01T00:00:00.000Z'; }
  uuid(): string { return `export-${++this.id}`; }
  async digest(value: Uint8Array): Promise<string> { return digest(value); }
}

type Outcome = { state: SaveAttempt['state'] | undefined; downloads: number; searchedIds: number[] };
const outcome = (controller: Controller, port: FakePort): Outcome => ({
  state: controller.attempt?.state, downloads: port.downloads.length, searchedIds: port.searches,
});
const evaluate = (actual: Outcome, expected: Outcome): void => assert.deepEqual(actual, expected);

test('save evaluator accepts the known answer and rejects changed result, count, or download identity', () => {
  const expected: Outcome = { state: 'saved', downloads: 1, searchedIds: [41] };
  evaluate(structuredClone(expected), expected);
  for (const changed of [
    { ...expected, state: 'saving' as const },
    { ...expected, downloads: 2 },
    { ...expected, searchedIds: [99] },
  ]) assert.throws(() => evaluate(changed, expected), assert.AssertionError);
});

test('records intention and digest before starting; returned download ID is not completion', async () => {
  const port = new FakePort();
  const controller = new SaveController(port);
  await controller.start(bytes, filename);
  assert.equal(controller.attempt?.state, 'saving');
  assert.equal(controller.attempt?.downloadId, 41);
  assert.equal(controller.attempt?.digest, digest(bytes));
  const intention = port.writes.findIndex((write) => write.state === 'saving' && write.downloadId === undefined);
  assert.ok(intention >= 0, 'persistent intention must precede download');
  assert.ok(port.events.indexOf('write:saving:no-id') < port.events.indexOf('download'));
  assert.deepEqual(port.downloads, [{ bytes, filename }]);
  assert.equal(port.record?.downloadId, 41);
});

test('failed intention storage proves no download was started', async () => {
  const port = new FakePort(); port.failWrites.add(1);
  const controller = new SaveController(port);
  await controller.start(bytes, filename).catch(() => undefined);
  evaluate(outcome(controller, port), { state: 'interrupted', downloads: 0, searchedIds: [] });
});

test('ambiguous download rejection becomes unknown, never an assumed cancellation', async () => {
  const port = new FakePort(); port.downloadError = true;
  const controller = new SaveController(port);
  await controller.start(bytes, filename).catch(() => undefined);
  assert.equal(controller.attempt?.state, 'unknown');
  assert.equal(port.downloads.length, 1);
  await controller.start(bytes, filename).catch(() => undefined);
  await controller.reconcile();
  assert.equal(port.downloads.length, 1, 'unknown result must not automatically re-download');
  assert.equal(controller.attempt?.state, 'unknown');
});

test('failed ID recording becomes unknown and leaves a reconcilable intention', async () => {
  const port = new FakePort(); port.failWrites.add(2);
  const controller = new SaveController(port);
  await controller.start(bytes, filename).catch(() => undefined);
  assert.equal(controller.attempt?.state, 'unknown');
  assert.equal(controller.attempt?.downloadId, 41);
  assert.equal(port.downloads.length, 1);
  assert.ok(port.record, 'a pre-download intention must remain on disk');
  assert.equal(port.record?.digest, digest(bytes));
  await controller.start(bytes, filename).catch(() => undefined);
  assert.equal(port.downloads.length, 1);
});

test('only a matching complete snapshot proves saved, not just a returned download ID', async () => {
  const port = new FakePort();
  const controller = new SaveController(port);
  await controller.start(bytes, filename);
  port.items.set(41, { id: 41, state: 'complete' });
  await controller.reconcile();
  evaluate(outcome(controller, port), { state: 'saved', downloads: 1, searchedIds: [41] });
  assert.equal(port.record?.state, 'saved');
  await controller.start(bytes, filename).catch(() => undefined);
  assert.equal(port.downloads.length, 1, 'saved same-screen artifact cannot be saved by a second click');
});

test('USER_CANCELED and a storage interruption have different terminal states', async (t) => {
  for (const [error, expected] of [['USER_CANCELED', 'cancelled'], ['FILE_NO_SPACE', 'interrupted']] as const) {
    await t.test(error, async () => {
      const port = new FakePort(); const controller = new SaveController(port);
      await controller.start(bytes, filename);
      port.items.set(41, { id: 41, state: 'interrupted', error });
      await controller.reconcile();
      assert.equal(controller.attempt?.state, expected);
      assert.equal(port.record?.state, expected);
      assert.equal(controller.attempt?.reason, error);
    });
  }
});

test('missing result, search failure, and an unrelated result are unknown', async (t) => {
  for (const scenario of ['missing', 'error', 'wrong-id'] as const) {
    await t.test(scenario, async () => {
      const port = new FakePort(); const controller = new SaveController(port);
      await controller.start(bytes, filename);
      if (scenario === 'error') port.searchError = true;
      if (scenario === 'wrong-id') port.items.set(41, { id: 999, state: 'complete' });
      await controller.reconcile();
      evaluate(outcome(controller, port), { state: 'unknown', downloads: 1, searchedIds: [41] });
    });
  }
});

test('a failed completion record is not represented as fully saved', async () => {
  const port = new FakePort(); const controller = new SaveController(port);
  await controller.start(bytes, filename);
  port.failWrites.add(3);
  port.items.set(41, { id: 41, state: 'complete' });
  await controller.reconcile().catch(() => undefined);
  assert.equal(controller.attempt?.state, 'unknown');
  assert.equal(port.downloads.length, 1);
  assert.notEqual(port.record?.state, 'saved');
});

test('double click during intention write and download uses one API call', async () => {
  const port = new FakePort(); const controller = new SaveController(port);
  const intention = deferred<void>(); port.writeGate = intention.promise;
  const first = controller.start(bytes, filename);
  const second = controller.start(bytes, filename).catch(() => undefined);
  intention.resolve();
  await Promise.all([first, second]);
  assert.equal(port.downloads.length, 1);
  assert.equal(port.writes.filter((write) => write.state === 'saving' && write.downloadId === undefined).length, 1);
});

test('a shared lock keeps simultaneous workspaces from starting duplicate unresolved attempts', async () => {
  const port = new FakePort();
  let previous: Promise<unknown> = Promise.resolve();
  port.withLock = <T>(work: () => Promise<T>): Promise<T> => {
    const current = previous.then(work);
    previous = current.catch(() => undefined);
    return current;
  };
  const first = new SaveController(port);
  const second = new SaveController(port);
  await Promise.all([
    first.start(bytes, filename),
    second.start(bytes, filename).catch(() => undefined),
  ]);
  assert.equal(port.downloads.length, 1);
  assert.equal(second.attempt?.exportId, first.attempt?.exportId);
  assert.equal(port.writes.filter((write) => write.state === 'saving' && write.downloadId === undefined).length, 1);
});

test('download changes are ID-filtered and disposal removes the observer', async () => {
  const port = new FakePort(); const controller = new SaveController(port);
  await controller.start(bytes, filename);
  port.items.set(41, { id: 41, state: 'complete' });
  port.emit(999); await tick();
  assert.equal(port.searches.length, 0, 'unrelated download changes must not collect another download');
  port.emit(41); await tick();
  assert.equal(controller.attempt?.state, 'saved');
  assert.deepEqual(port.searches, [41]);
  controller.dispose();
  assert.equal(port.listeners.size, 0);
  port.emit(41); await tick();
  assert.deepEqual(port.searches, [41]);
});

test('cancel acceptance alone is not cancellation evidence; completion can win the race', async () => {
  const port = new FakePort(); const controller = new SaveController(port);
  await controller.start(bytes, filename);
  port.items.set(41, { id: 41, state: 'in_progress' });
  await controller.cancel();
  assert.deepEqual(port.cancels, [41]);
  assert.notEqual(controller.attempt?.state, 'cancelled');
  port.items.set(41, { id: 41, state: 'complete' });
  await controller.reconcile();
  assert.equal(controller.attempt?.state, 'saved');
});

test('cancel is confirmed by matching interrupted USER_CANCELED search evidence', async () => {
  const port = new FakePort(); const controller = new SaveController(port);
  await controller.start(bytes, filename);
  port.items.set(41, { id: 41, state: 'interrupted', error: 'USER_CANCELED' });
  await controller.cancel();
  assert.equal(controller.attempt?.state, 'cancelled');
  assert.deepEqual(port.searches, [41]);
});

test('cancel failure with no state evidence is unknown, not cancelled or automatically retried', async () => {
  const port = new FakePort(); const controller = new SaveController(port);
  await controller.start(bytes, filename);
  port.cancelError = true;
  await controller.cancel().catch(() => undefined);
  assert.equal(controller.attempt?.state, 'unknown');
  await controller.start(bytes, filename).catch(() => undefined);
  assert.equal(port.downloads.length, 1);
});

test('screen loss restores only metadata and searches our recorded ID, never recreating bytes', async () => {
  const port = new FakePort(); port.record = storedAttempt('saving', 7);
  port.items.set(7, { id: 7, state: 'complete' });
  const controller = new SaveController(port);
  await controller.reconcile();
  evaluate(outcome(controller, port), { state: 'saved', downloads: 0, searchedIds: [7] });
  assert.equal(controller.attempt?.exportId, 'previous-export');
  assert.equal(controller.attempt?.digest, digest(bytes));
});

test('unknown restored intention without an ID remains unknown and never searches all downloads', async () => {
  const port = new FakePort(); port.record = storedAttempt('saving');
  const controller = new SaveController(port);
  await controller.reconcile();
  evaluate(outcome(controller, port), { state: 'unknown', downloads: 0, searchedIds: [] });
  await controller.cancel().catch(() => undefined);
  assert.deepEqual(port.cancels, []);
});

test('start in another workspace cannot overwrite an unresolved previous attempt', async (t) => {
  for (const state of ['saving', 'unknown'] as const) {
    await t.test(state, async () => {
      const port = new FakePort(); port.record = storedAttempt(state, 7);
      const controller = new SaveController(port);
      await controller.start(bytes, filename).catch(() => undefined);
      assert.equal(controller.attempt?.exportId, 'previous-export');
      assert.ok(['saving', 'unknown'].includes(controller.attempt?.state ?? ''));
      assert.equal(port.downloads.length, 0);
      assert.equal(port.record?.exportId, 'previous-export');
    });
  }
});

test('a new workspace may create a fresh plan after a terminal previous record', async () => {
  const port = new FakePort(); port.record = storedAttempt('saved', 7);
  const controller = new SaveController(port);
  await controller.start(bytes, filename);
  assert.equal(port.downloads.length, 1);
  assert.notEqual(controller.attempt?.exportId, 'previous-export');
  assert.equal(controller.attempt?.state, 'saving');
});

test('terminal retry uses unchanged held bytes and the same export identity', async () => {
  const port = new FakePort(); const controller = new SaveController(port);
  const input = new Uint8Array(bytes);
  await controller.start(input, filename);
  const firstId = controller.attempt?.exportId;
  port.items.set(41, { id: 41, state: 'interrupted', error: 'USER_CANCELED' });
  await controller.reconcile();
  input.fill(120); // caller mutation cannot change the already generated artifact
  await controller.start(bytes, filename);
  assert.equal(controller.attempt?.exportId, firstId);
  assert.equal(controller.attempt?.digest, digest(bytes));
  assert.deepEqual(port.downloads.map((download) => download.bytes), [bytes, bytes]);
});

test('changed bytes cannot be silently called the same export on terminal retry', async () => {
  const port = new FakePort(); const controller = new SaveController(port);
  await controller.start(bytes, filename);
  port.items.set(41, { id: 41, state: 'interrupted', error: 'USER_CANCELED' });
  await controller.reconcile();
  await assert.rejects(controller.start(new TextEncoder().encode('changed'), filename));
  assert.equal(port.downloads.length, 1);
  assert.equal(controller.attempt?.state, 'cancelled');
});

test('file digest confirmation resolves unknown without starting a download; mismatch stays unknown', async () => {
  const port = new FakePort(); port.record = storedAttempt('unknown');
  const controller = new SaveController(port);
  await controller.reconcile();
  await assert.rejects(controller.confirmFile(new TextEncoder().encode('wrong file')));
  assert.equal(controller.attempt?.state, 'unknown');
  await controller.confirmFile(bytes);
  assert.equal(controller.attempt?.state, 'saved');
  assert.equal(port.record?.state, 'saved');
  assert.equal(port.downloads.length, 0);
});

test('saved metadata contains no filename, bytes, source values, or broader download history', async () => {
  const port = new FakePort(); const controller = new SaveController(port);
  await controller.start(bytes, filename);
  assert.ok(port.writes.length > 0);
  const permittedKeys = new Set(['schemaVersion', 'exportId', 'digest', 'state', 'startedAt', 'downloadId', 'reason']);
  for (const write of port.writes) {
    for (const key of Object.keys(write)) assert.ok(permittedKeys.has(key), `unexpected persisted key: ${key}`);
    const serialized = JSON.stringify(write);
    assert.ok(!serialized.includes('000123'));
    assert.ok(!serialized.includes(filename));
    assert.ok(!serialized.includes('取引ID'));
  }
});

test('storage read failure cannot overwrite an unobserved unresolved record', async () => {
  const port = new FakePort(); port.record = storedAttempt('saving', 7); port.readError = true;
  const controller = new SaveController(port);
  await controller.start(bytes, filename).catch(() => undefined);
  assert.equal(controller.attempt?.state, 'unknown');
  assert.equal(port.downloads.length, 0);
  assert.equal(port.record?.exportId, 'previous-export');
});
