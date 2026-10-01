import { test, expect, type Page } from '@playwright/test';
import { inspectPage } from '../../src/extraction';
import { LIMITS, type InspectRequest } from '../../src/contracts';

// This is a hand-authored rendered-text oracle, independent of product output.
const headers = ['A', 'B'];
const rows = [['', 'VISIBLE_B'], ['SLOTTED', 'OFFSCREEN']];
const shadowWarning = '部品の内側（Shadow DOM）の表示は、この取得結果に含まれません。';
const source = `<!doctype html><html><body>
<style>td,th{border:1px solid #888;padding:4px}#offscreen{transform:translateY(2000px)}</style>
<table id="visible"><thead><tr><th>A</th><th>B</th></tr></thead><tbody>
<tr><td><x-closed><span id="helper">HIDDEN_HELPER</span><br id="hidden-break"></x-closed></td><td>VISIBLE_B</td></tr>
<tr><td><x-slotted><span slot="label">SLOTTED</span><span id="unassigned">HIDDEN_UNASSIGNED</span></x-slotted></td><td id="offscreen">OFFSCREEN</td></tr>
</tbody></table>
<x-closed-table><table id="hidden-table"><thead><tr><th>HIDDEN_HEADER</th></tr></thead><tbody><tr><td>HIDDEN_CELL</td></tr></tbody></table></x-closed-table>
<script>
customElements.define('x-closed', class extends HTMLElement { constructor(){super();this.attachShadow({mode:'closed'}).innerHTML='VISIBLE_OPAQUE';} });
customElements.define('x-slotted', class extends HTMLElement { constructor(){super();this.attachShadow({mode:'closed'}).innerHTML='<slot name="label"></slot>';} });
customElements.define('x-closed-table', class extends HTMLElement { constructor(){super();this.attachShadow({mode:'closed'}).innerHTML='VISIBLE_COMPONENT';} });
</script></body></html>`;

async function render(page: Page): Promise<void> {
  await page.setContent(source);
  await expect(page.locator('#helper')).not.toBeVisible();
  await expect(page.locator('#unassigned')).not.toBeVisible();
  await expect(page.locator('#hidden-table')).not.toBeVisible();
  await expect(page.locator('x-closed')).toBeVisible();
  expect(await page.locator('x-closed').evaluate(element => element.shadowRoot)).toBeNull();
  await expect(page.locator('span[slot="label"]')).toBeVisible();
  // A closed root masks assignedSlot as well, so geometry must decide visibility.
  expect(await page.locator('span[slot="label"]').evaluate(element => element.assignedSlot)).toBeNull();
  expect(await page.locator('#offscreen').evaluate(element => element.getBoundingClientRect().top > innerHeight)).toBe(true);
}

function request(mode: InspectRequest['mode'], content = false): InspectRequest {
  return { mode, expectedUrl: 'about:blank', requestId: 'rendered-text-oracle', limits: LIMITS, tableIndex: 0, tableKey: content ? 'content:id:visible' : 'id:visible', ...(content ? { kind: 'content' as const } : {}) };
}

test('rendered ordinary table: closed-shadow helpers never enter cells and unsupported internals are disclosed', async ({ page }) => {
  await render(page);
  const result = await page.evaluate(inspectPage, { ...request('capture'), headers, sourceIndexes: [0, 1] });
  expect(result.error).toBeUndefined();
  expect(result.capture?.headers).toEqual(headers);
  expect(result.capture?.rows).toEqual(rows);
  expect(result.capture?.warnings).toContain(shadowWarning);
  expect(JSON.stringify(result.capture)).not.toMatch(/HIDDEN_|VISIBLE_OPAQUE/);
});

test('rendered content table: cells use the same visible text contract and warn about closed components', async ({ page }) => {
  await render(page);
  const described = await page.evaluate(inspectPage, request('describe', true));
  expect(described.error).toBeUndefined();
  const candidate = described.tables![0];
  const result = await page.evaluate(inspectPage, { ...request('capture', true), headers, sourceIndexes: [0, 1], contentSignature: candidate.contentSignature });
  expect(result.error).toBeUndefined();
  expect(result.capture?.headers).toEqual(headers);
  expect(result.capture?.rows).toEqual(rows);
  expect(result.capture?.warnings).toContain(shadowWarning);
  expect(JSON.stringify(result.capture)).not.toMatch(/HIDDEN_|VISIBLE_OPAQUE/);
});

test('rendered table discovery: a hidden closed-shadow light-DOM table is unavailable', async ({ page }) => {
  await render(page);
  const result = await page.evaluate(inspectPage, { ...request('describe'), tableIndex: 1, tableKey: 'id:hidden-table' });
  expect(result.error).toBeUndefined();
  expect(result.tables?.[0].error).toMatch(/非表示/);
});

type ComponentFixtureOptions = { hostAttributes?: string; hostStyle?: string; ancestorAttributes?: string };

async function renderContentsComponent(page: Page, options: ComponentFixtureOptions = {}) {
  // This isolated table contains only one component, so another component
  // cannot accidentally supply the warning under test.
  await page.setContent(`<!doctype html><html><body>
    <style>[hidden]{display:none!important}td,th{border:1px solid #888;padding:4px}</style>
    <table id="visible"><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr>
      <td><span ${options.ancestorAttributes ?? ''}><x-contents-closed style="display:contents;${options.hostStyle ?? ''}" ${options.hostAttributes ?? ''}><span>HIDDEN_HELPER</span></x-contents-closed></span></td>
      <td>VISIBLE_B</td>
    </tr></tbody></table>
  </body></html>`);
  return page.evaluate(() => {
    const host = document.querySelector('x-contents-closed')!;
    const root = host.attachShadow({ mode: 'closed' });
    const internal = document.createElement('span');
    internal.textContent = 'VISIBLE_OPAQUE';
    root.append(internal);
    // The internal reference exists only in fixture setup. inspectPage is
    // evaluated independently and has no access to the closed root.
    const contents = document.createRange();
    contents.selectNodeContents(host);
    const rect = internal.getBoundingClientRect();
    return {
      hostDisplay: getComputedStyle(host).display,
      hostRectCount: host.getClientRects().length,
      contentsRectCount: contents.getClientRects().length,
      internalWidth: rect.width,
      internalHeight: rect.height,
      exposedShadowRoot: host.shadowRoot !== null,
    };
  });
}

test('rendered ordinary table: a closed-shadow display:contents host discloses opaque displayed text', async ({ page }) => {
  const geometry = await renderContentsComponent(page);
  expect(geometry).toMatchObject({ hostDisplay: 'contents', hostRectCount: 0, contentsRectCount: 0, exposedShadowRoot: false });
  expect(geometry.internalWidth).toBeGreaterThan(0);
  expect(geometry.internalHeight).toBeGreaterThan(0);
  const result = await page.evaluate(inspectPage, { ...request('capture'), headers, sourceIndexes: [0, 1] });
  expect(result.error).toBeUndefined();
  expect(result.capture?.headers).toEqual(headers);
  expect(result.capture?.rows).toEqual([['', 'VISIBLE_B']]);
  expect(JSON.stringify(result.capture)).not.toMatch(/HIDDEN_HELPER|VISIBLE_OPAQUE/);
  expect(result.capture?.warnings).toContain(shadowWarning);
});

test('rendered content table: a closed-shadow display:contents host is disclosed at describe and capture', async ({ page }) => {
  const geometry = await renderContentsComponent(page);
  expect(geometry).toMatchObject({ hostDisplay: 'contents', hostRectCount: 0, contentsRectCount: 0, exposedShadowRoot: false });
  expect(geometry.internalWidth).toBeGreaterThan(0);
  expect(geometry.internalHeight).toBeGreaterThan(0);
  const described = await page.evaluate(inspectPage, request('describe', true));
  expect(described.error).toBeUndefined();
  const candidate = described.tables![0];
  expect(candidate.headers).toEqual(headers);
  expect(candidate.warnings).toContain(shadowWarning);
  const result = await page.evaluate(inspectPage, { ...request('capture', true), headers, sourceIndexes: [0, 1], contentSignature: candidate.contentSignature });
  expect(result.error).toBeUndefined();
  expect(result.capture?.headers).toEqual(headers);
  expect(result.capture?.rows).toEqual([['', 'VISIBLE_B']]);
  expect(JSON.stringify(result.capture)).not.toMatch(/HIDDEN_HELPER|VISIBLE_OPAQUE/);
  expect(result.capture?.warnings).toContain(shadowWarning);
});

const invisibleComponents: Array<{ name: string; options: ComponentFixtureOptions }> = [
  { name: 'hidden attribute', options: { hostAttributes: 'hidden' } },
  { name: 'display:none', options: { hostStyle: 'display:none' } },
  { name: 'visibility:hidden', options: { hostStyle: 'visibility:hidden' } },
  { name: 'opacity:0', options: { hostStyle: 'opacity:0' } },
  { name: 'content-visibility:hidden', options: { hostStyle: 'content-visibility:hidden' } },
  { name: 'hidden ancestor', options: { ancestorAttributes: 'hidden' } },
];

for (const fixture of invisibleComponents) {
  test(`rendered component warning: ${fixture.name} never warns about invisible internals`, async ({ page }) => {
    // A box makes opacity/content-visibility act on the hidden component;
    // the boxless display:contents cases are covered separately above.
    await renderContentsComponent(page, { ...fixture.options, hostStyle: `display:inline-block;${fixture.options.hostStyle ?? ''}` });
    const ordinary = await page.evaluate(inspectPage, { ...request('capture'), headers, sourceIndexes: [0, 1] });
    expect(ordinary.error).toBeUndefined();
    expect(ordinary.capture?.headers).toEqual(headers);
    expect(ordinary.capture?.rows).toEqual([['', 'VISIBLE_B']]);
    expect(ordinary.capture?.warnings ?? []).not.toContain(shadowWarning);
    const described = await page.evaluate(inspectPage, request('describe', true));
    expect(described.error).toBeUndefined();
    const candidate = described.tables![0];
    expect(candidate.headers).toEqual(headers);
    expect(candidate.warnings ?? []).not.toContain(shadowWarning);
    const content = await page.evaluate(inspectPage, { ...request('capture', true), headers, sourceIndexes: [0, 1], contentSignature: candidate.contentSignature });
    expect(content.error).toBeUndefined();
    expect(content.capture?.headers).toEqual(headers);
    expect(content.capture?.rows).toEqual([['', 'VISIBLE_B']]);
    expect(content.capture?.warnings ?? []).not.toContain(shadowWarning);
  });
}
