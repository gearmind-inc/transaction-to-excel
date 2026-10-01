import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { LIMITS, type InspectRequest, type TableCandidate } from '../src/contracts.js';
import { inspectPage } from '../src/extraction.js';
import { buildPreview } from '../src/transform.js';
import { generateCsv } from '../src/csv.js';
import { COLUMNS } from './fixtures/expected.js';
import { parseCsv } from './oracle.js';

// Independent, hand-authored expectations. Never derive these from inspectPage output.
const CONTENT_URL = 'https://fixture.example/guide';
const CONTENT_HEADERS = ['H1', 'H2', 'H3', '内容'];
const CONTENT_ROWS = [
  ['利用ガイド', '', '', '表示中の文書を保存します。'],
  ['', '準備', '', '画面を開き、内容を確認します。\nログイン名\n保存操作:保存\n編集メニュー'],
  ['', '', '', '関連情報'],
  ['', '', '', '更新情報'],
  ['', '読み取り', '', '画面の本文だけを扱います。\n次の段落も残します。'],
  ['', '読み取り', '内容の例', '最初の項目\n二番目の項目\n対象：読み込み済みの内容\n出力：CSV'],
  ['', '読み取り', 'コード', 'const example = "日本語";\n  console.log(example);'],
  ['', '確認', '', '同じ内容\n同じ内容'],
];
const fixture = readFileSync(new URL('./fixtures/content.html', import.meta.url), 'utf8');

function withPage<T>(html: string, action: () => T): T {
  const dom = new JSDOM(html, { url: CONTENT_URL });
  const keys = ['window', 'document', 'location', 'Node', 'HTMLElement', 'HTMLTableElement', 'getComputedStyle'] as const;
  const descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
  try { return action(); } finally {
    for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    dom.window.close();
  }
}

function contentRequest(mode: InspectRequest['mode'], overrides: Partial<InspectRequest> = {}): InspectRequest {
  return { mode, kind: 'content', expectedUrl: CONTENT_URL, requestId: 'content-request', limits: LIMITS, ...overrides };
}
function describe(key?: string): TableCandidate {
  const result = inspectPage(contentRequest('describe', key ? { tableKey: key } : {}));
  assert.equal(result.error, undefined, 'a rendered document must be selectable without an HTML table');
  assert.equal(result.tables?.length, 1, 'describe must return one selected region, not a table list');
  const candidate = result.tables![0];
  assert.equal(candidate.kind, 'content');
  assert.ok(candidate.headers.length > 0 && candidate.headers.length <= LIMITS.columns);
  assert.equal(candidate.index, 0);
  assert.equal(typeof candidate.contentSignature, 'string', 'selected heading structure needs a bounded fingerprint');
  assert.ok(candidate.contentSignature!.length > 0 && candidate.contentSignature!.length <= 128);
  return candidate;
}
function capture(candidate: TableCandidate, overrides: Partial<InspectRequest> = {}) {
  return inspectPage(contentRequest('capture', {
    tableIndex: candidate.index, tableKey: candidate.key, headers: candidate.headers,
    contentSignature: candidate.contentSignature, sourceIndexes: candidate.headers.map((_, index) => index), ...(candidate.layout ? { layout: candidate.layout } : {}), ...overrides,
  }));
}

test('document evaluator: table discovery remains unchanged while whole-page describe selects body', () => withPage(fixture, () => {
  const ordinary = inspectPage({ mode: 'list', expectedUrl: CONTENT_URL, requestId: 'content-request', limits: LIMITS });
  assert.deepEqual(ordinary.tables, [], 'a non-table page must not silently become an ordinary table candidate');
  const candidate = describe();
  assert.equal(candidate.key, 'content:id:page');
  assert.ok(typeof candidate.label === 'string' && candidate.label.length <= 100);
  assert.ok(!JSON.stringify(candidate).includes('do-not-capture-input'), 'discovery cannot expose input values');
  const result = capture(candidate);
  assert.equal(result.error, undefined);
  assert.ok(result.capture!.rows.some(row => row[3].includes('サイトの案内')));
  assert.ok(result.capture!.rows.some(row => row[3].includes('ページ移動')));
  assert.ok(result.capture!.rows.some(row => row[3].includes('do-not-capture-other-region')), 'whole-page range includes the other visible region');
}));

test('document evaluator: section hierarchy, visible text, duplicate paragraphs and code match the fixed oracle', () => withPage(fixture, () => {
  const candidate = describe('content:id:guide');
  assert.equal(candidate.rowCount, CONTENT_ROWS.length);
  const result = capture(candidate);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.capture?.headers, CONTENT_HEADERS);
  assert.deepEqual(result.capture?.rows, CONTENT_ROWS, 'each visible text block must belong to exactly one section');
  assert.equal(result.capture?.tableKey, 'content:id:guide');
  assert.equal(result.capture?.scope, 'current-page');
  assert.equal(result.capture?.requestId, 'content-request');
  assert.ok(!JSON.stringify(result.capture).includes('do-not-capture'));
  assert.ok(!JSON.stringify(result.capture).includes('secret.example'), 'link destinations and attributes are not content');
}));

test('document evaluator: selecting only content preserves exact text and uses the existing preview and CSV path', () => withPage(fixture, () => {
  const result = capture(describe('content:id:guide'), { sourceIndexes: [3] });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.capture?.rows, CONTENT_ROWS.map(row => [row[3]]));
  const preview = buildPreview(result.capture!, [{ ...COLUMNS[0], sourceIndex: 3, outputName: '内容', kind: 'text', required: false }]);
  assert.equal(preview.errorCount, 0);
  assert.deepEqual(parseCsv(generateCsv(preview)), [['内容'], ...CONTENT_ROWS.map(row => [row[3]])]);
}));

test('document evaluator: arbitrary visible card regions can be selected independently from main', () => withPage(
  '<main id="guide"><h1>案内</h1><p>対象外</p></main><section id="power"><h2>パワー</h2><div><p>期間: 30日</p><p>eFTP: 250 W</p><p>W\': 0 kJ</p></div></section>', () => {
    const candidate = describe('content:id:power');
    const result = capture(candidate);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.rows, [['', 'パワー', "期間: 30日\neFTP: 250 W\nW': 0 kJ"]]);
    assert.ok(!JSON.stringify(result.capture).includes('対象外'));
  },
));

test('document evaluator: a legacy div document without main or article remains an explicitly selectable range', () => withPage(
  '<div>上部の操作</div><div><div id="legacy"><div><h1>Javaツール</h1></div><p>導入</p><h2>形式</h2><p>command [options]</p><h2>説明</h2><p>説明本文</p></div></div><div>下部の操作</div>', () => {
    const candidate = describe('content:id:legacy');
    assert.equal(candidate.key, 'content:id:legacy');
    const result = capture(candidate);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.rows, [['Javaツール', '', '導入'], ['Javaツール', '形式', 'command [options]'], ['Javaツール', '説明', '説明本文']]);
  },
));

test('document evaluator: nested wrappers never repeat descendant paragraphs', () => withPage(
  '<article id="article"><header><h1>本文</h1></header><div><div><p>一度だけ</p><p>二段落目</p></div></div><h2>次</h2><div>単独の表示テキスト<span>と続き</span></div></article>', () => {
    const result = capture(describe('content:id:article'));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.rows, [['本文', '', ''], ['', '', '一度だけ\n二段落目'], ['', '次', '単独の表示テキストと続き']]);
  },
));

test('document evaluator: long sections split between complete paragraphs without truncation', () => withPage(
  '<main id="long"><h1>長い章</h1><p>' + 'a'.repeat(6000) + '</p><p>' + 'b'.repeat(6000) + '</p><p>終わり</p></main>', () => {
    const candidate = describe('content:id:long');
    assert.equal(candidate.rowCount, 2);
    const result = capture(candidate);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.rows, [['長い章', 'a'.repeat(6000)], ['長い章', 'b'.repeat(6000) + '\n終わり']]);
    assert.ok(result.capture!.rows.every(row => row.every(cell => cell.length <= LIMITS.cellChars)));
  },
));

test('document evaluator: an indivisible paragraph or code block over 10000 characters fails without partial data', () => {
  for (const tag of ['p', 'pre']) withPage(`<main id="long"><h1>長い章</h1><${tag}>${'x'.repeat(10001)}</${tag}></main>`, () => {
    const described = inspectPage(contentRequest('describe', { tableKey: 'content:id:long' }));
    const candidate = described.tables?.[0];
    const stopped = described.error ? described : candidate?.error ? { error: candidate.error } : capture(candidate!);
    assert.match(stopped.error ?? '', /10,?000|文字数|上限/, 'indivisible blocks must explain the safety limit');
    assert.equal('capture' in stopped ? stopped.capture : undefined, undefined, 'failure cannot expose a prefix of the document');
  });
});

test('document evaluator: loaded offscreen paragraphs count, while collapsed details and hidden ancestors do not', () => withPage(
  '<main id="visible"><h1>画面の内容</h1><p style="margin-top:10000px">読み込み済み</p><details><summary>説明</summary><p>do-not-capture-collapsed</p></details><div hidden><h2>do-not-capture-heading</h2><p>do-not-capture-hidden-parent</p></div></main>', () => {
    const result = capture(describe('content:id:visible'));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.rows, [['画面の内容', '読み込み済み\n説明']]);
    assert.ok(!JSON.stringify(result.capture).includes('do-not-capture'));
  },
));

test('document evaluator: graphics and frames are disclosed, SVG text is retained, no graphical values are invented', () => withPage(
  '<main id="chart"><h1>グラフ</h1><p>eFTP: 250 W</p><svg><path d="M0 0L100 50"></path><text>250 W</text><text hidden>do-not-capture-svg-hidden</text></svg><canvas data-values="do-not-capture-canvas">do-not-capture-canvas-fallback</canvas><img src="/chart.png" alt="do-not-capture-image-alt"><iframe src="/other">do-not-capture-frame</iframe><p>説明</p></main>', () => {
    const candidate = describe('content:id:chart');
    const result = capture(candidate);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.rows, [['グラフ', 'eFTP: 250 W\n250 W\n説明']]);
    assert.ok(result.capture?.warnings?.some(value => /グラフ|図形|画像|Canvas|canvas|SVG/.test(value)), 'omitted graphical content must be disclosed');
    assert.ok(result.capture?.warnings?.some(value => /frame|iframe|フレーム/.test(value)), 'frame boundaries must be disclosed');
    assert.ok(!JSON.stringify(result.capture).includes('do-not-capture'));
  },
));

test('document evaluator: merged visual headers retain their declared column groups inside a mixed rectangle', () => withPage(
  '<main id="mixed"><h1>結果</h1><table><thead><tr><th colspan="2">測定</th></tr><tr><th>項目</th><th>値</th></tr></thead><tbody><tr><td>eFTP</td><td>250 W</td></tr><tr hidden><td>do-not-capture-hidden-row</td><td>hidden</td></tr></tbody></table><p>補足</p></main>', () => {
    const result = capture(describe('content:id:mixed'));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.headers, ['列1', '列2']);
    assert.equal(result.capture?.layout, 'composite');
    assert.deepEqual(result.capture?.rows, [['結果', ''], ['測定 / 項目', '測定 / 値'], ['eFTP', '250 W'], ['結果', '補足']]);
    assert.ok(!JSON.stringify(result.capture).includes('do-not-capture'));
  },
));

test('document evaluator: replacing the selected root or changing heading structure invalidates the selection', () => {
  withPage('<main id="guide"><h1>文書</h1><p>元の内容</p></main>', () => {
    const candidate = describe('content:id:guide');
    document.getElementById('guide')!.outerHTML = '<main id="guide"><h1>文書</h1><p>別文書</p></main>';
    const result = capture(candidate);
    assert.ok(result.error, 'same key and headers cannot accept a replacement DOM node');
    assert.equal(result.capture, undefined);
  });
  withPage('<main id="guide"><h1>文書</h1><h2>章</h2><p>内容</p></main>', () => {
    const candidate = describe('content:id:guide');
    document.querySelector('h2')!.textContent = '別の章';
    const result = capture(candidate);
    assert.ok(result.error, 'constant title/content headers cannot hide changed section structure');
    assert.equal(result.capture, undefined);
  });
});

test('document evaluator: refreshed displayed values are allowed in the same selected region and heading structure', () => withPage(
  '<main id="guide"><h1>測定</h1><p>eFTP: 250 W</p></main>', () => {
    const candidate = describe('content:id:guide');
    document.querySelector('p')!.textContent = 'eFTP: 251 W';
    const result = capture(candidate);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.rows, [['測定', 'eFTP: 251 W']]);
    assert.equal(result.capture?.contentSignature, candidate.contentSignature);
  },
));

test('document evaluator: foreign key/signature/URL/headers and malformed DOM paths cannot redirect capture', () => withPage(fixture, () => {
  const candidate = describe('content:id:guide');
  for (const overrides of [
    { tableKey: 'content:id:other' }, { contentSignature: 'foreign-signature' },
    { expectedUrl: 'https://fixture.example/other' }, { headers: ['別タイトル', '内容'] },
    { tableKey: 'content:dom:html[1]/body[1]/main[1],#other' },
    { sourceIndexes: [0, 0] }, { sourceIndexes: [4] },
  ] satisfies Partial<InspectRequest>[]) {
    const result = capture(candidate, overrides);
    assert.ok(result.error, 'selection provenance and syntax must be rechecked');
    assert.equal(result.capture, undefined);
  }
}));

test('document evaluator: row and total-character limits stop content without silently truncating it', () => {
  const pages = [
    '<main id="large"><h1>長文</h1>' + '<h2>章</h2><p>内容</p>'.repeat(5001) + '</main>',
    '<main id="large"><h1>長文</h1>' + ('<p>' + 'x'.repeat(5000) + '</p>').repeat(401) + '</main>',
  ];
  for (const html of pages) withPage(html, () => {
    const result = inspectPage(contentRequest('describe', { tableKey: 'content:id:large' }));
    assert.match(result.error ?? result.tables?.[0].error ?? '', /上限/, 'oversized content must explain why extraction stopped');
    assert.equal(result.capture, undefined);
  });
});

test('document evaluator: same-surrogate emoji heading changes invalidate the structural fingerprint', () => withPage(
  '<main id="guide"><h1>😎</h1><p>内容</p></main>', () => {
    const candidate = describe('content:id:guide');
    document.querySelector('h1')!.textContent = '🤓';
    const result = capture(candidate);
    assert.ok(result.error, 'fingerprints must compare complete Unicode characters');
    assert.equal(result.capture, undefined);
  },
));

test('document evaluator: a content selection without a unique id has a parsed DOM path identity', () => withPage(
  '<main><section><h2>カード</h2><p>表示本文</p></section></main>', () => {
    const candidate = describe('content:dom:html[1]/body[2]/main[1]/section[1]');
    const result = capture(candidate);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.rows, [['', 'カード', '表示本文']]);
  },
));

test('table describe evaluator: pointer-selected tables expose current metadata before column headers are known', () => withPage(
  '<table id="normal"><tr><th>A</th><th>B</th></tr><tr><td>x</td><td>y</td></tr></table><table id="merged"><tr><th colspan="2">見出し</th></tr><tr><td>x</td><td>y</td></tr></table>', () => {
    const request: InspectRequest = { mode: 'describe', expectedUrl: CONTENT_URL, requestId: 'table-describe', tableIndex: 0, tableKey: 'id:normal', limits: LIMITS };
    const result = inspectPage(request);
    assert.equal(result.error, undefined, 'a picked normal table must be described without preexisting headers');
    assert.deepEqual(result.tables, [{ index: 0, key: 'id:normal', headers: ['A', 'B'], rowCount: 1 }]);
    const merged = inspectPage({ ...request, tableIndex: 1, tableKey: 'id:merged' });
    assert.equal(merged.error, undefined, 'declared merged headers are now represented by their explicit slots');
    assert.deepEqual(merged.tables, [{ index: 1, key: 'id:merged', headers: ['見出し', '見出し'], rowCount: 1 }]);
  },
));

test('table describe evaluator: a pointer-selected table replaced under the same id cannot be reinterpreted', () => withPage(
  '<table id="normal"><tr><th>A</th></tr><tr><td>x</td></tr></table>', () => {
    const selected = document.getElementById('normal')!;
    Object.assign(window, { __transactionToExcelPickedV1: { requestId: 'pick-request', key: 'id:normal', element: selected } });
    const request: InspectRequest = { mode: 'describe', expectedUrl: CONTENT_URL, requestId: 'table-describe', tableIndex: 0, tableKey: 'id:normal', limits: LIMITS };
    assert.equal(inspectPage(request).error, undefined, 'the unchanged pointer-selected node must first be accepted');
    selected.outerHTML = '<table id="normal"><tr><th>A</th></tr><tr><td>replacement</td></tr></table>';
    const result = inspectPage(request);
    assert.ok(result.error);
    assert.equal(result.tables, undefined);
  },
));

test('document evaluator: selecting a heading alone retains that visible title as a row', () => withPage(
  '<main><h1 id="heading">見出しだけ</h1><p>選択外の段落</p></main>', () => {
    const result = capture(describe('content:id:heading'));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.rows, [['見出しだけ', '']]);
  },
));

test('document evaluator: heading-bearing inline wrappers preserve their inner section structure', () => withPage(
  '<main id="guide"><h1>ガイド</h1><span><h2>章</h2><p>内側の本文</p></span></main>', () => {
    const result = capture(describe('content:id:guide'));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.rows, [['ガイド', '', ''], ['ガイド', '章', '内側の本文']]);
  },
));

test('document evaluator: visible descendants can override a hidden ancestor visibility without reading its hidden text', () => withPage(
  '<main id="guide"><h1>ガイド</h1><div style="visibility:hidden"><p>do-not-capture-hidden</p><section style="visibility:visible"><h2>見える章</h2><p>表示本文</p></section></div></main>', () => {
    const result = capture(describe('content:id:guide'));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.rows, [['ガイド', '', ''], ['ガイド', '見える章', '表示本文']]);
  },
));

test('document evaluator: SVG nested inside a paragraph preserves displayed text and still discloses omitted shapes', () => withPage(
  '<main id="guide"><h1>グラフ</h1><p>グラフの表示<svg><path d="M0 0L10 10"></path><text>250 W</text><text>0 W</text><defs><text>do-not-capture-definition</text></defs></svg></p></main>', () => {
    const result = capture(describe('content:id:guide'));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.rows, [['グラフ', 'グラフの表示\n250 W\n0 W']]);
    assert.ok(result.capture?.warnings?.some(value => /SVG/.test(value)));
  },
));

test('document evaluator: button labels are valid standalone ranges while input values and pure images are not textual captures', () => {
  withPage('<button id="action">保存</button>', () => {
    const result = capture(describe('content:id:action'));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.rows, [['選択範囲', '保存']]);
  });
  for (const html of ['<input id="private" type="password" value="do-not-capture-password">', '<img id="private" src="/chart.png" alt="do-not-capture-alt">']) withPage(html, () => {
    const result = inspectPage(contentRequest('describe', { tableKey: 'content:id:private' }));
    assert.ok(result.error, 'a range without readable displayed text cannot pretend to produce rows');
    assert.equal(result.capture, undefined);
    assert.ok(!JSON.stringify(result).includes('do-not-capture'));
  });
});

test('document evaluator: CSS block spans inside a paragraph retain visible line boundaries', () => withPage(
  '<main id="guide"><h1>案内</h1><p><span style="display:block">A</span><span style="display:block">B</span></p></main>', () => {
    const result = capture(describe('content:id:guide'));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.capture?.rows, [['案内', 'A\nB']]);
  },
));

test('document evaluator: excluded input/select/textarea values receive a fixed warning while visible labels remain', () => {
  for (const control of ['<input value="do-not-capture-input-value">', '<select><option>do-not-capture-option-value</option></select>', '<textarea>do-not-capture-textarea-value</textarea>']) withPage(
    '<main id="guide"><h1>入力確認</h1><p><label>表示ラベル' + control + '</label></p></main>', () => {
      const input = document.querySelector('input,select,textarea')!;
      Object.defineProperty(input, 'value', { get() { throw new Error('form values must not be read'); } });
      const candidate = describe('content:id:guide');
      assert.ok(candidate.warnings?.some(value => /入力|フォーム/.test(value)), 'discovery must disclose excluded controls');
      const result = capture(candidate);
      assert.equal(result.error, undefined);
      assert.deepEqual(result.capture?.rows, [['入力確認', '表示ラベル']]);
      assert.ok(result.capture?.warnings?.some(value => /入力|フォーム/.test(value)), 'capture must retain the exclusion warning');
      assert.ok(!JSON.stringify(result).includes('do-not-capture'));
    },
  );
});
