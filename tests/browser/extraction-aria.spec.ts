import { test, expect } from '@playwright/test';
import { inspectPage } from '../../src/extraction';
import { LIMITS, type InspectRequest } from '../../src/contracts';

const headers = ['ID', '値'];
// Same fixed visible-cell contract as the DOM evaluator, without deriving
// expectations from product output or using authenticated website content.
const rows = [['001', '0']];
const table = '<table id="visible"><thead><tr><th>ID</th><th>値</th></tr></thead><tbody><tr><td aria-hidden="true">001</td><td>0</td></tr></tbody></table>';

function request(mode: InspectRequest['mode'], content: boolean): InspectRequest {
  return { mode, expectedUrl: 'about:blank', requestId: 'visible-aria-browser-oracle', limits: LIMITS, tableIndex: 0, tableKey: content ? 'content:id:visible' : 'id:visible', ...(content ? { kind: 'content' as const } : {}) };
}

for (const ancestorHidden of [false, true]) for (const content of [false, true]) {
  test(`${content ? 'content' : 'ordinary'} capture retains rendered ARIA-hidden cells${ancestorHidden ? ' inside an ARIA-hidden ancestor' : ''}`, async ({ page }) => {
    await page.setContent(`<!doctype html><html><body><main${ancestorHidden ? ' aria-hidden="true"' : ''}>${table}</main></body></html>`);
    await expect(page.locator('td[aria-hidden="true"]')).toBeVisible();
    await expect(page.locator('td[aria-hidden="true"]')).toHaveText('001');
    expect(await page.locator('td[aria-hidden="true"]').evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return Array.from(range.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
    })).toBe(true);
    const described = content ? await page.evaluate(inspectPage, request('describe', true)) : undefined;
    if (content) expect(described?.error).toBeUndefined();
    const result = await page.evaluate(inspectPage, { ...request('capture', content), headers, sourceIndexes: [0, 1], ...(content ? { contentSignature: described?.tables?.[0].contentSignature } : {}) });
    expect(result.error).toBeUndefined();
    expect(result.capture?.headers).toEqual(headers);
    expect(result.capture?.rows).toEqual(rows);
  });
}
