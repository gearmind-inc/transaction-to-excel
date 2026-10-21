# Chrome ウェブストア掲載文

登録欄への入力と公開前の確認は [申請手順](submission.md) を参照してください。

## 掲載の設定

| 項目 | 内容 |
|---|---|
| 名前 | `Webページ → CSV (無料ローカル版)` (manifest の `name` から表示されます) |
| 言語 | 日本語 |
| カテゴリ | ツール |

今の拡張機能は日本語だけで、`_locales` (多言語化のフォルダ) を持っていません。公式の [掲載情報のページ](https://developer.chrome.com/docs/webstore/cws-dashboard-listing) では、言語ごとの説明を登録できるのは拡張機能を多言語化した場合です。下の英語版は、多言語化したときに使う控えです。

## 日本語

### 短い説明

manifest の `description` と同じにする。変えるときは両方直す (132 文字以下のプレーンテキスト)。

ページ上で選んだ表や文章をサイドパネルで確認し、必要な列をローカルCSVへ保存します。

### 詳しい説明

Web ページ上で選んだ表や文章を、サイドパネルで表に整えて、ローカルの CSV ファイルとして保存する拡張機能です。「範囲を選ぶ → 表を編集する → CSV を保存する」の 3 つの手順で使います。

- 使いたいページでツールバーのボタンを押すと、ページの横にサイドパネルが開きます。「ページ上で範囲を選ぶ」を押し、ページ上の範囲にマウスを重ねてクリックすると、その範囲を表として取り込みます。↑ で範囲を広げ、↓ で戻し、Esc で取り消します。選択のクリックは別の透明な枠で受け取るため、ページのリンクやボタンは反応しません。ページ全体を使うこともできます。
- HTML の表、ARIA の表、同じ形で繰り返すカードや一覧を、行と列に変換します。結合セルは本来の位置に置き、結合で隠れた位置は空欄にします。見出しのある文章は、見出しの階層 (H1〜H6) と内容の列に分けます。
- 列の見出しを押すと、列名の変更、左右への移動、列の除外ができます。列の見出しをドラッグして並べ替えることもできます。行の除外、除外した行や列の復元、行と列の入れ替え、直近 50 回までの「元に戻す」が使えます。セルの値の書き換えには対応していません。
- 保存前に内容を確認してチェックを入れ、Chrome の保存画面で保存先を選びます。保存中は表を固定し、保存できた・取り消した・中断した・結果が分からない、を分けて表示します。結果が分からないときに自動で保存し直すことはしません。
- CSV は UTF-8 (BOM 付き)・カンマ区切りで、すべての値を引用符で囲みます。数式に見える値の先頭にはタブを加えます。値はすべて文字列のままで、日付や金額の変換はしません。
- CSV は Excel の書式・数式・セルの型を保存しません。この拡張機能は Excel のブックを作成・変更しません。表計算ソフトで使うときは、取り込むときに ID などの列の型を確かめてください。
- 取り込むのは、ツールバーのボタンを押したタブの、表示されている文字だけです。入力欄の値、非表示や未読み込みの部分、iframe や Shadow DOM の内側、画像、グラフの線、canvas に描かれた内容は取り込みません。
- 上限は 5,000 行・50 列・1 セル 10,000 文字・合計 2,000,000 文字です。超えた場合は出力しません。
- 取り込んだ表と編集の履歴はサイドパネルの中だけで扱い、パネルを閉じるか再読み込みすると消えます。自動の保存や復元はありません。
- 無料で、アカウント登録は不要です。拡張機能は外部へデータを送りません。サイトへのログインが必要な場合は、ご自身でログインしたページを使ってください。
- すべてのサイトで取り込めることは保証していません。

プライバシーポリシー: https://github.com/gearmind-inc/transaction-to-excel/blob/main/PRIVACY.md
お問い合わせ: dev@gearmind.cc

## English

### Short description

Keep this in sync with the manifest `description` when the extension is localized (plain text, 132 characters or fewer).

Review a table or text you select on a web page in the side panel, then save the columns you need to a local CSV file.

### Detailed description

This extension turns a table or text you select on a web page into a table in the side panel and saves it as a local CSV file. It works in three steps: select a range, edit the table, and save the CSV.

- Click the toolbar button on the page you want to use, and the side panel opens beside it. Click “ページ上で範囲を選ぶ” (select a range on the page), point at a range, and click it to capture that range as a table. ↑ expands the range, ↓ returns, and Esc cancels. Selection clicks are received in a separate transparent frame, so links and buttons on the page are not activated. You can also use the whole page.
- HTML tables, ARIA tables, and repeated cards or lists with the same structure become rows and columns. Merged cells stay in their original position, and positions covered by a merge are left blank. Text with headings is split into heading-level (H1–H6) and content columns.
- Click a column heading to rename it, move it left or right, or exclude it. You can also drag column headings to reorder them. You can exclude rows, restore excluded rows or columns, transpose rows and columns, and undo up to the last 50 changes. Editing cell values is not supported.
- Before saving, review the table and check the confirmation box, then choose where to save in Chrome's Save dialog. The table is locked while saving, and saved, cancelled, interrupted, and unknown results are shown separately. If the result is unknown, the extension does not save again automatically.
- The CSV is UTF-8 with a BOM, comma-separated, with every value quoted. Values that look like formulas get a leading tab. All values remain text; dates and amounts are not converted.
- CSV does not keep Excel formatting, formulas, or cell types. This extension does not create or modify Excel workbooks. When you use the file in a spreadsheet app, check the column types, such as ID columns, while importing.
- Only visible text in the tab where you clicked the toolbar button is captured. Input-field values, hidden or unloaded content, the inside of iframes and Shadow DOM, images, graph lines, and canvas drawings are not captured.
- Limits: 5,000 rows, 50 columns, 10,000 characters per cell, and 2,000,000 characters in total. Nothing is exported when a limit is exceeded.
- The captured table and its edit history exist only in the side panel and are lost when the panel is closed or reloaded. There is no automatic saving or recovery.
- Free, with no account registration. The extension does not send data externally. If a site requires login, sign in to that page yourself.
- Capturing every website is not guaranteed.

Privacy policy: https://github.com/gearmind-inc/transaction-to-excel/blob/main/PRIVACY.md
Contact: dev@gearmind.cc

## 画像

| 種類 | ファイル | 規定 |
|---|---|---|
| アイコン | `icons/icon128.png` | 128x128 PNG。絵は 96x96、周り 16px は透明 |
| スクリーンショット | `store/screenshots/*.png` (撮り直し手順は同じフォルダの README.md) | 1280x800 か 640x400、1〜5 枚。角は四角で余白なし (full bleed)。Playwright で撮った本物の画面だけを使う |
| 小さい宣伝画像 | `store/promo/small-440x280.png` | 440x280 (必須) |
| マーキー画像 | なし | 1400x560 (任意) |

規定は [画像の公式ページ](https://developer.chrome.com/docs/webstore/images) で 2026-10-02 に確認しました。申請前に確かめ直してください。Excel で開いた様子の画像はありません (Excel への取り込みは確認していないため)。
