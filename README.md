# transaction-to-excel

Free, local-only Chrome Manifest V3 MVP: select one ordinary HTML table in a page you opened, choose/reorder columns, explicitly convert dates/amounts, preview original/output values, and save one UTF-8 BOM CSV.

No product account, paid key, server, cloud, AI, API connector, automated login or transaction archive. Sign in to the source website yourself if needed. CSV does **not** preserve Excel formatting, formulas, templates or cell types. This is a prototype; public release/universal site compatibility are not claimed.

## Build and load

Use Node.js 24 and npm. Dependencies are pinned in the lockfile.

~~~sh
npm ci --ignore-scripts
npm run check
npm run package
~~~

1. Open chrome://extensions in desktop Chrome.
2. Enable Developer mode, choose **Load unpacked**, and select dist/extension.
3. Open an HTTP/HTTPS page containing a table and click the toolbar action. The workspace opens in a new tab, fixed to the original tab.

dist/transaction-to-excel-0.1.0.zip contains the same extension; extract it before loading. Build artifacts are local, not committed. Chrome 106 is the minimum API version, not a claim that all versions/OSes were tested.

## Try synthetic data

~~~sh
npm run fixture
~~~

Open http://127.0.0.1:4173/transactions, click the extension, choose table 2 and exclude column 6. Eight rows include separate same-value transactions, Japanese, quotes, newline, blank/zero, negative values, long/leading-zero IDs and formula-looking strings. No real transactions.

For this fixture only, set the date column to **date / YYYY/MM/DD** and amount to **amount / ¥ / comma grouping / dot decimal / leading minus**. Nothing is automatically guessed.

## Workspace workflow

1. Choose a table. **Check table in source page** highlights it. Only loaded rows, including off-screen rows. No next page or scroll loading.
2. Select columns, edit names/order and explicitly choose date/amount grammars. Text is default; blanks can optionally be errors.
3. Acquire and inspect original, logical converted and actual CSV values; row/column/blank/error/protection counts; types; capture time; current-page-only scope. Invisible characters appear as ⟦TAB⟧/⟦CR⟧/⟦LF⟧. Display is paged at 100 rows; output includes the entire capture.
4. Fix errors and preview again. Errors block saving. Table/column-selection changes require reacquisition; other changes invalidate confirmation and require fresh preview.
5. Confirm and save. Zero rows require explicit header-only confirmation. Choose a non-synced local folder. Existing files are not silently overwritten.
6. Check **saved / cancelled / interrupted / unknown**. A download ID is not completion. Unknown never automatically retries. Reconcile the recorded download or select a saved CSV for digest comparison. Closing/reloading loses bytes/transactions; reconciliation restores metadata only.
7. Save named local presets; choose/apply manually. Site/path, table identity and ordered headers must match exactly. Update increments the same preset version; delete removes that preset. Malformed settings/storage failure do not silently overwrite old settings.

## Explicit formats and bounds

- One visible, rectangular, top-level HTML table; first row is header, thead at most one row, remaining rows include tfoot. Duplicate/empty source headers use column position. Text nodes stay untrimmed; br becomes LF. No attribute/link/form-value reading.
- Merged cells, nested tables, forms/inputs, uneven rows, multirow headers, frames, Shadow DOM and virtual/card lists are refused, not approximated.
- Date input: YYYY-MM-DD, YYYY/MM/DD, YYYY年M月D日, MM/DD/YYYY, DD/MM/YYYY. Output: YYYY-MM-DD or YYYY/MM/DD. Gregorian years 1–9999, real dates only; no missing-year/timezone/timestamp/era inference.
- Amount: explicitly choose no symbol/prefix ¥,$,€/suffix 円; no/comma/dot grouping; dot/comma decimal; leading-minus/parentheses negative. Selected symbol required, valid grouping and distinct separators. No whitespace/fullwidth digit/dash-as-zero/arithmetic/trailing-minus guessing. Decimal digits/fractional trailing zeros remain exact, no floating point.
- Blank is not zero. IDs remain text unless explicitly changed. Identical transaction values never delete rows.
- Safety bounds: 5,000 data rows, 50 columns, 10,000 characters/cell, 2,000,000 selected text characters, 50 presets. Exceeding bounds stops output without truncation; not throughput guarantees.
- CSV: comma, every field quoted, embedded quotes doubled, CRLF records including final ending, internal breaks retained, BOM, literal-safe only. Formula-looking text/headers get a leading tab; converted decimal negatives do not. Bad controls block output. No raw-values/BOM-less/multiple-CSV ZIP modes.

## Import into Microsoft Excel

1. Use **Data → From Text/CSV**, not double-click. Labels differ by Excel version.
2. Choose UTF-8/comma; inspect Japanese and column count.
3. Inspect/remove automatic type conversion **before loading**. Set leading-zero/over-15-digit IDs, phones, date-looking/scientific-notation-looking IDs and formula-looking values to **Text**. Later formatting cannot recover lost digits.
4. Set date order/locale and amount precision. Long amounts can be imported as Text to preserve digits, which differs from a calculable Excel number.
5. Compare IDs/dates/amounts/blanks/count/protection tabs with the preview. Saving an .xlsx is separate; this extension does not create/modify Excel workbooks.

BOM/quotes do not disable type inference. Tabs change file values and may remain visible. Editing/re-saving CSV may remove protection. Acceptance is separate for each OS/Excel version. [Microsoft: leading zeros/long numbers](https://support.microsoft.com/en-us/excel/keeping-leading-zeros-and-large-numbers), [OWASP: CSV injection](https://community.owasp.org/attacks/CSV_Injection).

## Development and evidence

~~~sh
npm test
npm run typecheck
npm run build
PLAYWRIGHT_BROWSERS_PATH=node_modules/.cache/ms-playwright npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=node_modules/.cache/ms-playwright npm run test:browser
~~~

Hand-authored fixtures/expectations and independent CSV reader: tests/fixtures and tests/oracle.ts. Health checks reject changed dates, money, counts, source and blank/zero. Before implementation, valid empty adapters failed semantic comparisons while oracle checks passed. Save/preset evaluators also preceded implementation. CI retains these checks without relying on ignored internal specifications.

Local results: 232 automated assertions, TypeScript check, build, and seven isolated browser scenarios pass. Chrome for Testing 153.0.8010.12 on macOS 26.4.1 (Apple M4 Max, 64 GiB) saved the exact 476-byte oracle CSV. Twenty fixed 1,000-row × 30-column trials were below 3 seconds (95th percentile 282.3 ms, maximum 1,412.8 ms); not a guarantee for other machines.

Browser automation uses a temporary isolated copy with **test-only loopback host permission** for injection/worker/UI. Production has no host permission. This does not prove activeTab or native Save As; normal Chrome is separate evidence. CI runs the same automated checks on Linux/Windows/macOS, not Excel or business acceptance. The PR records actual CI results and release-readiness score. Normal desktop Chrome, Excel, real sites and business acceptance remain unverified gates.

## Privacy and scope

See [PRIVACY.md](PRIVACY.md). Only activeTab/scripting/storage/downloads. Transactions/CSV in workspace memory; presets/minimal save metadata in storage.local; no storage.sync or external product network path. Service-worker permanence is unnecessary.

Excel templates, wider collection, AI, ledgers, team/cloud/API integrations and automatic login remain future work, not shipped/pre-wired. Internal specs/instructions stay local-only and are not included in clones/distribution.
