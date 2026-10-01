# Webページ → CSV (transaction-to-excel) プライバシーポリシー / Privacy policy

最終更新日 / Last updated: 2026-10-02

## 日本語

### 提供者と適用範囲

Webページ → CSV (無料ローカル版、リポジトリ名 transaction-to-excel) は GearMind Inc. (株式会社GearMind) が提供する Chrome 拡張機能です。このポリシーは、この拡張機能が扱う情報について説明します。

### データの扱いの概要 (ローカル CSV の MVP)

製品のアカウント、サーバー、アクセス解析、クラウド同期、AI、外部 API はありません。同梱のコードは、取引・設定・ファイル・診断情報をネットワークへ送りません。拡張機能のページの CSP (コンテンツ セキュリティ ポリシー) が外部への接続を止めています。閲覧中のサイトと Chrome 自身の通常の通信は、これまでどおり行われます。

### 読む情報と保存の範囲

- 読むのは、ツールバーのボタンを押したタブの最上位の文書だけです。表の候補を探すときは、見出しと件数を読みます。範囲を選ぶか「ページ全体を使う」を選ぶと、表示されている文字を読んで見出しと件数を確かめ、選んだ範囲の全列を自動で取り込んで最初の表を表示します。列・行の除外と復元、列名の変更、並べ替え、行と列の入れ替え、元に戻すは、メモリ上に取り込んだ内容に対して行います。除外した行と列は、表示する表と出力する表から除きます。選んだ範囲にあれば、ナビゲーション・フッター、記事・カード、ボタンやフォームのラベルも取り込みの対象です。入力欄の値、Cookie や認証情報の保存領域、リンク先、他のタブ、iframe の内側、Shadow DOM の内側にはアクセスしません。選んだ HTML に見える形で書かれている機密の文字は、選んだ文字に含まれます。表・カード・見出しの階層・各節の本文の構造は、表示されている HTML から読みます。表示されない light DOM の補助の文字は除き、slot に差し込まれて表示されている light DOM の文字は対象にします。対応していない構造は、隠れたデータを推測せずに知らせます。
- タブの URL は、HTTP/HTTPS のページであることと、ページが変わっていないことを確かめるために読みます。パネルにはそのオリジン (例: `https://example.com`) だけを表示します。URL はパネルのメモリの中だけで扱い、保存しません。
- ページの値、編集した表、上限のある「元に戻す」の履歴、プレビュー、CSV のバイト列は、サイドパネルのメモリの中だけにあります。タブの切り替え・ページの移動・元のタブを閉じると、取り込みの許可はなくなりますが、取り込み済みの表は残ります。パネルを閉じるか再読み込みすると、表は消えます。もう一度取り込んでください。保管や自動の復元はありません。
- 設定の保存・再利用 (プリセット) の画面は、この版にはありません。以前の版で明示的に保存した設定が chrome.storage.local に残っていることがあります。内容は、名前、取得元のオリジンとパス (クエリとフラグメントは含まない)、表の識別名と見出し、ある場合は上限のある内容構造の指紋、出力列、変換の設定です。この版の画面は、これらを読まず、適用せず、書き込まず、削除もしません。取引の見本は保存しません。
- chrome.storage.session に置くのは、ウィンドウごとのツールバー操作の記録 (タブ ID とランダムな起動 ID) だけです。URL、ページの文字、取り込んだ行は置きません。パネルは新しい起動の記録を受け取ります。別のタブは、そのタブでツールバーのボタンを押したときだけ取り込みます。タブの切り替え・ページの移動・元のタブを閉じると、それ以上の取り込みはできなくなりますが、取り込み済みの表は編集できます。この記録は、同じウィンドウでボタンを押すたびに置き換わり、Chrome の再起動や、拡張機能の更新・再読み込み・無効化で消えます。
- ローカルに保存する保存の試行の記録は 1 件だけです。内容は、出力 ID、SHA-256 ダイジェスト、日時、分かればダウンロード ID、状態、決まった形の理由コードです。取引の台帳ではありません。新しい保存を始めると、ダウンロードを始める前に、その保存の記録 (状態は「保存中」) が古い記録を置き換えます。その後、保存の結果 (保存済み・取消・中断・不明) に合わせて状態を更新します。この記録を書き込めないときは、ダウンロードを始めません。前の保存の結果が確定していない (保存中・不明) ときは、照合するまで新しい保存はできず、古い記録はそのまま残ります。自動で消したり保存し直したりはしません。この記録は、次の保存を始めて置き換わるか、アンインストールするまで残ります。
- 保存結果が分からないときは、保存された CSV ファイルを選んで、生成した CSV と同じか照合できます。選んだファイルは、SHA-256 ダイジェストを計算するためにパネルのメモリの中だけで読み、保存も送信もしません。一致したときは、保存の試行の記録の状態を「保存済み」に更新します。
- 保存が完了した CSV は、選んだ PC のフォルダに置かれます。同期されないフォルダを選んでください。OneDrive などのソフトは、そのフォルダのファイルをアップロードすることがあります。拡張機能はそれを止められません。

storage.sync、取引用の IndexedDB、認証情報の保存、取引の記録 (ログ) は使いません。ローカルの保存領域は、信頼された拡張機能の画面だけが使えるように制限しています。アンインストールすると拡張機能内の設定は消えますが、保存した CSV と Chrome のダウンロード履歴は残ります。照会するのは記録したダウンロード ID だけで、それ以外のダウンロード履歴は集めません。

### 情報の利用

読んだ情報は、選んだ範囲を表にして編集し、CSV として保存するためだけに使います。広告・アクセス解析、第三者への提供・販売、信用判断・貸付には利用しません。開発者が端末内の情報を取得・閲覧する機能はありません。この情報の利用は、Chrome ウェブストアの [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) の制限に従います。

拡張機能は保存する記録を独自に暗号化していません。端末や Chrome のプロファイルにアクセスできる人は、保存の試行の記録や以前の版の設定を読める可能性があります。保存した CSV は、選んだフォルダに暗号化せずに置かれます。

### 権限

| 権限 | 目的 |
| --- | --- |
| activeTab | ツールバーのボタンを押したタブに、一時的にアクセスするため |
| scripting | そのタブの最上位の文書で、範囲を選んで強調表示し、選んだ範囲の表示されている文字を読むため |
| storage | ツールバー操作の記録と、最小限の保存の記録をローカルに置くため |
| downloads | 確認した CSV を保存し、その結果を照合するため |
| sidePanel | 新しいタブを開かずに、今のサイトの横に操作画面を表示するため |

常時のサイトアクセス権限 (host 権限)、cookies、history、debugger、identity、AI やクラウドの権限は使いません。タブ・文書・URL・範囲・見出しが一致するかは、権限とは別に確かめています。

### CSV とサポート

数式に見える文字や見出しの先頭には保護用のタブを加え、画面では ⟦TAB⟧ と表示します。負の数に見える金額も含め、値はすべて文字列のままです。日付や金額の変換はしません。使えない制御文字があると出力しません。BOM や引用符では Excel の型は保たれません。ID・電話番号・数式に見える列は、自動変換の前に文字列として取り込み、保護用のタブを確かめてください。編集・保存し直した後や、すべての表計算ソフトでの保護は保証しません。

不具合の報告には架空のデータを使ってください。取引の CSV、口座の情報、認証用の URL、加工していないスクリーンショットはアップロードしないでください。自動の確認は、特定の実サイトや Excel の版で動くことを示すものではありません。README を参照してください。

### お問い合わせと変更

お問い合わせは dev@gearmind.cc で受け付けます。不具合や機能の要望は [GitHub Issues](https://github.com/gearmind-inc/transaction-to-excel/issues) でも受け付けます。投稿は公開されます。

このポリシーを変更した場合は、このページに変更後の内容と最終更新日を掲載します。

## English

### Provider and scope

Webページ → CSV (無料ローカル版; repository name transaction-to-excel) is a Chrome extension provided by GearMind Inc. (株式会社GearMind). This policy explains how the extension handles data.

### Data handling — local CSV MVP

No product account, server, analytics, cloud sync, AI or external API is included. Packaged code does not send transactions, settings, files or diagnostics over the network; extension-page CSP blocks external connections. The website and Chrome can still communicate normally.

### Read and retention boundaries

- Only the top-level document of the tab where you click the action is read. Table discovery reads headers/counts. Explicit range selection or whole-page selection reads visible text to identify headings/counts and then automatically captures all columns in that explicitly selected range to show the initial table. Column/row exclusion and restoration, renaming, reordering, transpose and Undo use that in-memory snapshot; excluded rows and columns are omitted from the displayed/exported table. Navigation/footer, article/card, button and form labels are eligible when selected. No form-control values, cookie/authentication storage, link targets, other tabs, frame interiors or Shadow DOM interiors are accessed. Any sensitive text visibly written in the selected HTML is part of the selected text. Table, card, heading hierarchy and direct section-body structure are read from displayed HTML. Unrendered light-DOM helper text is excluded; visible slotted light-DOM text remains eligible. Unsupported structures are reported without inferring hidden data.
- The tab's URL is read to confirm that it is an HTTP/HTTPS page and that the page has not changed. The panel displays only its origin (for example, `https://example.com`). The URL stays in panel memory and is not stored.
- Page values, the edited table, its bounded Undo history, previews and CSV bytes stay in side-panel memory. Switching tabs, navigating or closing the source revokes acquisition access but preserves the already captured table. Closing/reloading the panel loses it. Acquire again; no archive or automatic recovery exists.
- Preset controls are deferred in this revision. Records explicitly saved by earlier revisions may remain in chrome.storage.local: name, origin/path without query/fragment, table key/headers, a bounded content-structure fingerprint when present, output columns and conversion settings. This UI does not read, apply, write or delete them. No transaction samples are stored.
- chrome.storage.session holds only a per-window toolbar activation: tab ID and random activation ID. It holds no URL, page text or captured rows. The panel subscribes to new activations; another tab is only acquired after its toolbar action is clicked. Switching/navigating/closing the source invalidates further acquisition access, while the already captured table remains editable. The activation is replaced each time you click the action in that window, and is cleared when Chrome restarts or the extension is updated, reloaded or disabled.
- One minimal local save-attempt record: export ID, SHA-256 digest, timestamp, download ID if known, state and bounded reason code. Not a transaction ledger. Starting a new save replaces the old record with that save's record (state: saving) before the download begins; its state is then updated to the result (saved, cancelled, interrupted or unknown). If that record cannot be written, the download does not start. While an earlier save is unresolved (saving or unknown), new saves are blocked until reconciliation and the old record is kept, without automatic clearing/retry. The record remains until a later save starts and replaces it, or the extension is uninstalled.
- If a save result is unknown, you can choose a saved CSV file to check whether it matches the generated CSV. The chosen file is read in panel memory only to compute its SHA-256 digest; it is not stored or sent. A match updates the save-attempt record to saved.
- Completed CSV goes to your chosen PC folder. Choose a non-synced folder. OneDrive/other software can upload files in its folders; the extension cannot prevent that.

No storage.sync, transaction IndexedDB, authentication storage or transaction logging. Local storage is restricted to trusted extension contexts. Uninstall removes settings, not CSVs or Chrome's download history. Only a recorded download ID is queried; broader history is not collected.

### Use of data

Data that is read is used only to turn the selected range into a table, edit it and save it as CSV. It is not used for advertising, analytics, credit decisions, or lending, or shared or sold to third parties. The developer has no feature to retrieve or read data on your device. This use of information adheres to the Chrome Web Store's [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) restrictions.

The extension does not encrypt its stored records itself. Someone with access to the device or Chrome profile may be able to read the save-attempt record or settings from earlier revisions. Saved CSV files are placed unencrypted in the folder you choose.

### Permissions

| Permission | Purpose |
| --- | --- |
| activeTab | Temporary access to the tab where you click the action |
| scripting | Select/highlight a range and read its chosen visible text in that top-level document |
| storage | Toolbar activation and minimal local save metadata |
| downloads | Save confirmed CSV and reconcile its result |
| sidePanel | Show controls alongside the current website, without a new workspace tab |

No permanent host, cookies, history, debugger, identity, AI or cloud permissions. Tab/document/URL/range/header matching is enforced separately.

### CSV and support

Formula-looking text/headers receive a leading tab, displayed as ⟦TAB⟧. All values remain text, including negative-looking amounts; no date or amount conversion is performed. Disallowed controls block output. BOM/quotes do not preserve Excel types. Import IDs/phones/formula-looking columns as Text before automatic conversion; check protection tabs. Protection after editing/re-saving or in all spreadsheet apps is not guaranteed.

Use synthetic data for bug reports. Do not upload transaction CSVs, account details, authentication URLs or raw screenshots. Automated checks do not prove support for a particular real site or Excel version; see README.

### Contact and changes

For questions, contact dev@gearmind.cc. Bug reports and feature requests are also welcome in [GitHub Issues](https://github.com/gearmind-inc/transaction-to-excel/issues). Posts are public.

If this policy changes, the revised text and last-updated date will be posted on this page.
