import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const sourceUrl = 'http://127.0.0.1:4173/transactions';
const pickerBundle = build({ entryPoints: ['src/picker.ts'], bundle: true, write: false, format: 'iife', globalName: 'PickerSubject', target: 'es2022' });
type Harness = { context: BrowserContext; source: Page; worker: Worker; tabId: number; pick(requestId?: string): Promise<unknown> };

async function launch(testInfo: import('@playwright/test').TestInfo): Promise<Harness> {
  const temporary = testInfo.outputPath('test-only-extension');
  await mkdir(temporary, { recursive: true });
  await cp(resolve('dist/extension'), temporary, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(temporary, 'manifest.json'), 'utf8'));
  await writeFile(resolve(temporary, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: ['http://127.0.0.1/*'] }));
  const context = await chromium.launchPersistentContext(testInfo.outputPath('temporary-profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${temporary}`, `--load-extension=${temporary}`],
    viewport: { width: 1000, height: 700 }, hasTouch: true,
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await context.route(sourceUrl, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>安全性の合成ページ</title>' }));
  const next = context.waitForEvent('page');
  const tab = await worker.evaluate(async url => chrome.tabs.create({ url }), sourceUrl);
  const source = await next; await source.waitForURL(sourceUrl); await source.bringToFront();
  const sandbox: { PickerSubject?: { pickRegion: Function } } = {};
  runInNewContext((await pickerBundle).outputFiles![0].text, sandbox);
  const serialized = sandbox.PickerSubject!.pickRegion.toString();
  const pick = (requestId = 'safety-pick') => worker.evaluate(`(async () => {
    const values = await chrome.scripting.executeScript({ target: { tabId: ${tab.id}, frameIds: [0] }, world: 'ISOLATED',
      func: (${serialized}), args: [${JSON.stringify({ requestId, expectedUrl: sourceUrl })}] });
    return values[0]?.result;
  })()`);
  return { context, source, worker, tabId: tab.id!, pick };
}

test('selection in ISOLATED world never reaches earlier window/document business handlers and restores normal input', async ({}, testInfo) => {
  const harness = await launch(testInfo);
  try {
    const { source } = harness;
    await source.setContent(`<style>button { position:absolute;left:80px;top:80px;width:180px;height:50px }</style>
      <form><button id="business-action">選択する内容</button></form><a id="normal-link" href="#normal">普通のリンク</a>`);
    await source.locator('#business-action').focus();
    await source.evaluate(() => {
      const counters: Record<string, number> = {};
      (window as Window & { siteCounters?: Record<string, number> }).siteCounters = counters;
      for (const surface of [window, document]) for (const name of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu', 'keydown', 'keyup', 'submit']) {
        const key = `${surface === window ? 'window' : 'document'}:${name}`; counters[key] = 0;
        surface.addEventListener(name, event => { counters[key]++; if (name === 'submit') event.preventDefault(); }, true);
      }
    });
    const pending = harness.pick();
    await expect.poll(async () => {
      await source.mouse.move(1, 1); await source.mouse.move(120, 100);
      return source.locator('[data-transaction-to-excel-picker]').count();
    }).toBe(1);
    await source.keyboard.press('Tab');
    await source.keyboard.press('Shift+Tab');
    await source.keyboard.press('Enter');
    await source.keyboard.press('Space');
    await source.mouse.click(120, 100, { button: 'right' });
    await source.mouse.click(120, 100, { button: 'middle' });
    await source.mouse.dblclick(120, 100);
    expect(await pending).toMatchObject({ kind: 'content', key: 'content:id:business-action' });
    const observed = await source.evaluate(() => (window as Window & { siteCounters?: Record<string, number> }).siteCounters);
    expect(observed).toEqual(Object.fromEntries(Object.keys(observed!).map(key => [key, 0])));
    await expect(source.locator('[data-transaction-to-excel-input-shield], [data-transaction-to-excel-picker]')).toHaveCount(0);
    await source.mouse.click(120, 100);
    expect(await source.evaluate(() => (window as Window & { siteCounters?: Record<string, number> }).siteCounters)).toMatchObject({ 'window:pointerdown': 1, 'document:click': 1 });
    await testInfo.attach('picker-safety-environment', { body: JSON.stringify({ browser: harness.context.browser()?.version(), input: 'real pointer sequence', injection: 'production picker function in ISOLATED world', activation: 'disposable loopback host grant; toolbar not covered' }), contentType: 'application/json' });
  } finally {
    await harness.context.close();
    await rm(testInfo.outputPath('temporary-profile'), { recursive: true, force: true });
    await rm(testInfo.outputPath('test-only-extension'), { recursive: true, force: true });
  }
});

test('touch selection stays inside the iframe and cannot activate the source button', async ({}, testInfo) => {
  const harness = await launch(testInfo);
  try {
    const { source } = harness;
    await source.setContent('<button id="touch-target" style="position:absolute;left:80px;top:80px;width:180px;height:50px">タッチの表示内容</button>');
    await source.evaluate(() => {
      (window as Window & { touches?: string[] }).touches = [];
      for (const name of ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'click']) window.addEventListener(name, () => (window as unknown as Window & { touches: string[] }).touches.push(name), true);
    });
    const pending = harness.pick();
    await expect(source.locator('[data-transaction-to-excel-input-shield]')).toBeVisible();
    await source.touchscreen.tap(120, 100);
    expect(await pending).toMatchObject({ kind: 'content', key: 'content:id:touch-target' });
    expect(await source.evaluate(() => (window as Window & { touches?: string[] }).touches)).toEqual([]);
    await expect(source.locator('[data-transaction-to-excel-input-shield]')).toHaveCount(0);
  } finally {
    await harness.context.close();
    await rm(testInfo.outputPath('temporary-profile'), { recursive: true, force: true });
    await rm(testInfo.outputPath('test-only-extension'), { recursive: true, force: true });
  }
});

test('Escape remains inside the selection frame and restores the original focused control', async ({}, testInfo) => {
  const harness = await launch(testInfo);
  try {
    const { source } = harness;
    await source.setContent('<input id="focused-control" value="private-value"><button id="target">対象</button>');
    await source.locator('#focused-control').focus();
    await source.evaluate(() => {
      (window as Window & { keys?: string[] }).keys = [];
      for (const type of ['keydown', 'keyup']) window.addEventListener(type, event => (window as unknown as Window & { keys: string[] }).keys.push((event as KeyboardEvent).key), true);
    });
    const pending = harness.pick();
    await expect(source.locator('[data-transaction-to-excel-input-shield]')).toBeVisible();
    await source.keyboard.press('Escape');
    expect(await pending).toMatchObject({ error: '範囲選択を中止しました。' });
    expect(await source.evaluate(() => (window as Window & { keys?: string[] }).keys)).toEqual([]);
    await expect(source.locator('#focused-control')).toBeFocused();
    await expect(source.locator('[data-transaction-to-excel-input-shield]')).toHaveCount(0);
    await source.keyboard.press('Enter');
    expect(await source.evaluate(() => (window as Window & { keys?: string[] }).keys)).toEqual(['Enter', 'Enter']);
  } finally {
    await harness.context.close();
    await rm(testInfo.outputPath('temporary-profile'), { recursive: true, force: true });
    await rm(testInfo.outputPath('test-only-extension'), { recursive: true, force: true });
  }
});

for (const input of ['existing modal dialog', 'modal opened during selection', 'strict frame/script/style CSP'] as const) test(`isolated selector works above ${input} without source business clicks`, async ({}, testInfo) => {
  const harness = await launch(testInfo);
  try {
    const { source } = harness;
    await source.setContent(input !== 'strict frame/script/style CSP'
      ? '<style>dialog::backdrop { pointer-events:none }</style><button id="outside">外側</button><dialog id="site-dialog"><button id="safe-target">ダイアログの表示内容</button></dialog>'
      : `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'none'; script-src 'none'; style-src 'none'"><button id="safe-target">制限下の表示内容</button>`);
    if (input === 'existing modal dialog') await source.evaluate(() => (document.getElementById('site-dialog') as HTMLDialogElement).showModal());
    await source.evaluate(() => {
      (window as Window & { clicks?: number }).clicks = 0;
      window.addEventListener('click', () => { (window as unknown as Window & { clicks: number }).clicks++; }, true);
    });
    const pending = harness.pick();
    await expect(source.locator('[data-transaction-to-excel-input-shield]')).toBeVisible();
    if (input === 'modal opened during selection') {
      await source.evaluate(() => (document.getElementById('site-dialog') as HTMLDialogElement).showModal());
      await expect(source.locator('#site-dialog [data-transaction-to-excel-input-shield]')).toBeVisible();
    }
    const target = await source.locator('#safe-target').boundingBox(); expect(target).not.toBeNull();
    const x = target!.x + target!.width / 2, y = target!.y + target!.height / 2;
    await source.mouse.move(x, y);
    await expect(source.locator('[data-transaction-to-excel-picker]')).toBeVisible();
    await source.mouse.click(x, y);
    expect(await pending).toMatchObject({ kind: 'content', key: 'content:id:safe-target' });
    expect(await source.evaluate(() => (window as Window & { clicks?: number }).clicks)).toBe(0);
    await expect(source.locator('[data-transaction-to-excel-input-shield]')).toHaveCount(0);
    await source.mouse.click(x, y);
    expect(await source.evaluate(() => (window as Window & { clicks?: number }).clicks)).toBe(1);
  } finally {
    await harness.context.close();
    await rm(testInfo.outputPath('temporary-profile'), { recursive: true, force: true });
    await rm(testInfo.outputPath('test-only-extension'), { recursive: true, force: true });
  }
});
