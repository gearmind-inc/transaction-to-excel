import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { inspectPage } from '../src/extraction.js';
import { LIMITS, type InspectRequest } from '../src/contracts.js';

const url = 'https://fixture.example/visibility';
const shadowWarning = '部品の内側（Shadow DOM）の表示は、この取得結果に含まれません。';

function withPage(action: () => void): void {
  const dom = new JSDOM('<table id="visible"><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><x-helper><span>HIDDEN_HELPER</span></x-helper></td><td>VISIBLE_B</td></tr><tr><td><x-label><span slot="label">SLOTTED</span><span>UNASSIGNED</span></x-label></td><td>0</td></tr></tbody></table>', { url });
  const keys = ['window', 'document', 'location', 'Node', 'HTMLElement', 'HTMLTableElement', 'getComputedStyle'] as const;
  const descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
  document.querySelector('x-helper')!.attachShadow({ mode: 'open' }).innerHTML = 'OPAQUE';
  document.querySelector('x-label')!.attachShadow({ mode: 'open' }).innerHTML = '<slot name="label"></slot>';
  try { action(); } finally {
    for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    dom.window.close();
  }
}

function request(mode: InspectRequest['mode'], content = false): InspectRequest {
  return { mode, expectedUrl: url, requestId: 'visibility-oracle', limits: LIMITS, tableIndex: 0, tableKey: content ? 'content:id:visible' : 'id:visible', ...(content ? { kind: 'content' as const } : {}) };
}

function withContentsComponent(action: (host: HTMLElement) => void): void {
  withPage(() => {
    document.body.innerHTML = '<table id="visible"><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><x-contents style="display:contents"></x-contents></td><td>VISIBLE_B</td></tr></tbody></table>';
    const host = document.querySelector<HTMLElement>('x-contents')!;
    host.attachShadow({ mode: 'closed' }).innerHTML = '<span>VISIBLE_OPAQUE</span>';
    // Model layout independently: the contents host has no box or light-DOM
    // ranges, while the surrounding ordinary table is rendered.
    Object.defineProperty(Object.getPrototypeOf(document.createRange()), 'getClientRects', {
      configurable: true,
      value(this: Range) { return this.startContainer === host ? [] : [{ width: 10, height: 10 }]; },
    });
    assert.equal(host.shadowRoot, null);
    assert.equal(host.getClientRects().length, 0);
    action(host);
  });
}

test('ordinary table visibility: unassigned light-DOM helpers are omitted while slotted text and zero keep their cells', () => withPage(() => {
  const result = inspectPage({ ...request('capture'), headers: ['A', 'B'], sourceIndexes: [0, 1] });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.capture?.headers, ['A', 'B']);
  assert.deepEqual(result.capture?.rows, [['', 'VISIBLE_B'], ['SLOTTED', '0']]);
  assert.ok(result.capture?.warnings?.includes(shadowWarning), 'unsupported component internals must be disclosed');
}));

test('content table visibility shares the same light-DOM cell contract and warns about component internals', () => withPage(() => {
  const described = inspectPage(request('describe', true));
  assert.equal(described.error, undefined);
  const candidate = described.tables![0];
  const result = inspectPage({ ...request('capture', true), headers: ['A', 'B'], sourceIndexes: [0, 1], contentSignature: candidate.contentSignature });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.capture?.rows, [['', 'VISIBLE_B'], ['SLOTTED', '0']]);
  assert.ok(candidate.warnings?.includes(shadowWarning));
  assert.ok(result.capture?.warnings?.includes(shadowWarning));
}));

test('ordinary table visibility refuses a table hidden by an unassigned shadow-host child', () => withPage(() => {
  const host = document.createElement('x-unassigned');
  document.body.append(host);
  host.append(document.querySelector('#visible')!);
  host.attachShadow({ mode: 'open' });
  const result = inspectPage(request('describe'));
  assert.match(result.tables?.[0].error ?? '', /非表示/);
}));

for (const content of [false, true]) {
  test(`${content ? 'content' : 'ordinary'} table warns about a closed component with display contents and no host box`, () => withContentsComponent(() => {
    const described = content ? inspectPage(request('describe', true)) : undefined;
    const candidate = described?.tables?.[0];
    const result = inspectPage({ ...request('capture', content), headers: ['A', 'B'], sourceIndexes: [0, 1], ...(content ? { contentSignature: candidate?.contentSignature } : {}) });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.headers, ['A', 'B']);
    assert.deepEqual(result.capture?.rows, [['', 'VISIBLE_B']]);
    if (content) assert.ok(candidate?.warnings?.includes(shadowWarning));
    assert.ok(result.capture?.warnings?.includes(shadowWarning));
  }));
}

const hiddenContentsCases: [string, (host: HTMLElement) => void][] = [
  ['hidden attribute', host => { host.hidden = true; }],
  ['display none', host => { host.style.display = 'none'; }],
  ['visibility hidden', host => { host.style.visibility = 'hidden'; }],
  ['zero opacity', host => { host.style.opacity = '0'; }],
  ['hidden content visibility', host => { host.style.contentVisibility = 'hidden'; }],
  ['hidden ancestor', host => { host.parentElement!.hidden = true; }],
];

for (const [name, hide] of hiddenContentsCases) {
  test(`a closed custom component with ${name} does not add a Shadow DOM warning`, () => withContentsComponent(host => {
    host.style.display = 'inline-block';
    hide(host);
    const result = inspectPage({ ...request('capture'), headers: ['A', 'B'], sourceIndexes: [0, 1] });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.rows, [['', 'VISIBLE_B']]);
    assert.ok(!result.capture?.warnings?.includes(shadowWarning));
  }));
}
