# transaction-to-excel

Free, local-only Chrome Manifest V3 prototype: open the side panel beside your page, point to a range, preview its values, and save one UTF-8 BOM CSV. Ordinary tables keep their columns. Articles, sections, cards, menus and other visible HTML become **タイトル / 内容** (Title / Content) rows. Select any loaded region, or the whole page; there is no domain or article-only allowlist.

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
3. Open an HTTP/HTTPS page and click the toolbar action. The controls open in Chrome’s side panel beside that page. Reload an already loaded unpacked extension after rebuilding.

dist/transaction-to-excel-0.1.0.zip contains the same extension; extract it before loading. Build artifacts are local, not committed. Chrome 116 is the minimum API version, not a claim that all versions/OSes were tested.

## Try synthetic data

~~~sh
npm run fixture
~~~

Open http://127.0.0.1:4173/transactions, click the extension, choose table 2 and exclude column 6. Eight rows include separate same-value transactions, Japanese, quotes, newline, blank/zero, negative values, long/leading-zero IDs and formula-looking strings. No real transactions.

For this fixture only, set the date column to **date / YYYY/MM/DD** and amount to **amount / ¥ / comma grouping / dot decimal / leading minus**. Nothing is automatically guessed.

## Side-panel workflow

1. Click **ページ上で範囲を選ぶ**, move the pointer over the source page and click the highlighted range. ↑ expands to its parent; ↓ returns to the previous range; Esc cancels. The click selects the range without following the source link/button. **ページ全体を使う** selects the loaded document from top to bottom, including off-screen content. Normal tables are preferred in automatic mode; choose **選んだ範囲をタイトル・内容にする** to select a cell or other smaller region. The table list remains an optional shortcut. No next page or scroll loading.
2. Select columns, edit names/order and explicitly choose date/amount grammars. Text is default; blanks can optionally be errors.
3. Acquire and inspect original, logical converted and actual CSV values; row/column/blank/error/protection counts; types; capture time; current-page-only scope. Invisible characters appear as ⟦TAB⟧/⟦CR⟧/⟦LF⟧. Display is paged at 100 rows; output includes the entire capture.
4. Fix errors and preview again. Errors block saving. Range/column-selection changes require reacquisition; other changes invalidate confirmation and require fresh preview.
5. Confirm and save. Zero rows require explicit header-only confirmation. Choose a non-synced local folder. Existing files are not silently overwritten.
6. Check **saved / cancelled / interrupted / unknown**. A download ID is not completion. Unknown never automatically retries. Reconcile the recorded download or select a saved CSV for digest comparison. Closing/reloading loses bytes/transactions; reconciliation restores metadata only.
7. Save named local presets; choose/apply manually. Site/path, range identity and ordered headers must match exactly. Reselect the range first; applying a preset does not silently choose page content. Update increments the same preset version; delete removes that preset. Malformed settings/storage failure do not silently overwrite old settings.

Tab switching, navigation and source closure invalidate the selection. Click the toolbar action on the desired page to select a new source. Other tabs are not automatically read. During saving or an unknown save result, the current export remains available for reconciliation and source replacement is blocked. Closing/reloading the panel loses captured values; reopening only restores settings and minimal save metadata.

## Explicit formats and bounds

- Content mode traverses loaded, visible top-level HTML in document order. Heading hierarchy becomes the title; paragraphs, lists and code become content. A section can span several rows at complete block boundaries. Ordinary HTML whitespace is normalized, block boundaries become line breaks, and preformatted text retains indentation. Navigation, header/footer and button labels are included when selected. Hidden or unloaded content is not acquired.
- A selected table that cannot preserve columns can explicitly be read as Title / Content text, with tab-separated cell text and a warning. This does not reconstruct merged cells. SVG text labels can be acquired; image pixels, graph lines, canvas data, frame interiors, Shadow DOM, generated CSS text and form-control values are not inferred. The panel reports unsupported structures within the chosen range. A range containing no readable text stops with a reason. No page API, background crawl or OCR is used.
- One visible, rectangular, top-level HTML table; first row is header, thead at most one row, remaining rows include tfoot. Duplicate/empty source headers use column position. Text nodes stay untrimmed; br becomes LF. No attribute/link/form-value reading.
- In normal table mode, merged cells, nested tables, forms/inputs, uneven rows and multirow headers stop rectangular extraction. Select the same range as content to acquire its visible text with warnings. Explicit rowspan="1"/colspan="1" cells are ordinary cells and are accepted; rowspan="0" remains unsupported.
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

The original table MVP passed 234 automated tests, TypeScript check, build, and seven isolated browser scenarios. These are historical baseline results, not the new side-panel validation. Chrome for Testing 153.0.8010.12 on macOS 26.4.1 (Apple M4 Max, 64 GiB) saved the exact 476-byte oracle CSV. Twenty fixed 1,000-row × 30-column trials were below 3 seconds (95th percentile 282.8 ms, maximum 297.9 ms); not a guarantee for other machines.

Browser automation uses a temporary isolated copy with **test-only loopback host permission** for injection/worker/UI. Production has no host permission. This does not prove activeTab or native Save As; normal Chrome is separate evidence. CI passed the same automated checks on Linux/Windows/macOS, not Excel or business acceptance. The PR records actual CI results and release-readiness score.

For the original table MVP in normal macOS Chrome, the production build was loaded and toolbar-to-new-tab opening was observed. On 2026-10-01, the operator reported successful save and cancellation after following the synthetic fixture's capture/preview/save/reload/cancel steps. This is **operator-reported evidence**, not independently observed CSV bytes or an Excel import. The running desktop Chrome version was not recorded. Normal Windows Chrome, Excel import on both OSes, and business acceptance remain unverified release gates; no universal Chrome/site compatibility is claimed. The earlier new-tab check does not prove the new side-panel behavior.

### Page-range change validation (2026-10-01)

Final local checks passed: 313 automated tests, TypeScript check, build/package, and all 15 isolated MV3 browser scenarios. Fixed content expectations, pointer-selection checks and source/save race checks failed before their implementations. The new isolated MV3 browser scenarios cover whole-page CSV bytes independently read back, article/card selection, hover highlight, partial-table selection, unsupported-table content conversion, Esc/reselection, 320px layout and navigation invalidation. The original seven browser scenarios remain regression checks. See the PR checks for the exact final commit and Linux/Windows/macOS results; test profiles use the test-only grant described above, not native toolbar permission or Save As.

A separate headed Chrome for Testing 153.0.8010.12 on macOS, using the unmodified production manifest with no host grant or debugging protocol, was operated through the native toolbar. It opened the real side panel, acquired the whole synthetic page, selected its heading by source-page click, and saved through the native Save As dialog. The heading-only CSV matched the fixed 83-byte expectation and an independent CSV reader. This confirms that isolated native flow; ordinary installed Chrome, Windows and Excel acceptance remain separate.

The same headed native session acquired the whole Oracle javadoc page as 51 Title / Content rows and the Chrome trader-disclosure page as 8 rows, with zero conversion errors. Image/form/SVG/Shadow DOM omissions were disclosed. These are observed live preview results, not independently verified full-document CSV equality. After the operator signed in to Intervals.icu, the same native session acquired the full loaded Power page as Title / Content, then clicked its merged table and explicitly converted the same selection to text. Both previews had zero conversion errors and disclosed omitted graphics/form values or merged-column layout. No private source values or authenticated-page screenshots are published. This observes that page and session, not every page in the domain or independent CSV equality for its personal data.

### Earlier authorized public-table checks (2026-10-01)

Four public sites were checked against expectations fixed before evaluation, with independent source/CSV readers. These are saved HTTP HTML and separately labelled read-only browser DOM snapshots replayed through the product extraction/preview/CSV functions, **not extension-UI or native-save tests**. Page scripts and external CSS do not run in the replay; continuing page behavior, Excel and business acceptance are not proved.

| Public source | Observed input and result |
| --- | --- |
| [W3Schools HTML tables](https://www.w3schools.com/html/html_tables.asp) | 6 rows, 3 source columns. Country then Company, excluding Contact: all values and the hand-authored 224-byte CSV match. The visible table's browser DOM values also match the source expectation. |
| [DataTables example](https://datatables.net/examples/core/basic_init/zero_configuration.html) | HTTP HTML has 57 data rows plus a footer; the live browser DOM has only 10 current data rows plus the footer. Name/start date/salary capture matches each input. Explicit date/amount settings report 2 footer errors and block CSV. A separately chosen text setting preserves every row: 2,406 bytes for HTTP HTML, 494 bytes for current DOM, both independently read back. No all-page capture claim. |
| [ECB reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html) | Merged header cells: explicitly refused, no CSV. This is an unsupported-input check, not an export success. |
| [Bank of Japan rate history](https://www.boj.or.jp/statistics/boj/other/discount/discount.htm) | Merged cells: explicitly refused, no CSV. Japanese-era date conversion is not claimed. |

The DataTables live DOM exposed an erroneous rejection of ordinary span=1 cells. A regression failed before the fix; the same five public inputs/expectations match after the fix. Genuine merged cells still stop extraction. Private banking/source tabs were not tested.

## Privacy and scope

See [PRIVACY.md](PRIVACY.md). Only activeTab/scripting/storage/downloads/sidePanel. Page values/CSV stay in panel memory; presets/minimal save metadata use storage.local. storage.session holds only a window-scoped toolbar activation (tab ID and random activation ID), with no URL or page text. No storage.sync or external product network path. Service-worker permanence is unnecessary.

Excel templates, wider collection, AI, ledgers, team/cloud/API integrations and automatic login remain future work, not shipped/pre-wired. Internal specs/instructions stay local-only and are not included in clones/distribution.
