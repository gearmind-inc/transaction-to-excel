import { test as base, expect, chromium, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { parseCsv } from '../oracle';

const fixtureUrl = 'http://127.0.0.1:4173/transactions';
type Harness = { context: BrowserContext; source: Page; workspace: Page; downloadDirectory: string; extensionId: string; sourceTabId: number };

// Disposable test-only host grant and CDP save path. This does not prove native
// toolbar/side-panel activation, production activeTab, or the OS Save As dialog.
async function launch(testInfo: TestInfo): Promise<Harness> {
  const temporary = testInfo.outputPath('test-only-extension');
  const production = resolve('dist/extension');
  const manifest = JSON.parse(await readFile(resolve(production, 'manifest.json'), 'utf8'));
  expect(manifest.permissions).toEqual(['activeTab', 'scripting', 'storage', 'downloads', 'sidePanel']);
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.optional_host_permissions).toBeUndefined();
  await mkdir(temporary, { recursive: true });
  await cp(production, temporary, { recursive: true });
  await writeFile(resolve(temporary, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: ['http://127.0.0.1/*'] }));
  const downloadDirectory = testInfo.outputPath('downloads');
  await mkdir(downloadDirectory, { recursive: true });
  const context = await chromium.launchPersistentContext(testInfo.outputPath('temporary-profile'), {
    channel: 'chromium', headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${temporary}`, `--load-extension=${temporary}`],
    viewport: { width: 1200, height: 900 },
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  const nextPage = context.waitForEvent('page');
  const tab = await worker.evaluate(async url => chrome.tabs.create({ url }), fixtureUrl);
  const source = await nextPage;
  await source.waitForURL(fixtureUrl);
  const workspace = await context.newPage();
  await workspace.goto(`chrome-extension://${extensionId}/workspace.html?tab=${tab.id}`);
  await expect(workspace.locator('#pick')).toBeEnabled();
  return { context, source, workspace, downloadDirectory, extensionId, sourceTabId: tab.id! };
}
const test = base.extend<{ harness: Harness }>({ harness: async ({}, use, testInfo) => {
  const harness = await launch(testInfo);
  try { await use(harness); } finally {
    await harness.context.close();
    await rm(testInfo.outputPath('temporary-profile'), { recursive: true, force: true });
    await rm(testInfo.outputPath('test-only-extension'), { recursive: true, force: true });
  }
} });

// Literal fixture and every matrix below are independently hand-authored. They
// must never be generated from table-editor, extraction, or the CSV serializer.
const fixture = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>編集の固定合成表</title></head><body>
<table id="editor-fixture"><thead><tr><th>ID</th><th>内容</th><th>値</th><th>メモ</th></tr></thead><tbody>
<tr><td>00001</td><td>日本語,"引用"<br>二行目</td><td>0</td><td></td></tr>
<tr><td>12345678901234567890</td><td>=SUM(1,2)</td><td></td><td>零</td></tr>
<tr><td>00003</td><td>@name</td><td>先頭ゼロ 001</td><td>戻す行</td></tr>
</tbody></table><p hidden>do-not-capture-hidden</p></body></html>`;
const initial = [
  ['ID', '内容', '値', 'メモ'],
  ['00001', '日本語,"引用"\n二行目', '0', ''],
  ['12345678901234567890', '=SUM(1,2)', '', '零'],
  ['00003', '@name', '先頭ゼロ 001', '戻す行'],
];
const moved = [
  ['説明', 'ID', '値', 'メモ'],
  ['日本語,"引用"\n二行目', '00001', '0', ''],
  ['=SUM(1,2)', '12345678901234567890', '', '零'],
  ['@name', '00003', '先頭ゼロ 001', '戻す行'],
];
const movedCsv = [
  ['説明', 'ID', '値', 'メモ'],
  ['日本語,"引用"\n二行目', '00001', '0', ''],
  ['\t=SUM(1,2)', '12345678901234567890', '', '零'],
  ['\t@name', '00003', '先頭ゼロ 001', '戻す行'],
];
const transposed = [
  ['元の列', '元の行1', '元の行2', '元の行3'],
  ['説明', '日本語,"引用"\n二行目', '=SUM(1,2)', '@name'],
  ['ID', '00001', '12345678901234567890', '00003'],
  ['値', '0', '', '先頭ゼロ 001'],
  ['メモ', '', '零', '戻す行'],
];
const header = (page: Page, id: number) => page.locator(`#preview th[data-source-index="${id}"] .column-heading`);
async function capture(harness: Harness): Promise<void> {
  await harness.source.setContent(fixture);
  await harness.workspace.bringToFront();
  await harness.workspace.locator('details.source-options > summary').click();
  await harness.workspace.locator('#scan').click();
  await harness.workspace.locator('#table').selectOption('0');
  await matrix(harness.workspace, initial);
  await harness.workspace.locator('details.source-options > summary').click();
}
async function matrix(page: Page, expected: string[][]): Promise<void> {
  await expect(page.locator('#preview')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#preview tbody tr')).toHaveCount(expected.length - 1);
  const actual = await page.locator('#preview').evaluate(container => {
    const names = [...container.querySelectorAll('th[data-source-index] button')].map(button => button.getAttribute('aria-label')?.replace(/：この列を調整$/, ''));
    const rows = [...container.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td .cell-value')].map(cell => cell.textContent === '［空欄］' ? '' : cell.textContent));
    return [names, ...rows];
  });
  expect(actual).toEqual(expected);
}
async function savedCsv(harness: Harness, expected: string[][]): Promise<number> {
  const page = harness.workspace;
  await page.locator('#confirm').check();
  const session = await harness.context.newCDPSession(page);
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: harness.downloadDirectory, eventsEnabled: true });
  await page.locator('#save').click();
  await expect(page.locator('#save-status')).toContainText('CSVを保存しました');
  const id = await page.evaluate(async () => ((await chrome.storage.local.get('saveAttemptV1')).saveAttemptV1 as { downloadId: number }).downloadId);
  const files = await page.evaluate(id => chrome.downloads.search({ id }), id);
  expect(files).toHaveLength(1); expect(files[0].state).toBe('complete');
  expect(files[0].filename.startsWith(harness.downloadDirectory + sep)).toBeTruthy();
  expect(parseCsv(await readFile(files[0].filename))).toEqual(expected);
  return id;
}

test('editor sequence: drag, exclude/restore both axes, transpose, undo, save, edit and resave retain every fixed cell', async ({ harness }, testInfo) => {
  const page = harness.workspace;
  await capture(harness);
  await expect(page.locator('#transpose')).toBeEnabled();
  await expect(page.locator('#undo')).toBeDisabled();
  await header(page, 1).click(); await page.locator('#column-name').fill('説明');
  await page.locator('#column-close').click();
  await page.locator('#preview th[data-source-index="1"]').dragTo(page.locator('#preview th[data-source-index="0"]'));
  await matrix(page, moved);
  await header(page, 2).click(); await page.locator('#column-hide').click();
  await matrix(page, [
    ['説明', 'ID', 'メモ'],
    ['日本語,"引用"\n二行目', '00001', ''],
    ['=SUM(1,2)', '12345678901234567890', '零'],
    ['@name', '00003', '戻す行'],
  ]);
  await page.locator('#hidden-columns [data-restore-index="2"]').click(); await matrix(page, moved);
  await page.locator('#preview [data-hide-row="1"]').click();
  await matrix(page, [
    ['説明', 'ID', '値', 'メモ'],
    ['日本語,"引用"\n二行目', '00001', '0', ''],
    ['@name', '00003', '先頭ゼロ 001', '戻す行'],
  ]);
  await page.locator('#hidden-rows [data-restore-row="1"]').click(); await matrix(page, moved);
  await page.locator('#transpose').click(); await matrix(page, transposed);
  await page.locator('#undo').click(); await matrix(page, moved);
  const first = await savedCsv(harness, movedCsv); await matrix(page, moved);
  await expect(page.locator('#save')).toBeDisabled();
  await header(page, 3).click(); await page.locator('#column-name').fill('記録');
  await page.locator('#column-close').click();
  await matrix(page, [['説明', 'ID', '値', '記録'], ...moved.slice(1)]);
  await expect(page.locator('#confirm')).not.toBeChecked();
  const second = await savedCsv(harness, [['説明', 'ID', '値', '記録'], ...movedCsv.slice(1)]);
  expect(second).not.toBe(first);
  const stored = await page.evaluate(() => chrome.storage.local.get(null));
  expect(Object.keys(stored)).toEqual(['saveAttemptV1']);
  expect(JSON.stringify(stored)).not.toMatch(/00001|12345678901234567890|日本語|SUM|戻す行/);
  await testInfo.attach('editor-browser-boundary', { body: JSON.stringify({ browser: harness.context.browser()?.version(), fixture: 'synthetic fixed 4 columns × 3 rows', comparison: 'all preview cells and independent protected CSV readback', differences: 'test-only loopback grant, direct workspace URL, CDP save directory; native activation/save dialog untested' }), contentType: 'application/json' });
});

test('320px editor: table remains central, keyboard column movement and focus return work without conversion/preset controls', async ({ harness }, testInfo) => {
  const page = harness.workspace;
  await page.setViewportSize({ width: 320, height: 900 }); await capture(harness);
  await header(page, 1).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#column-name')).toBeFocused();
  await page.locator('#column-name').fill('説明');
  await page.locator('#column-left').focus(); await page.keyboard.press('Enter'); await matrix(page, moved);
  await page.locator('#column-close').focus(); await page.keyboard.press('Enter'); await expect(header(page, 1)).toBeFocused();
  await expect(page.locator('#column-kind, #column-required, #preset, #save-preset')).toHaveCount(0);
  const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(width.document).toBeLessThanOrEqual(width.viewport + 1); expect(width.body).toBeLessThanOrEqual(width.viewport + 1);
  for (const id of ['pick', 'transpose', 'undo', 'confirm', 'save']) {
    const bounds = await page.locator(`#${id}`).boundingBox();
    expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(321);
  }
  await expect(page.locator('#reconcile')).toBeHidden();
  await expect(page.locator('#cancel-save')).toBeHidden();
  await expect(page.locator('#save-help')).toContainText(/確認/);
  await page.screenshot({ path: testInfo.outputPath('editor-320px.png'), fullPage: true });
  await testInfo.attach('editor-320px', { path: testInfo.outputPath('editor-320px.png'), contentType: 'image/png' });
});

test('normal source observer: tab activation and source navigation retain the snapshot while source controls lose permission', async ({ harness }, testInfo) => {
  const page = harness.workspace;
  await harness.source.setContent(fixture);
  // The normal route registers real Chrome tab lifecycle listeners. Activation
  // is synthetic session metadata, not a toolbar click or native side panel.
  await page.goto(`chrome-extension://${harness.extensionId}/workspace.html`);
  await page.evaluate(async tabId => {
    await chrome.tabs.update(tabId, { active: true });
    const current = await chrome.windows.getCurrent();
    await chrome.storage.session.set({ [`panelActivationV1:${current.id}`]: { tabId, activationId: 'browser-synthetic-native-observer' } });
  }, harness.sourceTabId);
  await expect(page.locator('#pick')).toBeEnabled();
  await page.locator('details.source-options > summary').click();
  await page.locator('#table').selectOption('0'); await matrix(page, initial);
  await page.locator('details.source-options > summary').click();
  await header(page, 1).click(); await page.locator('#column-name').fill('説明'); await page.locator('#column-left').click(); await page.locator('#column-close').click();
  await matrix(page, moved);
  const other = await harness.context.newPage(); await other.goto(fixtureUrl);
  await expect(page.locator('#pick')).toBeDisabled(); await matrix(page, moved);
  await harness.source.goto(fixtureUrl);
  await matrix(page, moved);
  await expect(page.locator('#pick')).toBeDisabled();
  await expect(page.locator('#source-help')).toContainText(/拡張アイコン/);
  await expect(page.locator('#status')).toContainText(/取得済みの表.*編集.*CSV保存/);
  await header(page, 3).click(); await page.locator('#column-name').fill('継続'); await page.locator('#column-close').click();
  await matrix(page, [['説明', 'ID', '値', '継続'], ...moved.slice(1)]);
  await savedCsv(harness, [['説明', 'ID', '値', '継続'], ...movedCsv.slice(1)]);
  await testInfo.attach('source-lifecycle-boundary', { body: 'Normal workspace route; real tabs.onActivated/onUpdated; synthetic window-scoped session activation; no toolbar/side-panel activation claim.', contentType: 'text/plain' });
});

test('fault-injected cancel, interruption and unknown outcomes keep the table and require explicit recovery before resave', async ({ harness }) => {
  const page = harness.workspace; await capture(harness);
  // Fault injection is confined to this extension page's Chrome download API.
  // It evaluates recovery UI, not native dialog cancellation or filesystem failure.
  await page.evaluate(() => {
    const state = { result: 'in_progress', calls: 0, bytes: [] as number[][], originalDownload: chrome.downloads.download, originalSearch: chrome.downloads.search, originalCancel: chrome.downloads.cancel };
    Object.assign(window, { syntheticSaveFault: state });
    chrome.downloads.download = (async (options: chrome.downloads.DownloadOptions) => { state.calls++; state.bytes.push([...new Uint8Array(await (await fetch(options.url)).arrayBuffer())]); return 700; }) as typeof chrome.downloads.download;
    chrome.downloads.search = (async () => state.result === 'unknown' ? [] : [{ id: 700, state: state.result === 'in_progress' ? 'in_progress' : 'interrupted', error: state.result }]) as unknown as typeof chrome.downloads.search;
    chrome.downloads.cancel = (async () => { state.result = 'USER_CANCELED'; }) as typeof chrome.downloads.cancel;
  });
  await page.locator('#confirm').check(); await page.locator('#save').click();
  await expect(page.locator('#save-status')).toContainText('保存中');
  await expect(page.locator('#transpose')).toBeDisabled(); await expect(page.locator('#undo')).toBeDisabled();
  await page.locator('#cancel-save').click(); await expect(page.locator('#save-status')).toContainText('保存を取り消しました'); await matrix(page, initial);
  await header(page, 1).click(); await page.locator('#column-name').fill('取消後'); await page.locator('#column-close').click();
  await matrix(page, [['ID', '取消後', '値', 'メモ'], ...initial.slice(1)]);
  await page.evaluate(() => { (window as unknown as { syntheticSaveFault: { result: string } }).syntheticSaveFault.result = 'FILE_FAILED'; });
  await page.locator('#confirm').check(); await page.locator('#save').click(); await expect(page.locator('#save-status')).toContainText('失敗または中断');
  await matrix(page, [['ID', '取消後', '値', 'メモ'], ...initial.slice(1)]);
  await header(page, 1).click(); await page.locator('#column-name').fill('失敗後'); await page.locator('#column-close').click();
  await page.evaluate(() => { (window as unknown as { syntheticSaveFault: { result: string } }).syntheticSaveFault.result = 'unknown'; });
  await page.locator('#confirm').check(); await page.locator('#save').click(); await expect(page.locator('#save-status')).toContainText('保存結果が不明');
  const retained = [['ID', '失敗後', '値', 'メモ'], ...initial.slice(1)]; await matrix(page, retained);
  await expect(page.locator('#save')).toBeDisabled(); await expect(page.locator('#transpose')).toBeDisabled(); await expect(page.locator('#reconcile')).toBeEnabled();
  await page.locator('#reconcile').click(); await expect(page.locator('#save-status')).toContainText('保存結果が不明'); await matrix(page, retained);
  expect(await page.evaluate(() => (window as unknown as { syntheticSaveFault: { calls: number } }).syntheticSaveFault.calls)).toBe(3);
  await harness.source.goto(fixtureUrl); await page.bringToFront(); await matrix(page, retained);
  expect(await page.evaluate(() => (window as unknown as { syntheticSaveFault: { calls: number } }).syntheticSaveFault.calls)).toBe(3);
  const heldBytes = await page.evaluate(() => (window as unknown as { syntheticSaveFault: { bytes: number[][] } }).syntheticSaveFault.bytes);
  for (const [index, name] of ['内容', '取消後', '失敗後'].entries()) {
    expect(parseCsv(new Uint8Array(heldBytes[index]))).toEqual([
      ['ID', name, '値', 'メモ'],
      ['00001', '日本語,"引用"\n二行目', '0', ''],
      ['12345678901234567890', '\t=SUM(1,2)', '', '零'],
      ['00003', '\t@name', '先頭ゼロ 001', '戻す行'],
    ]);
  }
  const matching = '\uFEFF"ID","失敗後","値","メモ"\r\n'
    + '"00001","日本語,""引用""\n二行目","0",""\r\n'
    + '"12345678901234567890","\t=SUM(1,2)","","零"\r\n'
    + '"00003","\t@name","先頭ゼロ 001","戻す行"\r\n';
  await page.locator('#file').setInputFiles({ name: 'matching.csv', mimeType: 'text/csv', buffer: Buffer.from(matching, 'utf8') });
  await expect(page.locator('#save-status')).toContainText('選択したファイルの内容が生成CSVと一致しました');
  await matrix(page, retained);
  await page.evaluate(() => {
    const state = (window as unknown as { syntheticSaveFault: { originalDownload: typeof chrome.downloads.download; originalSearch: typeof chrome.downloads.search; originalCancel: typeof chrome.downloads.cancel } }).syntheticSaveFault;
    chrome.downloads.download = state.originalDownload; chrome.downloads.search = state.originalSearch; chrome.downloads.cancel = state.originalCancel;
  });
  await header(page, 1).click(); await page.locator('#column-name').fill('復旧後'); await page.locator('#column-close').click();
  await savedCsv(harness, [
    ['ID', '復旧後', '値', 'メモ'],
    ['00001', '日本語,"引用"\n二行目', '0', ''],
    ['12345678901234567890', '\t=SUM(1,2)', '', '零'],
    ['00003', '\t@name', '先頭ゼロ 001', '戻す行'],
  ]);
});
