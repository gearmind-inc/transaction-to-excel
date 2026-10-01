import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { inspectPage } from '../src/extraction.js';
import { LIMITS, type InspectRequest } from '../src/contracts.js';

const url = 'https://fixture.example/visible-aria';
const headers = ['ID', '値'];
// Literal expectations are independent of extraction output. ARIA hiding only
// affects accessibility exposure; these cells have no visual hiding styles.
const rows = [['001', '0']];
const table = '<table id="visible"><thead><tr><th>ID</th><th>値</th></tr></thead><tbody><tr><td aria-hidden="true">001</td><td>0</td></tr></tbody></table>';

function withPage(ancestorHidden: boolean, action: () => void): void {
  const dom = new JSDOM(`<main${ancestorHidden ? ' aria-hidden="true"' : ''}>${table}</main>`, { url });
  const keys = ['window', 'document', 'location', 'Node', 'HTMLElement', 'HTMLTableElement', 'getComputedStyle'] as const;
  const descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
  try { action(); } finally {
    for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    dom.window.close();
  }
}

function request(mode: InspectRequest['mode'], content: boolean): InspectRequest {
  return { mode, expectedUrl: url, requestId: 'visible-aria-oracle', limits: LIMITS, tableIndex: 0, tableKey: content ? 'content:id:visible' : 'id:visible', ...(content ? { kind: 'content' as const } : {}) };
}

for (const ancestorHidden of [false, true]) for (const content of [false, true]) {
  test(`${content ? 'content' : 'ordinary'} table preserves visually displayed ARIA-hidden cells${ancestorHidden ? ' inside an ARIA-hidden ancestor' : ''}`, () => withPage(ancestorHidden, () => {
    const described = content ? inspectPage(request('describe', true)) : undefined;
    if (content) assert.equal(described?.error, undefined);
    const result = inspectPage({ ...request('capture', content), headers, sourceIndexes: [0, 1], ...(content ? { contentSignature: described?.tables?.[0].contentSignature } : {}) });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.headers, headers);
    assert.deepEqual(result.capture?.rows, rows);
  }));
}
