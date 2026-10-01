import assert from 'node:assert/strict';
import test from 'node:test';
import type { Preset } from '../src/contracts.ts';

type Port = { read(): Promise<unknown>; write(presets: Preset[]): Promise<void> };
type Store = { list(): Promise<Preset[]>; save(preset: Preset): Promise<Preset>; remove(id: string): Promise<void> };
type API = {
  validatePreset(value: unknown): Preset;
  matchesPreset(preset: Preset, origin: string, path: string, tableKey: string, headers: string[]): boolean;
  PresetStore: new (port: Port) => Store;
};

// A runnable empty product records assertion failures, not a missing-module error,
// before the implementation exists. Any other import error remains a real error.
const productUrl = new URL('../src/presets.ts', import.meta.url).href;
const api: API = await import(productUrl).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {
    validatePreset: (value: unknown) => value as Preset,
    matchesPreset: () => false,
    PresetStore: class {
      async list() { return []; }
      async save(preset: Preset) { return preset; }
      async remove() { /* Empty implementation. */ }
    },
  };
});

function fixture(overrides: Partial<Preset> = {}): Preset {
  return {
    schemaVersion: 1,
    id: 'settings-1', version: 1, name: '今月の取引',
    origin: 'https://example.test', path: '/transactions', tableKey: 'table:0',
    headers: ['日付', 'ID', '摘要', '金額'],
    columns: [
      { sourceIndex: 2, outputName: '内容', kind: 'text', required: false, dateFormat: 'YYYY-MM-DD', dateOutput: 'YYYY-MM-DD', amount: { symbol: '', grouping: ',', decimal: '.', negative: 'minus' } },
      { sourceIndex: 3, outputName: '金額', kind: 'amount', required: true, dateFormat: 'YYYY-MM-DD', dateOutput: 'YYYY/MM/DD', amount: { symbol: '¥', grouping: ',', decimal: '.', negative: 'parentheses' } },
      { sourceIndex: 0, outputName: '取引日', kind: 'date', required: true, dateFormat: 'YYYY年M月D日', dateOutput: 'YYYY-MM-DD', amount: { symbol: '', grouping: '', decimal: '.', negative: 'minus' } },
    ],
    ...overrides,
  };
}

function memoryPort(initial: unknown = undefined) {
  let stored = structuredClone(initial);
  let writes = 0;
  let failWrite = false;
  return {
    async read(): Promise<unknown> { return stored; },
    async write(value: Preset[]) {
      writes++;
      if (failWrite) throw new Error('容量不足');
      stored = structuredClone(value);
    },
    inspect: () => structuredClone(stored),
    writeCount: () => writes,
    failNextWrites: () => { failWrite = true; },
  };
}

test('valid settings retain selected source indexes, output order and explicit formats without input aliases', () => {
  const source = fixture();
  const result = api.validatePreset(source);
  assert.deepEqual(result, fixture());
  assert.notEqual(result, source);
  assert.notEqual(result.columns, source.columns);
  assert.notEqual(result.columns[0].amount, source.columns[0].amount);
  assert.notEqual(result.headers, source.headers);
  source.headers[0] = '変更';
  source.columns[0].outputName = '変更';
  assert.equal(result.headers[0], '日付');
  assert.equal(result.columns[0].outputName, '内容');
});

test('repeated and empty source headers remain positional; output names may contain CSV-protected characters', () => {
  const value = fixture({ headers: ['日付', '', '摘要', '摘要'] });
  value.columns[0].outputName = '=重要,"確認"\n摘要';
  assert.deepEqual(api.validatePreset(value), value);
});

const invalidMutations: Array<[string, (value: any) => unknown]> = [
  ['unknown preset properties / transaction samples', (p) => ({ ...p, rows: [['個人情報']] })],
  ['unknown column properties', (p) => { p.columns[0].raw = '取引サンプル'; return p; }],
  ['unknown amount properties', (p) => { p.columns[0].amount.token = 'secret'; return p; }],
  ['wrong schema', (p) => ({ ...p, schemaVersion: 2 })],
  ['missing required property', (p) => { delete p.tableKey; return p; }],
  ['unsafe identifier', (p) => ({ ...p, id: '../settings' })],
  ['identifier too long', (p) => ({ ...p, id: 'a'.repeat(81) })],
  ['blank name', (p) => ({ ...p, name: ' \n' })],
  ['name too long', (p) => ({ ...p, name: 'あ'.repeat(101) })],
  ['blank table key', (p) => ({ ...p, tableKey: '' })],
  ['table key too long', (p) => ({ ...p, tableKey: 't'.repeat(201) })],
  ['fractional version', (p) => ({ ...p, version: 1.1 })],
  ['zero version', (p) => ({ ...p, version: 0 })],
  ['unsafe version', (p) => ({ ...p, version: Number.MAX_SAFE_INTEGER + 1 })],
  ['not an HTML origin', (p) => ({ ...p, origin: 'file:///tmp/transactions.html' })],
  ['noncanonical origin', (p) => ({ ...p, origin: 'https://example.test/' })],
  ['origin includes credentials', (p) => ({ ...p, origin: 'https://user:secret@example.test' })],
  ['origin includes path', (p) => ({ ...p, origin: 'https://example.test/transactions' })],
  ['relative path', (p) => ({ ...p, path: 'transactions' })],
  ['path includes query', (p) => ({ ...p, path: '/transactions?token=secret' })],
  ['path includes hash', (p) => ({ ...p, path: '/transactions#account' })],
  ['path includes authority', (p) => ({ ...p, path: '//other.test/transactions' })],
  ['path includes backslash', (p) => ({ ...p, path: '/transactions\\login' })],
  ['path includes dot segment', (p) => ({ ...p, path: '/transactions/../login' })],
  ['malformed path escape', (p) => ({ ...p, path: '/transactions/%zz' })],
  ['login path', (p) => ({ ...p, path: '/account/login' })],
  ['encoded login path', (p) => ({ ...p, path: '/account/%6cogin' })],
  ['encoded authentication delimiter', (p) => ({ ...p, path: '/account%2Flogin' })],
  ['nested encoded authentication path', (p) => ({ ...p, path: '/account%252Flogin' })],
  ['authentication callback path', (p) => ({ ...p, path: '/oauth2/callback' })],
  ['no headers', (p) => ({ ...p, headers: [] })],
  ['too many headers', (p) => ({ ...p, headers: Array(51).fill('列') })],
  ['oversized source header', (p) => ({ ...p, headers: ['列'.repeat(10001), 'ID', '摘要', '金額'] })],
  ['no selected columns', (p) => ({ ...p, columns: [] })],
  ['noninteger source', (p) => { p.columns[0].sourceIndex = 1.5; return p; }],
  ['negative source', (p) => { p.columns[0].sourceIndex = -1; return p; }],
  ['absent source', (p) => { p.columns[0].sourceIndex = 4; return p; }],
  ['duplicate selected source', (p) => { p.columns[1].sourceIndex = p.columns[0].sourceIndex; return p; }],
  ['blank output name', (p) => { p.columns[0].outputName = ' '; return p; }],
  ['oversized output name', (p) => { p.columns[0].outputName = 'あ'.repeat(101); return p; }],
  ['duplicate output name', (p) => { p.columns[1].outputName = p.columns[0].outputName; return p; }],
  ['invalid column type', (p) => { p.columns[0].kind = 'script'; return p; }],
  ['invalid required flag', (p) => { p.columns[0].required = 'false'; return p; }],
  ['ambiguous date format', (p) => { p.columns[0].dateFormat = 'M/D'; return p; }],
  ['invalid date output', (p) => { p.columns[0].dateOutput = 'D/M/YYYY'; return p; }],
  ['unsupported currency', (p) => { p.columns[0].amount.symbol = 'GBP'; return p; }],
  ['unsupported grouping', (p) => { p.columns[0].amount.grouping = ' '; return p; }],
  ['unsupported decimal', (p) => { p.columns[0].amount.decimal = ':'; return p; }],
  ['same grouping and decimal', (p) => { p.columns[0].amount.decimal = ','; return p; }],
  ['unsupported negative style', (p) => { p.columns[0].amount.negative = 'trailing-minus'; return p; }],
];

for (const [name, mutate] of invalidMutations) {
  test(`schema evaluator rejects ${name}`, () => {
    assert.throws(() => api.validatePreset(mutate(fixture())));
  });
}

test('schema evaluator rejects null, primitives, arrays and objects with inherited/accessor/symbol payloads', () => {
  for (const value of [null, undefined, false, 1, 'settings', []]) assert.throws(() => api.validatePreset(value));
  const inherited = Object.assign(Object.create({ rows: ['transaction'] }), fixture());
  assert.throws(() => api.validatePreset(inherited));
  const symbol = Object.assign(fixture(), { [Symbol('raw')]: 'secret' });
  assert.throws(() => api.validatePreset(symbol));
  const accessor = fixture();
  Object.defineProperty(accessor, 'name', { enumerable: true, get: () => '秘密' });
  assert.throws(() => api.validatePreset(accessor));
});

test('matching requires the same origin, pathname, table key and every ordered header', () => {
  const preset = fixture();
  assert.equal(api.matchesPreset(preset, preset.origin, preset.path, preset.tableKey, [...preset.headers]), true);
  assert.equal(api.matchesPreset(preset, 'https://other.test', preset.path, preset.tableKey, preset.headers), false);
  assert.equal(api.matchesPreset(preset, preset.origin, '/other', preset.tableKey, preset.headers), false);
  assert.equal(api.matchesPreset(preset, preset.origin, preset.path, 'table:1', preset.headers), false);
  assert.equal(api.matchesPreset(preset, preset.origin, preset.path, preset.tableKey, [...preset.headers].reverse()), false);
  assert.equal(api.matchesPreset(preset, preset.origin, preset.path, preset.tableKey, [...preset.headers, '追加']), false);
  assert.equal(api.matchesPreset(preset, preset.origin, preset.path, preset.tableKey, ['日付', 'ID', '摘要']), false);
});

test('empty storage can save, list, update the same id and delete settings across store instances', async () => {
  const port = memoryPort();
  const store = new api.PresetStore(port);
  assert.deepEqual(await store.list(), []);
  const saved = await store.save(fixture({ version: 99 }));
  assert.equal(saved.version, 1);
  assert.deepEqual(await new api.PresetStore(port).list(), [fixture()]);
  const updated = await store.save(fixture({ version: 1, name: '変更した設定' }));
  assert.equal(updated.version, 2);
  assert.deepEqual(await new api.PresetStore(port).list(), [fixture({ version: 2, name: '変更した設定' })]);
  await store.remove('settings-1');
  assert.deepEqual(await new api.PresetStore(port).list(), []);
});

test('save/list return detached settings; mutation cannot silently alter persisted settings', async () => {
  const port = memoryPort([fixture()]);
  const store = new api.PresetStore(port);
  const listed = await store.list();
  listed[0].headers[0] = 'changed';
  listed[0].columns[0].outputName = 'changed';
  assert.deepEqual(port.inspect(), [fixture()]);
  const input = fixture({ name: '改訂' });
  const saved = await store.save(input);
  input.columns[0].amount.symbol = '$';
  saved.columns[0].amount.symbol = '€';
  assert.deepEqual(await store.list(), [fixture({ version: 2, name: '改訂' })]);
});

test('write failure preserves the old settings for update and delete', async () => {
  const port = memoryPort([fixture()]);
  const store = new api.PresetStore(port);
  port.failNextWrites();
  await assert.rejects(store.save(fixture({ name: '変更' })), /容量不足/);
  assert.deepEqual(await store.list(), [fixture()]);
  await assert.rejects(store.remove('settings-1'), /容量不足/);
  assert.deepEqual(await store.list(), [fixture()]);
});

test('malformed or unknown-version storage is not silently reset or overwritten', async () => {
  for (const initial of [null, {}, 'bad', [fixture({ schemaVersion: 2 as 1 })], [fixture(), fixture()], [fixture(), { ...fixture({ id: 'settings-2' }), rows: ['secret'] }]]) {
    const port = memoryPort(initial);
    const store = new api.PresetStore(port);
    await assert.rejects(store.list());
    await assert.rejects(store.save(fixture()));
    await assert.rejects(store.remove('settings-1'));
    assert.equal(port.writeCount(), 0);
    assert.deepEqual(port.inspect(), initial);
  }
});

test('read failures are propagated and cannot write a fresh empty list', async () => {
  let writes = 0;
  const store = new api.PresetStore({
    async read() { throw new Error('読込失敗'); },
    async write() { writes++; },
  });
  await assert.rejects(store.list(), /読込失敗/);
  await assert.rejects(store.save(fixture()), /読込失敗/);
  await assert.rejects(store.remove('settings-1'), /読込失敗/);
  assert.equal(writes, 0);
});

test('50-preset capacity prevents insertion but permits same-id update and deletion', async () => {
  const initial = Array.from({ length: 50 }, (_, i) => fixture({ id: `settings-${i}` }));
  const port = memoryPort(initial);
  const store = new api.PresetStore(port);
  await assert.rejects(store.save(fixture({ id: 'settings-extra' })));
  assert.equal(port.writeCount(), 0);
  await store.save(fixture({ id: 'settings-0', name: '改訂' }));
  assert.equal((await store.list()).length, 50);
  await store.remove('settings-0');
  await store.save(fixture({ id: 'settings-extra' }));
  assert.equal((await store.list()).length, 50);
});

test('over-capacity stored list rejects without overwrite; invalid new input never writes', async () => {
  const port = memoryPort(Array.from({ length: 51 }, (_, i) => fixture({ id: `settings-${i}` })));
  const store = new api.PresetStore(port);
  await assert.rejects(store.list());
  await assert.rejects(store.save(fixture()));
  assert.equal(port.writeCount(), 0);
  const validPort = memoryPort([fixture()]);
  const validStore = new api.PresetStore(validPort);
  await assert.rejects(validStore.save({ ...fixture(), rows: ['secret'] } as Preset));
  await assert.rejects(validStore.remove('../settings'));
  assert.equal(validPort.writeCount(), 0);
});

test('missing deletion is an idempotent no-op; updating maximum version refuses overflow', async () => {
  const port = memoryPort([fixture({ version: Number.MAX_SAFE_INTEGER })]);
  const store = new api.PresetStore(port);
  await store.remove('missing');
  assert.equal(port.writeCount(), 0);
  await assert.rejects(store.save(fixture()));
  assert.equal(port.writeCount(), 0);
});
