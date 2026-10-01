# Chrome ウェブストアへの申請

掲載本文は [listing.md](listing.md)、利用者向けの説明は [PRIVACY.md](../PRIVACY.md) にあります。このファイルは申請者向けです。

## 登録するリンクと提供者

| 項目 | 入力内容 |
|---|---|
| 提供者 | GearMind Inc. |
| 登記上の法人名を求められた場合 | 株式会社GearMind |
| 製品ホームページ | https://github.com/gearmind-inc/transaction-to-excel |
| プライバシーポリシー | 未確定。リポジトリを公開に切り替えた後に決まる (見込み: https://github.com/gearmind-inc/transaction-to-excel/blob/main/PRIVACY.md) |
| お問い合わせ | dev@gearmind.cc |

リポジトリは非公開のため、今は上の URL を外から開けません。公開に切り替えた後、ログアウト状態で開けることを確かめてから登録します。

## 単一の目的 / Single purpose

Web ページ上で選んだ表や文章を表に整えて確認・編集し、ローカルの CSV ファイルとして保存します。

Turn a table or text selected on a web page into a table, let the user review and edit it, and save it as a local CSV file.

## 権限ごとの理由

`manifest.json` の `permissions` は次の 5 つです。`host_permissions` と `optional_host_permissions` はありません (常時のサイトアクセスは求めません)。

| 権限 | 理由 | 使っている所 |
|---|---|---|
| `activeTab` | ツールバーのボタンを押したタブに限り、一時的にアクセスするためです。そのタブの URL を読んで HTTP/HTTPS のページか確かめ、`scripting` で範囲を選ぶ・読む処理を実行します。 | `src/workspace.ts` の `scan` (`chrome.tabs.get`) と `inject` / `pick` |
| `scripting` | 利用者がボタンを押したタブの最上位の文書で、同梱の関数を実行するためです。表の候補の見出しと件数を読む、ページ上で範囲を選ぶ、選んだ範囲を強調表示する、選んだ範囲の表示されている文字を読む、の 4 つに使います。 | `src/workspace.ts` の `inject` / `pick` / `stopPicker` (`chrome.scripting.executeScript`)。実行する関数は `src/extraction.ts` の `inspectPage` と `src/picker.ts` の `pickRegion` / `cancelRegion` |
| `storage` | ウィンドウごとのツールバー操作の記録 (タブ ID とランダムな ID) を `chrome.storage.session` に、最後に始めた保存の試行の記録 (出力 ID、SHA-256 ダイジェスト、日時、ダウンロード ID、状態、理由コード) を `chrome.storage.local` に置くためです。 | `src/background.ts` (`chrome.storage.session.set`)、`src/panel-source.ts` の `watchPanelSource`、`src/chrome-ports.ts` の `chromeSavePort` |
| `downloads` | 利用者が確認した CSV を、Chrome の保存画面で選んだ場所へ保存し、その保存の結果 (完了・取消・中断) を記録したダウンロード ID だけで照会するためです。保存中の取消の要求にも使います。 | `src/chrome-ports.ts` の `chromeSavePort` (`download` / `search` / `cancel` / `onChanged`) |
| `sidePanel` | ツールバーのボタンを押したときに、今のページの横に操作画面 (サイドパネル) を開くためです。 | `src/background.ts` (`chrome.sidePanel.open`)、manifest の `side_panel` |

### Permission justifications

- `activeTab`: Temporarily access only the tab where the user clicks the toolbar button. The extension reads that tab's URL to confirm it is an HTTP/HTTPS page and runs the range selection and reading through `scripting`.
- `scripting`: Run bundled functions in the top-level document of the tab where the user clicked the button: read table candidates' headers and counts, let the user select a range on the page, highlight the selected range, and read the visible text of the selected range.
- `storage`: Keep a per-window toolbar activation (tab ID and a random ID) in `chrome.storage.session`, and the record of the most recently started save attempt (export ID, SHA-256 digest, timestamp, download ID, state and reason code) in `chrome.storage.local`. A new save writes its record before the download begins, replacing the previous one.
- `downloads`: Save the CSV the user confirmed to the location chosen in Chrome's Save dialog, and check that save's result (complete, cancelled or interrupted) by its recorded download ID only. It is also used to request cancellation of an in-progress save.
- `sidePanel`: Open the controls in the side panel beside the current page when the user clicks the toolbar button.

The extension has no `host_permissions` or `optional_host_permissions`.

## リモートコード / Remote code

申告: **No, I am not using remote code.**

外部のスクリプトは読み込みません。ページで実行する関数は、拡張機能に同梱してビルドしたものです。拡張機能のページの CSP は `script-src 'self'` と `connect-src 'none'` で、外部のスクリプトの読み込みと外部への接続を止めています。

The extension does not load external scripts. The functions it runs in pages are bundled with the extension. The extension-page CSP uses `script-src 'self'` and `connect-src 'none'`, which block external scripts and external connections.

## データの取り扱い

端末内で処理する情報も開示対象です ([User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq))。「外部へ送信しない」ことを理由に「データを扱わない」と申告しないでください。

| 扱う情報 | 読む・置く場所 | 外部への送信 | ダッシュボードで照合するデータ種別 |
|---|---|---|---|
| 選んだ範囲の表示されている文字 (表・文章)、表の候補の見出しと件数 | パネルのメモリだけ。パネルを閉じると消える | しない | ウェブサイトのコンテンツ |
| 上の文字に含まれ得る氏名・ID・口座番号・取引の日付や金額・メッセージなど | 同上 | しない | 個人を特定できる情報、金融・支払いに関する情報、個人的な通信など、該当する各区分 |
| ボタンを押したタブの URL (確認用。パネルにはオリジンだけを表示) | パネルのメモリだけ。保存しない | しない | ウェブ閲覧の情報に関する区分 |
| 利用者が付けた列名、表の編集の内容、生成した CSV | パネルのメモリ。CSV は利用者が選んだフォルダ | しない | 利用者が作成したコンテンツに関する区分 (該当するかは画面の定義で判断) |
| 保存の試行の記録 (出力 ID、ダイジェスト、日時、ダウンロード ID、状態、理由コード) | `chrome.storage.local` (1 件。次の保存を始めると、ダウンロードの前に置き換わる。前の保存の結果が未確定なら、照合するまで新しい保存はできず、記録は残る) | しない | 該当する区分を画面の定義で判断 |
| 以前の版で保存した設定 (名前、取得元のオリジンとパス、見出し、列の設定)。この版では読み書きしない | `chrome.storage.local` に残っている場合がある | しない | ウェブ閲覧の情報に関する区分 |
| 照合のために利用者が選んだ CSV ファイル | パネルのメモリでダイジェストを計算するだけ。保存しない | しない | ウェブサイトのコンテンツ (CSV の中身はページから取り込んだ文字のため) |

上表は扱う情報との対応です。データ種別の定義は User Data FAQ の「user data」の一覧 (個人を特定できる情報、金融・支払い情報、健康情報、認証情報、ウェブサイトのコンテンツ、フォームのデータ、ウェブ閲覧の情報、個人的な通信、利用者が作成したコンテンツ) で確かめました (2026-10-02)。申請画面のチェック項目の名前は公式ページで確かめられなかったため、実際のチェック項目は申請時の画面の定義に照らして確定してください。選んだ範囲には任意のサイトの文字が入り得るため、「ウェブサイトのコンテンツ」だけで十分とは断定していません。入力欄の値、Cookie、認証情報の保存領域は読みません。

情報は、選んだ範囲を表にして編集し、CSV として保存するためだけに使います。広告・アクセス解析、第三者への提供・販売、信用判断・貸付には利用しません。開発者が端末内の情報を取得・閲覧する機能はありません。

### Limited Use の宣誓

申請画面で、次の内容に当てはまることを確認してから宣誓欄にチェックを入れます ([Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use))。

- 読んだ情報は、単一の目的 (選んだ範囲を表にして CSV として保存する) に必要な分だけを扱い、その目的のためだけに使う
- 第三者へ渡さない・売らない (拡張機能は外部へ送信しない。広告の基盤やデータ業者などへの販売もしない)
- 個人に合わせた広告、信用判断・貸付には使わない
- 人に読ませない (開発者が端末内の情報を取得・閲覧する機能は無い)

## 申請前の確認

以下が未確認の間は、公開準備が完了したものとして扱わないでください。

### 提出物

- [ ] この準備の PR をマージした後の main で zip を作る。作業場所で試しに作った zip は使わない。コマンドの例: `git switch main && git pull && npm ci --ignore-scripts && npm run check && npm run package` (出力: `dist/transaction-to-excel-0.1.0.zip`)
- [ ] zip の中身を `unzip -l dist/transaction-to-excel-0.1.0.zip` で確かめる。`manifest.json` がフォルダに入らず直下にあること、`background.js` `workspace.js` `worker.js` `workspace.html` `workspace.css` `icons/` `README.md` `PRIVACY.md` `LICENSE` があること、`src/` `tests/` `node_modules/`、ソースマップ、内部文書が入っていないこと
- [ ] `store/screenshots/` の PNG を差し替え後の最新版で確かめる。1280x800 か 640x400、1〜5 枚、余白なし。Playwright で撮った本物の画面だけで、今の画面と一致し、個人情報・実在の URL・他の拡張機能が写っていないこと
- [ ] アイコン (`icons/icon128.png`) と小さい宣伝画像 (`store/promo/small-440x280.png`) の大きさを確かめる

### 掲載情報と申告

- [ ] 日本語の掲載本文と画像を登録する。短い説明は 132 文字以下で、manifest の `description` と一字一句同じにする。各欄の上限と掲載結果は実画面で確かめる
- [ ] カテゴリと言語を実画面の選択肢で決める ([listing.md](listing.md) の案)
- [ ] データ種別と Limited Use の宣誓欄を実画面で確かめ、PRIVACY.md と一致する申告を登録する
- [ ] 保存データの保護が Chrome ウェブストアの要件を満たすか確かめる。[User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) の暗号化の項 (2026-10-02 確認) は、必要な暗号の種類として「transmit user data over a secure connection (e.g. HTTPS, WSS) and stored at rest using a strong encryption method such as RSA or AES」と書いている。一方、すべてのデータを暗号化する必要があるかの問いには「a minimum requirement of encrypting transmissions of all user data」と答えている。この拡張機能は `chrome.storage.local` の記録 (保存の試行の記録、以前の版の設定) を独自に暗号化していないため、端末内に置くだけで適合すると判断せず、必要なら Chrome ウェブストアに問い合わせる。適合しない場合は、実装で対応した後に確かめ直す
- [ ] 提供者・連絡先・取引者 (trader) の情報を登録し、公開される情報をプレビューで確かめる

### 公開の判断 (ユーザーの作業)

- [ ] リポジトリを公開に切り替える
- [ ] プライバシーポリシーの公開 URL を決め、ログアウト状態で開けることを確かめてから、申請画面と [listing.md](listing.md) に入れる
- [ ] 公開を決めた時点で、README の公開保留の記述 (「Public release and universal site compatibility are not claimed.」と「public release remains on hold.」) を直す
- [ ] タグを打つか決める (今はタグなし。manifest・package.json の version は 0.1.0)。GitHub Release に zip を付けるかも決める

### リリース前の未確認事項 (未確認のまま。確認が済むまでチェックしない)

- [ ] Windows と macOS の通常の Chrome で、範囲選択・表の編集・CSV の保存と取消・失敗からの戻りを操作して確かめる (Windows の実機での確認は無く、今の版の通常の Chrome でも未確認)
- [ ] Windows と macOS の Microsoft Excel で、列の型を指定して CSV を取り込み、先頭のゼロ・長い ID・日付・金額・件数・保護用のタブの扱いを確かめる (Excel での確認は無い)
- [ ] 公開されているサイトで、通常の Chrome と出荷用の拡張機能を使い、取り込み・プレビュー・ネイティブの保存と取消を画面で確かめる
- [ ] 本人の業務用サイトで、合意した CSV の列とデータを照合する
- [ ] 確かめた OS・Chrome・Excel の版を記録し、掲載文などで示す対応範囲を確かめた環境だけに限る

## 公式資料

- [提出物の準備 (zip の形)](https://developer.chrome.com/docs/webstore/prepare)
- [画像](https://developer.chrome.com/docs/webstore/images)
- [掲載情報の入力](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [掲載情報の要件](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements)
- [User Data FAQ (端末内の処理・暗号化・開示)](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
- [プライバシー欄への入力](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [manifest の description](https://developer.chrome.com/docs/extensions/reference/manifest/description)
