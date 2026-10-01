import { LIMITS, type AmountFormat, type ColumnConfig, type DateFormat, type Preset } from './contracts';

export interface PresetPort {
  read(): Promise<unknown>;
  write(presets: Preset[]): Promise<void>;
}

const DATE_FORMATS: DateFormat[] = ['YYYY-MM-DD', 'YYYY/MM/DD', 'YYYY年M月D日', 'MM/DD/YYYY', 'DD/MM/YYYY'];
const PRESET_FIELDS = ['schemaVersion', 'id', 'version', 'name', 'origin', 'path', 'tableKey', 'headers', 'columns'];
const COLUMN_FIELDS = ['sourceIndex', 'outputName', 'kind', 'required', 'dateFormat', 'dateOutput', 'amount'];
const AMOUNT_FIELDS = ['symbol', 'grouping', 'decimal', 'negative'];

function invalid(detail: string): never {
  throw new Error(`設定が不正です: ${detail}`);
}

function object(value: unknown, fields: string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(label);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(label);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) invalid(`${label}の項目`);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !('value' in descriptor)) invalid(`${label}の項目`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.trim().length === 0) || value.includes('\0')) invalid(label);
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) invalid('設定の識別名');
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(label);
  return value;
}

function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid(label);
  return value as T;
}

function origin(value: unknown): string {
  const result = text(value, '取得元のサイト', 2048);
  let url: URL;
  try { url = new URL(result); } catch { return invalid('取得元のサイト'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== result) invalid('取得元のサイト');
  return result;
}

function path(value: unknown, sourceOrigin: string): string {
  const result = text(value, '取得元のパス', 2048);
  if (!result.startsWith('/') || result.startsWith('//') || /[?#\\\x00-\x1f\x7f]/.test(result) || /%(?![0-9a-f]{2})/i.test(result)) invalid('取得元のパス');
  const url = new URL(result, sourceOrigin);
  if (url.origin !== sourceOrigin || url.pathname !== result || url.search || url.hash) invalid('取得元のパス');
  // Encoded separators cannot conceal an authentication URL. No query/hash or
  // authentication path is ever persisted, even if it looks like an ordinary URL.
  let decoded = result;
  for (let depth = 0; /%[0-9a-f]{2}/i.test(decoded); depth++) {
    if (depth >= 8) invalid('取得元のパスの符号化');
    try { decoded = decodeURIComponent(decoded); } catch { return invalid('取得元のパスの符号化'); }
  }
  if (/[?#\\\x00-\x1f\x7f]/.test(decoded) || decoded.startsWith('//') || decoded.split('/').some((part) => part === '.' || part === '..')) invalid('取得元のパス');
  const authSegment = /^(?:log[-_]?in|sign[-_]?in|auth|authenticate|authentication|oauth2?|sso|authorize|authorization|callback|password|otp|mfa)(?:$|[.;])/i;
  if (decoded.split('/').some((part) => authSegment.test(part))) invalid('認証画面のURLは保存できません');
  return result;
}

function amount(value: unknown): AmountFormat {
  const fields = object(value, AMOUNT_FIELDS, '金額の書式');
  const symbol = choice(fields.symbol, ['', '¥', '円', '$', '€'] as const, '通貨記号');
  const grouping = choice(fields.grouping, ['', ',', '.'] as const, '桁区切り');
  const decimal = choice(fields.decimal, ['.', ','] as const, '小数点');
  const negative = choice(fields.negative, ['minus', 'parentheses'] as const, '負数の書式');
  if (grouping === decimal) invalid('桁区切りと小数点が同じです');
  return { symbol, grouping, decimal, negative };
}

function column(value: unknown, headerCount: number): ColumnConfig {
  const fields = object(value, COLUMN_FIELDS, '列の設定');
  const sourceIndex = integer(fields.sourceIndex, '取得列', 0, headerCount - 1);
  const outputName = text(fields.outputName, '出力列名', 100);
  const kind = choice(fields.kind, ['text', 'date', 'amount'] as const, '列の型');
  if (typeof fields.required !== 'boolean') invalid('必須列の設定');
  const dateFormat = choice(fields.dateFormat, DATE_FORMATS, '日付の入力書式');
  const dateOutput = choice(fields.dateOutput, ['YYYY-MM-DD', 'YYYY/MM/DD'] as const, '日付の出力書式');
  return { sourceIndex, outputName, kind, required: fields.required, dateFormat, dateOutput, amount: amount(fields.amount) };
}

/** Strictly allowlist only MVP settings and return a detached snapshot. */
export function validatePreset(value: unknown): Preset {
  const fields = object(value, PRESET_FIELDS, '設定');
  if (fields.schemaVersion !== 1) invalid('対応していない設定形式です');
  const id = identifier(fields.id);
  const version = integer(fields.version, '設定の版', 1, Number.MAX_SAFE_INTEGER);
  const name = text(fields.name, '設定の名前', 100);
  const sourceOrigin = origin(fields.origin);
  const sourcePath = path(fields.path, sourceOrigin);
  const tableKey = text(fields.tableKey, '表の識別名', 200);
  if (!Array.isArray(fields.headers) || fields.headers.length < 1 || fields.headers.length > LIMITS.columns) invalid('表の見出し');
  const headers = Array.from(fields.headers, (header) => text(header, '表の見出し', LIMITS.cellChars, true));
  if (!Array.isArray(fields.columns) || fields.columns.length < 1 || fields.columns.length > headers.length) invalid('選択列の件数');
  const columns = Array.from(fields.columns, (entry) => column(entry, headers.length));
  if (new Set(columns.map((entry) => entry.sourceIndex)).size !== columns.length) invalid('取得列が重複しています');
  if (new Set(columns.map((entry) => entry.outputName)).size !== columns.length) invalid('出力列名が重複しています');
  return { schemaVersion: 1, id, version, name, origin: sourceOrigin, path: sourcePath, tableKey, headers, columns };
}

/** Reuse is manual and requires exact ordered headers, not a similar table. */
export function matchesPreset(preset: Preset, sourceOrigin: string, sourcePath: string, tableKey: string, headers: string[]): boolean {
  return preset.origin === sourceOrigin && preset.path === sourcePath && preset.tableKey === tableKey
    && preset.headers.length === headers.length && preset.headers.every((header, i) => header === headers[i]);
}

/** The Chrome adapter owns locking; this store never mutates a loaded value. */
export class PresetStore {
  constructor(private readonly port: PresetPort) {}

  async list(): Promise<Preset[]> {
    const stored = await this.port.read();
    if (stored === undefined) return [];
    if (!Array.isArray(stored) || stored.length > LIMITS.presets) invalid('保存済みの設定一覧');
    const presets = Array.from(stored, (entry) => validatePreset(entry));
    if (new Set(presets.map((preset) => preset.id)).size !== presets.length) invalid('保存済みの設定識別名が重複しています');
    return presets;
  }

  async save(value: Preset): Promise<Preset> {
    const preset = validatePreset(value);
    const presets = await this.list();
    const index = presets.findIndex((entry) => entry.id === preset.id);
    if (index < 0 && presets.length >= LIMITS.presets) invalid(`設定は最大${LIMITS.presets}件です`);
    const version = index < 0 ? 1 : presets[index].version + 1;
    if (!Number.isSafeInteger(version)) invalid('設定の版の上限です');
    const saved = { ...preset, version };
    const next = index < 0 ? [...presets, saved] : presets.map((entry, i) => i === index ? saved : entry);
    await this.port.write(next);
    return validatePreset(saved);
  }

  async remove(id: string): Promise<void> {
    identifier(id);
    const presets = await this.list();
    const next = presets.filter((entry) => entry.id !== id);
    if (next.length !== presets.length) await this.port.write(next);
  }
}
