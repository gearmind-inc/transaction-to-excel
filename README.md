# transaction-to-excel

Planned Chrome extension for converting web transaction lists into a user-provided Excel template, with CSV as an alternative export format.

Status: planning and design only; implementation, runtime validation, and release have not started.

The first target is a free, single-user, local-only MVP prototype: read one selected table from the current browser page (already signed in by the user, if needed), manually configure columns and basic date/amount conversions, preview the result, and save one CSV file to the user's PC. It requires no product account, cloud service, team workspace, API connection, paid AI service, or automated login. Settings stay in local extension storage; transaction data is kept in memory during processing, not automatically archived or synced.

CSV is the MVP's primary output, with guidance for importing values into Excel. Simple new-workbook XLSX export and broader collection are later free-extension candidates. Existing Excel template preservation and advanced local workflows, configuration sync, team sharing, API connections, and login-flow automation are later paid-option candidates; pricing and final packaging are undecided. CSV does not preserve Excel formatting, formulas, or cell types. MVP acceptance and achievement of the full product vision are separate milestones.

The planned full product includes multi-page and dynamic-list collection, reusable mappings and transformation rules, previews, duplicate handling, local AI mapping suggestions, multi-sheet and multi-source output, configuration sync, team configuration sharing, read-only API integrations, and login-flow automation.

Transaction processing and file generation are designed to run locally. Configuration sync and sharing use a separate, opt-in path; they are not transaction-upload features. Excel template preservation and CSV compatibility require validation before any support claim is made.

Internal planning entry point: [specs/spec.md](specs/spec.md). MVP and later-release allocation: [specs/release-scope.md](specs/release-scope.md). Planning documents and agent instructions are intentionally local-only and excluded from Git, so they are not included in a fresh clone. No build or installation procedure exists yet.
