import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { LIMITS, type Capture, type ColumnConfig, type InspectRequest, type TableCandidate } from '../src/contracts.js';
import { inspectPage } from '../src/extraction.js';
import { buildPreview } from '../src/transform.js';
import { generateCsv } from '../src/csv.js';
import { parseCsv } from './oracle.js';

// Hand-authored synthetic documentation; neither this matrix nor the CSV literal
// is generated from extraction results or authenticated website content.
const URL = 'https://fixture.example/document-hierarchy';
type Matrix = { headers: string[]; rows: string[][]; layout?: 'composite' };

function assertMatrix(actual: Matrix, expected: Matrix): void {
  assert.deepEqual(actual.headers, expected.headers, 'heading levels need separate source columns');
  assert.equal(actual.rows.length, expected.rows.length, 'every section, including repeated and empty sections, must remain in DOM order');
  actual.rows.forEach((row, index) => {
    assert.equal(row.length, expected.headers.length, `section ${index + 1} must contain every heading level and its own content`);
    assert.deepEqual(row, expected.rows[index], `section ${index + 1} must contain only its own heading path and direct body`);
  });
  assert.equal(actual.layout, expected.layout, 'only mixed structured blocks use the existing composite layout');
}

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
  return { mode, kind: 'content', expectedUrl: URL, requestId: 'hierarchy-request', limits: LIMITS, ...overrides };
}

function describe(key?: string): TableCandidate {
  const result = inspectPage(request('describe', key ? { tableKey: key } : {}));
  assert.equal(result.error, undefined, 'a visible synthetic document must be described successfully before its contents are evaluated');
  assert.equal(result.tables?.length, 1);
  assert.equal(result.tables?.[0].error, undefined);
  assert.ok(result.tables?.[0].contentSignature, 'the selected document must retain a structural fingerprint');
  return result.tables![0];
}

function capture(candidate: TableCandidate): Capture {
  const result = inspectPage(request('capture', {
    tableKey: candidate.key, tableIndex: candidate.index, headers: candidate.headers,
    contentSignature: candidate.contentSignature, sourceIndexes: candidate.headers.map((_, index) => index),
    ...(candidate.layout ? { layout: candidate.layout } : {}),
  }));
  assert.equal(result.error, undefined, 'capture must succeed; an injection or validation failure is not evidence of missing heading hierarchy');
  assert.ok(result.capture);
  return result.capture;
}

const GUIDE = `<main id="guide">
  <p>架空の公開文書です。</p>
  <h1>事業者情報の開示</h1>
  <p>利用者に表示する情報を確認します。</p>
  <section><h2>開示する情報</h2>
    <p>名称を掲載します。</p><p>連絡先を掲載します。</p>
    <ul><li>法人名を確認する</li><li>所在地を確認する</li></ul>
    <section><h3>連絡先</h3>
      <p>窓口は次のとおりです。</p>
      <dl><dt>メール</dt><dd>support@example.test</dd><dt>受付</dt><dd>平日<br>午前</dd></dl>
    </section>
    <section><h3>コードの例</h3><pre>const name = "架空";
  console.log(name);</pre></section>
  </section>
  <section><h2>更新</h2><p>同じ文章</p></section>
  <section><h2>更新</h2><p>同じ文章</p></section>
  <section><h2>確認項目</h2><section><h3>確認前</h3><p>内容を確かめます。</p></section></section>
  <h2>見出しだけ</h2>
</main>`;

const GUIDE_MATRIX: Matrix = {
  headers: ['H1', 'H2', 'H3', '内容'],
  rows: [
    ['', '', '', '架空の公開文書です。'],
    ['事業者情報の開示', '', '', '利用者に表示する情報を確認します。'],
    ['事業者情報の開示', '開示する情報', '', '名称を掲載します。\n連絡先を掲載します。\n法人名を確認する\n所在地を確認する'],
    ['事業者情報の開示', '開示する情報', '連絡先', '窓口は次のとおりです。\nメール：support@example.test\n受付：平日\n午前'],
    ['事業者情報の開示', '開示する情報', 'コードの例', 'const name = "架空";\n  console.log(name);'],
    ['事業者情報の開示', '更新', '', '同じ文章'],
    ['事業者情報の開示', '更新', '', '同じ文章'],
    ['事業者情報の開示', '確認項目', '', ''],
    ['事業者情報の開示', '確認項目', '確認前', '内容を確かめます。'],
    ['事業者情報の開示', '見出しだけ', '', ''],
  ],
};

const GUIDE_CSV = '\uFEFF"H1","H2","H3","内容"\r\n'
  + '"","","","架空の公開文書です。"\r\n'
  + '"事業者情報の開示","","","利用者に表示する情報を確認します。"\r\n'
  + '"事業者情報の開示","開示する情報","","名称を掲載します。\n連絡先を掲載します。\n法人名を確認する\n所在地を確認する"\r\n'
  + '"事業者情報の開示","開示する情報","連絡先","窓口は次のとおりです。\nメール：support@example.test\n受付：平日\n午前"\r\n'
  + '"事業者情報の開示","開示する情報","コードの例","const name = ""架空"";\n  console.log(name);"\r\n'
  + '"事業者情報の開示","更新","","同じ文章"\r\n'
  + '"事業者情報の開示","更新","","同じ文章"\r\n'
  + '"事業者情報の開示","確認項目","",""\r\n'
  + '"事業者情報の開示","確認項目","確認前","内容を確かめます。"\r\n'
  + '"事業者情報の開示","見出しだけ","",""\r\n';

test('hierarchy oracle health: the fixed section matrix and independently parsed CSV agree', () => {
  assertMatrix(structuredClone(GUIDE_MATRIX), GUIDE_MATRIX);
  assert.deepEqual(parseCsv(new TextEncoder().encode(GUIDE_CSV)), [GUIDE_MATRIX.headers, ...GUIDE_MATRIX.rows]);
});

test('hierarchy oracle health: flattening levels, copying child content, dropping empty parents or duplicates, and moving rows are rejected', () => {
  const flattened = { headers: ['タイトル', '内容'], rows: [['事業者情報の開示 / 開示する情報', '名称を掲載します。']] };
  assert.throws(() => assertMatrix(flattened, GUIDE_MATRIX), /separate source columns/);
  const copied = structuredClone(GUIDE_MATRIX);
  copied.rows[2][3] += '\n窓口は次のとおりです。';
  assert.throws(() => assertMatrix(copied, GUIDE_MATRIX), /direct body/);
  const noEmptyParent = structuredClone(GUIDE_MATRIX);
  noEmptyParent.rows.splice(7, 1);
  assert.throws(() => assertMatrix(noEmptyParent, GUIDE_MATRIX), /every section/);
  const deduplicated = structuredClone(GUIDE_MATRIX);
  deduplicated.rows.splice(6, 1);
  assert.throws(() => assertMatrix(deduplicated, GUIDE_MATRIX), /every section/);
  const moved = structuredClone(GUIDE_MATRIX);
  [moved.rows[3], moved.rows[4]] = [moved.rows[4], moved.rows[3]];
  assert.throws(() => assertMatrix(moved, GUIDE_MATRIX), /direct body/);
});

test('document hierarchy: a Chrome-like guide keeps H1/H2/H3 sections, direct paragraphs, list items, a definition list, and code', () => withPage(GUIDE, () => {
  const candidate = describe('content:id:guide');
  const observed = capture(candidate);
  assertMatrix(observed, GUIDE_MATRIX);
  assert.equal(candidate.rowCount, GUIDE_MATRIX.rows.length, 'initial preview count must describe emitted section rows');
}));

test('document hierarchy: the acquired heading matrix survives text preview and fixed CSV bytes without child-body duplication', () => withPage(GUIDE, () => {
  const observed = capture(describe('content:id:guide'));
  const columns: ColumnConfig[] = GUIDE_MATRIX.headers.map((outputName, sourceIndex) => ({
    sourceIndex, outputName, kind: 'text', required: false, dateFormat: 'YYYY-MM-DD', dateOutput: 'YYYY-MM-DD',
    amount: { symbol: '', grouping: '', decimal: '.', negative: 'minus' },
  }));
  // A semantic hierarchy assertion precedes conversion so the old implementation
  // fails for the missing source columns, rather than an out-of-range setting.
  assertMatrix(observed, GUIDE_MATRIX);
  const preview = buildPreview(observed, columns);
  assert.equal(preview.errorCount, 0);
  assert.deepEqual(preview.rows.map(row => row.map(cell => cell.logical)), GUIDE_MATRIX.rows);
  const bytes = generateCsv(preview);
  assert.deepEqual(Array.from(bytes), Array.from(new TextEncoder().encode(GUIDE_CSV)));
  assert.deepEqual(parseCsv(bytes), [GUIDE_MATRIX.headers, ...GUIDE_MATRIX.rows]);
}));

test('document hierarchy: missing H levels stay blank and empty parent headings remain separate rows through H6', () => withPage(
  '<main id="skipped"><h2>親</h2><h4>子</h4><h6>末端</h6><p>本文</p><h2>次の親</h2></main>', () => {
    assertMatrix(capture(describe('content:id:skipped')), {
      headers: ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', '内容'],
      rows: [
        ['', '親', '', '', '', '', ''],
        ['', '親', '', '子', '', '', ''],
        ['', '親', '', '子', '', '末端', '本文'],
        ['', '次の親', '', '', '', '', ''],
      ],
    });
  },
));

test('document hierarchy: identical sibling heading names and identical direct paragraphs retain every occurrence', () => withPage(
  '<main id="duplicates"><h1>親</h1><h2>確認</h2><p>同じ文章</p><p>同じ文章</p><h2>確認</h2><p>同じ文章</p><p>同じ文章</p></main>', () => {
    assertMatrix(capture(describe('content:id:duplicates')), {
      headers: ['H1', 'H2', '内容'], rows: [['親', '', ''], ['親', '確認', '同じ文章\n同じ文章'], ['親', '確認', '同じ文章\n同じ文章']],
    });
  },
));

test('document hierarchy: a partial selection does not import outside ancestors or headings', () => withPage(
  '<main><h1>選択外の親</h1><section><h2>選択外の章</h2><div id="partial"><h3>選択した節</h3><p>範囲内の本文</p></div></section><h6>選択外の深い見出し</h6></main>', () => {
    assertMatrix(capture(describe('content:id:partial')), {
      headers: ['H1', 'H2', 'H3', '内容'], rows: [['', '', '選択した節', '範囲内の本文']],
    });
  },
));

test('document hierarchy: nested sections inherit their parent path and restore it after the child ends', () => withPage(
  '<main id="sections"><h1>親文書</h1><p>前</p><section><h2>章</h2><p>章の本文</p><section><h3>節</h3><p>節の本文</p></section><p>章の後</p></section><p>親の後</p></main>', () => {
    assertMatrix(capture(describe('content:id:sections')), {
      headers: ['H1', 'H2', 'H3', '内容'],
      rows: [
        ['親文書', '', '', '前'],
        ['親文書', '章', '', '章の本文'],
        ['親文書', '章', '節', '節の本文'],
        ['親文書', '章', '', '章の後'],
        ['親文書', '', '', '親の後'],
      ],
    });
  },
));

for (const boundary of ['article', 'main', 'nav', 'header', 'footer', 'aside']) {
  test(`document hierarchy: ${boundary} has an independent heading stack and the surrounding document resumes in DOM order`, () => withPage(
    `<div id="boundary"><h1>外側</h1><p>外側の前</p><${boundary}><h2>独立した章</h2><p>内側の本文</p></${boundary}><p>外側の後</p></div>`, () => {
      assertMatrix(capture(describe('content:id:boundary')), {
        headers: ['H1', 'H2', '内容'],
        rows: [['外側', '', '外側の前'], ['', '独立した章', '内側の本文'], ['外側', '', '外側の後']],
      });
    },
  ));
}

test('document hierarchy: whole-page navigation and footer links do not turn a prose document into guessed records', () => withPage(
  '<body id="whole"><nav><ul><li><a>ガイド</a> <span>一覧</span></li><li><a>検索</a> <span>全文</span></li></ul></nav>'
  + '<main><h1>公開文書</h1><p>導入</p><section><h2>開示情報</h2><p>本文</p></section></main>'
  + '<footer><div><a>関連</a> <a>ヘルプ</a></div><div><a>利用規約</a> <a>プライバシー</a></div></footer></body>', () => {
    assertMatrix(capture(describe()), {
      headers: ['H1', 'H2', '内容'],
      rows: [['', '', 'ガイド 一覧\n検索 全文'], ['公開文書', '', '導入'], ['公開文書', '開示情報', '本文'], ['', '', '関連 ヘルプ\n利用規約 プライバシー']],
    });
  },
));

test('document hierarchy: sidebar link positions do not displace the independent main document hierarchy', () => withPage(
  '<body><aside><div><a>A</a><a>B</a></div><div><a>C</a><a>D</a></div></aside><main><h1>文書</h1><p>本文</p></main></body>', () => {
    assertMatrix(capture(describe()), { headers: ['H1', '内容'], rows: [['', 'AB\nCD'], ['文書', '本文']] });
  },
));

test('document hierarchy: hidden headings do not set the width and control values never enter the section body', () => withPage(
  '<main id="visible"><h1>表示文書</h1><h6 hidden>秘密の見出し</h6><p style="display:none">秘密の本文</p>'
  + '<p>説明<span aria-hidden="true">隠れた補足</span></p><label>氏名<input value="SECRET-INPUT"></label>'
  + '<select><option selected>SECRET-SELECT</option></select><textarea>SECRET-TEXTAREA</textarea>'
  + '<div style="visibility:hidden"><h5>隠れた親</h5><p style="visibility:visible">再表示の本文</p></div></main>', () => {
    const observed = capture(describe('content:id:visible'));
    assertMatrix(observed, { headers: ['H1', '内容'], rows: [['表示文書', '説明\n氏名\n再表示の本文']] });
    assert.ok(observed.warnings?.some(value => /入力|input/.test(value)), 'omitting visible controls must be disclosed');
    assert.ok(!JSON.stringify(observed).includes('SECRET-'));
    assert.ok(!JSON.stringify(observed).includes('秘密'));
  },
));

test('document hierarchy: a section above the cell limit continues only between paragraphs and explains its split', () => withPage(
  `<main id="long"><h1>長い章</h1><p>${'あ'.repeat(6000)}</p><p>${'い'.repeat(6000)}</p><p>末尾</p></main>`, () => {
    const observed = capture(describe('content:id:long'));
    assertMatrix(observed, { headers: ['H1', '内容'], rows: [['長い章', 'あ'.repeat(6000)], ['長い章', 'い'.repeat(6000) + '\n末尾']] });
    assert.ok(observed.warnings?.some(value => /分割|続き|複数行/.test(value)), 'continuation rows need an explicit warning');
  },
));

test('document hierarchy: the joining LF counts toward the cell limit rather than silently exceeding it', () => withPage(
  `<main id="line-limit"><h1>境界</h1><p>${'あ'.repeat(9999)}</p><p>い</p></main>`, () => {
    const observed = capture(describe('content:id:line-limit'));
    assertMatrix(observed, { headers: ['H1', '内容'], rows: [['境界', 'あ'.repeat(9999)], ['境界', 'い']] });
    assert.ok(observed.warnings?.length);
  },
));

test('document hierarchy: paragraph count is not misreported as emitted section-row count', () => withPage(
  `<main id="many-paragraphs"><h1>多数の段落</h1>${'<p>x</p>'.repeat(5001)}</main>`, () => {
    const candidate = describe('content:id:many-paragraphs');
    assertMatrix(capture(candidate), { headers: ['H1', '内容'], rows: [['多数の段落', 'x\n'.repeat(4999) + 'x'], ['多数の段落', 'x']] });
    assert.equal(candidate.rowCount, 2, '5,001 small paragraphs form two bounded continuation rows');
  },
));

test('document hierarchy: 5,001 small paragraphs before the first heading retain blank-path continuation rows', () => withPage(
  `<main id="prefix-paragraphs">${'<p>a</p>'.repeat(5001)}<h1>章</h1><p>後</p></main>`, () => {
    const candidate = describe('content:id:prefix-paragraphs');
    const observed = capture(candidate);
    assertMatrix(observed, { headers: ['H1', '内容'], rows: [['', 'a\n'.repeat(4999) + 'a'], ['', 'a'], ['章', '後']] });
    assert.equal(candidate.rowCount, 3, 'the pre-heading body needs two bounded rows rather than 5,001 output rows');
    assert.ok(observed.warnings?.some(value => /分割|続き|複数行/.test(value)));
  },
));

test('document hierarchy: adjacent definition lists with different term labels remain technical prose rather than repeated cards', () => withPage(
  '<main id="adjacent-definitions"><h1>用語集</h1><p>導入</p>'
  + '<dl><dt>開始</dt><dd>設定A</dd><dt>形式</dt><dd>文字列</dd></dl>'
  + '<dl><dt>終了</dt><dd>完了</dd><dt>備考</dt><dd>任意</dd></dl></main>', () => {
    assertMatrix(capture(describe('content:id:adjacent-definitions')), {
      headers: ['H1', '内容'], rows: [['用語集', '導入\n開始：設定A\n形式：文字列\n終了：完了\n備考：任意']],
    });
  },
));

test('document hierarchy: ordinary paragraphs with repeated inline emphasis remain prose rather than positional records', () => withPage(
  '<main id="emphasis"><h1>文書</h1><div><p><strong>B</strong><em>C</em></p><p><strong>D</strong><em>E</em></p></div></main>', () => {
    assertMatrix(capture(describe('content:id:emphasis')), { headers: ['H1', '内容'], rows: [['文書', 'BC\nDE']] });
  },
));

test('document hierarchy: adjacent headings with matching inline decoration remain two empty section rows', () => withPage(
  '<main id="decorated-headings"><h1><span>A</span><b>章</b></h1><h1><span>B</span><b>章</b></h1></main>', () => {
    assertMatrix(capture(describe('content:id:decorated-headings')), { headers: ['H1', '内容'], rows: [['A章', ''], ['B章', '']] });
  },
));

test('document hierarchy: non-rendered repeated light-DOM children under an open shadow host cannot become records', () => withPage(
  '<main id="shadow-document"><h1>VISIBLE</h1><p>BODY</p><div id="shadow-host" style="width:100px;height:10px">'
  + '<div><span>HIDDEN-A</span><span>HIDDEN-B</span></div><div><span>HIDDEN-C</span><span>HIDDEN-D</span></div></div></main>', () => {
    // An open shadow root without a slot makes these light-DOM children
    // non-rendered. This structural relationship also exists in JSDOM even
    // though native browser text geometry is unavailable in this evaluator.
    document.querySelector('#shadow-host')!.attachShadow({ mode: 'open' });
    assertMatrix(capture(describe('content:id:shadow-document')), { headers: ['H1', '内容'], rows: [['VISIBLE', 'BODY']] });
  },
));

test('document hierarchy: a heading inside a definition description retains its own section instead of being flattened into its parent', () => withPage(
  '<main id="nested-description"><h1>用語集</h1><p>導入</p><dl><dt>対象</dt><dd><p>前置き</p><h3>詳細</h3><p>子本文</p></dd></dl></main>', () => {
    assertMatrix(capture(describe('content:id:nested-description')), {
      headers: ['H1', 'H2', 'H3', '内容'], rows: [['用語集', '', '', '導入\n対象\n前置き'], ['用語集', '', '詳細', '子本文']],
    });
  },
));

test('document hierarchy: a table inside a definition description retains its own local header and data rows', () => withPage(
  '<main id="nested-description-table"><h1>用語集</h1><p>導入</p><dl><dt>対象</dt><dd><p>前置き</p><h3>詳細</h3><p>子本文</p>'
  + '<table><thead><tr><th>項目</th><th>値</th></tr></thead><tbody><tr><td>送料</td><td>55</td></tr></tbody></table></dd></dl></main>', () => {
    assertMatrix(capture(describe('content:id:nested-description-table')), {
      headers: ['列1', '列2'], layout: 'composite',
      rows: [['用語集', '導入'], ['用語集', '対象'], ['用語集', '前置き'], ['用語集 / 詳細', '子本文'], ['項目', '値'], ['送料', '55']],
    });
  },
));

test('document hierarchy: a hidden heading inside a definition description changes neither the visible item nor its fingerprint', () => withPage(
  '<main id="hidden-definition"><h1>文書</h1><dl><dt>対象</dt><dd>説明</dd></dl></main>', () => {
    const expected: Matrix = { headers: ['H1', '内容'], rows: [['文書', '対象：説明']] };
    const before = describe('content:id:hidden-definition');
    assertMatrix(capture(before), expected);
    const hidden = document.createElement('h6');
    hidden.hidden = true;
    hidden.textContent = '表示しない見出し';
    document.querySelector('dd')!.append(hidden);
    const after = describe('content:id:hidden-definition');
    assertMatrix(capture(after), expected);
    assert.equal(after.contentSignature, before.contentSignature, 'non-rendered structure cannot change the selected visible document contract');
    assertMatrix(capture(before), expected);
  },
));

test('document hierarchy: a table inside a definition term retains local matrix rows and the later description body', () => withPage(
  '<main id="table-term"><h1>文書</h1><dl><dt>対象<table><thead><tr><th>項目</th><th>値</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr></tbody></table></dt><dd><p>説明</p></dd></dl></main>', () => {
    assertMatrix(capture(describe('content:id:table-term')), {
      headers: ['列1', '列2'], layout: 'composite', rows: [['文書', '対象'], ['項目', '値'], ['A', '1'], ['文書', '説明']],
    });
  },
));

test('document hierarchy: code inside a definition description retains indentation and line breaks as a structural fragment', () => withPage(
  '<main id="code-description"><h1>文書</h1><dl><dt>例</dt><dd><pre>  a();\n    b();</pre></dd></dl></main>', () => {
    assertMatrix(capture(describe('content:id:code-description')), { headers: ['H1', '内容'], rows: [['文書', '例\n  a();\n    b();']] });
  },
));

test('document hierarchy: a long heading is not counted once per direct paragraph before aggregation', () => withPage(
  `<main id="long-heading"><h1>${'章'.repeat(9000)}</h1>${'<p>x</p>'.repeat(250)}</main>`, () => {
    assertMatrix(capture(describe('content:id:long-heading')), { headers: ['H1', '内容'], rows: [['章'.repeat(9000), 'x\n'.repeat(249) + 'x']] });
  },
));

test('document hierarchy: the cell limit applies separately to each heading level rather than a concatenated path', () => withPage(
  `<main id="long-path"><h1>${'親'.repeat(6000)}</h1><h2>${'章'.repeat(6000)}</h2><p>本文</p></main>`, () => {
    assertMatrix(capture(describe('content:id:long-path')), {
      headers: ['H1', 'H2', '内容'], rows: [['親'.repeat(6000), '', ''], ['親'.repeat(6000), '章'.repeat(6000), '本文']],
    });
  },
));

test('document hierarchy bounds: one oversized heading cell is rejected without partial output', () => withPage(
  `<main id="oversized-heading"><h1>${'章'.repeat(10001)}</h1><p>本文</p></main>`, () => {
    const result = inspectPage(request('describe', { tableKey: 'content:id:oversized-heading' }));
    assert.match(result.error ?? '', /10,000|上限/);
    assert.equal(result.capture, undefined);
    assert.equal(result.tables, undefined);
  },
));

for (const tag of ['p', 'pre', 'li']) {
  test(`document hierarchy bounds: a single oversized ${tag} is rejected without a partial capture`, () => withPage(
    `<main id="oversized"><h1>章</h1><${tag}>${'x'.repeat(10001)}</${tag}></main>`, () => {
      const result = inspectPage(request('describe', { tableKey: 'content:id:oversized' }));
      assert.match(result.error ?? '', /10,000|上限/);
      assert.equal(result.capture, undefined);
      assert.equal(result.tables, undefined);
    },
  ));
}

test('document hierarchy bounds: a definition item includes its term and delimiter in the indivisible cell limit', () => withPage(
  `<main id="oversized-definition"><h1>章</h1><dl><dt>用語</dt><dd>${'x'.repeat(9998)}</dd></dl></main>`, () => {
    const result = inspectPage(request('describe', { tableKey: 'content:id:oversized-definition' }));
    assert.match(result.error ?? '', /10,000|上限/, 'the 10,001-character term：description item must not be split or silently truncated');
    assert.equal(result.capture, undefined);
    assert.equal(result.tables, undefined);
  },
));

test('document hierarchy bounds: more than 5,000 emitted heading rows is rejected even when their bodies are empty', () => withPage(
  `<main id="row-limit">${'<h1>同名の章</h1>'.repeat(5001)}</main>`, () => {
    const result = inspectPage(request('describe', { tableKey: 'content:id:row-limit' }));
    assert.match(result.error ?? '', /5,000|上限/);
    assert.equal(result.capture, undefined);
    assert.equal(result.tables, undefined);
  },
));

test('document hierarchy bounds: final header, path and joined-body characters permit the exact total limit and reject one more', () => {
  // 199 bodies of 10,000 + one of 9,796 + 200 one-character H1 values
  // + headers (H1=2, 内容=2) = exactly 2,000,000 characters. Each body
  // contains one joining LF, which is absent from the HTML text nodes.
  const sections = `<h1>章</h1><p>${'x'.repeat(9998)}</p><p>x</p>`.repeat(199);
  const last = `<h1>章</h1><p>${'x'.repeat(9794)}</p><p>x</p>`;
  withPage(`<main id="total-limit">${sections}${last}</main>`, () => {
    const candidate = describe('content:id:total-limit');
    const observed = capture(candidate);
    assert.deepEqual(observed.headers, ['H1', '内容']);
    assert.equal(candidate.rowCount, 200);
    assert.equal(observed.rows.length, 200);
    observed.rows.forEach((row, index) => assert.deepEqual(row, ['章', 'x'.repeat(index === 199 ? 9794 : 9998) + '\nx']));
    assert.equal([...observed.headers, ...observed.rows.flat()].reduce((sum, cell) => sum + cell.length, 0), 2_000_000);
  });
  withPage(`<main id="total-limit">${sections}<h1>章</h1><p>${'x'.repeat(9794)}</p><p>xx</p></main>`, () => {
    const result = inspectPage(request('describe', { tableKey: 'content:id:total-limit' }));
    assert.match(result.error ?? '', /2,000,000|上限/);
    assert.equal(result.capture, undefined);
    assert.equal(result.tables, undefined);
  });
});

test('document hierarchy bounds: temporary definition-list headers cannot reject an exact-limit document they are absent from', () => {
  // A T：description item has two fixed prefix characters. Each of the first
  // 199 sections has 10,000 body characters + one H1 character. The last
  // section has 9,796 body characters + one H1 character. Final headers add 4.
  // 199 * 10,001 + 9,797 + 4 = exactly 2,000,000; legacy 項目/内容 headers
  // are not exported and cannot consume this document's character allowance.
  const expected: Matrix = {
    headers: ['H1', '内容'],
    rows: Array.from({ length: 200 }, (_, index) => ['章', 'T：' + 'x'.repeat(index === 199 ? 9794 : 9998)]),
  };
  assert.equal(199 * 10001 + 9797 + 4, 2_000_000);
  assert.equal([...expected.headers, ...expected.rows.flat()].reduce((sum, cell) => sum + cell.length, 0), 2_000_000);
  const firstSections = `<h1>章</h1><dl><dt>T</dt><dd>${'x'.repeat(9998)}</dd></dl>`.repeat(199);
  const lastSection = `<h1>章</h1><dl><dt>T</dt><dd>${'x'.repeat(9794)}</dd></dl>`;
  withPage(`<main id="definition-total-limit">${firstSections}${lastSection}</main>`, () => {
    const candidate = describe('content:id:definition-total-limit');
    assertMatrix(capture(candidate), expected);
    assert.equal(candidate.rowCount, 200);
  });
  withPage(`<main id="definition-total-limit">${firstSections}<h1>章</h1><dl><dt>T</dt><dd>${'x'.repeat(9795)}</dd></dl></main>`, () => {
    const result = inspectPage(request('describe', { tableKey: 'content:id:definition-total-limit' }));
    assert.match(result.error ?? '', /2,000,000|上限/);
    assert.equal(result.capture, undefined);
    assert.equal(result.tables, undefined);
  });
});

const MANY_DEFINITION_RANGES = [[0, 1387], [1388, 2637], [2638, 3887], [3888, 5000]] as const;
const MANY_DEFINITION_MATRIX: Matrix = {
  headers: ['H1', '内容'],
  rows: MANY_DEFINITION_RANGES.map(([first, last]) => ['用語集', Array.from({ length: last - first + 1 }, (_, offset) => `T${first + offset}：x`).join('\n')]),
};

test('document hierarchy bounds: 5,001 definition items form four fixed continuation rows rather than exceeding the data-row limit', () => {
  // This oracle does not run the product's split loop. The boundaries are fixed
  // by hand: T0..T999 use 6,889 characters including LF. Each further item uses
  // 8 more, so 388 additional items end the first row at T1387 (9,993 chars).
  // Later rows fit exactly 1,250 seven-character items separated by LF (9,999).
  // The remaining 1,113 items use 8,903. No item, including T5000, is discarded.
  const expected = MANY_DEFINITION_MATRIX;
  assert.deepEqual(expected.rows.map(row => row[1].length), [9993, 9999, 9999, 8903]);
  assert.equal(expected.rows.map(row => row[1]).join('\n').length, 38_897);
  const terms = Array.from({ length: 5001 }, (_, index) => `<dt>T${index}</dt><dd>x</dd>`).join('');
  withPage(`<main id="many-definitions"><h1>用語集</h1><dl>${terms}</dl></main>`, () => {
    const candidate = describe('content:id:many-definitions');
    const observed = capture(candidate);
    assertMatrix(observed, expected);
    assert.equal(candidate.rowCount, 4);
    assert.equal(observed.rows.map(row => row[1]).join('\n'), Array.from({ length: 5001 }, (_, index) => `T${index}：x`).join('\n'));
    assert.ok(observed.warnings?.some(value => /分割|続き|複数行/.test(value)));
  });
});

test('document hierarchy bounds: 5,001 sibling definition lists with different labels retain the same four prose rows', () => {
  // The same fixed oracle applies whether terms share one DL or each occupies
  // its own DL. Different term labels are not a repeated record schema.
  assert.deepEqual(MANY_DEFINITION_MATRIX.rows.map(row => row[1].length), [9993, 9999, 9999, 8903]);
  const definitions = Array.from({ length: 5001 }, (_, index) => `<dl><dt>T${index}</dt><dd>x</dd></dl>`).join('');
  withPage(`<main id="many-sibling-definitions"><h1>用語集</h1>${definitions}</main>`, () => {
    const candidate = describe('content:id:many-sibling-definitions');
    const observed = capture(candidate);
    assertMatrix(observed, MANY_DEFINITION_MATRIX);
    assert.equal(candidate.rowCount, 4);
    assert.equal(observed.rows.map(row => row[1]).join('\n'), Array.from({ length: 5001 }, (_, index) => `T${index}：x`).join('\n'));
    assert.ok(observed.warnings?.some(value => /分割|続き|複数行/.test(value)));
  });
});

test('document hierarchy provenance: refreshed direct body values preserve the heading fingerprint and aggregate the new body', () => withPage(
  '<main id="refreshed"><h1>文書</h1><p id="value">元の本文</p><p>第二段落</p></main>', () => {
    const selected = describe('content:id:refreshed');
    document.querySelector('#value')!.textContent = '更新した本文';
    const observed = capture(selected);
    assert.equal(observed.contentSignature, selected.contentSignature);
    assertMatrix(observed, { headers: ['H1', '内容'], rows: [['文書', '更新した本文\n第二段落']] });
  },
));

test('document hierarchy provenance: replacing H2 with H3 invalidates the selected structural fingerprint', () => withPage(
  '<main id="changed"><h1>親</h1><h2>章</h2><p>本文</p></main>', () => {
    const selected = describe('content:id:changed');
    const heading = document.querySelector('h2')!;
    const replacement = document.createElement('h3');
    replacement.textContent = heading.textContent;
    heading.replaceWith(replacement);
    const result = inspectPage(request('capture', {
      tableKey: selected.key, tableIndex: selected.index, headers: selected.headers,
      contentSignature: selected.contentSignature, sourceIndexes: selected.headers.map((_, index) => index),
      ...(selected.layout ? { layout: selected.layout } : {}),
    }));
    assert.match(result.error ?? '', /見出し|構成|変わ/);
    assert.equal(result.capture, undefined);
  },
));

test('document hierarchy provenance: adding an independent document boundary invalidates a previously described path', () => withPage(
  '<main id="changed-boundary"><h1>親</h1><section id="chapter"><h2>章</h2><p>本文</p></section></main>', () => {
    const selected = describe('content:id:changed-boundary');
    const chapter = document.querySelector('#chapter')!;
    const replacement = document.createElement('article');
    replacement.id = chapter.id;
    replacement.append(...Array.from(chapter.childNodes));
    chapter.replaceWith(replacement);
    const result = inspectPage(request('capture', {
      tableKey: selected.key, tableIndex: selected.index, headers: selected.headers,
      contentSignature: selected.contentSignature, sourceIndexes: selected.headers.map((_, index) => index),
      ...(selected.layout ? { layout: selected.layout } : {}),
    }));
    assert.match(result.error ?? '', /見出し|構成|変わ/);
    assert.equal(result.capture, undefined, 'changing section inheritance changes the acquired hierarchy even when its visible heading labels are unchanged');
  },
));

const MERGED_TABLE = '<table id="sales"><thead><tr><th rowspan="2">品目</th><th colspan="2">金額</th></tr><tr><th>税込</th><th>税</th></tr></thead><tbody><tr><td rowspan="2">架空商品</td><td>110</td><td>10</td></tr><tr><td>220</td><td>20</td></tr></tbody></table>';
const TABLE_MATRIX: Matrix = { headers: ['品目', '金額 / 税込', '金額 / 税'], rows: [['架空商品', '110', '10'], ['', '220', '20']] };

test('document hierarchy compatibility: a single merged HTML table keeps its semantic columns and anchor-only values', () => withPage(MERGED_TABLE, () => {
  assertMatrix(capture(describe('content:id:sales')), TABLE_MATRIX);
  const ordinary = inspectPage({ mode: 'capture', expectedUrl: URL, requestId: 'ordinary-table', limits: LIMITS, tableIndex: 0, tableKey: 'id:sales', headers: TABLE_MATRIX.headers, sourceIndexes: [0, 1, 2] });
  assert.equal(ordinary.error, undefined);
  assert.ok(ordinary.capture);
  assertMatrix(ordinary.capture, TABLE_MATRIX);
}));

test('document hierarchy compatibility: an explicit ARIA table and repeated labelled cards remain structured grids', () => {
  withPage('<div id="aria" role="table"><div role="row"><span role="columnheader">項目</span><span role="columnheader">値</span></div><div role="row"><span role="cell">eFTP</span><span role="cell">250 W</span></div></div>', () => {
    assertMatrix(capture(describe('content:id:aria')), { headers: ['項目', '値'], rows: [['eFTP', '250 W']] });
  });
  withPage('<section id="cards"><article><dl><dt>品名</dt><dd>ペン</dd><dt>数量</dt><dd>0</dd></dl></article><article><dl><dt>数量</dt><dd>2</dd><dt>品名</dt><dd>ノート</dd></dl></article></section>', () => {
    assertMatrix(capture(describe('content:id:cards')), { headers: ['品名', '数量'], rows: [['ペン', '0'], ['ノート', '2']] });
  });
});

test('document hierarchy compatibility: mixed prose and a table keep the existing ordered padded matrix', () => withPage(
  `<main id="mixed"><h1>月次メモ</h1><p>導入</p><p>もう一段落</p><h2>売上</h2>${MERGED_TABLE}<h2>補足</h2><p>結び</p></main>`, () => {
    assertMatrix(capture(describe('content:id:mixed')), {
      headers: ['列1', '列2', '列3'], layout: 'composite',
      rows: [
        ['月次メモ', '導入', ''], ['月次メモ', 'もう一段落', ''], ['月次メモ / 売上', '', ''],
        ['品目', '金額 / 税込', '金額 / 税'], ['架空商品', '110', '10'], ['', '220', '20'], ['月次メモ / 補足', '結び', ''],
      ],
    });
  },
));

test('document hierarchy compatibility: prose mixed with ARIA or repeated cards also keeps the existing local header rows', () => {
  withPage('<main id="mixed-aria"><h1>メモ</h1><p>前置き</p><div role="table"><div role="row"><span role="columnheader">項目</span><span role="columnheader">値</span></div><div role="row"><span role="cell">出力</span><span role="cell">CSV</span></div></div></main>', () => {
    assertMatrix(capture(describe('content:id:mixed-aria')), { headers: ['列1', '列2'], layout: 'composite', rows: [['メモ', '前置き'], ['項目', '値'], ['出力', 'CSV']] });
  });
  withPage('<main id="mixed-cards"><h1>商品メモ</h1><p>前置き</p><section><article><dl><dt>品名</dt><dd>ペン</dd><dt>数量</dt><dd>0</dd></dl></article><article><dl><dt>品名</dt><dd>ノート</dd><dt>数量</dt><dd>2</dd></dl></article></section></main>', () => {
    assertMatrix(capture(describe('content:id:mixed-cards')), { headers: ['列1', '列2'], layout: 'composite', rows: [['商品メモ', '前置き'], ['品名', '数量'], ['ペン', '0'], ['ノート', '2']] });
  });
});

test('document hierarchy compatibility: adjacent declared HTML tables retain local headers instead of guessed positional cells', () => withPage(
  '<main id="adjacent-tables"><table><thead><tr><th>項目</th><th>値</th></tr></thead><tbody><tr><td>送料</td><td>55</td></tr></tbody></table>'
  + '<table><thead><tr><th>項目</th><th>値</th></tr></thead><tbody><tr><td>手数料</td><td>20</td></tr></tbody></table></main>', () => {
    assertMatrix(capture(describe('content:id:adjacent-tables')), {
      headers: ['列1', '列2'], layout: 'composite', rows: [['項目', '値'], ['送料', '55'], ['項目', '値'], ['手数料', '20']],
    });
  },
));

test('document hierarchy compatibility: adjacent declared ARIA tables retain local headers instead of guessed positional cells', () => withPage(
  '<main id="adjacent-aria"><div role="table"><div role="row"><span role="columnheader">項目</span><span role="columnheader">値</span></div><div role="row"><span role="cell">送料</span><span role="cell">55</span></div></div>'
  + '<div role="table"><div role="row"><span role="columnheader">項目</span><span role="columnheader">値</span></div><div role="row"><span role="cell">手数料</span><span role="cell">20</span></div></div></main>', () => {
    assertMatrix(capture(describe('content:id:adjacent-aria')), {
      headers: ['列1', '列2'], layout: 'composite', rows: [['項目', '値'], ['送料', '55'], ['項目', '値'], ['手数料', '20']],
    });
  },
));

test('document hierarchy compatibility: heading-free paragraphs and a heading-free definition list keep their previous fallback', () => {
  withPage('<div id="plain"><p>一つ目の文章</p><p>同じ文章</p><p>同じ文章</p></div>', () => {
    assertMatrix(capture(describe('content:id:plain')), { headers: ['タイトル', '内容'], rows: [['選択範囲', '一つ目の文章'], ['選択範囲', '同じ文章'], ['選択範囲', '同じ文章']] });
  });
  withPage('<dl id="plain-definition"><dt>形式</dt><dd>CSV</dd><dt>数量</dt><dd>0</dd></dl>', () => {
    assertMatrix(capture(describe('content:id:plain-definition')), { headers: ['項目', '内容'], rows: [['形式', 'CSV'], ['数量', '0']] });
  });
});
