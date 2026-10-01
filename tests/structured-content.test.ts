import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { LIMITS, type InspectRequest, type TableCandidate } from '../src/contracts.js';
import { inspectPage } from '../src/extraction.js';

// Every expected matrix is authored independently of the extraction implementation.
// These labels and values are synthetic; no authenticated-page data is a fixture.
const URL = 'https://fixture.example/structured';

function withPage<T>(html: string, action: () => T): T {
  const dom = new JSDOM(html, { url: URL });
  const keys = ['window', 'document', 'location', 'Node', 'HTMLElement', 'HTMLTableElement', 'getComputedStyle'] as const;
  const descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
  try { return action(); } finally {
    for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    dom.window.close();
  }
}

function request(mode: InspectRequest['mode'], overrides: Partial<InspectRequest> = {}): InspectRequest {
  return { mode, kind: 'content', expectedUrl: URL, requestId: 'structured-request', limits: LIMITS, ...overrides };
}

function describe(key: string): TableCandidate {
  const result = inspectPage(request('describe', { tableKey: key }));
  assert.equal(result.error, undefined, 'a selected visible range must receive an initial rectangular result');
  assert.equal(result.tables?.length, 1);
  assert.equal(result.tables?.[0].error, undefined);
  assert.ok(result.tables?.[0].contentSignature);
  return result.tables![0];
}

function capture(candidate: TableCandidate) {
  return inspectPage(request('capture', {
    tableKey: candidate.key, tableIndex: candidate.index, headers: candidate.headers,
    contentSignature: candidate.contentSignature, sourceIndexes: candidate.headers.map((_, index) => index), ...(candidate.layout ? { layout: candidate.layout } : {}),
  }));
}

const PERIOD_TABLE = `<table id="periods">
  <thead><tr><th></th><th colspan="2">架空期間A</th><th colspan="2">架空期間B</th><th colspan="2">架空期間C</th></tr>
  <tr><th>タイム</th><th>w</th><th>w/kg</th><th>w</th><th>w/kg</th><th>w</th><th>w/kg</th></tr></thead>
  <tbody><tr><td>5秒</td><td>900</td><td>12.0</td><td>880</td><td>11.7</td><td>870</td><td>11.6</td></tr>
  <tr><td>60秒</td><td>500</td><td>6.7</td><td>490</td><td>6.5</td><td>480</td><td>6.4</td></tr></tbody>
</table>`;
const PERIOD_HEADERS = ['タイム', '架空期間A / w', '架空期間A / w/kg', '架空期間B / w', '架空期間B / w/kg', '架空期間C / w', '架空期間C / w/kg'];
const PERIOD_ROWS = [
  ['5秒', '900', '12.0', '880', '11.7', '870', '11.6'],
  ['60秒', '500', '6.7', '490', '6.5', '480', '6.4'],
];

test('structured evaluator: selecting a two-band merged-header table initializes seven semantic columns', () => withPage(PERIOD_TABLE, () => {
  const candidate = describe('content:id:periods');
  assert.deepEqual(candidate.headers, PERIOD_HEADERS, 'group labels must apply only to their explicit colspan slots');
  assert.equal(candidate.rowCount, 2);
  const result = capture(candidate);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.capture?.headers, PERIOD_HEADERS);
  assert.deepEqual(result.capture?.rows, PERIOD_ROWS, 'every displayed measurement needs its own source column');
  assert.equal((result.capture as unknown as { layout?: string }).layout, undefined, 'a single declared table has a semantic schema');
}));

const SALES_TABLE = `<table id="sales"><thead>
  <tr><th rowspan="2">日付</th><th rowspan="2">商品</th><th colspan="2">金額</th></tr>
  <tr><th>税込</th><th>税</th></tr></thead><tbody>
  <tr><td rowspan="2">2026-09-01</td><td>ペン</td><td>110</td><td>10</td></tr>
  <tr><td>ノート</td><td>220</td><td>20</td></tr>
  <tr><td colspan="2">合計</td><td>330</td><td>30</td></tr>
</tbody></table>`;
const SALES_HEADERS = ['日付', '商品', '金額 / 税込', '金額 / 税'];
const SALES_ROWS = [
  ['2026-09-01', 'ペン', '110', '10'],
  ['', 'ノート', '220', '20'],
  ['合計', '', '330', '30'],
];

test('structured evaluator: header rowspans and body spans retain anchor-only cells without invented repeated values', () => withPage(SALES_TABLE, () => {
  const result = capture(describe('content:id:sales'));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.capture?.headers, SALES_HEADERS);
  assert.deepEqual(result.capture?.rows, SALES_ROWS, 'covered slots stay empty; a shared source cell is not copied into new values');
  assert.ok(result.capture?.warnings?.some(value => /結合|空欄|span/.test(value)), 'CSV cannot express merged coverage, so its anchor-only projection must be disclosed');
}));

test('structured evaluator: rowspan zero stops at its own row group rather than shifting a later group', () => withPage(
  '<table id="groups"><thead><tr><th>群</th><th>値</th></tr></thead><tbody><tr><td rowspan="0">A</td><td>1</td></tr><tr><td>2</td></tr></tbody><tbody><tr><td>B</td><td>3</td></tr></tbody></table>', () => {
    const result = capture(describe('content:id:groups'));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.headers, ['群', '値']);
    assert.deepEqual(result.capture?.rows, [['A', '1'], ['', '2'], ['B', '3']]);
  },
));

test('structured evaluator: mixed prose and unrelated tables form one ordered padded matrix with local header rows', () => withPage(
  `<main id="mixed"><h1>月次メモ</h1><p>すべて架空の値です。</p><p>二段落目も独立した行です。</p>
  <h2>売上</h2>${SALES_TABLE}<h2>費用</h2>
  <table id="costs"><thead><tr><th>金額</th><th>費目</th><th>日付</th></tr></thead><tbody><tr><td>55</td><td>送料</td><td>2026-09-02</td></tr></tbody></table>
  <h2>補足</h2><p>結びの文章です。</p></main>`, () => {
    const candidate = describe('content:id:mixed');
    assert.deepEqual(candidate.headers, ['列1', '列2', '列3', '列4'], 'unrelated local columns must not be assigned one global semantic label');
    const result = capture(candidate);
    assert.equal(result.error, undefined);
    assert.equal((result.capture as unknown as { layout?: string }).layout, 'composite');
    assert.deepEqual(result.capture?.rows, [
      ['月次メモ', 'すべて架空の値です。', '', ''],
      ['月次メモ', '二段落目も独立した行です。', '', ''],
      ['月次メモ / 売上', '', '', ''],
      ['日付', '商品', '金額 / 税込', '金額 / 税'],
      ['2026-09-01', 'ペン', '110', '10'],
      ['', 'ノート', '220', '20'],
      ['合計', '', '330', '30'],
      ['月次メモ / 費用', '', '', ''],
      ['金額', '費目', '日付', ''],
      ['55', '送料', '2026-09-02', ''],
      ['月次メモ / 補足', '結びの文章です。', '', ''],
    ], 'source block order, source field order, local schemas and every paragraph must remain independently observable');
  },
));

const CARDS = `<section id="inventory"><article class="card"><dl>
  <dt>品名</dt><dd>ペン</dd><dt>型番</dt><dd>A-01</dd><dt>数量</dt><dd>0</dd><dt>単価</dt><dd>110</dd>
  </dl></article><article class="card"><dl>
  <dt>単価</dt><dd>220</dd><dt>型番</dt><dd>A-02</dd><dt>品名</dt><dd>ノート</dd>
  </dl></article><article class="card"><dl>
  <dt>型番</dt><dd>A-03</dd><dt>数量</dt><dd>2</dd><dt>品名</dt><dd>消しゴム</dd>
  </dl></article></section>`;

test('structured evaluator: repeated labelled cards align exact labels despite field order changes and missing values', () => withPage(CARDS, () => {
  const result = capture(describe('content:id:inventory'));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.capture?.headers, ['品名', '型番', '数量', '単価']);
  assert.deepEqual(result.capture?.rows, [
    ['ペン', 'A-01', '0', '110'],
    ['ノート', 'A-02', '', '220'],
    ['消しゴム', 'A-03', '2', ''],
  ], 'zero remains a value and missing fields cannot borrow a previous card value');
}));

test('structured evaluator: unlabelled repeated div rows keep all rows and use positional names rather than promoting first data', () => withPage(
  '<div id="rows"><div class="row"><span>ペン</span><span>0</span></div><div class="row"><span>ノート</span><span>2</span></div><div class="row"><span>消しゴム</span><span>1</span></div></div>', () => {
    const result = capture(describe('content:id:rows'));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.headers, ['列1', '列2']);
    assert.deepEqual(result.capture?.rows, [['ペン', '0'], ['ノート', '2'], ['消しゴム', '1']]);
  },
));

test('structured evaluator: explicit ARIA table roles produce the same semantic rectangle as HTML cells', () => withPage(
  '<div role="table" id="aria"><div role="row"><span role="columnheader">項目</span><span role="columnheader">値</span></div><div role="row"><span role="cell">eFTP</span><span role="cell">250 W</span></div><div role="row"><span role="cell">期間</span><span role="cell">30日</span></div></div>', () => {
    const result = capture(describe('content:id:aria'));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.headers, ['項目', '値']);
    assert.deepEqual(result.capture?.rows, [['eFTP', '250 W'], ['期間', '30日']]);
  },
));

test('structured evaluator: selecting a partial row does not widen to its ancestor table or borrow outside headers', () => withPage(
  '<table><tr><th>対象外の項目</th><th>対象外の値</th></tr><tr id="partial"><td>x</td><td>y</td></tr><tr><td>対象外</td><td>99</td></tr></table>', () => {
    const result = capture(describe('content:id:partial'));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.headers, ['列1', '列2']);
    assert.deepEqual(result.capture?.rows, [['x', 'y']]);
    assert.ok(!JSON.stringify(result.capture).includes('対象外'));
  },
));

test('structured evaluator: selecting a partial ARIA row retains only its cells without borrowing its table schema', () => withPage(
  '<div role="table"><div role="row"><span role="columnheader">対象外の項目</span><span role="columnheader">対象外の値</span></div><div role="row" id="partial-aria"><span role="cell">x</span><span role="cell">y</span></div><div role="row"><span role="cell">対象外</span><span role="cell">99</span></div></div>', () => {
    const result = capture(describe('content:id:partial-aria'));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.headers, ['列1', '列2']);
    assert.deepEqual(result.capture?.rows, [['x', 'y']]);
    assert.ok(!JSON.stringify(result.capture).includes('対象外'));
  },
));

test('structured evaluator: ordinary table extraction preserves raw visible whitespace and blank slots while excluding hidden text and rows', () => withPage(
  '<table id="visible"><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td> \t原文<span hidden>private-hidden</span><span style="display:none">private-none</span><script>private-script</script><br>二行目</td><td style="visibility:hidden">private-cell</td></tr><tr hidden><td>private-row</td><td>private-row-value</td></tr><tr><td><span style="visibility:hidden">private-invisible<span style="visibility:visible">表示する文字</span></span></td><td>0</td></tr></tbody></table>', () => {
    const ordinary: InspectRequest = { mode: 'describe', expectedUrl: URL, requestId: 'structured-request', limits: LIMITS, tableKey: 'id:visible', tableIndex: 0 };
    const described = inspectPage(ordinary);
    assert.equal(described.error, undefined);
    assert.deepEqual(described.tables?.[0].headers, ['A', 'B']);
    assert.equal(described.tables?.[0].rowCount, 2);
    const result = inspectPage({ ...ordinary, mode: 'capture', headers: ['A', 'B'], sourceIndexes: [0, 1] });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.rows, [[' \t原文\n二行目', ''], ['表示する文字', '0']]);
    assert.ok(!JSON.stringify(result.capture).includes('private-'));
  },
));

test('structured evaluator: layout signatures detect reordered blocks and changed local schemas even with unchanged headings', () => {
  for (const change of ['order', 'header', 'span']) withPage(
    '<main id="mixed"><h1>結果</h1><table id="first"><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><table id="second"><tr><th>X</th><th>Y</th></tr><tr><td>3</td><td>4</td></tr></table></main>', () => {
      const candidate = describe('content:id:mixed');
      if (change === 'order') document.getElementById('mixed')!.append(document.getElementById('first')!);
      else if (change === 'header') document.querySelector('#first th')!.textContent = '別項目';
      else document.querySelector('#first th')!.setAttribute('colspan', '2');
      const result = capture(candidate);
      assert.ok(result.error, `the unchanged title cannot conceal changed ${change}`);
      assert.equal(result.capture, undefined, 'structural mismatch must never return the old matrix with a new field correspondence');
    },
  );
});

test('structured evaluator: refreshed cell values remain capturable without changing a table layout signature', () => withPage(PERIOD_TABLE, () => {
  const candidate = describe('content:id:periods');
  document.querySelector('#periods tbody tr td:nth-child(2)')!.textContent = '901';
  const result = capture(candidate);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.capture?.headers, PERIOD_HEADERS);
  assert.deepEqual(result.capture?.rows, [
    ['5秒', '901', '12.0', '880', '11.7', '870', '11.6'],
    ['60秒', '500', '6.7', '490', '6.5', '480', '6.4'],
  ]);
  assert.equal(result.capture?.contentSignature, candidate.contentSignature, 'data values are not schema identity');
}));

test('structured evaluator: content bounds stop before reading later blocks or constructing an oversized positional matrix', () => {
  for (const prefix of [
    '<p>x</p>'.repeat(5001),
    ('<p>' + 'x'.repeat(5000) + '</p>').repeat(401),
    '<section><div class="row">' + '<span>x</span>'.repeat(51) + '</div><div class="row">' + '<span>x</span>'.repeat(51) + '</div></section>',
  ]) withPage(`<main id="bounded">${prefix}<p id="later">must-not-be-read</p></main>`, () => {
    const node = document.getElementById('later')!.firstChild!;
    Object.defineProperty(node, 'nodeValue', { get() { throw new Error('later block was read before bounds stopped capture'); } });
    const result = inspectPage(request('describe', { tableKey: 'content:id:bounded' }));
    assert.match(result.error ?? '', /上限|50列/, 'row, text and positional column bounds are enforced during accumulation');
    assert.equal(result.capture, undefined);
  });
});

test('structured evaluator: nested table fallback preserves the inner rectangle and surrounding text exactly once', () => withPage(
  '<table id="outer"><tr><td>外側前<p>説明</p><table id="inner"><tr><th>内項目</th><th>内値</th></tr><tr><td>A</td><td>1</td></tr></table>外側後</td><td>右側</td></tr></table>', () => {
    const candidate = describe('content:id:outer');
    const result = capture(candidate);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.headers, ['列1', '列2']);
    assert.equal(result.capture?.layout, 'composite');
    assert.deepEqual(result.capture?.rows, [
      ['選択範囲', '外側前'], ['選択範囲', '説明'], ['内項目', '内値'], ['A', '1'],
      ['選択範囲', '外側後'], ['選択範囲', '右側'],
    ]);
    assert.ok(result.capture?.warnings?.some(value => /入れ子|外側/.test(value)));
  },
));

test('structured evaluator: direct text around repeated records remains in source order beside the matrix', () => withPage(
  '<div id="picked">Intro<div><span>A</span><span>B</span></div><div><span>C</span><span>D</span></div>Outro</div>', () => {
    const result = capture(describe('content:id:picked'));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.headers, ['列1', '列2']);
    assert.deepEqual(result.capture?.rows, [['選択範囲', 'Intro'], ['列1', '列2'], ['A', 'B'], ['C', 'D'], ['選択範囲', 'Outro']]);
  },
));

test('structured evaluator: inline wrappers preserve descendant HTML and ARIA table rectangles rather than rendering one text cell', () => {
  for (const inner of [
    '<table><tr><th>Item</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table>',
    '<span role="table"><span role="row"><span role="columnheader">Item</span><span role="columnheader">Value</span></span><span role="row"><span role="cell">A</span><span role="cell">1</span></span></span>',
  ]) withPage(`<main id="picked"><p>Before</p><span>${inner}</span><p>After</p></main>`, () => {
    const result = capture(describe('content:id:picked'));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.headers, ['列1', '列2']);
    assert.deepEqual(result.capture?.rows, [['選択範囲', 'Before'], ['Item', 'Value'], ['A', '1'], ['選択範囲', 'After']]);
  });
});

test('structured evaluator: explicit row headers remain data even when an entire row uses th cells', () => withPage(
  '<table id="rowscope"><tr><th scope="col">Month</th><th scope="col">Day</th></tr><tr><th scope="row">Sep</th><th scope="row">Mon</th></tr><tr><td>1</td><td>2</td></tr></table>', () => {
    const candidate = describe('content:id:rowscope');
    const result = capture(candidate);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.headers, ['Month', 'Day']);
    assert.deepEqual(result.capture?.rows, [['Sep', 'Mon'], ['1', '2']]);
  },
));

test('structured evaluator: explicit ARIA column indexes retain missing slots rather than moving a value under another header', () => withPage(
  '<div role="table" id="indexed"><div role="row"><span role="columnheader" aria-colindex="1">Item</span><span role="columnheader" aria-colindex="2">Amount</span><span role="columnheader" aria-colindex="3">Tax</span></div><div role="row"><span role="cell" aria-colindex="1">Pen</span><span role="cell" aria-colindex="3">10</span></div></div>', () => {
    const result = capture(describe('content:id:indexed'));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.headers, ['Item', 'Amount', 'Tax']);
    assert.deepEqual(result.capture?.rows, [['Pen', '', '10']]);
  },
));

test('structured evaluator: oversized labelled card collections stop before reading labels from out-of-bounds records', () => withPage(
  '<section id="cards">' + '<article><dl><dt>Name</dt><dd>x</dd></dl></article>'.repeat(5001) + '</section>', () => {
    const text = document.querySelectorAll('dt')[5000].firstChild!;
    Object.defineProperty(text, 'nodeValue', { get() { throw new Error('read-row-5001-before-limit-stop'); } });
    const result = inspectPage(request('describe', { tableKey: 'content:id:cards' }));
    assert.match(result.error ?? '', /5,?000|行数|上限/);
    assert.equal(result.capture, undefined);
  },
));

test('structured evaluator: the ordinary table picker supports the same synthetic two-band seven-column table', () => withPage(PERIOD_TABLE, () => {
  const ordinary: InspectRequest = { mode: 'describe', expectedUrl: URL, requestId: 'structured-request', limits: LIMITS, tableKey: 'id:periods', tableIndex: 0 };
  const described = inspectPage(ordinary);
  assert.equal(described.error, undefined);
  assert.deepEqual(described.tables?.[0].headers, PERIOD_HEADERS);
  assert.equal(described.tables?.[0].rowCount, 2);
  const result = inspectPage({ ...ordinary, mode: 'capture', headers: PERIOD_HEADERS, sourceIndexes: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.capture?.rows, PERIOD_ROWS);
}));
