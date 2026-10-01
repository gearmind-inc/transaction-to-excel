import { LIMITS, type Capture, type ColumnConfig, type InspectRequest, type InspectResult, type Preset, type Preview, type TableCandidate } from './contracts';
import { inspectPage } from './extraction';
import { acceptInspection } from './inspection';
import { matchesPreset } from './presets';
import { chromeSavePort, locked, presetStore } from './chrome-ports';
import { SaveController } from './save';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => element<HTMLButtonElement>(id);
const tableSelect = element<HTMLSelectElement>('table');
const presetSelect = element<HTMLSelectElement>('preset');
const confirmation = element<HTMLInputElement>('confirm');
const nameInput = element<HTMLInputElement>('preset-name');
const status = (text: string) => { element('status').textContent = text; };
type Draft = ColumnConfig & { enabled: boolean };
let tabId = Number(new URL(location.href).searchParams.get('tab'));
let sourceUrl = '', documentId = '', candidates: TableCandidate[] = [], selected: TableCandidate | undefined;
let columns: Draft[] = [], capture: Capture | undefined, preview: Preview | undefined, artifact: Uint8Array | undefined;
let presets: Preset[] = [], editingId = '', revision = 0, page = 0, busy = false, worker: Worker | undefined;
let cancelWorker: (() => void) | undefined;
let presetBusy = false;
let saveController: SaveController;
const received = new Set<string>();
const dateFormats = ['YYYY-MM-DD', 'YYYY/MM/DD', 'YYYY年M月D日', 'MM/DD/YYYY', 'DD/MM/YYYY'];

function savingUnresolved(): boolean { return !!saveController?.attempt && ['saving', 'unknown'].includes(saveController.attempt.state); }
function updateControls(): void {
  const blocked = busy || presetBusy || savingUnresolved();
  tableSelect.disabled = blocked || !candidates.length;
  button('scan').disabled = blocked;
  button('show-source').disabled = blocked || !selected;
  button('capture').disabled = blocked || !selected || !columns.some(value => value.enabled);
  button('refresh-preview').disabled = blocked || !capture;
  button('stop').disabled = !busy;
  button('save-preset').disabled = blocked || !selected;
  for (const id of ['apply-preset', 'delete-preset']) button(id).disabled = blocked || !presetSelect.value;
  presetSelect.disabled = blocked; nameInput.disabled = blocked;
  for (const field of element('columns').querySelectorAll('fieldset')) field.disabled = blocked;
  confirmation.disabled = blocked || !preview || !artifact || preview.errorCount > 0;
  button('save').disabled = blocked || !artifact || !confirmation.checked || !!preview?.errorCount || saveController?.attempt?.state === 'saved';
  button('cancel-save').disabled = saveController?.attempt?.state !== 'saving' || saveController.attempt.downloadId === undefined;
  button('reconcile').disabled = busy;
  element('verify-file').hidden = saveController?.attempt?.state !== 'unknown';
  button('previous').disabled = !preview || page === 0;
  button('next').disabled = !preview || (page + 1) * 100 >= preview.rows.length;
}
function renderSave(): void {
  const record = saveController?.attempt;
  const labels = { generated: 'CSVを生成しました。保存はまだ始めていません。', saving: '保存中です。ダウンロードIDの取得だけでは保存完了にしません。', saved: '保存完了を照合しました。Excelへの取り込みは別に確認してください。', cancelled: 'キャンセルを確認しました。保存完了ではありません。', interrupted: '保存に失敗・中断しました。途中ファイルが残る場合があります。', unknown: '保存結果が不明です。自動では再保存しません。「保存結果を照合」または保存済みファイルの照合を使ってください。' };
  element('save-status').textContent = record ? labels[record.state] + (record.reason === 'FILE_DIGEST_CONFIRMED' ? ' 選択したファイルの内容が生成CSVと一致しました。' : '') : '保存はまだ開始していません。';
  updateControls();
}
function freshSaveController(): void {
  saveController?.dispose();
  saveController = new SaveController(chromeSavePort(), renderSave);
  renderSave();
}
function invalidate(requireCapture = false): void {
  revision++;
  preview = undefined; artifact = undefined; confirmation.checked = false; page = 0;
  element('confirm-label').textContent = 'このプレビューを確認しました';
  if (requireCapture) capture = undefined;
  element('preview').replaceChildren(); element('header-notice').textContent = '';
  element('summary').textContent = requireCapture ? '列または表が変わりました。再取得してください。' : '設定が変わりました。プレビューを作り直してください。';
  element('page').textContent = '';
  if (!savingUnresolved()) freshSaveController();
  updateControls();
}
function select(options: string[], value: string, changed: (value: string) => void, aria: string): HTMLSelectElement {
  const control = document.createElement('select'); control.setAttribute('aria-label', aria);
  for (const option of options) { const node = document.createElement('option'); node.value = option; node.textContent = option || 'なし'; control.append(node); }
  control.value = value; control.addEventListener('change', () => changed(control.value)); return control;
}
function label(text: string, control: HTMLElement): HTMLLabelElement {
  const node = document.createElement('label'); node.append(document.createTextNode(text + ' '), control); return node;
}
function renderColumns(): void {
  const container = element('columns'); container.replaceChildren();
  columns.forEach((column, position) => {
    const field = document.createElement('fieldset');
    const legend = document.createElement('legend'); legend.textContent = `${position + 1}. 元列 ${column.sourceIndex + 1}：${selected?.headers[column.sourceIndex] || '見出しなし'}`; field.append(legend);
    const main = document.createElement('div'); main.className = 'column-main';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = column.enabled;
    check.addEventListener('change', () => { column.enabled = check.checked; invalidate(true); });
    const output = document.createElement('input'); output.type = 'text'; output.value = column.outputName; output.maxLength = 100; output.setAttribute('aria-label', `元列${column.sourceIndex + 1}の出力列名`);
    output.addEventListener('input', () => { column.outputName = output.value; invalidate(); });
    const required = document.createElement('input'); required.type = 'checkbox'; required.checked = column.required;
    required.addEventListener('change', () => { column.required = required.checked; invalidate(); });
    const kind = select(['text', 'date', 'amount'], column.kind, value => { column.kind = value as Draft['kind']; invalidate(); renderColumns(); }, `元列${column.sourceIndex + 1}の型`);
    for (const option of kind.options) option.textContent = { text: '文字列（原文を保持）', date: '日付（書式を指定）', amount: '金額（規則を指定）' }[option.value as Draft['kind']];
    main.append(label('取得・出力', check), label('出力列名', output), label('型', kind), label('空欄はエラー', required));
    for (const [text, delta] of [['上へ', -1], ['下へ', 1]] as const) {
      const move = document.createElement('button'); move.textContent = text; move.type = 'button'; move.disabled = position + delta < 0 || position + delta >= columns.length;
      move.addEventListener('click', () => { [columns[position], columns[position + delta]] = [columns[position + delta], columns[position]]; invalidate(); renderColumns(); }); main.append(move);
    }
    field.append(main);
    const conversion = document.createElement('div'); conversion.className = 'conversion';
    if (column.kind === 'date') {
      conversion.append(label('入力書式', select(dateFormats, column.dateFormat, value => { column.dateFormat = value as Draft['dateFormat']; invalidate(); }, `元列${column.sourceIndex + 1}の日付入力書式`)), label('出力書式', select(['YYYY-MM-DD', 'YYYY/MM/DD'], column.dateOutput, value => { column.dateOutput = value as Draft['dateOutput']; invalidate(); }, `元列${column.sourceIndex + 1}の日付出力書式`)));
    }
    if (column.kind === 'amount') {
      for (const [text, key, values] of [['通貨記号（指定時は必須）', 'symbol', ['', '¥', '円', '$', '€']], ['桁区切り', 'grouping', ['', ',', '.']], ['小数点', 'decimal', ['.', ',']], ['負数の表記', 'negative', ['minus', 'parentheses']]] as const) {
        const control = select([...values], column.amount[key], value => { (column.amount as Record<string, string>)[key] = value; invalidate(); }, `元列${column.sourceIndex + 1}の${text}`);
        if (key === 'negative') for (const option of control.options) option.textContent = option.value === 'minus' ? '先頭マイナス（-¥330）' : '括弧（(¥330)）';
        conversion.append(label(text, control));
      }
    }
    field.append(conversion); container.append(field);
  });
  updateControls();
}
function defaults(table: TableCandidate): Draft[] {
  return table.headers.map((header, index) => ({ sourceIndex: index, outputName: header || `列${index + 1}`, enabled: true, kind: 'text', required: false, dateFormat: 'YYYY-MM-DD', dateOutput: 'YYYY-MM-DD', amount: { symbol: '', grouping: '', decimal: '.', negative: 'minus' } }));
}
async function inject(request: InspectRequest): Promise<InspectResult> {
  const expectedDocument = documentId, activeRevision = revision;
  const results = await chrome.scripting.executeScript({ target: { tabId, ...(expectedDocument ? { documentIds: [expectedDocument] } : { frameIds: [0] }) }, func: inspectPage, args: [request], world: 'ISOLATED' });
  if (activeRevision !== revision) throw new Error('中止した取得結果は反映しません。');
  const accepted = acceptInspection(results, request, expectedDocument || undefined);
  documentId = accepted.documentId; return accepted.data;
}
const request = (mode: InspectRequest['mode'], requestId = crypto.randomUUID()): InspectRequest => ({ mode, expectedUrl: sourceUrl, requestId, tableIndex: selected?.index, tableKey: selected?.key, headers: selected?.headers, sourceIndexes: columns.filter(value => value.enabled).map(value => value.sourceIndex), limits: LIMITS });
async function scan(): Promise<void> {
  if (busy || presetBusy || savingUnresolved()) return;
  busy = true; invalidate(true); selected = undefined; columns = []; candidates = []; documentId = ''; renderColumns(); updateControls();
  element('coverage').textContent = '取得範囲：現在ページの選択した表のみ（表は未選択）';
  const activeRevision = revision;
  tableSelect.replaceChildren(new Option('表を確認中です', ''));
  status('元のページの表を確認しています。');
  try {
    if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error('元のページで拡張のボタンを押して開き直してください。');
    const tab = await chrome.tabs.get(tabId);
    if (activeRevision !== revision) return;
    if (!tab.url || !/^https?:\/\//.test(tab.url)) throw new Error('通常のHTTP/HTTPSページで拡張を起動してください。Chromeの設定画面等は取得できません。');
    sourceUrl = tab.url;
    const safeUrl = new URL(sourceUrl); element('source').textContent = `対象：${safeUrl.origin}（起動したタブに固定）`;
    const data = await inject(request('list'));
    if (activeRevision !== revision) return;
    candidates = data.tables || []; tableSelect.replaceChildren(new Option('取得する表を選んでください', ''));
    for (const table of candidates) {
      const option = new Option(`表 ${table.index + 1}：${table.headers.slice(0, 5).join(' / ')}（${table.rowCount}件）${table.error ? '・対象外：' + table.error : ''}`, String(table.index));
      option.disabled = !!table.error; tableSelect.append(option);
    }
    status(candidates.some(value => !value.error) ? '表を選び、取得する列と書式を設定してください。' : '取得できる通常HTML表がありません。ログイン切れの場合は元サイトでログインし直し、表を探し直してください。');
  } catch (error) { if (activeRevision === revision) status(error instanceof Error ? error.message : 'ページを取得できませんでした。本人が再ログインした後に、元のページから開き直してください。'); }
  finally { if (activeRevision === revision) { busy = false; updateControls(); } }
}
function visible(value: string): string {
  return value === '' ? '［空欄］' : value.replace(/\t/g, '⟦TAB⟧').replace(/\r/g, '⟦CR⟧').replace(/\n/g, '⟦LF⟧\n').replace(/\0/g, '⟦NUL⟧');
}
function renderPreview(): void {
  const container = element('preview'); container.replaceChildren();
  if (!preview) return;
  const config = columns.filter(value => value.enabled);
  const table = document.createElement('table'); const head = table.createTHead(); const header = head.insertRow();
  const appendHeader = (text: string) => { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = text; header.append(cell); };
  appendHeader('元の行'); preview.headers.forEach((text, index) => appendHeader(`${visible(text)} / ${config[index]?.kind || ''}`));
  const body = table.createTBody();
  preview.rows.slice(page * 100, (page + 1) * 100).forEach((row, index) => {
    const tr = body.insertRow(); tr.insertCell().textContent = String(page * 100 + index + 1);
    row.forEach(cell => {
      const td = tr.insertCell(); td.className = cell.error ? 'error' : cell.protection ? 'protection' : '';
      for (const [title, value] of [['元値', cell.raw], ['変換後', cell.logical], ['CSV値', cell.output]]) {
        const line = document.createElement('div'); line.className = 'cell-line';
        const tag = document.createElement('span'); tag.className = 'cell-label'; tag.textContent = title + '：'; line.append(tag, document.createTextNode(visible(value))); td.append(line);
      }
      for (const text of [cell.error, cell.protection, cell.warning]) if (text) { const note = document.createElement('div'); note.className = 'warning'; note.textContent = text; td.append(note); }
    });
  });
  container.append(table);
  const pages = Math.max(1, Math.ceil(preview.rows.length / 100)); element('page').textContent = `${page + 1} / ${pages} ページ（表示は100件ずつ・CSVには取得した全行）`;
  element('summary').textContent = `取得 ${preview.sourceCount}件 / 出力 ${preview.rows.length}件 / 選択 ${preview.headers.length}列 / 空欄 ${preview.emptyCount}セル / エラー ${preview.errorCount}件 / CSV保護 ${preview.protectionCount}件。現在ページの選択した表のみ。取得時刻：${capture?.capturedAt || ''}`;
  const dataErrors = preview.rows.flat().filter(cell => cell.error).length;
  element('header-notice').textContent = preview.errorCount > dataErrors ? '出力列名に使えない制御文字があります。列名を直してください。' : preview.headers.some((value, index) => value !== config[index]?.outputName) ? '式に見える出力列名にも、保護用タブを加えています。' : '';
  element('confirm-label').textContent = preview.rows.length === 0 ? '0件の表です。見出しだけのCSVを保存することを確認しました' : `元値・出力値・${preview.rows.length}件・保護の変更を確認しました`;
  updateControls();
}
async function calculate(): Promise<void> {
  if (!capture) return;
  busy = true; invalidate(); updateControls(); status('プレビューを作成しています。');
  const activeRevision = revision;
  const requestId = crypto.randomUUID();
  worker = new Worker(chrome.runtime.getURL('worker.js'), { type: 'module' });
  try {
    const result = await new Promise<{ preview: Preview; bytes?: Uint8Array; error?: string }>((resolve, reject) => {
      cancelWorker = () => reject(new Error('処理を中止しました。'));
      worker!.onmessage = event => {
        if (event.data?.requestId !== requestId) { reject(new Error('プレビュー結果が一致しません。')); return; }
        resolve(event.data);
      };
      worker!.onerror = () => reject(new Error('プレビューの作成に失敗しました。'));
      worker!.postMessage({ requestId, capture: structuredClone(capture), columns: columns.filter(value => value.enabled).map(({ enabled: _, ...value }) => value) });
    });
    if (activeRevision !== revision) return;
    if (result.error) throw new Error(result.error);
    preview = result.preview; artifact = result.bytes; page = 0; renderPreview();
    status(preview.errorCount ? 'エラーがあります。設定を直してプレビューを作り直してください。保存は開始できません。' : '値と件数を確認し、確認チェックを入れて保存してください。');
  } catch (error) { if (activeRevision === revision) status(error instanceof Error ? error.message : 'プレビューに失敗しました。'); }
  finally { if (activeRevision === revision) { worker?.terminate(); worker = undefined; cancelWorker = undefined; busy = false; updateControls(); } }
}
async function acquire(): Promise<void> {
  if (!selected || busy || savingUnresolved()) return;
  busy = true; invalidate(true); updateControls(); status('選んだ表の列を取得しています。');
  const activeRevision = revision, call = request('capture');
  try {
    const data = await inject(call);
    if (activeRevision !== revision || received.has(call.requestId)) return;
    if (!data.capture) throw new Error('取得結果がありません。');
    received.add(call.requestId); capture = data.capture;
    busy = false; await calculate();
  } catch (error) { if (activeRevision === revision) status(error instanceof Error ? error.message : '取得に失敗しました。元ページを確認し、再取得してください。'); }
  finally { if (activeRevision === revision) { busy = false; updateControls(); } }
}
async function reloadPresets(): Promise<void> {
  presets = await presetStore.list(); presetSelect.replaceChildren(new Option('新しい設定', ''));
  for (const preset of presets) presetSelect.append(new Option(`${preset.name}（版${preset.version}）`, preset.id));
  presetSelect.value = editingId; updateControls();
}
tableSelect.addEventListener('change', () => {
  selected = candidates.find(value => String(value.index) === tableSelect.value && !value.error);
  columns = selected ? defaults(selected) : []; editingId = ''; presetSelect.value = ''; nameInput.value = '';
  invalidate(true); renderColumns(); element('coverage').textContent = selected ? `取得範囲：現在ページの表${selected.index + 1}だけ・候補確認時 ${selected.rowCount}件 / ${selected.headers.length}列（tfootを含む）` : '取得範囲：現在ページの選択した表のみ';
});
button('scan').addEventListener('click', () => { void scan(); });
button('show-source').addEventListener('click', () => {
  void inject(request('highlight')).then(() => chrome.tabs.update(tabId, { active: true })).catch(() => status('元のページが変わったか、タブが閉じられました。表を探し直してください。'));
});
button('capture').addEventListener('click', () => { void acquire(); });
button('refresh-preview').addEventListener('click', () => { void calculate(); });
button('stop').addEventListener('click', () => {
  revision++; worker?.terminate(); worker = undefined; cancelWorker?.(); cancelWorker = undefined; busy = false; capture = undefined; preview = undefined; artifact = undefined; confirmation.checked = false;
  element('preview').replaceChildren(); element('summary').textContent = '処理を中止しました。再取得してください。'; status('処理を中止しました。自動では再開しません。'); updateControls();
});
button('previous').addEventListener('click', () => { page--; renderPreview(); });
button('next').addEventListener('click', () => { page++; renderPreview(); });
confirmation.addEventListener('change', updateControls);
presetSelect.addEventListener('change', () => {
  if (!presetSelect.value) { editingId = ''; nameInput.value = ''; }
  updateControls();
});
button('apply-preset').addEventListener('click', () => {
  const preset = presets.find(value => value.id === presetSelect.value); if (!preset || !selected) return;
  const url = new URL(sourceUrl);
  if (!matchesPreset(preset, url.origin, url.pathname, selected.key, selected.headers)) { element('preset-status').textContent = 'サイト・ページ・表・列の構造が一致しません。旧設定は変更しません。表を選び直すか、新しい設定を作ってください。'; return; }
  columns = preset.columns.map(value => ({ ...structuredClone(value), enabled: true }));
  for (let index = 0; index < selected.headers.length; index++) if (!columns.some(value => value.sourceIndex === index)) columns.push({ ...defaults(selected)[index], enabled: false });
  editingId = preset.id; nameInput.value = preset.name; invalidate(true); renderColumns(); element('preset-status').textContent = '選択した設定を反映しました。再取得して確認してください。';
});
button('save-preset').addEventListener('click', async () => {
  if (!selected || presetBusy || busy || savingUnresolved()) return;
  presetBusy = true; updateControls();
  try {
    const url = new URL(sourceUrl);
    const preset: Preset = { schemaVersion: 1, id: editingId || crypto.randomUUID(), version: 1, name: nameInput.value, origin: url.origin, path: url.pathname, tableKey: selected.key, headers: [...selected.headers], columns: columns.filter(value => value.enabled).map(({ enabled: _, ...value }) => structuredClone(value)) };
    const saved = await locked('mvp-presets', () => presetStore.save(preset)); editingId = saved.id;
    await reloadPresets(); element('preset-status').textContent = '設定をローカルに保存しました。取引の値は保存していません。';
  } catch (error) { element('preset-status').textContent = error instanceof Error ? error.message : '設定を保存できませんでした。旧設定は保持しています。'; }
  finally { presetBusy = false; updateControls(); }
});
button('delete-preset').addEventListener('click', async () => {
  const id = presetSelect.value; if (!id || presetBusy || busy || savingUnresolved()) return;
  presetBusy = true; updateControls();
  try { await locked('mvp-presets', () => presetStore.remove(id)); if (editingId === id) { editingId = ''; nameInput.value = ''; } await reloadPresets(); element('preset-status').textContent = '選んだ設定を削除しました。現在の列設定は画面に残っています。'; }
  catch { element('preset-status').textContent = '設定を削除できませんでした。もう一度確認してください。'; }
  finally { presetBusy = false; updateControls(); }
});
button('save').addEventListener('click', async () => {
  if (!artifact || !confirmation.checked || preview?.errorCount || busy || savingUnresolved()) return;
  try { await saveController.start(artifact, `transactions-${new Date().toISOString().slice(0, 10)}.csv`); await saveController.reconcile(); }
  catch { status('保存を開始できませんでした。保存状態を照合してください。'); }
  renderSave();
});
button('cancel-save').addEventListener('click', () => { void saveController.cancel().then(renderSave).catch(() => { status('取消結果を確認できません。保存状態を照合してください。'); renderSave(); }); });
button('reconcile').addEventListener('click', () => { void saveController.reconcile().then(renderSave).catch(() => { status('保存結果を確認できませんでした。自動再保存は行いません。'); renderSave(); }); });
element<HTMLInputElement>('file').addEventListener('change', async event => {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; if (!file) return;
  try { if (file.size > 16_000_000) throw new Error('照合ファイルが大きすぎます。生成したCSVを選んでください。'); await saveController.confirmFile(new Uint8Array(await file.arrayBuffer())); renderSave(); }
  catch { status('ファイルの内容が一致しないか、照合を記録できませんでした。不明状態のままです。'); }
  finally { input.value = ''; }
});
window.addEventListener('pagehide', () => { worker?.terminate(); saveController?.dispose(); capture = undefined; artifact = undefined; preview = undefined; });
async function initialize(): Promise<void> {
  freshSaveController();
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await reloadPresets(); await saveController.reconcile();
    await scan();
  } catch { status('ローカル設定か保存照合情報を確認できません。保存済み設定を上書きせず停止しました。'); }
  renderSave();
}
void initialize();
