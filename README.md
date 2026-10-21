# transaction-to-excel

Free, local-only Chrome Manifest V3 prototype with three steps: **select a page range → edit the table → save CSV**. HTML tables, ARIA rows and repeated cards become a table. Documents retain their heading hierarchy and section text; mixed ranges retain local tables and text in page order.

The extension runs inside desktop Chrome and saves CSV files to your computer. **Normal use does not require a local server, Node.js, npm or Microsoft Excel.** There is no product account, backend, cloud service, AI, API connector, automated login or transaction archive. Sign in to the source website yourself if needed; that website may need an internet connection. CSV does not preserve Excel formatting, formulas, templates or cell types. Not every website structure is supported.

## Use the extension

The Chrome Web Store release is being prepared; there is no published installation link yet. After installing the extension, open the HTTP/HTTPS page you want to use and click the extension's toolbar icon. Its controls open in Chrome's side panel beside that page.

Follow the three steps below to save a CSV. Building from source and running sample pages are separate [developer instructions](#for-developers); they are not part of everyday use of an installed extension.

### Three-step workflow

1. **Select.** Click the range-selection button and point at the source page. Click the highlighted range; ↑ expands to its parent, ↓ returns, and Esc cancels. Selection input is received in a separate temporary frame so the selection click does not activate source links or buttons. The selected range appears as a table automatically. Whole-page selection and rereading are under supplementary controls. A cancelled or failed replacement retains the previous table.
2. **Edit.** Click a column heading to rename, move left/right or exclude it. Drag column headings to reorder them; the left/right controls are a keyboard-accessible alternative. Exclude rows using their row controls, and restore excluded rows or columns from the recovery controls. Transpose exchanges the visible rows and columns while keeping column names as ordinary cell values. Undo restores the last 50 changes, including a transpose and its preceding exclusion state. Cell-value editing and row dragging are outside this revision.
3. **Save.** Check all rows/columns and any CSV protection, confirm, and save to a non-synced local folder. The CSV contains all edited rows, even though the preview displays 100 at a time. Saving freezes the export and blocks edits until the result is resolved. Saved, cancelled, interrupted and unknown results are distinct. Unknown results require reconciliation or matching-file verification before another save; there is no automatic retry. After a resolved save, edit the same table and save the newly confirmed revision.

Changes use the captured in-memory table, without rereading the website. Switching tabs, navigation or closing the source revokes further acquisition but preserves the existing table for editing and saving. Click the action on the desired page to enable a new selection; that action alone does not replace the table. Closing or reloading the panel loses the table and edit history. No automatic persistence or restart recovery exists.

Stopping a pending edit returns to the last calculated table and CSV. If the first display calculation stops or fails, **表を編集** resumes from the held capture, including after source access expires.

For example, transposing this table:

| 名前 | 金額 |
| --- | --- |
| A社 | 001 |
| B社 | 0 |

produces:

| 元の列 | 元の行1 | 元の行2 |
| --- | --- | --- |
| 名前 | A社 | B社 |
| 金額 | 001 | 0 |

Click Transpose again to return to the original orientation, with no additional rows or columns. The header-value column becomes the column headings again; generated headings return to preview row labels rather than becoming CSV cells. Edits to those headings remain as row labels and reappear on the next transpose. The header-value column is identified even after renaming or moving it; the next forward transpose places it first.

Excluded rows/columns are omitted from the transpose; Undo restores the complete prior table, including exclusions. Restore the header-value column before returning if you have excluded it, and restore at least one row if all transposed rows are excluded. A first transpose needs one extra column for the original names, so up to 49 visible rows fit the 50-column limit. Returning a transposed table with 50 rows restores its original 50 columns. Refused operations retain the table and history.

Date/amount conversion, required-field settings and preset controls are deferred. Existing local preset records are neither applied nor deleted by this UI. Excel output, wider collection, AI, ledgers, team/cloud/API features and automated login remain future work.

## Explicit formats and bounds

- Content extraction traverses loaded, visible top-level HTML in document order. A document with headings has **H1…H6 / 内容** columns up to its deepest displayed heading. Missing levels and ancestors outside the selection stay blank. Each heading occurrence becomes a section row containing only its direct paragraphs, list items, standalone definitions and code, joined by line breaks. Empty parent headings and repeated sections/text remain. Preformatted indentation remains. Heading-free text retains the Title / Content fallback.
- Article, main, navigation, header, footer and aside boundaries start an independent hierarchy; nested sections inherit and restore their parent path. Selected navigation, header/footer and button labels are eligible. Text before the first heading has blank heading cells. Unrendered heading helpers, hidden or unloaded content are not acquired.
- HTML tables expand rowspan/colspan into their declared positions. A merged data cell remains at its upper-left slot; covered slots stay blank, with a warning because CSV cannot retain merges. Multiple header rows become group/leaf names. rowspan="0" stays within its row group. No repeated data or graph values are invented. Ordinary single-header table text retains raw spacing and br line breaks; footers remain data.
- Explicit ARIA table/grid roles, labelled definition-list cards and repeated rows with the same field structure can become rectangles. Unlabelled repeated rows get positional names and retain the first data row. Uncertain structures fall back to paragraph rows. Input-control values are excluded.
- Mixed ranges stack paragraphs and local table headers/data, padding to the widest block. Outer headers are positional **列1…**; local headers retain their own meaning in the worksheet. Editing operates on worksheet positions; all values remain text.
- SVG text labels can be acquired. Image pixels, graph lines, canvas data, frame interiors, Shadow DOM, generated CSS text and form-control values are not inferred. Unsupported structures inside the chosen range are disclosed. A range with no readable text stops with a reason. No page API, background crawl or OCR is used.
- Blank is not zero. Dates, amounts and IDs remain their captured strings; no type conversion is applied. Identical transaction values never delete rows.
- Safety bounds: 5,000 emitted data rows, 50 columns, 10,000 UTF-16 code units/cell, 2,000,000 across logical headers and data. Generated transpose headers count; CSV quoting, BOM and added protection tabs do not. Original tabs and document path/separator text do count. Acquisition, editing, preview and CSV enforce the same budget. Long document sections continue at paragraph/item boundaries with the same heading path and a warning. A single oversized paragraph, code block or definition item stops output without truncation. These are not throughput guarantees.
- CSV: comma, every field quoted, embedded quotes doubled, CRLF records including final ending, internal breaks retained, BOM, literal-safe only. Formula-looking text/headers get a leading tab, including text that starts with a minus sign. Bad controls block output. No raw-values/BOM-less/multiple-CSV ZIP modes.

## Optional: import the CSV into Microsoft Excel

Excel is one way to open the saved CSV; it is not needed to run the extension or save a file. If you use Excel:

1. Use **Data → From Text/CSV**, not double-click. Labels differ by Excel version.
2. Choose UTF-8/comma; inspect Japanese and column count.
3. Inspect/remove automatic type conversion **before loading**. Set leading-zero/over-15-digit IDs, phones, date-looking/scientific-notation-looking IDs and formula-looking values to **Text**. Later formatting cannot recover lost digits.
4. Set date order/locale and amount precision. Long amounts can be imported as Text to preserve digits, which differs from a calculable Excel number.
5. Compare IDs/dates/amounts/blanks/count/protection tabs with the preview. Saving an .xlsx is separate; this extension does not create/modify Excel workbooks.

BOM/quotes do not disable type inference. Tabs change file values and may remain visible. Editing/re-saving CSV may remove protection. Acceptance is separate for each OS/Excel version. [Microsoft: leading zeros/long numbers](https://support.microsoft.com/en-us/excel/keeping-leading-zeros-and-large-numbers), [OWASP: CSV injection](https://community.owasp.org/attacks/CSV_Injection).

## For developers

### Build and load from source

These steps are for developing or testing a source checkout. Use Node.js 24 and npm. Dependencies are pinned in the lockfile. From the repository directory, run:

~~~sh
npm ci --ignore-scripts
npm run check
npm run package
~~~

1. Open `chrome://extensions` in desktop Chrome. This is Chrome's built-in extension management page, not a local server.
2. Enable Developer mode, choose **Load unpacked**, and select `dist/extension`.
3. Open an HTTP/HTTPS page and click the extension's toolbar icon. Continue with the [three-step workflow](#three-step-workflow). Reload the unpacked extension after rebuilding.

The build produces a standalone extension; it does not start a server. `dist/transaction-to-excel-0.1.0.zip` contains the same extension; extract it before loading. Build artifacts are local, not committed. Chrome 116 is the minimum API version, not evidence of testing every version or OS.

### Optional: run local sample pages

This development server only serves synthetic pages for testing. **The installed extension does not depend on it.** You can use another supported website instead.

~~~sh
npm run fixture
~~~

While that command is running, open http://127.0.0.1:4173/transactions to try Japanese, quotes, newlines, blank/zero, long and leading-zero IDs, and formula-looking strings. Select the desired table, edit its structure and save; captured values remain text, with CSV protection applied as described above.

Open http://127.0.0.1:4173/structured for merged headers, mixed paragraphs/tables and labelled cards, or http://127.0.0.1:4173/document-hierarchy for nested headings, definitions and code. All sample values are synthetic. `127.0.0.1` means this computer; these addresses are not public websites. Stop the sample server with Ctrl+C when finished.

### Automated checks

~~~sh
npm run check
PLAYWRIGHT_BROWSERS_PATH=node_modules/.cache/ms-playwright npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=node_modules/.cache/ms-playwright npm run test:browser
~~~

Fixed expectations and an independent CSV reader live in tests/fixtures and tests/oracle.ts. The rework evaluates source-event isolation, rendered-text boundaries, all-cell editor sequences, cancellation/failure recovery, immutable save contents, narrow-panel layout and keyboard/focus behavior. New semantic checks failed before their implementations. Existing extraction examples remain regression checks.

Automated MV3 tests use a disposable extension copy with **test-only loopback host permission**, a direct workspace route and an isolated download path. These checks do not prove production activeTab activation or native Save As. Separate picker/extraction browser tests exercise serialized functions and rendered DOM; they do not prove the extension UI.

### Verification recorded on 2026-10-21

Type checking, build, all 484 unit checks and all 49 browser checks passed on macOS 26.4.1 / Chromium 153.0.8010.12. The fixed 1,000-row × 30-column workload completed below 3 seconds in 19 of 20 trials on an Apple M4 Max (first trial: 3,199 ms; remaining trials: 320–869 ms). This meets the 19-of-20 target for that workload; it is a measurement on this host, not a guarantee for every page or computer.

The production manifest was also tested through the native toolbar, side panel and Save As dialog in ordinary Chrome 155.0.8059.80 on macOS 26.4.1. After excluding one column from an eight-row synthetic table, the five-column CSV matched all expected cells and UTF-8/BOM/CRLF bytes (487 bytes). The first table on the [W3C sample page](https://www.w3.org/WAI/tutorials/tables/one-header/) produced three data rows and three columns, also matching every cell and byte (149 bytes). Cancelling Save As kept the table editable. Navigating to another page retained the old table and required a new toolbar activation before another capture.

[CI for the tested source revision](https://github.com/gearmind-inc/transaction-to-excel/actions/runs/36937614137) passed on Windows, Linux and macOS. The initial macOS run timed out waiting for the extension; rerunning that job passed without code changes. Ordinary Windows Chrome, Microsoft Excel import on either OS and use with the operator's business data remain unverified. The native checks above cover only the stated browser, host and inputs; they do not establish compatibility with every website.

## Privacy and scope

See [PRIVACY.md](PRIVACY.md). Only activeTab/scripting/storage/downloads/sidePanel. Page values, editing history and CSV stay in panel memory. storage.local holds minimal save metadata; old preset records may remain from earlier revisions. storage.session holds only a per-window toolbar activation (tab ID and random activation ID), with no URL or page text. No storage.sync or external product network path. Service-worker permanence is unnecessary. Internal specs/instructions remain local and are excluded from clones/distribution.

## License

MIT. See [LICENSE](LICENSE).
