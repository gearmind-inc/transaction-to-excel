import { LIMITS, type Capture, type ColumnConfig, type InspectRequest, type InspectResult, type Preset, type Preview, type TableCandidate } from './contracts';
import { inspectPage } from './extraction';
import { acceptInspection, acceptPicked } from './inspection';
import { pickRegion, cancelRegion, type PickerRequest } from './picker';
import { watchPanelSource } from './panel-source';
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
const directTab = new URL(location.href).searchParams.get('tab');
let tabId = directTab === null ? -1 : Number(directTab);
let sourceReady = directTab !== null, saveStarting = false;
let picker: { requestId: string; tabId: number; documentId: string } | undefined;
let disposeSource: (() => void) | undefined;
let sourceUrl = '', documentId = '', candidates: TableCandidate[] = [], selected: TableCandidate | undefined;
let columns: Draft[] = [], capture: Capture | undefined, preview: Preview | undefined, artifact: Uint8Array | undefined;
let presets: Preset[] = [], editingId = '', revision = 0, page = 0, busy = false, calculating = false, worker: Worker | undefined;
let cancelWorker: (() => void) | undefined;
let calculationTimer: ReturnType<typeof setTimeout> | undefined, editorIndex: number | undefined;
let presetBusy = false;
let saveController: SaveController;
const received = new Set<string>();
const dateFormats = ['YYYY-MM-DD', 'YYYY/MM/DD', 'YYYY年M月D日', 'MM/DD/YYYY', 'DD/MM/YYYY'];

function savingUnresolved(): boolean { return !!saveController?.attempt && ['saving', 'unknown'].includes(saveController.attempt.state); }
function editingBlocked(): boolean { return busy || presetBusy || saveStarting || savingUnresolved() || !sourceReady; }
function composite(): boolean { return selected?.layout === 'composite'; }
function updateControls(): void {
  const blocked = busy || presetBusy || saveStarting || savingUnresolved();
  tableSelect.disabled = blocked || !candidates.length;
  button('scan').disabled = blocked || !sourceReady;
  button('pick').disabled = blocked || !sourceReady || !documentId;
  button('page-content').disabled = blocked || !sourceReady || !documentId;
  element<HTMLSelectElement>('pick-kind').disabled = blocked;
  button('use-content').disabled = blocked || !sourceReady || !selected || selected.kind === 'content';
  button('show-source').disabled = blocked || !sourceReady || !selected || !!selected.error;
  button('capture').disabled = blocked || !sourceReady || !selected || !!selected.error;
  button('stop').disabled = !busy && !calculating;
  button('save-preset').disabled = blocked || !sourceReady || !selected || !!selected.error;
  for (const id of ['apply-preset', 'delete-preset']) button(id).disabled = blocked || !presetSelect.value;
  presetSelect.disabled = blocked; nameInput.disabled = blocked;
  for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('#column-editor input, #column-editor select, #column-editor button, #hidden-columns button, #preview th button')) control.disabled = blocked || !sourceReady;
  const kind = document.getElementById('column-kind') as HTMLSelectElement | null;
  if (kind) kind.disabled ||= composite();
  const required = document.getElementById('column-required') as HTMLInputElement | null;
  if (required) required.disabled ||= composite();
  const position = columns.findIndex(column => column.sourceIndex === editorIndex);
  if (document.getElementById('column-left')) button('column-left').disabled ||= !columns.slice(0, position).some(column => column.enabled);
  if (document.getElementById('column-right')) button('column-right').disabled ||= !columns.slice(position + 1).some(column => column.enabled);
  confirmation.disabled = blocked || calculating || !preview || !artifact || preview.errorCount > 0;
  button('save').disabled = blocked || calculating || !sourceReady || !artifact || !confirmation.checked || !!preview?.errorCount || saveController?.attempt?.state === 'saved';
  button('cancel-save').disabled = saveController?.attempt?.state !== 'saving' || saveController.attempt.downloadId === undefined;
  button('reconcile').disabled = busy;
  element('verify-file').hidden = saveController?.attempt?.state !== 'unknown';
  button('previous').disabled = blocked || calculating || !preview || page === 0;
  button('next').disabled = blocked || calculating || !preview || (page + 1) * 100 >= preview.rows.length;
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
function cancelCalculation(): void {
  clearTimeout(calculationTimer); calculationTimer = undefined;
  worker?.terminate(); worker = undefined; cancelWorker?.(); cancelWorker = undefined; calculating = false;
}
function invalidate(requireCapture = false): void {
  revision++;
  artifact = undefined; confirmation.checked = false;
  element('confirm-label').textContent = 'この表を確認しました';
  element('cell-detail').hidden = true;
  if (requireCapture) {
    cancelCalculation();
    capture = undefined; preview = undefined; page = 0;
    element('preview').replaceChildren(); element('page').textContent = '';
    element('preview').setAttribute('aria-busy', 'false'); document.body.classList.remove('has-preview');
  }
  element('header-notice').textContent = '';
  element('summary').textContent = requireCapture ? '選んだ範囲を取り込んでいます。' : '列の変更を表に反映しています。';
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
  const hidden = element('hidden-columns'); hidden.replaceChildren();
  const excluded = columns.filter(column => !column.enabled); hidden.hidden = !excluded.length;
  if (excluded.length) hidden.append(document.createTextNode('省いた列を戻す：'));
  for (const column of excluded) {
    const restore = document.createElement('button'); restore.type = 'button'; restore.dataset.restoreIndex = String(column.sourceIndex); restore.textContent = column.outputName;
    restore.addEventListener('click', () => { if (editingBlocked()) return; column.enabled = true; edited(); renderColumns(); }); hidden.append(restore);
  }
  if (!columns.some(column => column.sourceIndex === editorIndex && column.enabled)) { editorIndex = undefined; element('column-editor').hidden = true; }
  updateControls();
}
function edited(): void { invalidate(); scheduleCalculate(); }
function openColumn(sourceIndex: number): void {
  if (editingBlocked()) return;
  const column = columns.find(value => value.sourceIndex === sourceIndex); if (!column?.enabled) return;
  editorIndex = sourceIndex;
  const container = element('column-editor'); container.hidden = false; container.replaceChildren();
  const title = document.createElement('h3'); title.textContent = `列の調整：${column.outputName}`; container.append(title);
  const output = document.createElement('input'); output.id = 'column-name'; output.type = 'text'; output.value = column.outputName; output.maxLength = 100; output.setAttribute('aria-label', `元列${sourceIndex + 1}の出力列名`);
  output.addEventListener('input', event => {
    if (editingBlocked()) { output.value = column.outputName; return; }
    column.outputName = output.value; invalidate();
    if ((event as InputEvent).isComposing) { cancelCalculation(); calculating = true; element('preview').setAttribute('aria-busy', 'true'); updateControls(); }
    else scheduleCalculate();
  });
  output.addEventListener('compositionend', () => { if (!editingBlocked()) { invalidate(); scheduleCalculate(); } });
  const required = document.createElement('input'); required.id = 'column-required'; required.type = 'checkbox'; required.checked = column.required;
  required.addEventListener('change', () => { if (editingBlocked() || composite()) { required.checked = column.required; return; } column.required = required.checked; edited(); });
  const conversion = document.createElement('div'); conversion.className = 'conversion';
  const kind = select(['text', 'date', 'amount'], column.kind, value => {
    if (editingBlocked() || composite()) { kind.value = column.kind; return; }
    column.kind = value as Draft['kind']; edited(); renderConversion();
  }, `元列${sourceIndex + 1}の型`); kind.id = 'column-kind';
  for (const option of kind.options) option.textContent = { text: '文字列', date: '日付', amount: '金額' }[option.value as Draft['kind']];
  const main = document.createElement('div'); main.className = 'column-main'; main.append(label('列名', output), label('型', kind), label('空欄はエラー', required));
  container.append(main, conversion);
  function renderConversion(): void {
    conversion.replaceChildren();
    if (column!.kind === 'date') {
      for (const [text, key, id, options] of [['入力書式', 'dateFormat', 'date-input', dateFormats], ['出力書式', 'dateOutput', 'date-output', ['YYYY-MM-DD', 'YYYY/MM/DD']]] as const) {
        const control = select([...options], column![key], value => { if (editingBlocked()) { control.value = column![key]; return; } (column as unknown as Record<string, string>)[key] = value; edited(); }, `元列${sourceIndex + 1}の日付${text}`); control.id = id; conversion.append(label(text, control));
      }
    }
    if (column!.kind === 'amount') {
      for (const [text, key, values] of [['通貨記号（指定時は必須）', 'symbol', ['', '¥', '円', '$', '€']], ['桁区切り', 'grouping', ['', ',', '.']], ['小数点', 'decimal', ['.', ',']], ['負数の表記', 'negative', ['minus', 'parentheses']]] as const) {
        const control = select([...values], column!.amount[key], value => { if (editingBlocked()) { control.value = column!.amount[key]; return; } (column!.amount as Record<string, string>)[key] = value; edited(); }, `元列${sourceIndex + 1}の${text}`); control.id = `amount-${key}`;
        if (key === 'negative') for (const option of control.options) option.textContent = option.value === 'minus' ? '先頭マイナス' : '括弧';
        conversion.append(label(text, control));
      }
    }
    updateControls();
  }
  const actions = document.createElement('div'); actions.className = 'actions';
  for (const [text, id, action] of [
    ['左へ', 'column-left', () => move(-1)], ['右へ', 'column-right', () => move(1)],
    ['この列を省く', 'column-hide', () => { column.enabled = false; edited(); renderColumns(); }],
    ['閉じる', 'column-close', () => {
      editorIndex = undefined; container.hidden = true;
      document.querySelector<HTMLButtonElement>(`#preview th[data-source-index="${sourceIndex}"] button`)?.focus();
    }],
  ] as const) {
    const control = document.createElement('button'); control.id = id; control.type = 'button'; control.textContent = text; control.addEventListener('click', () => { if (!editingBlocked()) action(); }); actions.append(control);
  }
  function move(delta: number): void {
    const position = columns.indexOf(column!); let other = position + delta;
    while (other >= 0 && other < columns.length && !columns[other].enabled) other += delta;
    if (other < 0 || other >= columns.length) return;
    [columns[position], columns[other]] = [columns[other], columns[position]]; edited(); updateControls();
  }
  container.append(actions);
  if (composite()) { const note = document.createElement('p'); note.textContent = '異なる表や文章を縦につないだ範囲です。文字列と空欄をそのまま保持します。'; container.append(note); }
  renderConversion();
  output.focus(); container.scrollIntoView?.({ block: 'nearest' });
}
function defaults(table: TableCandidate): Draft[] {
  const used = new Set<string>();
  const clipped = (value: string, length: number) => value.slice(0, length).replace(/[\uD800-\uDBFF]$/, '');
  return table.headers.map((header, index) => {
    const base = header.trim() ? header : `列${index + 1}`; let outputName = clipped(base, 100), suffix = 1;
    while (used.has(outputName)) { const ending = `（${++suffix}）`; outputName = clipped(base, 100 - ending.length) + ending; }
    used.add(outputName);
    return { sourceIndex: index, outputName, enabled: true, kind: 'text', required: false, dateFormat: 'YYYY-MM-DD', dateOutput: 'YYYY-MM-DD', amount: { symbol: '', grouping: '', decimal: '.', negative: 'minus' } };
  });
}
async function selectRange(candidate: TableCandidate | undefined): Promise<void> {
  selected = candidate;
  columns = selected && !selected.error ? defaults(selected) : []; editingId = ''; presetSelect.value = ''; nameInput.value = '';
  editorIndex = undefined; invalidate(true); renderColumns();
  const description = selected?.layout === 'composite' ? '複数の表・文章を順に表示' : selected?.headers.length === 2 && selected.headers[0] === 'タイトル' && selected.headers[1] === '内容' ? '見出しと文章' : `${selected?.headers.length || 0}列の表`;
  const scope = selected?.kind === 'content' ? `${selected.label || '選択した範囲'}（${description}）` : selected ? `表${selected.index + 1}` : '未選択';
  element('coverage').textContent = selected ? `取得範囲：現在ページの${scope}だけ・候補確認時 ${selected.rowCount}件 / ${selected.headers.length}列${selected.kind === 'content' ? '（表示文字を変換）' : '（tfootを含む）'}` : '取得範囲：未選択';
  element('range-notice').textContent = [selected?.error || '', ...(selected?.warnings || [])].filter(Boolean).join('\n');
  if (selected?.kind === 'content') {
    const option = new Option(`${selected.label || '選んだ範囲'}（${description}）`, 'content');
    tableSelect.querySelector('option[value="content"]')?.remove(); tableSelect.append(option); tableSelect.value = 'content';
  } else tableSelect.value = selected ? String(selected.index) : '';
  status(selected?.error ? '範囲を取り込めません。取り込み方法を変更するか、範囲を選び直してください。' : '選んだ範囲を取り込んでいます。');
  if (selected && !selected.error) await acquire();
}
async function inject(request: InspectRequest): Promise<InspectResult> {
  const expectedDocument = documentId, activeRevision = revision;
  let results: chrome.scripting.InjectionResult<InspectResult>[];
  try {
    results = await chrome.scripting.executeScript({ target: { tabId, ...(expectedDocument ? { documentIds: [expectedDocument] } : { frameIds: [0] }) }, func: inspectPage, args: [request], world: 'ISOLATED' });
  } catch { throw new Error('元ページが変わったか、取得する許可がありません。使うページで拡張アイコンを押し、範囲を選び直してください。'); }
  if (activeRevision !== revision) throw new Error('中止した取得結果は反映しません。');
  const accepted = acceptInspection(results, request, expectedDocument || undefined);
  documentId = accepted.documentId; return accepted.data;
}
const request = (mode: InspectRequest['mode'], requestId = crypto.randomUUID()): InspectRequest => ({ mode, expectedUrl: sourceUrl, requestId, tableIndex: selected?.index, tableKey: selected?.key, headers: selected?.headers, sourceIndexes: selected?.headers.map((_, index) => index), limits: LIMITS, ...(selected?.kind === 'content' ? { kind: 'content', contentSignature: selected.contentSignature, ...(selected.layout ? { layout: selected.layout } : {}) } : {}) });
function stopPicker(): void {
  const active = picker; picker = undefined;
  if (active) void chrome.scripting.executeScript({ target: { tabId: active.tabId, documentIds: [active.documentId] }, func: cancelRegion, args: [active.requestId], world: 'ISOLATED' }).catch(() => {});
}
function stopWork(): void {
  revision++; stopPicker(); cancelCalculation(); busy = false;
}
function sourceChanged(): void {
  sourceReady = false; stopPicker();
  if (saveStarting || savingUnresolved() || presetBusy) {
    status('元のページが変わりました。現在の保存・設定処理を確認してから、使うページで拡張アイコンを押してください。');
    updateControls(); return;
  }
  stopWork(); selected = undefined; candidates = []; columns = []; documentId = ''; editingId = '';
  invalidate(true); renderColumns(); tableSelect.replaceChildren(new Option('ページ上で範囲を選んでください', ''));
  element('range-notice').textContent = ''; element('coverage').textContent = '取得範囲：未選択';
  status('使うページで拡張アイコンを押してください。別のページは自動で取得しません。');
}
async function activateSource(id: number): Promise<void> {
  if (saveStarting || savingUnresolved() || presetBusy) { status('保存・設定処理が終わってから、使うページで拡張アイコンを押してください。'); return; }
  stopWork(); tabId = id; sourceReady = true;
  await scan();
}
async function scan(): Promise<void> {
  if (!sourceReady || busy || presetBusy || saveStarting || savingUnresolved()) return;
  stopPicker();
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
    if (directTab === null && tab.active === false) { sourceChanged(); return; }
    sourceUrl = tab.url;
    const safeUrl = new URL(sourceUrl); element('source').textContent = `対象：${safeUrl.origin}（アイコンを押したページ）`;
    const data = await inject(request('list'));
    if (activeRevision !== revision) return;
    candidates = data.tables || []; tableSelect.replaceChildren(new Option('取得する表を選んでください', ''));
    for (const table of candidates) {
      const option = new Option(`表 ${table.index + 1}：${table.headers.slice(0, 5).join(' / ')}（${table.rowCount}件）${table.error ? '・対象外：' + table.error : ''}`, String(table.index));
      option.disabled = !!table.error; tableSelect.append(option);
    }
    status(candidates.some(value => !value.error) ? 'ページ上で範囲または表を選び、取り込んだ表を確認してください。' : 'ページ上で範囲を選ぶか、ページ全体を使ってください。選ぶと表を表示します。');
  } catch (error) { if (activeRevision === revision) status(error instanceof Error ? error.message : 'ページを取得できませんでした。本人が再ログインした後に、元のページから開き直してください。'); }
  finally { if (activeRevision === revision) { busy = false; updateControls(); } }
}
async function describeRange(kind?: 'content', key?: string, index?: number): Promise<void> {
  if (!sourceReady || busy || presetBusy || saveStarting || savingUnresolved()) return;
  busy = true; invalidate(true); updateControls();
  const activeRevision = revision;
  try {
    const data = await inject({ mode: 'describe', requestId: crypto.randomUUID(), expectedUrl: sourceUrl, limits: LIMITS, kind, tableKey: key, tableIndex: index });
    if (activeRevision !== revision) return;
    busy = false; await selectRange(data.tables?.[0]);
  } catch (error) { if (activeRevision === revision) status(error instanceof Error ? error.message : '選んだ範囲を取得できませんでした。'); }
  finally { if (activeRevision === revision) { busy = false; updateControls(); } }
}
async function pick(): Promise<void> {
  if (!sourceReady || !documentId || busy || presetBusy || saveStarting || savingUnresolved()) return;
  busy = true; invalidate(true); updateControls();
  const activeRevision = revision, expectedDocument = documentId;
  const call: PickerRequest = { requestId: crypto.randomUUID(), expectedUrl: sourceUrl, ...(element<HTMLSelectElement>('pick-kind').value === 'content' ? { kind: 'content' } : {}) };
  picker = { requestId: call.requestId, tabId, documentId: expectedDocument };
  status('ページ上で範囲を選んでください。クリックで確定、↑で広げる、↓で戻す、Escで取消です。');
  try {
    let results: chrome.scripting.InjectionResult<Awaited<ReturnType<typeof pickRegion>>>[];
    try {
      results = await chrome.scripting.executeScript({ target: { tabId, documentIds: [expectedDocument] }, func: pickRegion, args: [call], world: 'ISOLATED' });
    } catch { throw new Error('元ページが変わったか、選択する許可がありません。使うページで拡張アイコンを押し、範囲を選び直してください。'); }
    if (activeRevision !== revision) return;
    picker = undefined;
    const picked = acceptPicked(results, call, expectedDocument).data;
    busy = false;
    await describeRange(picked.kind === 'content' ? 'content' : undefined, picked.key, picked.index);
  } catch (error) { if (activeRevision === revision) { picker = undefined; status(error instanceof Error ? error.message : '範囲を選択できませんでした。'); } }
  finally { if (activeRevision === revision) { busy = false; updateControls(); } }
}
function visible(value: string): string {
  return value === '' ? '［空欄］' : value.replace(/\t/g, '⟦TAB⟧').replace(/\r/g, '⟦CR⟧').replace(/\n/g, '⟦LF⟧\n').replace(/\0/g, '⟦NUL⟧');
}
function renderPreview(): void {
  const container = element('preview'), focused = document.activeElement;
  const headerFocus = focused instanceof HTMLElement && container.contains(focused) ? focused.closest<HTMLElement>('th[data-source-index]')?.dataset.sourceIndex : undefined;
  const cellFocus = focused instanceof HTMLElement && container.contains(focused) ? focused.closest<HTMLElement>('td[data-source-row]')?.dataset : undefined;
  container.replaceChildren();
  if (!preview) return;
  const config = columns.filter(value => value.enabled);
  const table = document.createElement('table'); const head = table.createTHead(); const header = head.insertRow();
  const appendHeader = (text: string) => { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = text; header.append(cell); };
  appendHeader('元の行'); preview.headers.forEach((_text, index) => {
    const column = config[index], cell = document.createElement('th'); cell.scope = 'col'; cell.dataset.sourceIndex = String(column.sourceIndex);
    const control = document.createElement('button'); control.type = 'button'; control.className = 'column-heading'; control.setAttribute('aria-label', `${column.outputName}：この列を調整`);
    control.append(document.createTextNode(column.outputName));
    const type = document.createElement('span'); type.className = 'column-type'; type.textContent = { text: '文字列', date: '日付', amount: '金額' }[column.kind]; control.append(type);
    control.addEventListener('click', () => openColumn(column.sourceIndex)); cell.append(control); header.append(cell);
  });
  const body = table.createTBody();
  preview.rows.slice(page * 100, (page + 1) * 100).forEach((row, index) => {
    const tr = body.insertRow(); tr.insertCell().textContent = String(page * 100 + index + 1);
    row.forEach((cell, columnIndex) => {
      const td = tr.insertCell(); td.className = cell.error ? 'error' : cell.protection ? 'protection' : '';
      td.dataset.sourceIndex = String(config[columnIndex].sourceIndex); td.dataset.sourceRow = String(page * 100 + index + 1);
      const value = document.createElement('div'); value.className = 'cell-value'; value.textContent = cell.logical === '' ? '［空欄］' : cell.logical; td.append(value);
      if (cell.error || cell.protection || cell.warning) { const note = document.createElement('span'); note.className = 'cell-badge'; note.textContent = cell.error ? '変換エラー' : cell.protection ? 'CSVで保護' : '取り込み注意'; td.append(note); }
      const detail = document.createElement('button'); detail.type = 'button'; detail.className = 'cell-more'; detail.textContent = '詳細'; detail.setAttribute('aria-label', `元の行${page * 100 + index + 1} ${config[columnIndex].outputName}の値の詳細`);
      detail.addEventListener('click', () => {
        const container = element('cell-detail'); container.replaceChildren(); container.hidden = false;
        const title = document.createElement('h3'); title.textContent = `元の行${page * 100 + index + 1}・${config[columnIndex].outputName}`; container.append(title);
        for (const [name, text] of [['元値', cell.raw], ['変換後', cell.logical], ['CSV値', cell.output]]) { const line = document.createElement('div'); line.className = 'cell-line'; line.textContent = `${name}：${visible(text)}`; container.append(line); }
        for (const text of [cell.error, cell.protection, cell.warning]) if (text) { const note = document.createElement('p'); note.textContent = text; container.append(note); }
        const close = document.createElement('button'); close.type = 'button'; close.textContent = '閉じる'; close.addEventListener('click', () => { container.hidden = true; detail.focus(); }); container.append(close);
        container.tabIndex = -1; container.focus(); container.scrollIntoView?.({ block: 'nearest' });
      }); td.append(detail);
    });
  });
  container.append(table);
  const pages = Math.max(1, Math.ceil(preview.rows.length / 100)); element('page').textContent = `${page + 1} / ${pages} ページ（表示は100件ずつ・CSVには取得した全行）`;
  element('summary').textContent = `取得 ${preview.sourceCount}件 / 出力 ${preview.rows.length}件 / 選択 ${preview.headers.length}列 / 空欄 ${preview.emptyCount}セル / エラー ${preview.errorCount}件 / CSV保護 ${preview.protectionCount}件。現在ページの選択した範囲のみ。取得時刻：${capture?.capturedAt || ''}`;
  const dataErrors = preview.rows.flat().filter(cell => cell.error).length;
  element('header-notice').textContent = preview.errorCount > dataErrors ? '出力列名に使えない制御文字があります。列名を直してください。' : preview.headers.some((value, index) => value !== config[index]?.outputName) ? '式に見える出力列名にも、保護用タブを加えています。' : '';
  element('confirm-label').textContent = preview.rows.length === 0 ? '0件の表です。見出しだけのCSVを保存することを確認しました' : `この表の${preview.rows.length}件とCSV保護${preview.protectionCount}件を確認しました`;
  container.setAttribute('aria-busy', 'false'); document.body.classList.add('has-preview');
  renderColumns();
  updateControls();
  const restored = headerFocus !== undefined ? container.querySelector<HTMLButtonElement>(`th[data-source-index="${headerFocus}"] button`)
    : cellFocus ? container.querySelector<HTMLButtonElement>(`td[data-source-row="${cellFocus.sourceRow}"][data-source-index="${cellFocus.sourceIndex}"] button`) : null;
  restored?.focus({ preventScroll: true });
}
function scheduleCalculate(): void {
  clearTimeout(calculationTimer); worker?.terminate(); worker = undefined; cancelWorker?.(); cancelWorker = undefined;
  if (!capture) return;
  calculating = true; element('preview').setAttribute('aria-busy', 'true'); updateControls();
  calculationTimer = setTimeout(() => { calculationTimer = undefined; void calculate(); }, 180);
}
async function calculate(): Promise<void> {
  if (!capture || editingBlocked()) return;
  clearTimeout(calculationTimer); calculationTimer = undefined;
  calculating = true; artifact = undefined; confirmation.checked = false; updateControls(); status('表を更新しています。');
  const activeRevision = revision;
  const config = columns.filter(value => value.enabled);
  const problem = !config.length ? '保存する列を1つ以上選んでください。省いた列は下のボタンで戻せます。'
    : config.some(column => !column.outputName.trim()) ? '列名を入力してください。'
    : new Set(config.map(column => column.outputName)).size !== config.length ? '列名が重複しています。別の列名を入力してください。'
    : composite() && config.some(column => column.kind !== 'text' || column.required) ? '異なる表や文章をつないだ範囲は、文字列と空欄をそのまま保持してください。' : '';
  if (problem) {
    if (!config.length) { preview = undefined; element('preview').replaceChildren(); element('page').textContent = ''; }
    element('header-notice').textContent = problem; status(problem); calculating = false; element('preview').setAttribute('aria-busy', 'false'); updateControls(); return;
  }
  worker?.terminate(); cancelWorker?.();
  const requestId = crypto.randomUUID();
  const currentWorker = new Worker(chrome.runtime.getURL('worker.js'), { type: 'module' }); worker = currentWorker;
  try {
    const result = await new Promise<{ preview: Preview; bytes?: Uint8Array; error?: string }>((resolve, reject) => {
      cancelWorker = () => reject(new Error('処理を中止しました。'));
      currentWorker.onmessage = event => {
        if (event.data?.requestId !== requestId) { reject(new Error('プレビュー結果が一致しません。')); return; }
        resolve(event.data);
      };
      currentWorker.onerror = () => reject(new Error('プレビューの作成に失敗しました。'));
      currentWorker.postMessage({ requestId, capture: structuredClone(capture), columns: config.map(({ enabled: _, ...value }) => value) });
    });
    if (activeRevision !== revision) return;
    if (result.error) throw new Error(result.error);
    preview = result.preview; artifact = result.bytes; page = Math.min(page, Math.max(0, Math.ceil(preview.rows.length / 100) - 1)); renderPreview();
    status(preview.errorCount ? 'エラーがあります。設定を直してプレビューを作り直してください。保存は開始できません。' : '値と件数を確認し、確認チェックを入れて保存してください。');
  } catch (error) { if (activeRevision === revision) status(error instanceof Error ? error.message : 'プレビューに失敗しました。'); }
  finally { currentWorker.terminate(); if (activeRevision === revision) { worker = undefined; cancelWorker = undefined; calculating = false; element('preview').setAttribute('aria-busy', 'false'); updateControls(); } }
}
async function acquire(): Promise<void> {
  if (!sourceReady || !selected || selected.error || busy || presetBusy || saveStarting || savingUnresolved()) return;
  clearTimeout(calculationTimer); calculationTimer = undefined; worker?.terminate(); cancelWorker?.(); worker = undefined; cancelWorker = undefined; calculating = false;
  busy = true; invalidate(true); updateControls(); status('選んだ範囲を表にしています。');
  const activeRevision = revision, call = request('capture');
  try {
    const data = await inject(call);
    if (activeRevision !== revision || received.has(call.requestId)) return;
    if (!data.capture) throw new Error('取得結果がありません。');
    received.add(call.requestId); capture = data.capture;
    element('range-notice').textContent = (capture.warnings || selected.warnings || []).join('\n');
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
  if (busy || presetBusy || saveStarting || savingUnresolved() || !sourceReady || tableSelect.value === 'content') return;
  void selectRange(candidates.find(value => String(value.index) === tableSelect.value && !value.error));
});
button('scan').addEventListener('click', () => { void scan(); });
button('pick').addEventListener('click', () => { void pick(); });
button('page-content').addEventListener('click', () => { void describeRange('content'); });
button('use-content').addEventListener('click', () => {
  if (selected) { element<HTMLSelectElement>('pick-kind').value = 'content'; void describeRange('content', selected.key.startsWith('content:') ? selected.key : `content:${selected.key}`, 0); }
});
button('show-source').addEventListener('click', () => {
  if (busy || presetBusy || saveStarting || savingUnresolved() || !sourceReady || !selected || selected.error) return;
  const activeRevision = revision, sourceTabId = tabId;
  void inject(request('highlight')).then(() => {
    if (activeRevision === revision) return chrome.tabs.update(sourceTabId, { active: true });
  }).catch(() => {
    if (activeRevision === revision) status('元のページが変わったか、タブが閉じられました。範囲を選び直してください。');
  });
});
button('capture').addEventListener('click', () => { void acquire(); });
button('stop').addEventListener('click', () => {
  if (saveStarting || savingUnresolved() || presetBusy) return;
  stopWork(); capture = undefined; preview = undefined; artifact = undefined; confirmation.checked = false;
  element('preview').replaceChildren(); element('summary').textContent = '処理を中止しました。再取得してください。'; status('処理を中止しました。自動では再開しません。'); updateControls();
});
button('previous').addEventListener('click', () => { if (!button('previous').disabled) { page--; renderPreview(); } });
button('next').addEventListener('click', () => { if (!button('next').disabled) { page++; renderPreview(); } });
confirmation.addEventListener('change', updateControls);
presetSelect.addEventListener('change', () => {
  if (!presetSelect.value) { editingId = ''; nameInput.value = ''; }
  updateControls();
});
button('apply-preset').addEventListener('click', () => {
  if (!sourceReady || busy || presetBusy || saveStarting || savingUnresolved()) return;
  const preset = presets.find(value => value.id === presetSelect.value); if (!preset || !selected) return;
  const url = new URL(sourceUrl);
  if (!matchesPreset(preset, url.origin, url.pathname, selected.key, selected.headers, selected.contentSignature)) { element('preset-status').textContent = 'サイト・ページ・範囲・列の構造が一致しません。旧設定は変更しません。範囲を選び直すか、新しい設定を作ってください。'; return; }
  if (composite() && preset.columns.some(column => column.kind !== 'text' || column.required)) { element('preset-status').textContent = '異なる表や文章をつないだ範囲には、日付・金額や空欄エラーの列設定を適用できません。旧設定は変更しません。'; return; }
  columns = preset.columns.map(value => ({ ...structuredClone(value), enabled: true }));
  for (let index = 0; index < selected.headers.length; index++) if (!columns.some(value => value.sourceIndex === index)) columns.push({ ...defaults(selected)[index], enabled: false });
  editingId = preset.id; nameInput.value = preset.name; editorIndex = undefined; invalidate(); renderColumns(); scheduleCalculate(); element('preset-status').textContent = '選択した設定を反映しました。更新した表を確認してください。';
});
button('save-preset').addEventListener('click', async () => {
  if (!sourceReady || !selected || selected.error || presetBusy || busy || saveStarting || savingUnresolved()) return;
  presetBusy = true; updateControls();
  try {
    const url = new URL(sourceUrl);
    const preset: Preset = { schemaVersion: 1, id: editingId || crypto.randomUUID(), version: 1, name: nameInput.value, origin: url.origin, path: url.pathname, tableKey: selected.key, headers: [...selected.headers], columns: columns.filter(value => value.enabled).map(({ enabled: _, ...value }) => structuredClone(value)), ...(selected.kind === 'content' && selected.contentSignature ? { contentSignature: selected.contentSignature } : {}) };
    const saved = await locked('mvp-presets', () => presetStore.save(preset)); editingId = saved.id;
    await reloadPresets(); element('preset-status').textContent = '設定をローカルに保存しました。取引の値は保存していません。';
  } catch (error) { element('preset-status').textContent = error instanceof Error ? error.message : '設定を保存できませんでした。旧設定は保持しています。'; }
  finally { presetBusy = false; updateControls(); }
});
button('delete-preset').addEventListener('click', async () => {
  const id = presetSelect.value; if (!id || presetBusy || busy || saveStarting || savingUnresolved()) return;
  presetBusy = true; updateControls();
  try { await locked('mvp-presets', () => presetStore.remove(id)); if (editingId === id) { editingId = ''; nameInput.value = ''; } await reloadPresets(); element('preset-status').textContent = '選んだ設定を削除しました。現在の列設定は画面に残っています。'; }
  catch { element('preset-status').textContent = '設定を削除できませんでした。もう一度確認してください。'; }
  finally { presetBusy = false; updateControls(); }
});
button('save').addEventListener('click', async () => {
  if (!sourceReady || !artifact || !confirmation.checked || preview?.errorCount || busy || calculating || presetBusy || saveStarting || savingUnresolved()) return;
  saveStarting = true; updateControls();
  const controller = saveController, bytes = artifact;
  try { await controller.start(bytes, `page-${new Date().toISOString().slice(0, 10)}.csv`); await controller.reconcile(); }
  catch { status('保存を開始できませんでした。保存状態を照合してください。'); }
  finally { saveStarting = false; }
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
window.addEventListener('pagehide', () => { stopWork(); disposeSource?.(); saveController?.dispose(); capture = undefined; artifact = undefined; preview = undefined; });
document.addEventListener('visibilitychange', () => { if (document.hidden && picker) { stopWork(); updateControls(); status('範囲選択を中止しました。もう一度範囲を選んでください。'); } });
if (directTab === null) {
  chrome.tabs.onUpdated.addListener((id, change) => { if (id === tabId && (change.status === 'loading' || change.url && change.url !== sourceUrl)) sourceChanged(); });
  chrome.tabs.onRemoved.addListener(id => { if (id === tabId) sourceChanged(); });
}
async function initialize(): Promise<void> {
  freshSaveController();
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await reloadPresets(); await saveController.reconcile();
    if (directTab !== null) await scan();
    else disposeSource = await watchPanelSource(activateSource, sourceChanged);
  } catch { status('ローカル設定か保存照合情報を確認できません。保存済み設定を上書きせず停止しました。'); }
  renderSave();
}
void initialize();
