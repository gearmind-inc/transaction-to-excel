import { test as base, expect, chromium, type BrowserContext, type Page, type Worker, type TestInfo } from '@playwright/test';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { arch, cpus, release, totalmem, loadavg } from 'node:os';

import { parseCsv } from '../oracle';

const fixtureUrl = 'http://127.0.0.1:4173/transactions';
const host = () => ({ platform: process.platform, osRelease: release(), architecture: arch(), cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), loadAverage: loadavg() });
type Harness = { context: BrowserContext; source: Page; workspace: Page; serviceWorker: Worker; extensionId: string; tabId: number; requests: string[]; downloadDirectory: string };

/**
 * Real unpacked MV3 code, real Chrome scripting/storage/worker/download APIs.
 * ONLY this disposable copy receives a loopback host grant because Playwright
 * cannot press Chrome's toolbar action to grant production activeTab.
 * CDP selects an isolated download directory instead of the native Save As UI.
 * The workspace URL with ?tab=N is a test harness route, not native side-panel
 * activation. Therefore these tests do not prove toolbar activation, native
 * side-panel lifecycle, activeTab activation, or native Save As dialogs.
 */
async function launchHarness(testInfo: TestInfo, profile?: string): Promise<Harness> {
  const production = resolve('dist/extension');
  const temporary = testInfo.outputPath('test-only-extension');
  const manifest = JSON.parse(await readFile(resolve(production, 'manifest.json'), 'utf8'));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toEqual(['activeTab', 'scripting', 'storage', 'downloads', 'sidePanel']);
  expect(manifest.side_panel).toEqual({ default_path: 'workspace.html' });
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.optional_host_permissions).toBeUndefined();
  await mkdir(temporary, { recursive: true });
  await cp(production, temporary, { recursive: true });
  await writeFile(resolve(temporary, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: ['http://127.0.0.1/*'] }));
  const downloadDirectory = testInfo.outputPath('downloads');
  await mkdir(downloadDirectory, { recursive: true });
  const context = await chromium.launchPersistentContext(profile ?? testInfo.outputPath('temporary-profile'), {
    channel: 'chromium', headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${temporary}`, `--load-extension=${temporary}`],
    viewport: { width: 1440, height: 1000 },
  });
  const requests: string[] = [];
  context.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).hostname;
  const nextPage = context.waitForEvent('page');
  const tab = await serviceWorker.evaluate(async url => chrome.tabs.create({ url }), fixtureUrl);
  const source = await nextPage;
  await source.waitForURL(fixtureUrl);
  await expect(source.locator('#transactions tbody tr')).toHaveCount(7);
  // Synthetic secret markers demonstrate that query/hash are not persisted.
  await source.evaluate(() => history.replaceState(null, '', '?session=do-not-store#private'));
  const workspace = await context.newPage();
  await workspace.goto(`chrome-extension://${extensionId}/workspace.html?tab=${tab.id}`);
  await expect(workspace.locator('#status')).toContainText(/(?:範囲|表).*選/);
  // Table-list selection is still available as a disclosed alternative to the
  // page picker. Open that disclosure for the table-list regression flows.
  await workspace.locator('details.source-options > summary').click();
  return { context, source, workspace, serviceWorker, extensionId, tabId: tab.id!, requests, downloadDirectory };
}

const test = base.extend<{ harness: Harness }>({
  harness: async ({}, use, testInfo) => {
    const harness = await launchHarness(testInfo);
    try { await use(harness); }
    finally {
      await harness.context.close();
      // Never leave a browser profile containing synthetic transaction data.
      await rm(testInfo.outputPath('temporary-profile'), { recursive: true, force: true });
      await rm(testInfo.outputPath('test-only-extension'), { recursive: true, force: true });
    }
  },
});

const previewColumn = (page: Page, sourceColumn: number) => page.locator(`#preview th[data-source-index="${sourceColumn - 1}"] button`);
async function editColumn(page: Page, sourceColumn: number): Promise<void> {
  await previewColumn(page, sourceColumn).click();
  await expect(page.locator('#column-editor')).toBeVisible();
}
const visible = (value: string) => value === '' ? '［空欄］' : value.replace(/\t/g, '⟦TAB⟧').replace(/\r/g, '⟦CR⟧').replace(/\n/g, '⟦LF⟧\n').replace(/\0/g, '⟦NUL⟧');
const displayedValue = (value: string) => value === '' ? '［空欄］' : value;
const previewNames = (page: Page) => page.locator('#preview th[data-source-index] button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')?.replace(/：この列を調整$/, '')));
async function assertPanelVisibleWithoutAnotherAction(page: Page, id: string): Promise<void> {
  const rectangle = await page.locator(`#${id}`).evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  expect(rectangle.width).toBeGreaterThan(0); expect(rectangle.height).toBeGreaterThan(0);
  expect(rectangle.x).toBeGreaterThanOrEqual(-1); expect(rectangle.y).toBeGreaterThanOrEqual(-1);
  expect(rectangle.right).toBeLessThanOrEqual(rectangle.viewportWidth + 1);
  expect(rectangle.bottom).toBeLessThanOrEqual(rectangle.viewportHeight + 1);
}

// Fixed text-only browser oracle: raw dates and amounts remain strings. The
// protected CSV cells are specified here independently of product code.
const t = (raw: string, output = raw) => ({ raw, logical: raw, output });
const EXPECTED_PREVIEW = { rows: [
  [t('2026/10/01'), t('日本語,"引用"\n二行目'), t('¥1,234.50'), t('00001'), t('')],
  [t('2024/02/29'), t('=SUM(1,2)', '\t=SUM(1,2)'), t('-¥330', '\t-¥330'), t('12345678901234567890'), t('0')],
  [t('2026/10/02'), t('+81-90-0000', '\t+81-90-0000'), t('¥0'), t('00003'), t('')],
  [t('2026/10/02'), t('@name', '\t@name'), t('¥12.00'), t('00004'), t('')],
  [t('2026/10/03'), t(' \t＝1+2', '\t \t＝1+2'), t('¥00001.2300'), t('00005'), t('')],
  [t('2026/10/04'), t('同値の別取引'), t('¥20.00'), t('00777'), t('')],
  [t('2026/10/04'), t('同値の別取引'), t('¥20.00'), t('00777'), t('')],
  [t('2026/10/05'), t('-1+2', '\t-1+2'), t('-¥0.50', '\t-¥0.50'), t('00008'), t('備考')],
] };
const EXPECTED_CSV = '\uFEFF"日付","内容","取引額","取引ID","任意メモ"\r\n'
  + '"2026/10/01","日本語,""引用""\n二行目","¥1,234.50","00001",""\r\n'
  + '"2024/02/29","\t=SUM(1,2)","\t-¥330","12345678901234567890","0"\r\n'
  + '"2026/10/02","\t+81-90-0000","¥0","00003",""\r\n'
  + '"2026/10/02","\t@name","¥12.00","00004",""\r\n'
  + '"2026/10/03","\t \t＝1+2","¥00001.2300","00005",""\r\n'
  + '"2026/10/04","同値の別取引","¥20.00","00777",""\r\n'
  + '"2026/10/04","同値の別取引","¥20.00","00777",""\r\n'
  + '"2026/10/05","\t-1+2","\t-¥0.50","00008","備考"\r\n';
async function configureGolden(page: Page): Promise<void> {
  await page.locator('#table').selectOption('1');
  await expect(page.locator('#coverage')).toContainText('8件 / 6列');
  await expect(page.locator('#preview tbody tr')).toHaveCount(8);
  await editColumn(page, 6); await page.locator('#column-hide').click();
  for (const [column, name] of [[1, '取引ID'], [2, '日付'], [3, '内容'], [4, '取引額'], [5, '任意メモ']] as const) {
    await editColumn(page, column); await page.locator('#column-name').fill(name);
  }
  await editColumn(page, 1);
  for (let index = 0; index < 3; index++) await page.locator('#column-right').click();
  await page.locator('#column-close').click();
}
async function captureGolden(page: Page): Promise<void> {
  await configureGolden(page);
  await expect(page.locator('#summary')).toContainText('取得 8件 / 出力 8件・5列 / 空欄 6セル / CSV保護 7件');
}

async function storage(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => chrome.storage.local.get(null));
}

async function assertOtherStorageEmpty(page: Page): Promise<void> {
  expect(await page.evaluate(async () => ({
    localStorageEntries: localStorage.length,
    sessionStorageEntries: sessionStorage.length,
    indexedDBNames: (await indexedDB.databases()).map(database => database.name),
    sync: await chrome.storage.sync.get(null),
  }))).toEqual({ localStorageEntries: 0, sessionStorageEntries: 0, indexedDBNames: [], sync: {} });
}

test('real unpacked MV3: chosen table, literal text, preview and saved CSV bytes match independent oracle', async ({ harness }, testInfo) => {
  const { workspace, requests, downloadDirectory } = harness;
  const otherTab = await harness.context.newPage();
  await otherTab.goto(fixtureUrl);
  await otherTab.locator('#transactions tbody tr').first().locator('td').first().evaluate(cell => { cell.textContent = 'do-not-capture-other-tab'; });
  // Linux may suspend animation frames in a background tab, blocking the
  // click stability check. Resume the workspace the user is operating.
  await workspace.bringToFront();
  await captureGolden(workspace);
  const displayed = await workspace.locator('#preview tbody tr').evaluateAll(rows => rows.map(row => Array.from(row.querySelectorAll('td')).slice(1).map(cell => cell.querySelector('.cell-value')?.textContent)));
  expect(displayed).toEqual(EXPECTED_PREVIEW.rows.map(row => row.map(cell => displayedValue(cell.logical))));
  // Raw/converted/protected bytes remain individually inspectable; the default
  // grid now displays each value only once instead of repeating three lines.
  for (let row = 0; row < EXPECTED_PREVIEW.rows.length; row++) {
    for (let column = 0; column < EXPECTED_PREVIEW.rows[row].length; column++) {
      await workspace.locator('#preview tbody tr').nth(row).locator('td').nth(column + 1).getByRole('button').click();
      const cell = EXPECTED_PREVIEW.rows[row][column];
      await expect(workspace.locator('#cell-detail .cell-line')).toHaveText([`元の文字列：${visible(cell.raw)}`, `表の値：${visible(cell.logical)}`, `CSV値：${visible(cell.output)}`]);
    }
  }
  expect(await workspace.locator('#preview').innerText()).not.toMatch(/do-not-capture/);
  await expect(workspace.locator('#save')).toBeDisabled();
  await workspace.locator('#confirm').check();
  const session = await harness.context.newCDPSession(workspace);
  const begun: string[] = [];
  session.on('Browser.downloadWillBegin', event => begun.push(event.guid));
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory, eventsEnabled: true });
  // Exercise rapid repeated activation; the production state machine must save once.
  await workspace.locator('#save').evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(workspace.locator('#save-status')).toContainText('CSVを保存しました');
  await expect(workspace.locator('#save')).toBeDisabled();
  const record = await storage(workspace);
  expect(Object.keys(record)).toEqual(['saveAttemptV1']);
  const downloadId = (record.saveAttemptV1 as { downloadId: number }).downloadId;
  const downloads = await workspace.evaluate(async id => chrome.downloads.search({ id }), downloadId);
  expect(downloads).toHaveLength(1);
  expect(downloads[0].state).toBe('complete');
  expect(begun).toHaveLength(1);
  expect(downloads[0].filename.startsWith(downloadDirectory + sep)).toBeTruthy();
  const actual = await readFile(downloads[0].filename);
  expect(actual).toEqual(Buffer.from(EXPECTED_CSV, 'utf8'));
  expect(parseCsv(actual)).toEqual([['日付', '内容', '取引額', '取引ID', '任意メモ'], ...EXPECTED_PREVIEW.rows.map(row => row.map(cell => cell.output))]);
  expect(JSON.stringify(record)).not.toMatch(/00001|12345678901234567890|日本語|SUM|session|do-not-/);
  await assertOtherStorageEmpty(workspace);
  expect(requests.every(url => new URL(url).origin === new URL(fixtureUrl).origin)).toBeTruthy();
  await testInfo.attach('test-environment', { body: JSON.stringify({ browser: harness.context.browser()?.version(), host: host(), permissionDifference: 'test-only loopback host grant; activeTab activation not covered', saveDialogDifference: 'CDP isolated download directory; native Save As UI not covered', actualSavedBytes: actual.length }, null, 2), contentType: 'application/json' });
});

test('column edits invalidate confirmation; ambiguous date and currency strings remain literal without deferred conversion controls', async ({ harness }) => {
  const page = harness.workspace; await captureGolden(page);
  await page.locator('#confirm').check(); await editColumn(page, 3);
  await page.locator('#column-name').fill('変更した内容');
  await expect(page.locator('#confirm')).not.toBeChecked(); await expect(page.locator('#save')).toBeDisabled();
  await expect(page.locator('#preview thead')).toContainText('変更した内容');
  await expect(page.locator('#column-kind, #column-required, #preset, #save-preset')).toHaveCount(0);
  await harness.source.locator('#transactions tbody tr').first().locator('td').nth(1).evaluate(cell => { cell.textContent = '01/02/2026'; });
  await page.locator('#capture').click();
  await expect(page.locator('#summary')).toContainText('取得 8件 / 出力 8件・6列');
  await expect(page.locator('#preview tbody tr').first().locator('td').nth(2)).toContainText('01/02/2026');
  await page.locator('#preview tbody tr').first().locator('td').nth(2).getByRole('button').click();
  await expect(page.locator('#cell-detail .cell-line')).toHaveText(['元の文字列：01/02/2026', '表の値：01/02/2026', 'CSV値：01/02/2026']);
  await expect(page.locator('#confirm')).toBeEnabled(); expect(await storage(page)).toEqual({});
});

test('service worker stop does not own transaction memory; reload loses transactions instead of restoring them', async ({ harness }) => {
  const page = harness.workspace;
  await captureGolden(page);
  const session = await harness.context.newCDPSession(page);
  const versions: { scriptURL: string; runningStatus: string }[] = [];
  session.on('ServiceWorker.workerVersionUpdated', event => versions.push(...event.versions));
  await session.send('ServiceWorker.enable');
  await session.send('ServiceWorker.stopAllWorkers');
  await expect.poll(() => versions.some(version => version.scriptURL === harness.serviceWorker.url() && version.runningStatus === 'stopped')).toBeTruthy();
  await expect(page.locator('#preview tbody tr')).toHaveCount(8);
  await editColumn(page, 3);
  await page.locator('#column-name').fill('Worker停止後の内容');
  await expect(page.locator('#summary')).toContainText('取得 8件 / 出力 8件');
  await page.reload();
  await expect(page.locator('#status')).toContainText(/(?:範囲|表).*選/);
  await expect(page.locator('#preview tbody tr')).toHaveCount(0);
  await expect(page.locator('#save')).toBeDisabled();
  expect(await storage(page)).toEqual({});
});

test('stop cancels an in-flight acquisition while preserving the prior table; no stale replacement appears', async ({ harness }) => {
  const page = harness.workspace;
  await configureGolden(page);
  const started = performance.now();
  await page.evaluate(() => {
    (document.querySelector('#capture') as HTMLButtonElement).click();
    (document.querySelector('#stop') as HTMLButtonElement).click();
  });
  await expect(page.locator('#status')).toContainText(/中止/);
  expect(performance.now() - started).toBeLessThan(1000);
  await expect(page.locator('#preview tbody tr')).toHaveCount(8);
  await expect(page.locator('#save')).toBeDisabled();
  // Let the pending injection settle without relying on a blind sleep.
  await expect(page.locator('#capture')).toBeEnabled();
  await page.locator('#capture').click();
  await expect(page.locator('#summary')).toContainText('取得 8件 / 出力 8件');
  expect(await storage(page)).toEqual({});
});

test('fault-injected unresolved save metadata blocks automatic resaving and verifies only the explicitly selected matching file', async ({ harness }) => {
  const page = harness.workspace;
  const data = Buffer.from(EXPECTED_CSV, 'utf8');
  const record = await page.evaluate(async bytes => {
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
    const attempt = { schemaVersion: 1, exportId: 'fault-injected-save', digest: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''), state: 'unknown', startedAt: '2026-10-01T00:00:00.000Z', reason: 'DOWNLOAD_RESULT_UNKNOWN' };
    await chrome.storage.local.set({ saveAttemptV1: attempt });
    return attempt;
  }, [...data]);
  await page.reload();
  await expect(page.locator('#save-status')).toContainText('保存結果が不明');
  await expect(page.locator('#scan')).toBeDisabled();
  await expect(page.locator('#save')).toBeDisabled();
  await expect(page.locator('#verify-file')).toBeVisible();
  await page.locator('#reconcile').click();
  await expect(page.locator('#save-status')).toContainText('保存結果が不明');
  // Reconciliation without an ID supplies no new evidence; keep the old reason.
  expect((await storage(page)).saveAttemptV1).toEqual(record);
  await page.locator('#file').setInputFiles({ name: 'wrong.csv', mimeType: 'text/csv', buffer: Buffer.from('wrong bytes') });
  await expect(page.locator('#status')).toContainText('ファイルの内容が一致しない');
  await expect(page.locator('#save-status')).toContainText('保存結果が不明');
  await page.locator('#file').setInputFiles({ name: 'matching.csv', mimeType: 'text/csv', buffer: data });
  await expect(page.locator('#save-status')).toContainText('選択したファイルの内容が生成CSVと一致しました');
  expect((await storage(page)).saveAttemptV1).toEqual({ ...record, state: 'saved', reason: 'FILE_DIGEST_CONFIRMED' });
});

test('fixed 1,000 by 30 browser workload is measured, paginated and bounded without truncation', async ({ harness }, testInfo) => {
  await harness.source.evaluate(() => {
    const table = document.querySelector('#transactions')!;
    table.replaceChildren();
    const head = document.createElement('thead'), body = document.createElement('tbody');
    const header = head.insertRow();
    for (let column = 0; column < 30; column++) { const cell = document.createElement('th'); cell.textContent = `列${column + 1}`; header.append(cell); }
    for (let row = 0; row < 1000; row++) { const tr = body.insertRow(); for (let column = 0; column < 30; column++) tr.insertCell().textContent = `${row}:${column}`; }
    table.append(head, body);
  });
  const page = harness.workspace;
  await page.locator('#scan').click();
  await expect(page.locator('#status')).toContainText(/(?:範囲|表).*選/);
  await page.locator('#table').selectOption('1');
  const elapsed: number[] = [];
  for (let trial = 0; trial < 20; trial++) {
    const start = performance.now();
    await page.locator('#capture').click();
    // Identical summary text can belong to the previous trial. Wait for the
    // real acquisition/worker/render cycle to release its control first.
    await expect(page.locator('#capture')).toBeEnabled();
    await expect(page.locator('#preview')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#summary')).toContainText('取得 1000件 / 出力 1000件・30列');
    elapsed.push(performance.now() - start);
  }
  expect(elapsed.filter(value => value < 3000).length).toBeGreaterThanOrEqual(19);
  await expect(page.locator('#preview tbody tr')).toHaveCount(100);
  await page.locator('#next').click();
  await expect(page.locator('#page')).toContainText('2 / 10');
  await expect(page.locator('#preview tbody tr').first().locator('td').first()).toContainText('元の行101');
  await expect(page.locator('#preview tbody tr').first().locator('td').first().getByRole('button')).toHaveAccessibleName('元の行101を除外');
  const measurements = testInfo.outputPath('fixed-workload-measurements.json');
  await writeFile(measurements, JSON.stringify({ fixture: 'synthetic 1,000 data rows × 30 text columns', browser: harness.context.browser()?.version(), host: host(), trials: 20, milliseconds: elapsed, budgetMilliseconds: 3000, requiredPassingTrials: 19, measurement: 'UI click through real scripting, Worker and first 100-row preview render; 20 trials on this host only' }, null, 2));
  await testInfo.attach('fixed-workload-measurements', { path: measurements, contentType: 'application/json' });
  // Exceed the fixed data-row ceiling: selection is disabled, never truncated.
  await harness.source.evaluate(() => {
    const body = document.querySelector('#transactions tbody')!;
    const first = body.firstElementChild!;
    for (let row = 1000; row < 5001; row++) body.append(first.cloneNode(true));
  });
  await page.locator('#scan').click();
  await expect(page.locator('#table option[value="1"]')).toHaveJSProperty('disabled', true);
  await expect(page.locator('#table option[value="1"]')).toContainText('5,000行');
  // Scanning never discards a good captured snapshot. Explicit re-reading of
  // the now oversized table must fail, retaining the old 1,000 rows unchanged.
  await page.locator('#capture').click();
  await expect(page.locator('#status')).toContainText('5,000行');
  await expect(page.locator('#summary')).toContainText('取得 1000件 / 出力 1000件・30列');
  await expect(page.locator('#preview tbody tr')).toHaveCount(100);
  await expect(page.locator('#preview tbody tr').first().locator('.cell-value').first()).toHaveText('100:0');
  await expect(page.locator('#save')).toBeDisabled();
});

// A separate, hand-authored visible-page oracle. Neither expected rows nor CSV
// bytes are generated by the extraction or transformation implementation.
const browserContent = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>範囲選択の合成ページ</title>
  <style>article,#card{padding:24px;border:1px solid #888;margin:20px 0}body{font:16px sans-serif;margin:24px}</style></head>
  <body id="browser-page"><h1>確認用ページ</h1>
    <article id="article"><h2>概要</h2><p>最初の説明。<a id="article-link" href="/elsewhere">参照</a>できます。</p>
      <p hidden>do-not-capture-hidden</p><h2>手順</h2><p>一行目<br>二行目</p></article>
    <div id="card"><h2>カード</h2><p>カードの内容</p></div>
    <form><label>入力ラベル<input type="password" value="do-not-capture-password"></label></form>
    <table id="unsupported"><tr><th colspan="2">結合見出し</th></tr><tr><td><span id="partial">AA</span></td><td>BB</td></tr></table>
  </body></html>`;
const contentHeader = ['タイトル', '内容'];
const articleHeader = ['H1', 'H2', '内容'];
const articleRows = [['', '概要', '最初の説明。参照できます。'], ['', '手順', '一行目\n二行目']];
const cardRows = [['', 'カード', 'カードの内容']];
const bodyRows = [
  ['確認用ページ / 概要', '最初の説明。参照できます。'],
  ['確認用ページ / 手順', '一行目\n二行目'],
  ['確認用ページ / カード', 'カードの内容'],
  ['確認用ページ / カード', '入力ラベル'],
  ['結合見出し', '結合見出し'],
  ['AA', 'BB'],
];
const bodyCsv = '\uFEFF"列1","列2"\r\n"確認用ページ / 概要","最初の説明。参照できます。"\r\n"確認用ページ / 手順","一行目\n二行目"\r\n"確認用ページ / カード","カードの内容"\r\n"確認用ページ / カード","入力ラベル"\r\n"結合見出し","結合見出し"\r\n"AA","BB"\r\n';

async function contentSource(harness: Harness): Promise<void> {
  await harness.source.setContent(browserContent);
  await harness.workspace.bringToFront();
  await harness.workspace.locator('#scan').click();
  await expect(harness.workspace.locator('#page-content')).toBeEnabled();
}

async function pickSource(harness: Harness, selector: string, content = false): Promise<void> {
  const { source, workspace } = harness;
  await source.locator(selector).scrollIntoViewIfNeeded();
  await workspace.bringToFront();
  if (content) await workspace.locator('#pick-kind').selectOption('content');
  await workspace.locator('#pick').click();
  await source.bringToFront();
  // Padding targets the actual article/card container rather than its child
  // heading. Other selectors exercise their exact visible HTML element.
  const position = ['#article', '#card', '#aria-grid', '#mixed'].includes(selector) ? { x: 8, y: 8 } : undefined;
  const bounds = await source.locator(selector).boundingBox();
  expect(bounds).not.toBeNull();
  const point = { x: bounds!.x + (position?.x ?? bounds!.width / 2), y: bounds!.y + (position?.y ?? bounds!.height / 2) };
  await source.mouse.move(point.x, point.y);
  await expect(source.locator('[data-transaction-to-excel-picker]')).toBeVisible();
  await source.mouse.click(point.x, point.y);
  await expect(source.locator('[data-transaction-to-excel-picker]')).toHaveCount(0);
  await workspace.bringToFront();
}

async function contentPreview(page: Page, expected: string[][], headers = contentHeader): Promise<void> {
  await expect(page.locator('#preview tbody tr')).toHaveCount(expected.length);
  await expect(page.locator('#preview')).toHaveAttribute('aria-busy', 'false');
  const observed = await page.locator('#preview tbody tr').evaluateAll(rows => rows.map(row => Array.from(row.querySelectorAll('td')).slice(1).map(cell => cell.querySelector('.cell-value')?.textContent)));
  expect(observed).toEqual(expected.map(row => row.map(displayedValue)));
  expect(await previewNames(page)).toEqual(headers);
  await expect(page.locator('#summary')).toContainText(`取得 ${expected.length}件 / 出力 ${expected.length}件・${headers.length}列`);
  await expect(page.locator('#confirm')).toBeEnabled();
}

test('page content: whole body preview and real saved CSV bytes preserve visible headings and content', async ({ harness }, testInfo) => {
  const { workspace, downloadDirectory } = harness;
  await contentSource(harness);
  await workspace.locator('#page-content').click();
  await contentPreview(workspace, bodyRows, ['列1', '列2']);
  expect(await workspace.locator('#preview').innerText()).not.toMatch(/do-not-capture/);
  await workspace.locator('#confirm').check();
  const session = await harness.context.newCDPSession(workspace);
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory, eventsEnabled: true });
  await workspace.locator('#save').click();
  await expect(workspace.locator('#save-status')).toContainText('CSVを保存しました');
  const record = await storage(workspace);
  const downloadId = (record.saveAttemptV1 as { downloadId: number }).downloadId;
  const files = await workspace.evaluate(id => chrome.downloads.search({ id }), downloadId);
  expect(files).toHaveLength(1); expect(files[0].state).toBe('complete');
  const actual = await readFile(files[0].filename);
  expect(actual).toEqual(Buffer.from(bodyCsv, 'utf8'));
  expect(parseCsv(actual)).toEqual([['列1', '列2'], ...bodyRows]);
  expect(JSON.stringify(record)).not.toMatch(/最初の説明|カードの内容|do-not-capture|session/);
  await assertOtherStorageEmpty(workspace);
  await testInfo.attach('content-browser-evidence', { body: JSON.stringify({ browser: harness.context.browser()?.version(), source: 'synthetic displayed HTML', actualSavedBytes: actual.length, activationDifference: 'test-only loopback host grant and direct workspace URL; native toolbar/side-panel activation not covered', saveDialogDifference: 'CDP isolated directory; native Save As UI not covered' }, null, 2), contentType: 'application/json' });
});

test('range picker: real hover/click selects an article and preserves only its heading hierarchy and content', async ({ harness }, testInfo) => {
  await contentSource(harness);
  await pickSource(harness, '#article');
  await contentPreview(harness.workspace, articleRows, articleHeader);
  expect(await harness.workspace.locator('#preview').innerText()).not.toMatch(/カードの内容|入力ラベル|AA|do-not-capture/);
  expect(await storage(harness.workspace)).toEqual({});
  const sourceImage = testInfo.outputPath('article-source.png');
  const previewImage = testInfo.outputPath('article-preview.png');
  await harness.source.screenshot({ path: sourceImage, fullPage: true });
  await harness.workspace.screenshot({ path: previewImage, fullPage: true });
  await testInfo.attach('synthetic-article-source', { path: sourceImage, contentType: 'image/png' });
  await testInfo.attach('confirmed-article-preview', { path: previewImage, contentType: 'image/png' });
});

test('range picker: selecting a page link suppresses navigation and captures its visible label only', async ({ harness }) => {
  await contentSource(harness);
  const oldUrl = harness.source.url();
  await pickSource(harness, '#article-link');
  expect(harness.source.url()).toBe(oldUrl);
  await contentPreview(harness.workspace, [['選択範囲', '参照']]);
});

test('content mode: a visible partial table region can be chosen without selecting the whole table', async ({ harness }) => {
  await contentSource(harness);
  await pickSource(harness, '#partial', true);
  await contentPreview(harness.workspace, [['選択範囲', 'AA']]);
  expect(await harness.workspace.locator('#preview').innerText()).not.toMatch(/BB|結合見出し/);
});

test('merged table: the selected range keeps two columns without flattening or a fallback action', async ({ harness }) => {
  await contentSource(harness);
  await pickSource(harness, '#partial');
  await contentPreview(harness.workspace, [['AA', 'BB']], ['結合見出し', '結合見出し（2）']);
});

test('range picker: Escape cleans the page and a restarted selection captures only the new card', async ({ harness }) => {
  const { source, workspace } = harness;
  await contentSource(harness);
  await workspace.locator('#pick').click(); await source.bringToFront();
  const bounds = await source.locator('#article').boundingBox();
  expect(bounds).not.toBeNull(); await source.mouse.move(bounds!.x + 8, bounds!.y + 8);
  await expect(source.locator('[data-transaction-to-excel-picker]')).toBeVisible();
  await source.keyboard.press('Escape');
  await expect(source.locator('[data-transaction-to-excel-picker]')).toHaveCount(0);
  await workspace.bringToFront();
  await expect(workspace.locator('#capture')).toBeDisabled();
  await expect(workspace.locator('#pick')).toBeEnabled();
  await pickSource(harness, '#card');
  await contentPreview(workspace, cardRows, articleHeader);
});

test('narrow panel: 320px layout keeps page controls and confirmation within the viewport', async ({ harness }) => {
  const { workspace } = harness;
  await contentSource(harness);
  await workspace.setViewportSize({ width: 320, height: 900 });
  await workspace.locator('#page-content').click(); await contentPreview(workspace, bodyRows, ['列1', '列2']);
  const width = await workspace.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(width.document).toBeLessThanOrEqual(width.viewport + 1); expect(width.body).toBeLessThanOrEqual(width.viewport + 1);
  for (const id of ['pick', 'page-content', 'capture', 'confirm', 'save']) {
    const bounds = await workspace.locator(`#${id}`).boundingBox();
    expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(321);
  }
});

test('new document: explicit re-read refuses an obsolete range while keeping the previously captured table editable', async ({ harness }) => {
  await contentSource(harness); await pickSource(harness, '#article');
  await contentPreview(harness.workspace, articleRows, articleHeader);
  await harness.workspace.locator('#confirm').check();
  await harness.source.goto(fixtureUrl); await harness.workspace.bringToFront();
  await harness.workspace.locator('#capture').click();
  await contentPreview(harness.workspace, articleRows, articleHeader);
  await expect(harness.workspace.locator('#status')).toContainText(/変わ|見つ|取得|文書/);
  await editColumn(harness.workspace, 2); await harness.workspace.locator('#column-name').fill('継続する章');
  await expect(harness.workspace.locator('#preview thead')).toContainText('継続する章');
  expect(await storage(harness.workspace)).toEqual({});
});

const structuredHeaders = ['時間', '回数 / 自分', '回数 / 比較', 'パワー / 自分', 'パワー / 比較', 'W/kg / 自分', 'W/kg / 比較'];
const structuredRows = [
  ['5 秒', '2', '3', '400 W', '420 W', '6.0', '6.3'],
  ['', '1', '2', '390 W', '410 W', '5.9', '6.2'],
];

test('structured initial preview: selecting a merged seven-column table immediately preserves its rows and columns', async ({ harness }, testInfo) => {
  const html = await readFile(resolve('tests/fixtures/structured-browser.html'), 'utf8');
  await harness.source.setContent(html);
  await harness.workspace.locator('#scan').click();
  await pickSource(harness, '#power-grid');
  // This is deliberately asserted before any acquisition/configuration click:
  // a user selecting the range must first receive a usable structured table.
  await expect(harness.workspace.locator('#preview thead th')).toHaveCount(8);
  await expect(harness.workspace.locator('#preview tbody tr')).toHaveCount(2);
  const observedHeaders = await previewNames(harness.workspace);
  expect(observedHeaders).toEqual(structuredHeaders);
  const observed = await harness.workspace.locator('#preview tbody tr').evaluateAll(rows => rows.map(row => Array.from(row.querySelectorAll('td')).slice(1).map(cell => cell.querySelector('.cell-value')?.textContent)));
  expect(observed).toEqual(structuredRows.map(row => row.map(displayedValue)));
  const image = testInfo.outputPath('structured-initial-preview.png');
  await harness.workspace.screenshot({ path: image, fullPage: true });
  await testInfo.attach('structured-initial-preview', { path: image, contentType: 'image/png' });
});

const mixedHeaders = ['列1', '列2', '列3'];
const mixedRows = [
  ['説明と一覧', '各一覧の項目を保ちます。', ''],
  ['品名', '個数', ''],
  ['りんご', '2', ''],
  ['みかん', '3', ''],
  ['説明と一覧', '次の一覧は価格を含みます。', ''],
  ['商品', '価格', '在庫'],
  ['パン', '120', '5'],
];

test('structured mixed range: all paragraphs and differently shaped tables remain separate cells in DOM order', async ({ harness }) => {
  await harness.source.setContent(await readFile(resolve('tests/fixtures/structured-browser.html'), 'utf8'));
  await harness.workspace.locator('#scan').click();
  await pickSource(harness, '#mixed', true);
  await contentPreview(harness.workspace, mixedRows, mixedHeaders);
  expect(await harness.workspace.locator('#preview').innerText()).not.toMatch(/do-not-capture|400 W|ノート/);
  // Every initial slot is literal text; conversion settings are deferred.
  await editColumn(harness.workspace, 2);
  await expect(harness.workspace.locator('#column-kind, #column-required')).toHaveCount(0);
  expect(await storage(harness.workspace)).toEqual({});
});

test('structured card range: repeated definition lists automatically become two named columns', async ({ harness }) => {
  await harness.source.setContent(await readFile(resolve('tests/fixtures/structured-browser.html'), 'utf8'));
  await harness.workspace.locator('#scan').click();
  await pickSource(harness, '.cards', true);
  await contentPreview(harness.workspace, [['ノート', '100'], ['ペン', '80']], ['商品', '価格']);
  expect(await harness.workspace.locator('#preview').innerText()).not.toMatch(/パン|りんご|400 W/);
});

test('structured ARIA range: a displayed grid has separate named cells without an HTML table', async ({ harness }) => {
  await harness.source.setContent(await readFile(resolve('tests/fixtures/structured-browser.html'), 'utf8'));
  await harness.workspace.locator('#scan').click();
  await pickSource(harness, '#aria-grid', true);
  await contentPreview(harness.workspace, [['距離', '42', 'km'], ['時間', '90', '分']], ['項目', '値', '単位']);
  expect(await harness.workspace.locator('#preview').innerText()).not.toMatch(/りんご|ノート|400 W/);
});

test('initial table adjustments: headers rename, move, hide and restore while preserving the captured snapshot', async ({ harness }, testInfo) => {
  const { source, workspace } = harness;
  await workspace.setViewportSize({ width: 420, height: 900 });
  await source.setContent(await readFile(resolve('tests/fixtures/structured-browser.html'), 'utf8'));
  await workspace.locator('#scan').click();
  await pickSource(harness, '#power-grid');
  await contentPreview(workspace, structuredRows, structuredHeaders);
  await workspace.locator('#confirm').check();
  await source.locator('#power-grid tbody tr').first().locator('td').nth(2).evaluate(cell => { cell.textContent = 'do-not-refetch'; });
  await editColumn(workspace, 4);
  // Check immediately after the header click. Filling the editor's input would
  // itself auto-scroll under Playwright and conceal an off-screen editor bug.
  await assertPanelVisibleWithoutAnotherAction(workspace, 'column-editor');
  const editorImage = testInfo.outputPath('structured-column-editor.png');
  await workspace.screenshot({ path: editorImage, fullPage: true });
  await testInfo.attach('visible-column-editor', { path: editorImage, contentType: 'image/png' });
  await workspace.locator('#column-name').fill('自分 W');
  await expect(workspace.locator('#confirm')).not.toBeChecked();
  await expect(previewColumn(workspace, 4)).toHaveAccessibleName('自分 W：この列を調整');
  await workspace.locator('#column-left').click();
  const movedHeaders = ['時間', '回数 / 自分', '自分 W', '回数 / 比較', 'パワー / 比較', 'W/kg / 自分', 'W/kg / 比較'];
  const movedRows = [
    ['5 秒', '2', '400 W', '3', '420 W', '6.0', '6.3'],
    ['', '1', '390 W', '2', '410 W', '5.9', '6.2'],
  ];
  await contentPreview(workspace, movedRows, movedHeaders);
  await workspace.locator('#column-hide').click();
  await expect(previewColumn(workspace, 4)).toHaveCount(0);
  await expect(workspace.locator('#preview thead th')).toHaveCount(7);
  await workspace.locator('#hidden-columns button[data-restore-index="3"]').click();
  // Restore retains the chosen order, including the move before hiding. The
  // captured rows remain unchanged even though the source page has changed.
  await contentPreview(workspace, movedRows, movedHeaders);
  expect(await workspace.locator('#preview').innerText()).not.toMatch(/do-not-refetch/);
  const cellDetail = workspace.locator('#preview tbody tr').first().locator('td').nth(3).getByRole('button');
  await cellDetail.click();
  await assertPanelVisibleWithoutAnotherAction(workspace, 'cell-detail');
  await expect(workspace.locator('#cell-detail .cell-line')).toHaveText(['元の文字列：400 W', '表の値：400 W', 'CSV値：400 W']);
  await workspace.locator('#cell-detail').getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(workspace.locator('#cell-detail')).toBeHidden();
  await expect(cellDetail).toBeFocused();
  expect(await storage(workspace)).toEqual({});
});

// Literal section values and CSV bytes are hand-authored independently of the
// extraction and CSV writers. Child body text belongs only to its own row.
const hierarchyHeader = ['H1', 'H2', 'H3', '内容'];
const hierarchyRows = [
  ['合成ガイド', '', '', 'これは合成の文書です。\n表示内容を取り込みます。'],
  ['合成ガイド', '準備', '', 'ページを開きます。\n範囲を選びます。\n表を確認します。\n保存先を決めます。'],
  ['合成ガイド', '準備', '用語', '範囲：選んだHTMLの領域。\n列：一つの項目。'],
  ['合成ガイド', '操作', '', '見出しを押します。\n列名を変更します。'],
  ['合成ガイド', '操作', '例', 'run --csv\n  --output sample.csv'],
  ['', '', '', 'この文書は合成です。'],
];
const hierarchyCsv = '\uFEFF"H1","H2","小見出し","内容"\r\n'
  + '"合成ガイド","","","これは合成の文書です。\n表示内容を取り込みます。"\r\n'
  + '"合成ガイド","準備","","ページを開きます。\n範囲を選びます。\n表を確認します。\n保存先を決めます。"\r\n'
  + '"合成ガイド","準備","用語","範囲：選んだHTMLの領域。\n列：一つの項目。"\r\n'
  + '"合成ガイド","操作","","見出しを押します。\n列名を変更します。"\r\n'
  + '"合成ガイド","操作","例","run --csv\n  --output sample.csv"\r\n'
  + '"","","","この文書は合成です。"\r\n';

test('document hierarchy: initial H1-H3 columns own section bodies, remain editable and save exact CSV bytes', async ({ harness }, testInfo) => {
  const { source, workspace, downloadDirectory } = harness;
  await source.goto(`${new URL(fixtureUrl).origin}/document-hierarchy`);
  // This direct test route intentionally omits native source observers. Reload
  // its workspace to bind the new document; native reactivation is tested in
  // editor-rework through real tab listeners and synthetic session activation.
  await workspace.reload(); await workspace.bringToFront();
  await expect(workspace.locator('#pick')).toBeEnabled();
  await workspace.locator('details.source-options > summary').click();
  await expect(workspace.locator('#page-content')).toBeEnabled();
  await workspace.locator('#page-content').click();
  // No second acquisition click: the first visible table must be structured.
  await expect(workspace.locator('#preview thead th')).toHaveCount(5);
  await contentPreview(workspace, hierarchyRows, hierarchyHeader);
  expect(await workspace.locator('#preview').innerText()).not.toMatch(/do-not-capture/);
  await workspace.locator('#confirm').check();
  await editColumn(workspace, 3);
  await workspace.locator('#column-name').fill('小見出し');
  await expect(workspace.locator('#confirm')).not.toBeChecked();
  const outputHeader = ['H1', 'H2', '小見出し', '内容'];
  await contentPreview(workspace, hierarchyRows, outputHeader);
  const image = testInfo.outputPath('document-hierarchy-preview.png');
  await workspace.screenshot({ path: image, fullPage: true });
  await testInfo.attach('document-hierarchy-preview', { path: image, contentType: 'image/png' });
  await workspace.locator('#confirm').check();
  const session = await harness.context.newCDPSession(workspace);
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory, eventsEnabled: true });
  await workspace.locator('#save').click();
  await expect(workspace.locator('#save-status')).toContainText('CSVを保存しました');
  const record = await storage(workspace);
  const downloadId = (record.saveAttemptV1 as { downloadId: number }).downloadId;
  const files = await workspace.evaluate(id => chrome.downloads.search({ id }), downloadId);
  expect(files).toHaveLength(1); expect(files[0].state).toBe('complete');
  const actual = await readFile(files[0].filename);
  expect(actual).toEqual(Buffer.from(hierarchyCsv, 'utf8'));
  expect(parseCsv(actual)).toEqual([outputHeader, ...hierarchyRows]);
  expect(JSON.stringify(record)).not.toMatch(/合成ガイド|用語|do-not-capture/);
  await assertOtherStorageEmpty(workspace);
});

const visibleShadowDocument = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>実表示の見出し確認</title>
<style>body{font:16px sans-serif;margin:24px}.inactive{display:none}footer{margin-top:24px;border-top:1px solid #999}</style></head><body>
<main><h1 id="opaque-title">操作ガイド<x-actions><span id="hidden-helper">do-not-capture-helper</span><button id="hidden-tooltip">do-not-capture-tooltip</button></x-actions></h1>
<x-closed><h6 id="closed-heading">do-not-capture-closed-H6</h6><span id="closed-helper">do-not-capture-closed-helper</span>
<table id="closed-table"><thead><tr><th>do-not-capture-closed-columnA</th><th>do-not-capture-closed-columnB</th></tr></thead><tbody><tr><td>do-not-capture-closed-cellA</td><td>do-not-capture-closed-cellB</td></tr></tbody></table>
<div role="row" id="closed-row"><span role="cell">do-not-capture-closed-role-cellA</span><span role="cell">do-not-capture-closed-role-cellB</span></div></x-closed>
<x-closed-records id="closed-record-box" style="display:block;width:100px;height:10px;background:#eee">
<div id="closed-record-one"><span id="closed-record-cellA">do-not-capture-closed-record-cellA</span><span id="closed-record-cellB">do-not-capture-closed-record-cellB</span></div>
<div id="closed-record-two"><span id="closed-record-cellC">do-not-capture-closed-record-cellC</span><span id="closed-record-cellD">do-not-capture-closed-record-cellD</span></div></x-closed-records>
<p>本文は一つ。</p><h2>準備</h2><p>可視の案内。</p>
<h1 id="slotted-title"><x-title><span slot="label" id="slotted-label">別のガイド</span><span id="unassigned-label">do-not-capture-unassigned</span></x-title></h1>
<p id="offscreen-body" style="margin-top:1500px">別の本文。<x-closed-title><span slot="label" id="closed-slotted-label">閉じた部品の表示文字。</span><span id="closed-unassigned-label">do-not-capture-closed-unassigned</span></x-closed-title></p></main>
<footer><h2>関連情報</h2><p>フッターの本文。</p><h6 class="inactive">do-not-capture-H6</h6></footer>
<script>
customElements.define('x-actions', class extends HTMLElement { constructor() { super(); this.attachShadow({mode:'open'}); } });
customElements.define('x-title', class extends HTMLElement { constructor() { super(); this.attachShadow({mode:'open'}).innerHTML = '<slot name="label"></slot>'; } });
customElements.define('x-closed', class extends HTMLElement { constructor() { super(); this.attachShadow({mode:'closed'}); } });
customElements.define('x-closed-title', class extends HTMLElement { constructor() { super(); this.attachShadow({mode:'closed'}).innerHTML = '<slot name="label"></slot>'; } });
customElements.define('x-closed-records', class extends HTMLElement { constructor() { super(); this.attachShadow({mode:'closed'}); } });
</script></body></html>`;
const visibleShadowRows = [
  ['操作ガイド', '', '本文は一つ。'],
  ['操作ガイド', '準備', '可視の案内。'],
  ['別のガイド', '', '別の本文。閉じた部品の表示文字。'],
  ['', '関連情報', 'フッターの本文。'],
];

test('document visibility: slotted heading text stays, unassigned helpers disappear and footer starts a separate hierarchy', async ({ harness }, testInfo) => {
  const { source, workspace } = harness;
  await source.setContent(visibleShadowDocument);
  // Real Chromium rendering establishes which light-DOM text reaches the
  // screen. A computed display style alone cannot identify an unassigned node.
  await expect(source.locator('#hidden-helper')).not.toBeVisible();
  await expect(source.locator('#hidden-tooltip')).not.toBeVisible();
  await expect(source.locator('#unassigned-label')).not.toBeVisible();
  await expect(source.locator('#closed-heading')).not.toBeVisible();
  await expect(source.locator('#closed-helper')).not.toBeVisible();
  await expect(source.locator('#closed-table')).not.toBeVisible();
  await expect(source.locator('#closed-row')).not.toBeVisible();
  await expect(source.locator('#closed-record-box')).toBeVisible();
  expect(await source.locator('#closed-record-box').evaluate(host => {
    const bounds = host.getBoundingClientRect(); return { width: bounds.width, height: bounds.height };
  })).toEqual({ width: 100, height: 10 });
  for (const id of ['closed-record-one', 'closed-record-two', 'closed-record-cellA', 'closed-record-cellB', 'closed-record-cellC', 'closed-record-cellD']) {
    await expect(source.locator(`#${id}`)).not.toBeVisible();
  }
  await expect(source.locator('#closed-unassigned-label')).not.toBeVisible();
  expect(await source.locator('x-closed').evaluate(host => host.shadowRoot)).toBeNull();
  await expect(source.locator('#closed-slotted-label')).toBeVisible();
  expect(await source.locator('#closed-slotted-label').evaluate(label => label.assignedSlot)).toBeNull();
  expect(await source.locator('x-closed-title').evaluate(host => host.shadowRoot)).toBeNull();
  await expect(source.locator('#slotted-label')).toBeVisible();
  expect(await source.locator('#opaque-title').innerText()).toBe('操作ガイド');
  expect(await source.locator('#slotted-title').innerText()).toBe('別のガイド');
  expect(await source.locator('#offscreen-body').evaluate(element => element.getBoundingClientRect().top > innerHeight)).toBeTruthy();
  expect(await source.locator('#offscreen-body').innerText()).toBe('別の本文。閉じた部品の表示文字。');
  await workspace.bringToFront();
  await workspace.locator('#scan').click();
  await expect(workspace.locator('#page-content')).toBeEnabled();
  await workspace.locator('#page-content').click();
  await expect(workspace.locator('#preview tbody tr').first()).toBeVisible();
  await expect(workspace.locator('#preview')).toHaveAttribute('aria-busy', 'false');
  expect(await workspace.locator('#preview').innerText()).not.toMatch(/do-not-capture-closed/);
  await contentPreview(workspace, visibleShadowRows, ['H1', 'H2', '内容']);
  expect(await workspace.locator('#preview').innerText()).not.toMatch(/do-not-capture/);
  const image = testInfo.outputPath('document-visible-shadow-preview.png');
  await workspace.screenshot({ path: image, fullPage: true });
  await testInfo.attach('document-visible-shadow-preview', { path: image, contentType: 'image/png' });
  expect(await storage(workspace)).toEqual({});
});

const visibleMixedDocument = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>混在範囲の実表示確認</title>
<style>body{font:16px sans-serif;margin:24px}table{border-collapse:collapse}th,td{border:1px solid #888;padding:8px}</style></head><body>
<main><h1 id="mixed-visible-title">構造確認<x-actions><span id="mixed-hidden-helper">do-not-capture-mixed-helper</span></x-actions></h1>
<x-closed><h6 id="mixed-closed-heading">do-not-capture-mixed-H6</h6></x-closed>
<p>導入</p>
<table id="visible-mixed-grid"><thead><tr><th>品名</th><th>個数</th></tr></thead><tbody><tr><td>りんご</td><td>2</td></tr></tbody></table></main>
<script>
customElements.define('x-actions', class extends HTMLElement { constructor() { super(); this.attachShadow({mode:'open'}); } });
customElements.define('x-closed', class extends HTMLElement { constructor() { super(); this.attachShadow({mode:'closed'}); } });
</script></body></html>`;
const visibleMixedRows = [
  ['構造確認', '導入'],
  ['品名', '個数'],
  ['りんご', '2'],
];

test('mixed visibility: a genuine displayed table keeps the existing matrix while unseen heading helpers stay out', async ({ harness }) => {
  const { source, workspace } = harness;
  await source.setContent(visibleMixedDocument);
  await expect(source.locator('#mixed-hidden-helper')).not.toBeVisible();
  await expect(source.locator('#mixed-closed-heading')).not.toBeVisible();
  expect(await source.locator('#mixed-visible-title').innerText()).toBe('構造確認');
  await expect(source.locator('#visible-mixed-grid')).toBeVisible();
  await workspace.bringToFront();
  await workspace.locator('#scan').click();
  await expect(workspace.locator('#page-content')).toBeEnabled();
  await workspace.locator('#page-content').click();
  await contentPreview(workspace, visibleMixedRows, ['列1', '列2']);
  expect(await workspace.locator('#preview').innerText()).not.toMatch(/do-not-capture/);
  expect(await storage(workspace)).toEqual({});
});
