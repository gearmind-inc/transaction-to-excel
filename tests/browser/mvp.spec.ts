import { test as base, expect, chromium, type BrowserContext, type Page, type Worker, type TestInfo } from '@playwright/test';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { arch, cpus, release, totalmem, loadavg } from 'node:os';
import { EXPECTED_CSV, EXPECTED_PREVIEW } from '../fixtures/expected';

const fixtureUrl = 'http://127.0.0.1:4173/transactions';
const host = () => ({ platform: process.platform, osRelease: release(), architecture: arch(), cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), loadAverage: loadavg() });
type Harness = { context: BrowserContext; source: Page; workspace: Page; serviceWorker: Worker; extensionId: string; tabId: number; requests: string[]; downloadDirectory: string };

/**
 * Real unpacked MV3 code, real Chrome scripting/storage/worker/download APIs.
 * ONLY this disposable copy receives a loopback host grant because Playwright
 * cannot press Chrome's toolbar action to grant production activeTab.
 * CDP selects an isolated download directory instead of the native Save As UI.
 * Therefore these tests do not prove activeTab activation or native dialogs.
 */
async function launchHarness(testInfo: TestInfo, profile?: string): Promise<Harness> {
  const production = resolve('dist/extension');
  const temporary = testInfo.outputPath('test-only-extension');
  const manifest = JSON.parse(await readFile(resolve(production, 'manifest.json'), 'utf8'));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toEqual(['activeTab', 'scripting', 'storage', 'downloads']);
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
  await expect(workspace.locator('#status')).toContainText('表を選び');
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

const field = (page: Page, sourceColumn: number) => page.locator('#columns fieldset').filter({ has: page.locator('legend', { hasText: new RegExp(`元列 ${sourceColumn}：`) }) });

async function configureGolden(page: Page): Promise<void> {
  await page.locator('#table').selectOption('1');
  await expect(page.locator('#coverage')).toContainText('8件 / 6列');
  await field(page, 6).getByLabel('取得・出力', { exact: true }).uncheck();
  await page.getByRole('combobox', { name: '元列2の型', exact: true }).selectOption('date');
  await page.getByRole('combobox', { name: '元列2の日付入力書式', exact: true }).selectOption('YYYY/MM/DD');
  await page.getByRole('combobox', { name: '元列4の型', exact: true }).selectOption('amount');
  await page.getByRole('combobox', { name: '元列4の通貨記号（指定時は必須）', exact: true }).selectOption('¥');
  await page.getByRole('combobox', { name: '元列4の桁区切り', exact: true }).selectOption(',');
  for (const [column, name] of [[1, '取引ID'], [2, '日付'], [3, '内容'], [4, '取引額'], [5, '任意メモ']] as const) {
    await page.getByRole('textbox', { name: `元列${column}の出力列名`, exact: true }).fill(name);
  }
  for (const column of [1, 2, 4]) await field(page, column).getByLabel('空欄はエラー', { exact: true }).check();
  // Initial ID/date/description/amount/memo => date/description/amount/ID/memo.
  for (let index = 0; index < 3; index++) await field(page, 1).getByRole('button', { name: '下へ', exact: true }).click();
}

async function captureGolden(page: Page): Promise<void> {
  await configureGolden(page);
  await page.locator('#capture').click();
  await expect(page.locator('#summary')).toContainText('取得 8件 / 出力 8件 / 選択 5列 / 空欄 6セル / エラー 0件 / CSV保護 5件');
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

test('real unpacked MV3: chosen table, explicit conversion, preview and saved CSV bytes match independent oracle', async ({ harness }, testInfo) => {
  const { workspace, requests, downloadDirectory } = harness;
  const otherTab = await harness.context.newPage();
  await otherTab.goto(fixtureUrl);
  await otherTab.locator('#transactions tbody tr').first().locator('td').first().evaluate(cell => { cell.textContent = 'do-not-capture-other-tab'; });
  await captureGolden(workspace);
  const displayed = await workspace.locator('#preview tbody tr').evaluateAll(rows => rows.map(row => Array.from(row.querySelectorAll('td')).slice(1).map(cell => Array.from(cell.querySelectorAll('.cell-line')).map(line => line.textContent))));
  const visible = (value: string) => value === '' ? '［空欄］' : value.replace(/\t/g, '⟦TAB⟧').replace(/\r/g, '⟦CR⟧').replace(/\n/g, '⟦LF⟧\n').replace(/\0/g, '⟦NUL⟧');
  expect(displayed).toEqual(EXPECTED_PREVIEW.rows.map(row => row.map(cell => [`元値：${visible(cell.raw)}`, `変換後：${visible(cell.logical)}`, `CSV値：${visible(cell.output)}`])));
  expect(await workspace.locator('#preview').innerText()).not.toMatch(/do-not-capture/);
  await expect(workspace.locator('#save')).toBeDisabled();
  await workspace.locator('#confirm').check();
  const session = await harness.context.newCDPSession(workspace);
  const begun: string[] = [];
  session.on('Browser.downloadWillBegin', event => begun.push(event.guid));
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory, eventsEnabled: true });
  // Exercise rapid repeated activation; the production state machine must save once.
  await workspace.locator('#save').evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(workspace.locator('#save-status')).toContainText('保存完了を照合しました');
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
  expect(JSON.stringify(record)).not.toMatch(/00001|12345678901234567890|日本語|SUM|session|do-not-/);
  await assertOtherStorageEmpty(workspace);
  expect(requests.every(url => new URL(url).origin === new URL(fixtureUrl).origin)).toBeTruthy();
  await testInfo.attach('test-environment', { body: JSON.stringify({ browser: harness.context.browser()?.version(), host: host(), permissionDifference: 'test-only loopback host grant; activeTab activation not covered', saveDialogDifference: 'CDP isolated download directory; native Save As UI not covered', actualSavedBytes: actual.length }, null, 2), contentType: 'application/json' });
});

test('configuration changes invalidate confirmation; malformed dates preserve raw value and prevent saving', async ({ harness }) => {
  const page = harness.workspace;
  await captureGolden(page);
  await page.locator('#confirm').check();
  await page.getByRole('textbox', { name: '元列3の出力列名', exact: true }).fill('変更した内容');
  await expect(page.locator('#confirm')).not.toBeChecked();
  await expect(page.locator('#preview tbody tr')).toHaveCount(0);
  await expect(page.locator('#save')).toBeDisabled();
  await page.locator('#refresh-preview').click();
  await expect(page.locator('#preview thead')).toContainText('変更した内容');
  await harness.source.locator('#transactions tbody tr').first().locator('td').nth(1).evaluate(cell => { cell.textContent = '01/02/2026'; });
  await page.locator('#capture').click();
  await expect(page.locator('#summary')).toContainText('エラー 1件');
  await expect(page.locator('#preview tbody tr').first().locator('td').nth(1)).toContainText('元値：01/02/2026');
  await expect(page.locator('#preview .error')).toContainText('指定した入力書式 YYYY/MM/DD と一致しません');
  await expect(page.locator('#confirm')).toBeDisabled();
  await expect(page.locator('#save')).toBeDisabled();
  expect(await storage(page)).toEqual({});
});

test('local preset survives a real isolated browser restart, updates version, refuses structure mismatch, and deletes', async ({ harness }, testInfo) => {
  const page = harness.workspace;
  await captureGolden(page);
  await page.locator('#preset-name').fill('合成表の設定');
  await page.locator('#save-preset').click();
  await expect(page.locator('#preset-status')).toContainText('設定をローカルに保存しました');
  const before = await storage(page);
  expect(Object.keys(before)).toEqual(['presetsV1']);
  expect(JSON.stringify(before)).not.toMatch(/00001|12345678901234567890|日本語|SUM|session|do-not-/);
  await assertOtherStorageEmpty(page);
  const preset = (before.presetsV1 as { id: string; version: number; path: string }[])[0];
  expect(preset.path).toBe('/transactions');
  await harness.context.close();
  // Same disposable profile and same unpacked path: real persistence, not API mocks.
  const restarted = await launchHarness(testInfo, testInfo.outputPath('temporary-profile'));
  try {
    const next = restarted.workspace;
    await next.locator('#table').selectOption('1');
    await next.locator('#preset').selectOption(preset.id);
    await next.locator('#apply-preset').click();
    await expect(next.locator('#preset-status')).toContainText('選択した設定を反映しました');
    await expect(next.getByRole('textbox', { name: '元列1の出力列名', exact: true })).toHaveValue('取引ID');
    await expect(field(next, 6).getByLabel('取得・出力', { exact: true })).not.toBeChecked();
    await next.locator('#capture').click();
    await expect(next.locator('#summary')).toContainText('取得 8件 / 出力 8件 / 選択 5列');
    await next.locator('#preset-name').fill('修正した設定');
    await next.locator('#save-preset').click();
    await expect(next.locator('#preset option')).toContainText(['新しい設定', '修正した設定（版2）']);
    const updated = await storage(next);
    expect((updated.presetsV1 as { version: number }[])[0].version).toBe(preset.version + 1);
    await restarted.source.locator('#transactions th').first().evaluate(cell => { cell.textContent = '変更されたID'; });
    await next.locator('#scan').click();
    await expect(next.locator('#status')).toContainText('表を選び');
    await next.locator('#table').selectOption('1');
    await next.locator('#preset').selectOption(preset.id);
    await next.locator('#apply-preset').click();
    await expect(next.locator('#preset-status')).toContainText('構造が一致しません');
    expect(await storage(next)).toEqual(updated);
    await next.locator('#delete-preset').click();
    await expect(next.locator('#preset-status')).toContainText('選んだ設定を削除しました');
    expect(await storage(next)).toEqual({ presetsV1: [] });
    await expect(next.locator('#preview tbody tr')).toHaveCount(0);
  } finally { await restarted.context.close(); }
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
  await page.locator('#refresh-preview').click();
  await expect(page.locator('#summary')).toContainText('取得 8件 / 出力 8件');
  await page.reload();
  await expect(page.locator('#status')).toContainText('表を選び');
  await expect(page.locator('#preview tbody tr')).toHaveCount(0);
  await expect(page.locator('#save')).toBeDisabled();
  expect(await storage(page)).toEqual({});
});

test('stop immediately invalidates an in-flight acquisition; no automatic resume or stale preview appears', async ({ harness }) => {
  const page = harness.workspace;
  await configureGolden(page);
  const started = performance.now();
  await page.evaluate(() => {
    (document.querySelector('#capture') as HTMLButtonElement).click();
    (document.querySelector('#stop') as HTMLButtonElement).click();
  });
  await expect(page.locator('#summary')).toHaveText('処理を中止しました。再取得してください。');
  expect(performance.now() - started).toBeLessThan(1000);
  await expect(page.locator('#preview tbody tr')).toHaveCount(0);
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
  await expect(page.locator('#status')).toContainText('表を選び');
  await page.locator('#table').selectOption('1');
  const elapsed: number[] = [];
  for (let trial = 0; trial < 20; trial++) {
    const start = performance.now();
    await page.locator('#capture').click();
    await expect(page.locator('#summary')).toContainText('取得 1000件 / 出力 1000件 / 選択 30列');
    elapsed.push(performance.now() - start);
  }
  expect(elapsed.filter(value => value < 3000).length).toBeGreaterThanOrEqual(19);
  await expect(page.locator('#preview tbody tr')).toHaveCount(100);
  await page.locator('#next').click();
  await expect(page.locator('#page')).toContainText('2 / 10');
  await expect(page.locator('#preview tbody tr').first().locator('td').first()).toHaveText('101');
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
  await expect(page.locator('#capture')).toBeDisabled();
  await expect(page.locator('#save')).toBeDisabled();
});
