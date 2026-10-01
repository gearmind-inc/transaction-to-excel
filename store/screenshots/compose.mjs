// Compose the real Playwright captures into Chrome Web Store-sized (1280x800) images.
// Only cropping, scaling, layout, background, headings and short step captions are added.
// Usage: node store/screenshots/compose.mjs <scratch input directory> [output directory]
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, 'node_modules', '.cache', 'ms-playwright');
const rawArg = process.argv[2];
if (!rawArg) throw new Error('Usage: node store/screenshots/compose.mjs <scratch input directory> [output directory]');
const raw = path.resolve(rawArg);
const output = path.resolve(process.argv[3] ?? here);
const width = 1280;
const height = 800;

const steps = ['範囲を選ぶ', '表を編集する', 'CSVを保存する'];
const screens = [
  {
    file: '01-choose-range.png', step: 0,
    title: 'ページ上で、取り込む範囲を選ぶ',
    caption: '見本の取引ページで表にマウスを重ねると、選択枠で範囲が分かります。クリックで確定します。',
    layout: 'pair',
    // The page capture is cropped to the area above the empty bottom of the sample page.
    pageCrop: { height: 570 },
    pageLabel: '見本の取引ページ（すべて架空のデータ）',
    panelLabel: '拡張機能のサイドパネル',
    images: ['step1-page.png', 'step1-panel-top.png', 'step1-panel-actions.png'],
  },
  {
    file: '02-edit-table.png', step: 1,
    title: '取り込んだ表を見ながら、整える',
    caption: '列の見出しを押して名前を変えたり、順番を入れ替えたり、不要な列を省いたりできます。',
    layout: 'single', images: ['step2-panel.png'],
  },
  {
    file: '03-save-csv.png', step: 2,
    title: '確認した表を、CSV として保存',
    caption: '表を確認してチェックを入れ、保存します。保存できた結果が画面に表示されます。',
    layout: 'single', images: ['step3-panel.png'],
  },
];

const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", "Meiryo", "Noto Sans JP", sans-serif';
const esc = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function imageData(buffer) {
  if (buffer.toString('ascii', 1, 4) !== 'PNG') throw new Error('生キャプチャが PNG ではありません。');
  return {
    url: `data:image/png;base64,${buffer.toString('base64')}`,
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

// Captures are taken at 2x; size them in CSS pixels at 1x.
const css = image => ({ w: image.width / 2, h: image.height / 2 });

function htmlFor(spec, images) {
  const stepChips = steps.map((name, index) =>
    `<li class="${index === spec.step ? 'on' : ''}"><b>${index + 1}</b>${esc(name)}</li>`).join('');
  const top = 150;               // content area starts here
  const areaHeight = height - top - 36;
  let body;
  if (spec.layout === 'pair') {
    const page = css(images[0]);
    const cropHeight = Math.min(spec.pageCrop.height, page.h);
    const gap = 10;
    const panelHeight = images.slice(1).reduce((sum, image) => sum + css(image).h, 0) + gap * (images.length - 2);
    body = `<div class="pair" style="top:${top}px">
      <div class="col" style="width:${page.w}px">
        <div class="label">${esc(spec.pageLabel)}</div>
        <figure style="width:${page.w}px;height:${cropHeight}px"><img src="${images[0].url}" style="width:${page.w}px;height:${page.h}px"></figure>
      </div>
      <div class="col" style="width:${css(images[1]).w}px">
        <div class="label">${esc(spec.panelLabel)}</div>
        <div class="stack" style="height:${panelHeight}px">${images.slice(1).map(image =>
          `<figure style="width:${css(image).w}px;height:${css(image).h}px"><img src="${image.url}" style="width:${css(image).w}px;height:${css(image).h}px"></figure>`).join('')}</div>
      </div>
    </div>`;
  } else {
    const image = css(images[0]);
    const scale = Math.min(1, (width - 96) / image.w, areaHeight / image.h);
    body = `<div class="single" style="top:${top}px;height:${areaHeight}px">
      <figure style="width:${image.w * scale}px;height:${image.h * scale}px"><img src="${images[0].url}" style="width:${image.w * scale}px;height:${image.h * scale}px"></figure>
    </div>`;
  }

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
    body { position: relative; background: linear-gradient(145deg, #f5f8fc 0%, #e3ebf5 100%); color: #172b43; font-family: ${FONT}; }
    header { position: absolute; left: 48px; right: 48px; top: 32px; }
    h1 { font-size: 36px; line-height: 1.3; font-weight: 700; letter-spacing: .01em; }
    header p { margin-top: 8px; color: #44586f; font-size: 18px; line-height: 1.5; }
    ol { position: absolute; right: 0; top: 4px; display: flex; gap: 8px; list-style: none; }
    li { display: flex; align-items: center; gap: 8px; padding: 7px 14px 7px 8px; border-radius: 22px; background: #d9e4f1; color: #52667d; font-size: 15px; font-weight: 600; }
    li b { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: #fff; color: #52667d; font-size: 14px; }
    li.on { background: #185c98; color: #fff; }
    li.on b { background: #fff; color: #185c98; }
    figure { overflow: hidden; background: #fff; outline: 1px solid rgba(25, 47, 73, .14); box-shadow: 0 12px 30px rgba(23, 43, 67, .16); }
    figure img { display: block; }
    .label { height: 24px; margin-bottom: 4px; color: #4a5f77; font-size: 14px; font-weight: 700; }
    .pair { position: absolute; left: 48px; right: 48px; display: flex; justify-content: space-between; align-items: flex-start; }
    .stack { display: flex; flex-direction: column; gap: 10px; }
    .single { position: absolute; left: 48px; right: 48px; display: flex; align-items: center; justify-content: center; }
  </style></head><body>
    <header><h1>${esc(spec.title)}</h1><p>${esc(spec.caption)}</p><ol>${stepChips}</ol></header>
    ${body}
  </body></html>`;
}

await mkdir(output, { recursive: true });
for (const spec of screens) {
  for (const file of spec.images) await access(path.join(raw, file));
}

const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'ja-JP' });
  for (const spec of screens) {
    const images = await Promise.all(spec.images.map(async file => imageData(await readFile(path.join(raw, file)))));
    await page.setContent(htmlFor(spec, images), { waitUntil: 'load' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(image => image.decode()));
    });
    await page.screenshot({ path: path.join(output, spec.file), animations: 'disabled' });
    console.log(`saved: ${spec.file}`);
  }
} finally {
  await browser.close();
}
