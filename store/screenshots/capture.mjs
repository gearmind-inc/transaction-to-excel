// Capture real screens of the extension and the synthetic sample page into a scratch folder.
// Usage: node store/screenshots/capture.mjs <scratch output directory outside the repository>
// Requires: `npm run build` (dist/extension) and Playwright's Chromium in node_modules.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, 'node_modules', '.cache', 'ms-playwright');
const rawArg = process.argv[2];
if (!rawArg) throw new Error('Usage: node store/screenshots/capture.mjs <scratch output directory>');

const raw = path.resolve(rawArg);
if (raw === root || raw.startsWith(`${root}${path.sep}`)) {
  throw new Error('生キャプチャの出力先には、リポジトリ外のフォルダを指定してください。');
}

const dist = path.join(root, 'dist', 'extension');
// The sample page is reached through this made-up host name (mapped to loopback inside the
// scratch Chromium only), so no loopback address or port is ever drawn in a screenshot.
const sampleHost = 'transactions.example';
const outputNames = ['step1-page.png', 'step1-panel-top.png', 'step1-panel-actions.png', 'step2-panel.png', 'step3-panel.png'];

let sampleServer;
let browserContext;
let extensionCopy;
let profile;
let downloads;

async function startSampleServer() {
  const html = await readFile(path.join(here, 'sample-page.html'));
  sampleServer = createServer((req, res) => {
    if (req.url === '/' || req.url === '/transactions') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => {
    sampleServer.once('error', reject);
    sampleServer.listen(0, '127.0.0.1', resolve);
  });
  return sampleServer.address().port;
}

async function waitForEnabled(locator) {
  await locator.waitFor({ state: 'visible' });
  const deadline = Date.now() + 10_000;
  while (!(await locator.isEnabled())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for an enabled control.');
    await delay(100);
  }
}

try {
  await mkdir(raw, { recursive: true });
  for (const name of outputNames) await rm(path.join(raw, name), { force: true });

  const productionManifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
  const requiredPermissions = ['activeTab', 'scripting', 'storage', 'downloads', 'sidePanel'];
  if (requiredPermissions.some(permission => !productionManifest.permissions?.includes(permission))) {
    throw new Error('dist/extension/manifest.json is missing a permission required by the screenshot flow. Run `npm run build` first.');
  }
  if (productionManifest.host_permissions || productionManifest.optional_host_permissions) {
    throw new Error('The production manifest already has host permissions; the screenshot copy expects host access to stay test-only.');
  }

  const port = await startSampleServer();
  const sampleUrl = `http://${sampleHost}:${port}/transactions`;

  // Throw-away copy of the build with a test-only host permission. The tracked manifest.json is untouched.
  extensionCopy = await mkdtemp(path.join(raw, '.extension-copy-'));
  await cp(dist, extensionCopy, { recursive: true });
  await writeFile(path.join(extensionCopy, 'manifest.json'), JSON.stringify({
    ...productionManifest,
    host_permissions: [`http://${sampleHost}/*`],
  }, null, 2));

  // Brand-new temporary profile; the everyday Chrome profile is never touched.
  profile = await mkdtemp(path.join(raw, '.profile-'));
  downloads = await mkdtemp(path.join(raw, '.downloads-'));
  browserContext = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    viewport: { width: 720, height: 690 },
    deviceScaleFactor: 2,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    args: [
      `--disable-extensions-except=${extensionCopy}`,
      `--load-extension=${extensionCopy}`,
      `--host-resolver-rules=MAP ${sampleHost} 127.0.0.1`,
    ],
  });

  const worker = browserContext.serviceWorkers()[0] ?? await browserContext.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).hostname;
  const sourcePageReady = browserContext.waitForEvent('page');
  const tab = await worker.evaluate(url => chrome.tabs.create({ url }), sampleUrl);
  const source = await sourcePageReady;
  await source.waitForURL(sampleUrl);
  await source.locator('#transactions tbody tr').first().waitFor({ state: 'visible' });

  // The native side panel cannot be captured, so the extension page is opened as a normal tab at side-panel width.
  const workspace = await browserContext.newPage();
  await workspace.setViewportSize({ width: 440, height: 690 });
  await workspace.goto(`chrome-extension://${extensionId}/workspace.html?tab=${tab.id}`);
  const pickButton = workspace.locator('#pick');
  await waitForEnabled(pickButton);

  // Step 1: the real page picker outlines the real sample table while the panel shows "choose a range".
  await pickButton.click();
  await source.bringToFront();
  const table = source.locator('#transactions');
  const bounds = await table.boundingBox();
  if (!bounds) throw new Error('The sample transaction table is not visible.');
  await source.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await source.locator('[data-transaction-to-excel-picker]').waitFor({ state: 'visible' });
  await source.screenshot({ path: path.join(raw, 'step1-page.png'), animations: 'disabled' });
  // The panel also prints the source address under "対象：", so the panel is cut into two regions
  // that leave that one line out (cropping only; nothing in the panel is changed).
  const clipOf = async (selector) => {
    const box = await workspace.locator(selector).boundingBox();
    if (!box) throw new Error(`${selector} is not visible.`);
    return box;
  };
  const statusBox = await clipOf('#status');
  const headingBox = await clipOf('#source-heading');
  const pickBox = await clipOf('#pick');
  const coverageBox = await clipOf('#coverage');
  const panelWidth = 440;
  await workspace.screenshot({
    path: path.join(raw, 'step1-panel-top.png'), animations: 'disabled',
    clip: { x: 0, y: statusBox.y, width: panelWidth, height: headingBox.y + headingBox.height + 6 - statusBox.y },
  });
  await workspace.screenshot({
    path: path.join(raw, 'step1-panel-actions.png'), animations: 'disabled',
    clip: { x: 0, y: pickBox.y - 6, width: panelWidth, height: coverageBox.y + coverageBox.height + 14 - (pickBox.y - 6) },
  });

  // Click to select the outlined table, then rename a column in the panel.
  await source.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await workspace.bringToFront();
  await workspace.locator('#preview tbody tr').first().waitFor({ state: 'visible', timeout: 15_000 });
  await workspace.setViewportSize({ width: 900, height: 520 });
  await workspace.locator('#preview th[data-source-index="0"] button').click();
  await workspace.locator('#column-name').fill('日付');
  await workspace.locator('#preview th[data-source-index="0"] button[aria-label^="日付"]')
    .waitFor({ state: 'visible', timeout: 10_000 });
  await workspace.waitForFunction(() => document.querySelector('#preview')?.getAttribute('aria-busy') === 'false');
  await workspace.locator('#preview th[data-source-index="0"] button[aria-label^="日付"]').click();
  await workspace.locator('#column-name').evaluate(element => element.blur());
  await workspace.locator('.preview-section').screenshot({ path: path.join(raw, 'step2-panel.png'), animations: 'disabled' });

  // Step 3: save a real CSV into the scratch downloads folder and capture the result message.
  await workspace.locator('#column-close').click();
  const session = await browserContext.newCDPSession(workspace);
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  await workspace.locator('#confirm').check();
  await workspace.locator('#save').click();
  await workspace.waitForFunction(() => document.querySelector('#save-status')?.textContent?.includes('CSVを保存しました'), null, { timeout: 15_000 });
  await workspace.locator('#save').evaluate(element => element.blur());
  // From the top of the table to the bottom of the save section (the source address is above this range).
  const tableBox = await clipOf('#preview');
  const saveBox = await clipOf('.save-section');
  const pageY = await workspace.evaluate(() => window.scrollY);
  await workspace.screenshot({
    path: path.join(raw, 'step3-panel.png'), animations: 'disabled', fullPage: true,
    clip: { x: 0, y: tableBox.y + pageY, width: 900, height: saveBox.y + saveBox.height + 4 - tableBox.y },
  });

  console.log(`Captured real extension screens in: ${raw}`);
} finally {
  if (browserContext) await browserContext.close().catch(() => {});
  if (sampleServer) await new Promise(resolve => sampleServer.close(resolve));
  if (profile) await rm(profile, { recursive: true, force: true });
  if (extensionCopy) await rm(extensionCopy, { recursive: true, force: true });
  if (downloads) await rm(downloads, { recursive: true, force: true });
}
