# transaction-to-excel

A local-only Chrome Manifest V3 extension: **select a page range → edit the table → save CSV**. It extracts visible HTML tables, ARIA rows, repeated cards and documents, including heading hierarchy.

This README covers development and verification. User-facing instructions are maintained in the [Chrome Web Store listing source](https://github.com/gearmind-inc/transaction-to-excel/blob/main/store/listing.md). The store release is in preparation.

## Build and load from source

Use Node.js 24 and npm. From the repository root:

~~~sh
npm ci --ignore-scripts
npm run check
npm run package
~~~

Load `dist/extension` through **Developer mode → Load unpacked** in `chrome://extensions`. Open an HTTP/HTTPS page and activate the extension from the toolbar. Reload the unpacked extension after rebuilding.

The package command produces `dist/transaction-to-excel-0.1.0.zip`. Build artifacts are not committed. Chrome 116 is the minimum API version; it is not a tested compatibility range.

### Optional local fixtures

~~~sh
npm run fixture
~~~

This serves synthetic test pages on loopback:

- http://127.0.0.1:4173/transactions — Japanese text, quotes, newlines, blanks/zero, long and leading-zero IDs, formula-looking values.
- http://127.0.0.1:4173/structured — merged headers, mixed paragraphs/tables, labelled cards.
- http://127.0.0.1:4173/document-hierarchy — nested headings, definitions and code.

**The fixture server is only a development tool; the installed extension runs without it.** Stop it with Ctrl+C. No backend or local server is needed for normal use.

### Automated checks

~~~sh
npm run check
PLAYWRIGHT_BROWSERS_PATH=node_modules/.cache/ms-playwright npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=node_modules/.cache/ms-playwright npm run test:browser
~~~

`check` runs type checking, unit tests and the build. Fixed expectations are in `tests/fixtures`; `tests/oracle.ts` independently reads exported CSV. Browser tests cover extraction, source-event isolation, editing, cancellation/recovery, save contents, layout and keyboard/focus behavior.

Automated MV3 tests use a disposable extension copy with test-only loopback permission, a direct workspace route and an isolated download path. They do not prove production `activeTab` activation or native Save As; those are checked separately.

## Current scope and constraints

- Acquisition reads loaded, visible top-level HTML. Input values, hidden/unloaded content, frame interiors, Shadow DOM, image pixels, graph lines and canvas are excluded. No OCR, page API or background crawl is used.
- Editing supports column names/order, row/column exclusion and restoration, transpose, and 50-step undo. Repeated transpose restores orientation without adding cells. Cell-value editing and row dragging are not supported.
- The captured table and history remain in panel memory. Navigation or source-access expiry blocks new acquisition but retains the table. Cancelled or failed replacement also retains it; closing/reloading the panel loses it.
- Saving freezes the confirmed export. Saved, cancelled, interrupted and unknown outcomes are distinct. Unknown outcomes require reconciliation or file verification before another save; there is no automatic retry.
- Limits are 5,000 data rows, 50 columns, 10,000 UTF-16 code units per cell and 2,000,000 across logical headers and data. Acquisition, editing and export enforce the same budget. Unsupported or oversized content is disclosed rather than silently truncated.
- CSV uses a UTF-8 BOM, commas, quoted fields and CRLF records. Dates, amounts, IDs, blanks and duplicate rows retain their captured values. Formula-looking text receives a leading tab. CSV does not preserve Excel formatting, formulas or cell types; Excel is not a runtime dependency.

Implementation details and edge cases are covered in `src/extraction.ts`, `src/table-editor.ts`, `src/csv.ts`, `src/save.ts` and their tests. Spreadsheet import can still infer types or remove CSV protections when resaving; see [Microsoft's import guidance](https://support.microsoft.com/en-us/excel/keeping-leading-zeros-and-large-numbers) and [OWASP's CSV injection guidance](https://community.owasp.org/attacks/CSV_Injection).

Date/amount conversion, required-field settings and preset controls are deferred. Existing local preset records are neither applied nor deleted by this UI. Excel workbook output, wider collection, AI, ledgers, team/cloud/API features and automated login remain future work.

## Verification recorded on 2026-10-21

Type checking, build, 484 unit tests and 49 browser tests passed on macOS 26.4.1 / Chromium 153.0.8010.12. The fixed 1,000-row × 30-column workload met the 19-of-20 under-three-second target on an Apple M4 Max (first trial: 3,199 ms; remaining trials: 320–869 ms).

In ordinary Chrome 155.0.8059.80 on macOS 26.4.1, the production manifest passed native toolbar, selection, column editing, Save As, cancellation and source-navigation checks. Synthetic eight-row/five-column and [W3C sample](https://www.w3.org/WAI/tutorials/tables/one-header/) three-row/three-column exports matched all expected cells and bytes (487 and 149 bytes).

[CI for the tested source revision](https://github.com/gearmind-inc/transaction-to-excel/actions/runs/36937614137) passed on Windows, Linux and macOS; the initial macOS extension-load timeout passed on rerun without code changes. Ordinary Windows Chrome, Excel import on either OS and the operator's business-data acceptance remain unverified. These checks do not establish compatibility with every website.

## Privacy

See [PRIVACY.md](PRIVACY.md). Permissions are `activeTab`, `scripting`, `storage`, `downloads` and `sidePanel`. There is no external product network path, `storage.sync`, account or transaction archive.

Page values, edit history and generated CSV stay in panel memory until the user saves a file. `storage.local` holds minimal save metadata; legacy preset records may remain. `storage.session` holds a per-window toolbar activation (tab ID and random activation ID), without URLs or page text. Internal specs/instructions are local and excluded from clones/distribution.

## License

MIT. See [LICENSE](LICENSE).
