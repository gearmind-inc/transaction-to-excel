import type { SaveAttempt, SaveState } from './contracts.js';

export type DownloadSnapshot = { id: number; state: 'in_progress' | 'complete' | 'interrupted'; error?: string };

/** The adapter owns Chrome API access. It must search only the supplied ID. */
export type SavePort = {
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

type HeldArtifact = { bytes: Uint8Array; filename: string; exportId: string; digest: string };
type PendingId = { exportId: string; digest: string; startedAt: string; downloadId: number };
const states = new Set<SaveState>(['generated', 'saving', 'saved', 'cancelled', 'interrupted', 'unknown']);
const isUnresolved = (attempt: SaveAttempt): boolean => attempt.state === 'saving' || attempt.state === 'unknown';
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/** Reject a corrupt or expanded record before any overwrite or download. */
export function validateSaveAttempt(input: unknown): SaveAttempt {
  const allowed = new Set(['schemaVersion', 'exportId', 'digest', 'state', 'startedAt', 'downloadId', 'reason']);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('保存確認情報を読み取れません。自動で上書きや再保存はしません。');
  }
  const value = input as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(value);
  const required = ['schemaVersion', 'exportId', 'digest', 'state', 'startedAt'];
  if ((prototype !== Object.prototype && prototype !== null) ||
      Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      required.some((key) => !Object.hasOwn(value, key)) || value.schemaVersion !== 1 ||
      typeof value.exportId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.exportId) ||
      typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) ||
      typeof value.state !== 'string' || !states.has(value.state as SaveState) ||
      typeof value.startedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.startedAt) ||
      !Number.isFinite(Date.parse(value.startedAt)) || new Date(value.startedAt).toISOString() !== value.startedAt ||
      (value.downloadId !== undefined && (typeof value.downloadId !== 'number' || !Number.isSafeInteger(value.downloadId) || value.downloadId < 0)) ||
      (value.reason !== undefined && (typeof value.reason !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value.reason)))) {
    throw new Error('保存確認情報を読み取れません。自動で上書きや再保存はしません。');
  }
  return { ...value } as SaveAttempt;
}

/** CSV bytes exist only in this screen's memory; persistent records are metadata. */
export class SaveController {
  private current?: SaveAttempt;
  private readFailure?: SaveAttempt;
  private pendingId?: PendingId;
  private held?: HeldArtifact;
  private queue: Promise<unknown> = Promise.resolve();
  private starting = false;
  private disposed = false;
  private savedHere = false;
  private durableExportId?: string;
  private readonly unlisten: () => void;

  constructor(private readonly port: SavePort, private readonly onChange: () => void = () => {}) {
    this.unlisten = port.listen((id) => {
      if (!this.disposed && this.current?.downloadId === id && isUnresolved(this.current)) {
        void this.reconcile().catch(() => undefined);
      }
    });
  }

  get attempt(): SaveAttempt | undefined {
    const visible = this.readFailure ?? this.current;
    return visible && { ...visible };
  }

  private notify(): void {
    // A rendering failure must not interrupt the save protocol after API work.
    if (!this.disposed) {
      try { this.onChange(); } catch { /* State remains available through attempt. */ }
    }
  }

  private publish(attempt: SaveAttempt): void {
    this.current = { ...attempt };
    if (attempt.state === 'saved' && this.held?.exportId === attempt.exportId) this.savedHere = true;
    this.notify();
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => this.port.withLock ? this.port.withLock(work) : work());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('処理画面は終了しています。再取得して新しいプレビューを作ってください。');
  }

  private unknown(reason: string): void {
    if (this.current) this.publish({ ...this.current, state: 'unknown', reason });
  }

  private showReadFailure(): void {
    // A display marker is not an export intention and can never reach persist().
    const visible = this.current ?? {
      schemaVersion: 1 as const, exportId: 'unread-save-record', digest: '0'.repeat(64),
      state: 'unknown' as const, startedAt: this.port.now(),
    };
    this.readFailure = { ...visible, state: 'unknown', reason: 'STORAGE_READ_FAILED' };
    this.notify();
  }

  /** Called inside the shared lock, so an old screen never writes over a new export. */
  private async refresh(): Promise<boolean> {
    let stored: SaveAttempt | undefined;
    try {
      const value = await this.port.read();
      stored = value === undefined ? undefined : validateSaveAttempt(value);
    } catch {
      this.showReadFailure();
      return false;
    }
    const readRecovered = this.readFailure !== undefined;
    this.readFailure = undefined;
    if (stored) {
      const same = this.current?.exportId === stored.exportId && this.current.digest === stored.digest;
      // A failed pre-download write may leave an older terminal record on disk.
      // No download began, so retain the new screen's exact artifact for retry.
      if (!same && !isUnresolved(stored) && this.current?.state === 'interrupted' &&
          this.held?.exportId === this.current.exportId && this.durableExportId !== this.current.exportId) {
        this.durableExportId = stored.exportId;
        if (readRecovered) this.notify();
        return true;
      }
      // Only this API call's unrecorded result can supplement its exact intention.
      // A remembered terminal/ordinary saving ID is never reused on a new retry.
      const pending = this.pendingId;
      if (pending && stored.exportId === pending.exportId && stored.digest === pending.digest &&
          stored.startedAt === pending.startedAt && stored.downloadId === undefined && isUnresolved(stored)) {
        stored = { ...stored, downloadId: pending.downloadId, state: 'unknown', reason: 'STORAGE_WRITE_FAILED' };
      } else {
        this.pendingId = undefined;
      }
      if (!same && this.held?.exportId !== stored.exportId) this.held = undefined;
      this.durableExportId = stored.exportId;
      this.publish(stored);
    } else if (this.current && this.durableExportId === this.current.exportId) {
      this.unknown('SAVE_RECORD_MISSING');
      return false;
    } else if (readRecovered) {
      this.notify();
    }
    return true;
  }

  private async persist(attempt: SaveAttempt): Promise<boolean> {
    try {
      await this.port.write(validateSaveAttempt(attempt));
      this.durableExportId = attempt.exportId;
      if (attempt.downloadId !== undefined || !isUnresolved(attempt)) this.pendingId = undefined;
      this.publish(attempt);
      return true;
    } catch {
      this.publish({ ...attempt, state: 'unknown', reason: 'STORAGE_WRITE_FAILED' });
      return false;
    }
  }

  private intentionTime(): string {
    // A retry gets a new generation without changing the held export's identity.
    // Monotonicity also distinguishes calls made within one clock millisecond.
    const previous = this.current ? Date.parse(this.current.startedAt) : -Infinity;
    return new Date(Math.max(Date.parse(this.port.now()), previous + 1)).toISOString();
  }

  async start(bytes: Uint8Array, filename: string): Promise<void> {
    this.assertOpen();
    if (this.starting || this.savedHere) throw new Error('この出力は保存中または保存済みです。連続保存はしません。');
    this.starting = true;
    const input = new Uint8Array(bytes);
    try {
      await this.exclusive(async () => {
        this.assertOpen();
        if (!await this.refresh()) return;
        if (this.current && isUnresolved(this.current)) {
          throw new Error('前の保存結果が未確定です。保存状態を照合してください。');
        }
        if (this.savedHere) throw new Error('この出力は保存済みです。');

        let intention: SaveAttempt;
        if (this.held && this.current?.exportId === this.held.exportId) {
          if (!sameBytes(input, this.held.bytes) || filename !== this.held.filename) {
            throw new Error('再保存する内容が変わっています。新しいプレビューを確認してください。');
          }
          intention = {
            schemaVersion: 1, exportId: this.held.exportId, digest: this.held.digest,
            state: 'saving', startedAt: this.intentionTime(),
          };
        } else {
          const digest = await this.port.digest(input);
          this.assertOpen();
          intention = {
            schemaVersion: 1, exportId: this.port.uuid(), digest,
            state: 'saving', startedAt: this.intentionTime(),
          };
          this.held = { bytes: input, filename, exportId: intention.exportId, digest };
        }
        const artifact = this.held;
        if (!artifact) throw new Error('生成済みCSVを失いました。再取得してください。');
        this.pendingId = undefined;
        this.publish({ ...intention, state: 'generated' });
        // No download is possible until the pre-download intention is durable.
        if (!await this.persist(intention)) {
          this.publish({ ...intention, state: 'interrupted', reason: 'INTENTION_WRITE_FAILED' });
          return;
        }
        if (this.disposed) {
          await this.persist({ ...intention, state: 'interrupted', reason: 'SCREEN_CLOSED_BEFORE_DOWNLOAD' });
          return;
        }
        let id: number;
        try {
          // Give the adapter a copy, never the immutable retry artifact itself.
          id = await this.port.download(new Uint8Array(artifact.bytes), artifact.filename);
          if (!Number.isSafeInteger(id) || id < 0) throw new Error('invalid download ID');
        } catch {
          await this.persist({ ...intention, state: 'unknown', reason: 'DOWNLOAD_RESULT_UNKNOWN' });
          return;
        }
        if (!await this.persist({ ...intention, downloadId: id })) {
          this.pendingId = { exportId: intention.exportId, digest: intention.digest, startedAt: intention.startedAt, downloadId: id };
        }
      });
    } finally {
      this.starting = false;
    }
  }

  private async reconcileCurrent(): Promise<void> {
    const attempt = this.current;
    if (!attempt || !isUnresolved(attempt)) return;
    if (attempt.downloadId === undefined) {
      if (attempt.state !== 'unknown') {
        await this.persist({ ...attempt, state: 'unknown', reason: 'DOWNLOAD_ID_UNKNOWN' });
      }
      return;
    }
    let snapshot: DownloadSnapshot | undefined;
    try {
      snapshot = await this.port.search(attempt.downloadId);
    } catch {
      await this.persist({ ...attempt, state: 'unknown', reason: 'DOWNLOAD_SEARCH_FAILED' });
      return;
    }
    if (!snapshot || snapshot.id !== attempt.downloadId) {
      await this.persist({ ...attempt, state: 'unknown', reason: 'DOWNLOAD_RESULT_UNKNOWN' });
      return;
    }
    const { reason: _previousReason, ...base } = attempt;
    if (snapshot.state === 'complete') {
      await this.persist({ ...base, state: 'saved' });
    } else if (snapshot.state === 'interrupted') {
      const reason = snapshot.error && /^[A-Z_]{1,80}$/.test(snapshot.error) ? snapshot.error : 'DOWNLOAD_INTERRUPTED';
      await this.persist({ ...base, state: reason === 'USER_CANCELED' ? 'cancelled' : 'interrupted', reason });
    } else if (snapshot.state === 'in_progress' && attempt.state !== 'saving') {
      await this.persist({ ...base, state: 'saving' });
    } else if (snapshot.state !== 'in_progress') {
      await this.persist({ ...attempt, state: 'unknown', reason: 'DOWNLOAD_RESULT_UNKNOWN' });
    }
  }

  async reconcile(): Promise<void> {
    this.assertOpen();
    await this.exclusive(async () => {
      this.assertOpen();
      if (await this.refresh()) await this.reconcileCurrent();
    });
  }

  async cancel(): Promise<void> {
    this.assertOpen();
    await this.exclusive(async () => {
      this.assertOpen();
      if (!await this.refresh() || !this.current || !isUnresolved(this.current)) return;
      if (this.current.downloadId === undefined) {
        await this.reconcileCurrent();
        return;
      }
      // API acceptance is not evidence of cancellation. A complete snapshot wins.
      try { await this.port.cancel(this.current.downloadId); } catch { /* Search for actual state next. */ }
      await this.reconcileCurrent();
    });
  }

  async confirmFile(bytes: Uint8Array): Promise<void> {
    this.assertOpen();
    const selected = new Uint8Array(bytes);
    await this.exclusive(async () => {
      this.assertOpen();
      if (!await this.refresh()) return;
      const attempt = this.current;
      if (!attempt || attempt.state !== 'unknown') throw new Error('照合が必要な保存結果はありません。');
      if (await this.port.digest(selected) !== attempt.digest) {
        throw new Error('選択したファイルの内容は、生成したCSVと一致しません。');
      }
      // This proves matching bytes only, not a path, ownership, or Excel import.
      await this.persist({ ...attempt, state: 'saved', reason: 'FILE_DIGEST_CONFIRMED' });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unlisten();
    this.held = undefined;
    this.pendingId = undefined;
    // Closing the screen does not cancel a download or establish any outcome.
  }
}
