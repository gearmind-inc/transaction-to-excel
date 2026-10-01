import assert from 'node:assert/strict';
import test from 'node:test';
import type { Capture, ColumnConfig, Preset } from '../src/contracts';
import { matchesPreset, PresetStore, validatePreset } from '../src/presets';
import { buildPreview } from '../src/transform';

const column: ColumnConfig = { sourceIndex: 0, outputName: '列1', kind: 'text', required: false, dateFormat: 'YYYY-MM-DD', dateOutput: 'YYYY-MM-DD', amount: { symbol: '', grouping: '', decimal: '.', negative: 'minus' } };
const preset: Preset & { contentSignature: string } = { schemaVersion: 1, id: 'layout-setting', version: 1, name: '選んだ範囲', origin: 'https://fixture.example', path: '/page', tableKey: 'content:id:area', headers: ['列1', '列2'], columns: [column], contentSignature: 'blocks:2:abc123' };
const capture: Capture & { layout: 'composite' } = { schemaVersion: 1, requestId: 'layout-fixture', tableKey: preset.tableKey, headers: preset.headers, sourceIndexes: [0, 1], rows: [['商品', '数量'], ['りんご', '0'], ['日付', '摘要'], ['2026-10-01', '確認']], scope: 'current-page', capturedAt: '2026-10-01T00:00:00Z', layout: 'composite' };

test('content settings retain a structural signature without changing legacy schema 1', async () => {
  assert.deepEqual(validatePreset(preset), preset);
  let stored: unknown;
  const store = new PresetStore({ read: async () => stored, write: async value => { stored = structuredClone(value); } });
  const saved = await store.save(preset);
  assert.equal((saved as typeof preset).contentSignature, preset.contentSignature);
  assert.deepEqual(await store.list(), [preset]);
  const { contentSignature: _, ...legacy } = preset;
  assert.deepEqual(validatePreset(legacy), legacy, 'old settings remain readable and are not rewritten');
});

test('equal positional headers cannot reuse a content setting for changed local block structures', () => {
  const match = (signature?: string) => Reflect.apply(matchesPreset, undefined, [preset, preset.origin, preset.path, preset.tableKey, preset.headers, signature]);
  assert.equal(match(preset.contentSignature), true);
  assert.equal(match('blocks:2:other'), false, 'a price/description swap cannot be hidden by generic outer headers');
  assert.equal(match(), false, 'a signed setting requires the actual structure signature');
  const { contentSignature: _, ...legacy } = preset;
  assert.equal(Reflect.apply(matchesPreset, undefined, [legacy, preset.origin, preset.path, preset.tableKey, preset.headers, preset.contentSignature]), false);
});

test('mixed worksheets cannot apply one date or amount grammar to unrelated headers and paragraphs', () => {
  assert.deepEqual(buildPreview(capture, [column]).rows.map(row => row[0].logical), ['商品', 'りんご', '日付', '2026-10-01']);
  for (const kind of ['date', 'amount'] as const) assert.throws(() => buildPreview(capture, [{ ...column, kind }]), /文字列|混在|複数/);
});

test('mixed worksheets cannot require padding cells from unrelated local blocks', () => {
  assert.throws(() => buildPreview({ ...capture, rows: [['商品', '数量'], ['りんご', '0'], ['', '補足']] }, [{ ...column, required: true }]), /空欄|混在|複数/);
});

test('structural signatures reject getters, foreign fields and invalid values', () => {
  for (const value of ['', 'x'.repeat(129), 0, null, 'blocks:\nprivate']) assert.throws(() => validatePreset({ ...preset, contentSignature: value }));
  let evaluated = false;
  const getter = { ...preset };
  Object.defineProperty(getter, 'contentSignature', { get: () => { evaluated = true; return preset.contentSignature; }, enumerable: true });
  assert.throws(() => validatePreset(getter));
  assert.equal(evaluated, false, 'stored settings must never execute an accessor');
  assert.throws(() => validatePreset({ ...preset, blocks: capture.rows }));
});
