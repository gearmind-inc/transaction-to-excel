# ストア用スクリーンショット

Chrome ウェブストアに載せる 1280x800 の PNG が 3 枚あります。「範囲を選ぶ → 表を編集する → CSV を保存する」の 3 工程を 1 枚ずつ見せます。

画面は、Playwright 同梱の Chromium で拡張機能を実際に読み込んで撮った本物です。AI で作ったイメージ画像や、CSV を Excel で開いた様子の絵は使っていません。仕上げ (`compose.mjs`) で加えるのは、切り抜き・縮小・配置・背景・見出し・工程名・短い説明文だけで、画面の中身は書き換えません。

| ファイル | 見せている内容 |
|---|---|
| `01-choose-range.png` | 見本の取引ページで表が選択枠に囲まれ、右のサイドパネルが「ページ上で範囲を選んでください」と案内している様子 (工程 1) |
| `02-edit-table.png` | 取り込んだ表を、取引日の列を「日付」に変える列名の編集欄と一緒に表示している様子 (工程 2) |
| `03-save-csv.png` | 表の確認にチェックを入れて保存したあと、「CSVを保存しました」と結果が表示された様子 (工程 3) |

## 写っているもの・写らないもの

- 取引先や金額は、すべて `sample-page.html` の架空データです (実在の会社・取引ではありません)。
- 新しい一時プロファイルだけを使います。普段使いの Chrome やブランドの Google Chrome には触れません。
- 拡張機能の画面は、サイドパネルと同じ幅 (440px) か少し広めの幅で、普通のタブとして開いて撮っています。ネイティブのサイドパネルそのものは撮れていません。
- ブラウザの枠・アドレスバー・他の拡張機能は写しません。サイドパネルには見本ページの接続先が表示される行があるため、その行を含めないよう、撮った画面を領域で切って並べています (切るだけで、中の文字は変えません)。
- CSV は撮影のたびに一時フォルダへ本当に保存され、撮影後に消されます。OS の保存ダイアログと、Excel で開いた様子は、この画像に含めていません。Excel への取り込みは確認していません。

## 前提

- リポジトリ直下で作業すること。`node_modules` と Playwright の Chromium が入っていること (撮影のための再インストールはしません。Chromium が無いときだけ `PLAYWRIGHT_BROWSERS_PATH=node_modules/.cache/ms-playwright npx playwright install chromium`)。
- `npm run build` で `dist/extension` ができること。
- 空いているローカルのポートを 1 つ使えること (スクリプトが空きポートを選び、撮影後に閉じます)。
- 日本語フォントがあること (macOS ならヒラギノ角ゴシック。Windows なら Yu Gothic や Meiryo)。
- ImageMagick の `magick` (画像サイズの確認用)。

## 撮り直し

リポジトリ直下で、リポジトリの外にある書き込み可能な一時フォルダ (`<scratch>`) を指定して実行します。生キャプチャは `<scratch>` に出て、仕上がりはこのフォルダに上書きされます。

```sh
npm run build
node store/screenshots/capture.mjs <scratch>
node store/screenshots/compose.mjs <scratch>
magick identify -format '%f %wx%h\n' store/screenshots/0*.png
```

`compose.mjs` の出力先を変えるときは、`<scratch>` の後ろに出力フォルダを足します。

## 仕組み

- `sample-page.html`: 撮影用の架空の取引ページ。`capture.mjs` が自分で持つ小さな HTTP サーバーから返します。
- `capture.mjs`:
  1. `dist/extension` を使い捨てフォルダへコピーし、そのコピーの manifest にだけ撮影用の host 権限 (`http://transactions.example/*`) を足します。追跡している `manifest.json` と `dist/extension` は変えません。権限が足りない・すでに host 権限がある場合は止まります。
  2. 新しい一時プロファイルの Chromium (`channel: 'chromium'`、ヘッドレス) にコピーを読み込みます。`transactions.example` は Chromium の中だけで 127.0.0.1 に割り当てた表示用の名前で、画面に 127.0.0.1 の URL を出さないための物です。
  3. 見本ページを開き、拡張機能の `workspace.html` を別タブで開いて、本物のページ上の範囲選択 (選択枠) → クリック → 列名の編集 → 確認にチェック → 保存を操作して、各場面の画面を撮ります。
  4. 終わったら (失敗しても) 一時プロファイル・拡張機能のコピー・保存した CSV・サーバーを片付けます。
- `compose.mjs`: 生キャプチャ (2 倍の解像度) を 1x に縮め、背景・見出し・工程名・説明文と合わせて 1280x800 にします。

撮影で使うホスト名・ポート・パスはスクリプトの中でも実行時に決めるだけで、画像にも書き込まれません。
