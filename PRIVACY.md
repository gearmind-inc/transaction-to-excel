# Data handling — local CSV MVP

No product account, server, analytics, cloud sync, AI or external API is included. Packaged code does not send transactions, settings, files or diagnostics over the network; extension-page CSP blocks external connections. The website and Chrome can still communicate normally.

## Read and retention boundaries

- Only the top-level document of the tab where you click the action is read. Table discovery reads headers/counts. Explicit range selection or whole-page selection reads visible text to identify headings/counts and then automatically captures all columns in that explicitly selected range to show the initial table. Hiding/restoring columns uses that in-memory snapshot; hidden columns are excluded from the displayed/exported table. Navigation/footer, article/card, button and form labels are eligible when selected. No form-control values, cookie/authentication storage, link targets, other tabs, frame interiors or Shadow DOM interiors are accessed. Any sensitive text visibly written in the selected HTML is part of the selected text. Table, card, heading hierarchy and direct section-body structure are read from displayed HTML. Unrendered light-DOM helper text is excluded; visible slotted light-DOM text remains eligible. Unsupported structures are reported without inferring hidden data.
- Page values, transformed values, previews and CSV bytes stay in side-panel memory. Closing/reloading loses them. Acquire again; no archive or automatic recovery exists.
- Explicitly saved presets use chrome.storage.local: name, origin/path without query/fragment, table key/headers, a bounded content-structure fingerprint when present, output columns and conversion settings. No transaction samples. Authentication paths are refused. Do not put secrets/account numbers in names or labels. Delete presets in the workspace.
- chrome.storage.session holds only a per-window toolbar activation: tab ID and random activation ID. It holds no URL, page text or captured rows. The panel subscribes to new activations; another tab is only acquired after its toolbar action is clicked. Switching/navigating/closing the source invalidates the selection.
- One minimal local save-attempt record: export ID, SHA-256 digest, timestamp, download ID if known, state and bounded reason code. Not a transaction ledger. A new resolved export replaces the old record; unresolved exports block new saves until reconciliation, without automatic clearing/retry.
- Completed CSV goes to your chosen PC folder. Choose a non-synced folder. OneDrive/other software can upload files in its folders; the extension cannot prevent that.

No storage.sync, transaction IndexedDB, authentication storage or transaction logging. Local storage is restricted to trusted extension contexts. Uninstall removes settings, not CSVs or Chrome's download history. Only a recorded download ID is queried; broader history is not collected.

## Permissions

| Permission | Purpose |
| --- | --- |
| activeTab | Temporary access to the tab where you click the action |
| scripting | Select/highlight a range and read its chosen visible text in that top-level document |
| storage | Local presets and minimal save metadata |
| downloads | Save confirmed CSV and reconcile its result |
| sidePanel | Show controls alongside the current website, without a new workspace tab |

No permanent host, cookies, history, debugger, identity, AI or cloud permissions. Tab/document/URL/range/header matching is enforced separately.

## CSV and support

Formula-looking text/headers receive a leading tab, displayed as ⟦TAB⟧; converted valid negative amounts do not. Disallowed controls block output. BOM/quotes do not preserve Excel types. Import IDs/phones/formula-looking columns as Text before automatic conversion; check protection tabs. Protection after editing/re-saving or in all spreadsheet apps is not guaranteed.

Use synthetic data for bug reports. Do not upload transaction CSVs, account details, authentication URLs or raw screenshots. Automated checks do not prove support for a particular real site or Excel version; see README.
