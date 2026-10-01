import { LIMITS, type Capture, type ColumnConfig, type InspectRequest, type InspectResult, type Preview, type TableCandidate } from './contracts';
import { inspectPage } from './extraction';
import { acceptInspection, acceptPicked } from './inspection';
import { pickRegion, cancelRegion, type PickerRequest } from './picker';
import { watchPanelSource } from './panel-source';
import { chromeSavePort } from './chrome-ports';
import { createEditor, editTable, editorView, canUndo, transposeProblem, type EditorAction, type EditorState } from './table-editor';
import { SaveController } from './save';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => element<HTMLButtonElement>(id);
const tableSelect = element<HTMLSelectElement>('table');
const confirmation = element<HTMLInputElement>('confirm');
const status = (text: string) => { element('status').textContent = text; };
const directTab = new URL(location.href).searchParams.get('tab');
let tabId = directTab === null ? -1 : Number(directTab);
let sourceReady = directTab !== null, saveStarting = false;
let picker: { requestId: string; tabId: number; documentId: string } | undefined;
let disposeSource: (() => void) | undefined;
let sourceUrl = '', documentId = '', candidates: TableCandidate[] = [], selected: TableCandidate | undefined;
let editor: EditorState | undefined, capture: Capture | undefined, preview: Preview | undefined, artifact: Uint8Array | undefined;
let calculatedEditor: EditorState | undefined, draggedColumn: number | undefined;
let calculatedPreview: Preview | undefined, calculatedArtifact: Uint8Array | undefined, captureOrigin = '';
let revision = 0, page = 0, busy = false, calculating = false, worker: Worker | undefined;
let cancelWorker: (() => void) | undefined;
let calculationTimer: ReturnType<typeof setTimeout> | undefined, editorIndex: number | undefined;
let pendingStructureFocus: { revision: number; origin: Element | null; selectors: string[] } | undefined;
let saveController: SaveController;
const received = new Set<string>();

function savingUnresolved(): boolean { return !!saveController?.attempt && ['saving', 'unknown'].includes(saveController.attempt.state); }
function editingBlocked(): boolean { return busy || saveStarting || savingUnresolved(); }
function updateControls(): void {
  const blocked = editingBlocked(), record = saveController?.attempt;
  const sourceProblem = saveStarting ? '保存を開始しています。保存結果を待ってください。' : savingUnresolved() ? '保存結果が確定するまで、表と取得元を変更できません。' : busy ? '範囲の選択・取り込み中です。中止すると元の表に戻れます。' : !sourceReady ? '使うページで拡張アイコンを押すと範囲を選べます。' : '';
  const setDisabled = (id: string, disabled: boolean, reason = '') => { const control = button(id); control.disabled = disabled; control.title = disabled ? reason : ''; };
  tableSelect.disabled = blocked || !sourceReady || !candidates.length;
  setDisabled('scan', blocked || !sourceReady, sourceProblem);
  for (const id of ['pick', 'page-content']) setDisabled(id, blocked || !sourceReady || !documentId, sourceProblem || '元のページを確認してから範囲を選んでください。');
  element<HTMLSelectElement>('pick-kind').disabled = blocked || !sourceReady;
  setDisabled('use-content', blocked || !sourceReady || !selected || selected.kind === 'content', sourceProblem || (selected?.kind === 'content' ? 'この範囲はすでに表示内容から取り込んでいます。' : '選んだ表があると、この取り込み方法を使えます。'));
  for (const id of ['show-source', 'capture']) setDisabled(id, blocked || !sourceReady || !selected || !!selected.error, sourceProblem || '範囲を選んでから使えます。');
  setDisabled('stop', !busy && !calculating); button('stop').hidden = !busy && !calculating;
  for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('#column-editor input, #column-editor button, #hidden-columns button, #hidden-rows button, #preview th button, #preview [data-hide-row]')) control.disabled = blocked;
  for (const heading of document.querySelectorAll<HTMLElement>('#preview th[data-source-index]')) heading.draggable = !blocked;
  const view = editor && editorView(editor), position = view?.columnIds.indexOf(editorIndex ?? -1) ?? -1;
  if (document.getElementById('column-left')) setDisabled('column-left', blocked || position <= 0, blocked ? sourceProblem : 'この列は左端です。');
  if (document.getElementById('column-right')) setDisabled('column-right', blocked || !view || position >= view.columnIds.length - 1, blocked ? sourceProblem : 'この列は右端です。');
  if (document.getElementById('column-help')) element('column-help').textContent = blocked ? sourceProblem : view?.columnIds.length === 1 ? '表示する列は1列です。左右へは移せません。' : position === 0 ? '左端の列です。右へ移せます。' : position === (view?.columnIds.length || 0) - 1 ? '右端の列です。左へ移せます。' : '左右ボタンで列の順番を変えられます。';
  setDisabled('undo', blocked || !editor || !canUndo(editor), sourceProblem || '元に戻せる編集はまだありません。');
  const resumable = !!capture && !!view?.headers.length && !preview && !calculating && view.headers.every(name => !!name.trim()) && new Set(view.headers).size === view.headers.length;
  button('resume').hidden = !resumable || blocked;
  setDisabled('resume', !resumable || blocked);
  const transposeReason = editor ? transposeProblem(editor) : '範囲を選ぶと使えます。';
  setDisabled('transpose', blocked || !editor || !!transposeReason, sourceProblem || transposeReason);
  confirmation.disabled = blocked || calculating || !preview || !artifact || preview.errorCount > 0;
  const saveProblem = saveStarting ? '保存を開始しています。' : record?.state === 'unknown' ? '保存結果が不明です。先に保存結果を照合してください。' : record?.state === 'saving' ? '保存中です。結果が確定するまで表を固定しています。' : busy ? (capture ? '選択・取り込みが終わるか、中止するとこの表を保存できます。' : '元ページを確認しています。確認後、範囲を選ぶと表を表示します。') : calculating ? '編集した表をCSVへ反映しています。' : !capture ? '範囲を選ぶと表を確認できます。' : resumable ? '「表を編集」で内容を確認してから保存してください。' : !artifact || preview?.errorCount ? '表の案内に沿って列を直してください。' : record?.state === 'saved' ? 'この表は保存済みです。編集すると新しいCSVを保存できます。' : !confirmation.checked ? '意図した内容を保存するため、表を確認してください。確認チェックを入れてください。' : '確認した表をCSVとして保存できます。';
  setDisabled('save', blocked || calculating || !artifact || !confirmation.checked || !!preview?.errorCount || record?.state === 'saved', saveProblem);
  button('cancel-save').hidden = record?.state !== 'saving' || record.downloadId === undefined;
  setDisabled('cancel-save', saveStarting || record?.state !== 'saving' || record.downloadId === undefined);
  button('reconcile').hidden = !record || !['saving', 'unknown'].includes(record.state);
  setDisabled('reconcile', busy || saveStarting || !!button('reconcile').hidden);
  element('verify-file').hidden = record?.state !== 'unknown';
  element<HTMLInputElement>('file').disabled = busy || saveStarting;
  setDisabled('previous', blocked || calculating || !preview || page === 0, page === 0 ? '最初のページです。' : sourceProblem);
  setDisabled('next', blocked || calculating || !preview || (page + 1) * 100 >= preview.rows.length, !preview || (page + 1) * 100 >= preview.rows.length ? '最後のページです。' : sourceProblem);
  element('pagination').hidden = !preview || preview.rows.length <= 100;
  element('source-help').textContent = sourceProblem || (capture ? '別の範囲を取り込むと、取得に成功した時点でこの表を置き換えます。取消や失敗ではこの表を残します。' : 'ページ上で範囲を選んで、表を取り込みます。');
  element('edit-help').textContent = blocked ? sourceProblem : !editor ? '範囲を選ぶと表の編集ができます。' : resumable ? '取り込んだ内容は保持しています。「表を編集」で再開できます。' : !preview && calculating ? '取り込んだ内容から表を作っています。' : transposeReason || (editor.discardedHistory ? '列の見出しで名前・順番・除外を調整できます。元に戻せるのは直近50回の編集です。' : '列の見出しで名前・除外を調整できます。列見出しをドラッグするか、左右ボタンで順番を変えられます。');
  element('save-help').textContent = saveProblem;
}
function renderSave(): void {
  const record = saveController?.attempt;
  const labels = { generated: 'CSVの準備ができました。表を確認してから保存できます。', saving: '保存中です。保存内容は開始時点のものに固定され、結果が分かるまで次の保存を待ちます。', saved: 'CSVを保存しました。表は引き続き編集できますが、Excelへの取り込みは確認していません。', cancelled: '保存を取り消しました。表を編集して、もう一度保存できます。', interrupted: '保存が失敗または中断しました。途中のファイルが残る場合があるため、保存先を確認してから保存し直してください。', unknown: '保存結果が不明です。自動では再保存しません。「保存結果を照合」または保存済みファイルの照合を使ってください。' };
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
function invalidate(): void {
  revision++;
  artifact = undefined; confirmation.checked = false;
  element('cell-detail').hidden = true; element('header-notice').textContent = '';
  if (!savingUnresolved()) freshSaveController();
  updateControls();
}
function renderColumns(): void {
  for (const [id, items, text, dataKey, action] of [
    ['hidden-columns', editor?.table.columns.filter(column => !column.included) || [], '列を復元：', 'restoreIndex', 'restore-column'],
    ['hidden-rows', editor?.table.rows.filter(row => !row.included) || [], '行を復元：', 'restoreRow', 'restore-row'],
  ] as const) {
    const container = element(id); container.replaceChildren(); container.hidden = !items.length;
    if (items.length) container.append(document.createTextNode(text));
    for (const item of items) {
      const restore = document.createElement('button'); restore.type = 'button'; restore.dataset[dataKey] = String(item.id); restore.textContent = 'name' in item ? item.name : item.label; restore.setAttribute('aria-label', `${restore.textContent}：${action === 'restore-column' ? '列を復元' : '行を復元'}`);
      restore.addEventListener('click', () => changeEditor({ type: action, id: item.id })); container.append(restore);
    }
  }
  if (!editor?.table.columns.some(column => column.id === editorIndex && column.included)) { editorIndex = undefined; element('column-editor').hidden = true; }
  const currentColumn = editor?.table.columns.find(column => column.id === editorIndex && column.included);
  const currentInput = document.getElementById('column-name') as HTMLInputElement | null;
  if (currentColumn && currentInput) {
    // Leave an unchanged input alone so recalculation preserves its caret and IME.
    if (currentInput.value !== currentColumn.name) currentInput.value = currentColumn.name;
    const title = element('column-editor').querySelector('h3');
    if (title) title.textContent = `列の調整：${currentColumn.name}`;
  }
  updateControls();
}
function changeEditor(action: EditorAction): void {
  if (!editor || editingBlocked()) return;
  try {
    const next = editTable(editor, action); if (next === editor) return;
    const previousView = editorView(editor), origin = document.activeElement;
    editor = next; invalidate();
    if (['exclude-column', 'restore-column', 'exclude-row', 'restore-row'].includes(action.type) && 'id' in action) {
      const view = editorView(next), rowAction = action.type.endsWith('row'), ids = rowAction ? view.rowIds : view.columnIds;
      const previousIds = rowAction ? previousView.rowIds : previousView.columnIds;
      const targetId = action.type.startsWith('restore') ? action.id : ids[Math.min(previousIds.indexOf(action.id), ids.length - 1)];
      if (rowAction && targetId !== undefined) page = Math.floor(view.rowIds.indexOf(targetId) / 100);
      const target = rowAction ? `[data-hide-row="${targetId}"]` : `th[data-source-index="${targetId}"] button`;
      const fallback = rowAction ? `#hidden-rows [data-restore-row="${action.id}"]` : `#hidden-columns [data-restore-index="${action.id}"]`;
      pendingStructureFocus = { revision, origin, selectors: targetId === undefined ? [fallback] : [target, fallback] };
    }
    renderColumns(); scheduleCalculate();
  } catch (error) { status(error instanceof Error ? error.message : 'この操作はできません。表は変更していません。'); renderColumns(); }
}
function restoreStructureFocus(): boolean {
  const pending = pendingStructureFocus; pendingStructureFocus = undefined;
  if (!pending || pending.revision !== revision || document.activeElement !== document.body && document.activeElement !== pending.origin) return false;
  for (const selector of pending.selectors) {
    const target = document.querySelector<HTMLButtonElement>(selector);
    if (target) { target.focus(); return true; }
  }
  return false;
}
function openColumn(id: number): void {
  if (editingBlocked()) return;
  const column = editor?.table.columns.find(value => value.id === id); if (!column?.included) return;
  editorIndex = id;
  const container = element('column-editor'); container.hidden = false; container.replaceChildren();
  const title = document.createElement('h3'); title.textContent = `列の調整：${column.name}`; container.append(title);
  const output = document.createElement('input'); output.id = 'column-name'; output.type = 'text'; output.value = column.name; output.maxLength = 100; output.setAttribute('aria-label', '出力する列名');
  const name = document.createElement('label'); name.textContent = '列名 '; name.append(output); container.append(name);
  output.addEventListener('input', event => {
    if (editingBlocked()) { output.value = editor?.table.columns.find(value => value.id === id)?.name || ''; return; }
    changeEditor({ type: 'rename-column', id, name: output.value });
    if ((event as InputEvent).isComposing) { cancelCalculation(); calculating = true; element('preview').setAttribute('aria-busy', 'true'); updateControls(); }
  });
  output.addEventListener('compositionend', () => { if (!editingBlocked()) { invalidate(); scheduleCalculate(); } });
  const actions = document.createElement('div'); actions.className = 'actions';
  for (const [text, controlId, action] of [
    ['左へ移動', 'column-left', () => move(-1)], ['右へ移動', 'column-right', () => move(1)],
    ['列を除外', 'column-hide', () => changeEditor({ type: 'exclude-column', id })],
    ['閉じる', 'column-close', () => {
      editorIndex = undefined; container.hidden = true;
      document.querySelector<HTMLButtonElement>(`#preview th[data-source-index="${id}"] button`)?.focus();
    }],
  ] as const) {
    const control = document.createElement('button'); control.id = controlId; control.type = 'button'; control.textContent = text; control.addEventListener('click', () => { if (!editingBlocked()) action(); }); actions.append(control);
  }
  function move(delta: number): void {
    if (!editor) return;
    const view = editorView(editor), position = view.columnIds.indexOf(id), toVisibleIndex = position + delta;
    if (toVisibleIndex >= 0 && toVisibleIndex < view.columnIds.length) changeEditor({ type: 'move-column', id, toVisibleIndex });
  }
  container.append(actions);
  const help = document.createElement('p'); help.id = 'column-help'; help.className = 'operation-help'; container.append(help);
  updateControls(); output.focus(); container.scrollIntoView?.({ block: 'nearest' });
}
async function selectRange(candidate: TableCandidate | undefined): Promise<void> {
  if (!candidate) { status('範囲を選んでください。今の表はそのまま残します。'); return; }
  if (candidate.error) { element('range-notice').textContent = candidate.error; status('この範囲は取り込めません。範囲を選び直してください。今の表はそのまま残します。'); return; }
  await acquire(candidate);
}
function describeSelection(): void {
  if (!selected) return;
  const description = selected.layout === 'composite' ? '複数の表・文章を順に表示' : `${selected.headers.length}列の表`;
  const scope = selected.kind === 'content' ? `${selected.label || '選択した範囲'}（${description}）` : `表${selected.index + 1}`;
  element('coverage').textContent = `取得済み表：${captureOrigin}の${scope}だけ・取得 ${capture?.rows.length || 0}件 / ${selected.headers.length}列・取得時刻 ${capture?.capturedAt || ''}`;
  element('range-notice').textContent = (capture?.warnings || selected.warnings || []).join('\n');
  if (selected.kind === 'content') {
    tableSelect.querySelector('option[value="content"]')?.remove(); tableSelect.append(new Option(`${selected.label || '選んだ範囲'}（${description}）`, 'content')); tableSelect.value = 'content';
  } else tableSelect.value = String(selected.index);
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
const request = (mode: InspectRequest['mode'], requestId = crypto.randomUUID(), candidate = selected): InspectRequest => ({ mode, expectedUrl: sourceUrl, requestId, tableIndex: candidate?.index, tableKey: candidate?.key, headers: candidate?.headers, sourceIndexes: candidate?.headers.map((_, index) => index), limits: LIMITS, ...(candidate?.kind === 'content' ? { kind: 'content', contentSignature: candidate.contentSignature, ...(candidate.layout ? { layout: candidate.layout } : {}) } : {}) });
function stopPicker(): void {
  const active = picker; picker = undefined;
  if (active) void chrome.scripting.executeScript({ target: { tabId: active.tabId, documentIds: [active.documentId] }, func: cancelRegion, args: [active.requestId], world: 'ISOLATED' }).catch(() => {});
}
function stopWork(): void {
  revision++; stopPicker(); cancelCalculation(); busy = false;
}
function sourceChanged(): void {
  sourceReady = false; stopPicker();
  if (saveStarting || savingUnresolved()) {
    status('元のページが変わりました。保存中の表を保持しています。保存結果を確認してください。'); updateControls(); return;
  }
  stopWork(); selected = undefined; candidates = []; documentId = '';
  tableSelect.replaceChildren(new Option('使うページで拡張アイコンを押してください', ''));
  status(capture ? '元ページを読めません。取得済みの表は編集とCSV保存を続けられます。' : '使うページで拡張アイコンを押してください。');
  if (editor && !artifact) scheduleCalculate();
  updateControls();
}
async function activateSource(id: number): Promise<void> {
  if (saveStarting || savingUnresolved()) { status('保存結果を確認してから、使うページで拡張アイコンを押してください。'); return; }
  stopWork(); tabId = id; sourceReady = true; selected = undefined; documentId = '';
  await scan();
}
function beginSourceWork(): number {
  stopWork(); busy = true; updateControls(); return revision;
}
function finishSourceWork(activeRevision: number): void {
  if (activeRevision !== revision) return;
  busy = false;
  if (editor && !artifact && !calculating) scheduleCalculate();
  updateControls();
}
async function scan(): Promise<void> {
  if (!sourceReady || busy || saveStarting || savingUnresolved()) return;
  stopPicker();
  const activeRevision = beginSourceWork();
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
  finally { finishSourceWork(activeRevision); }
}
async function describeRange(kind?: 'content', key?: string, index?: number): Promise<void> {
  if (!sourceReady || busy || saveStarting || savingUnresolved()) return;
  const activeRevision = beginSourceWork();
  try {
    const data = await inject({ mode: 'describe', requestId: crypto.randomUUID(), expectedUrl: sourceUrl, limits: LIMITS, kind, tableKey: key, tableIndex: index });
    if (activeRevision !== revision) return;
    busy = false; await selectRange(data.tables?.[0]);
  } catch (error) { if (activeRevision === revision) status(error instanceof Error ? error.message : '選んだ範囲を取得できませんでした。'); }
  finally { finishSourceWork(activeRevision); }
}
async function pick(): Promise<void> {
  if (!sourceReady || !documentId || busy || saveStarting || savingUnresolved()) return;
  const activeRevision = beginSourceWork(), expectedDocument = documentId;
  const call: PickerRequest = { requestId: crypto.randomUUID(), expectedUrl: sourceUrl, ...(element<HTMLSelectElement>('pick-kind').value === 'content' ? { kind: 'content' } : {}) };
  picker = { requestId: call.requestId, tabId, documentId: expectedDocument };
  status((capture ? '範囲を選び直しています。選択を終えるまで、現在の表は残ります。' : 'ページ上で範囲を選んでください。') + 'クリックで確定、↑で広げる、↓で戻す、Escで取消です。');
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
  } catch (error) { if (activeRevision === revision) { picker = undefined; status(error instanceof Error ? capture && error.message === '範囲選択を中止しました。' ? '範囲の選択を取り消しました。以前の表を引き続き編集できます。' : error.message : '範囲を選択できませんでした。'); } }
  finally { finishSourceWork(activeRevision); }
}
function visible(value: string): string {
  return value === '' ? '［空欄］' : value.replace(/\t/g, '⟦TAB⟧').replace(/\r/g, '⟦CR⟧').replace(/\n/g, '⟦LF⟧\n').replace(/\0/g, '⟦NUL⟧');
}
function renderPreview(): void {
  const container = element('preview'), focused = document.activeElement;
  const headerFocus = focused instanceof HTMLElement && container.contains(focused) ? focused.closest<HTMLElement>('th[data-source-index]')?.dataset.sourceIndex : undefined;
  const cellFocus = focused instanceof HTMLElement && container.contains(focused) ? focused.closest<HTMLElement>('td[data-source-row]')?.dataset : undefined;
  const rowFocus = focused instanceof HTMLElement && container.contains(focused) ? focused.dataset.hideRow : undefined;
  container.replaceChildren();
  if (!preview || !editor) return;
  const view = editorView(editor), table = document.createElement('table'), header = table.createTHead().insertRow();
  const rowHeader = document.createElement('th'); rowHeader.scope = 'col'; rowHeader.textContent = '行'; header.append(rowHeader);
  view.headers.forEach((name, index) => {
    const id = view.columnIds[index], cell = document.createElement('th'); cell.scope = 'col'; cell.dataset.sourceIndex = String(id); cell.draggable = !editingBlocked();
    const control = document.createElement('button'); control.type = 'button'; control.className = 'column-heading'; control.setAttribute('aria-label', `${name}：この列を調整`); control.textContent = name;
    control.addEventListener('click', () => openColumn(id)); cell.append(control); header.append(cell);
    cell.addEventListener('dragstart', event => { if (editingBlocked()) { event.preventDefault(); return; } draggedColumn = id; event.dataTransfer?.setData('text/plain', String(id)); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; });
    cell.addEventListener('dragover', event => { if (draggedColumn !== undefined && !editingBlocked()) { event.preventDefault(); cell.classList.add('drop-target'); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; } });
    cell.addEventListener('dragleave', () => cell.classList.remove('drop-target'));
    cell.addEventListener('drop', event => { event.preventDefault(); cell.classList.remove('drop-target'); if (draggedColumn !== undefined && !editingBlocked()) changeEditor({ type: 'move-column', id: draggedColumn, toVisibleIndex: index }); draggedColumn = undefined; });
    cell.addEventListener('dragend', () => { draggedColumn = undefined; for (const target of container.querySelectorAll('.drop-target')) target.classList.remove('drop-target'); });
  });
  const body = table.createTBody();
  preview.rows.slice(page * 100, (page + 1) * 100).forEach((row, index) => {
    const rowIndex = page * 100 + index, rowId = view.rowIds[rowIndex], rowLabel = view.rowLabels[rowIndex];
    const tr = body.insertRow(), first = tr.insertCell(); first.append(document.createTextNode(rowLabel));
    const hide = document.createElement('button'); hide.type = 'button'; hide.textContent = '行を除外'; hide.className = 'row-hide'; hide.dataset.hideRow = String(rowId); hide.setAttribute('aria-label', `${rowLabel}を除外`); hide.addEventListener('click', () => changeEditor({ type: 'exclude-row', id: rowId })); first.append(hide);
    row.forEach((cell, columnIndex) => {
      const columnId = view.columnIds[columnIndex], td = tr.insertCell(); td.className = cell.error ? 'error' : cell.protection ? 'protection' : '';
      td.dataset.sourceIndex = String(columnId); td.dataset.sourceRow = String(rowId);
      const value = document.createElement('div'); value.className = 'cell-value'; value.textContent = cell.logical === '' ? '［空欄］' : cell.logical; td.append(value);
      if (cell.error || cell.protection || cell.warning) { const note = document.createElement('span'); note.className = 'cell-badge'; note.textContent = cell.error ? '変換エラー' : cell.protection ? 'CSVで保護' : '取り込み注意'; td.append(note); }
      const detail = document.createElement('button'); detail.type = 'button'; detail.className = 'cell-more'; detail.textContent = '詳細'; detail.setAttribute('aria-label', `${rowLabel} ${view.headers[columnIndex]}の値の詳細`);
      detail.addEventListener('click', () => {
        const detailContainer = element('cell-detail'); detailContainer.replaceChildren(); detailContainer.hidden = false;
        const title = document.createElement('h3'); title.textContent = `${rowLabel}・${view.headers[columnIndex]}`; detailContainer.append(title);
        for (const [name, text] of [['元の文字列', cell.raw], ['表の値', cell.logical], ['CSV値', cell.output]]) { const line = document.createElement('div'); line.className = 'cell-line'; line.textContent = `${name}：${visible(text)}`; detailContainer.append(line); }
        for (const text of [cell.error, cell.protection, cell.warning]) if (text) { const note = document.createElement('p'); note.textContent = text; detailContainer.append(note); }
        const close = document.createElement('button'); close.type = 'button'; close.textContent = '閉じる'; close.addEventListener('click', () => { detailContainer.hidden = true; detail.focus(); }); detailContainer.append(close);
        detailContainer.tabIndex = -1; detailContainer.focus(); detailContainer.scrollIntoView?.({ block: 'nearest' });
      }); td.append(detail);
    });
  });
  container.append(table);
  const pages = Math.max(1, Math.ceil(preview.rows.length / 100)); element('page').textContent = `${page + 1} / ${pages} ページ（CSVには表の全行）`;
  element('summary').textContent = `取得 ${capture?.rows.length || 0}件 / 出力 ${preview.rows.length}件・${preview.headers.length}列 / 空欄 ${preview.emptyCount}セル / CSV保護 ${preview.protectionCount}件。取得時刻：${capture?.capturedAt || ''}`;
  element('header-notice').textContent = preview.errorCount ? '出力列名に使えない制御文字があります。列名を直してください。' : preview.headers.some((value, index) => value !== view.headers[index]) ? '式に見える出力列名にも、保護用タブを加えています。' : '';
  element('confirm-label').textContent = preview.rows.length === 0 ? '見出しだけのCSVを保存することを確認しました' : `この表の${preview.rows.length}件とCSV保護${preview.protectionCount}件を確認しました`;
  container.setAttribute('aria-busy', 'false'); document.body.classList.add('has-preview'); renderColumns();
  const restored = headerFocus !== undefined ? container.querySelector<HTMLButtonElement>(`th[data-source-index="${headerFocus}"] button`)
    : cellFocus ? container.querySelector<HTMLButtonElement>(`td[data-source-row="${cellFocus.sourceRow}"][data-source-index="${cellFocus.sourceIndex}"] button`)
    : rowFocus !== undefined ? container.querySelector<HTMLButtonElement>(`[data-hide-row="${rowFocus}"]`) : null;
  if (restoreStructureFocus()) return;
  if (restored) restored.focus({ preventScroll: true });
  else if (headerFocus !== undefined || rowFocus !== undefined) container.querySelector<HTMLButtonElement>('th button, [data-hide-row]')?.focus({ preventScroll: true });
}
function scheduleCalculate(): void {
  clearTimeout(calculationTimer); worker?.terminate(); worker = undefined; cancelWorker?.(); cancelWorker = undefined;
  if (!capture) return;
  calculating = true; element('preview').setAttribute('aria-busy', 'true'); updateControls();
  calculationTimer = setTimeout(() => { calculationTimer = undefined; void calculate(); }, 180);
}
async function calculate(): Promise<void> {
  if (!capture || !editor || editingBlocked()) return;
  clearTimeout(calculationTimer); calculationTimer = undefined;
  calculating = true; artifact = undefined; confirmation.checked = false; updateControls(); status('表を更新しています。');
  const activeRevision = revision;
  const currentEditor = editor, view = editorView(currentEditor);
  const config: ColumnConfig[] = view.headers.map((outputName, sourceIndex) => ({ sourceIndex, outputName, kind: 'text', required: false, dateFormat: 'YYYY-MM-DD', dateOutput: 'YYYY-MM-DD', amount: { symbol: '', grouping: '', decimal: '.', negative: 'minus' } }));
  const problem = !config.length ? '保存する列を1つ以上選んでください。省いた列は下のボタンで戻せます。'
    : config.some(column => !column.outputName.trim()) ? '列名を入力してください。'
    : new Set(config.map(column => column.outputName)).size !== config.length ? '列名が重複しています。別の列名を入力してください。' : '';
  if (problem) {
    if (!config.length) { preview = undefined; element('preview').replaceChildren(); element('page').textContent = ''; }
    element('header-notice').textContent = problem; status(problem); calculating = false; element('preview').setAttribute('aria-busy', 'false'); renderColumns(); restoreStructureFocus(); return;
  }
  const editedCapture: Capture = { ...capture, headers: view.headers, sourceIndexes: view.headers.map((_, index) => index), rows: view.rows };
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
      currentWorker.postMessage({ requestId, capture: structuredClone(editedCapture), columns: structuredClone(config) });
    });
    if (activeRevision !== revision) return;
    if (result.error) throw new Error(result.error);
    preview = result.preview; artifact = result.bytes; calculatedEditor = currentEditor; calculatedPreview = preview; calculatedArtifact = artifact; page = Math.min(page, Math.max(0, Math.ceil(preview.rows.length / 100) - 1)); renderPreview();
    status(preview.errorCount ? 'エラーがあります。設定を直してプレビューを作り直してください。保存は開始できません。' : '値と件数を確認し、確認チェックを入れて保存してください。');
  } catch (error) { if (activeRevision === revision) status(error instanceof Error ? error.message : 'プレビューに失敗しました。'); }
  finally { currentWorker.terminate(); if (activeRevision === revision) { worker = undefined; cancelWorker = undefined; calculating = false; element('preview').setAttribute('aria-busy', 'false'); updateControls(); } }
}
async function acquire(candidate = selected): Promise<void> {
  if (!sourceReady || !candidate || candidate.error || busy || saveStarting || savingUnresolved()) return;
  const activeRevision = beginSourceWork(), call = request('capture', crypto.randomUUID(), candidate);
  status(capture ? '新しい範囲を取り込んでいます。完了するまで、現在の表は残ります。' : '選んだ範囲を表にしています。');
  try {
    const data = await inject(call);
    if (activeRevision !== revision || received.has(call.requestId)) return;
    if (!data.capture) throw new Error('取得結果がありません。');
    const next = createEditor(data.capture);
    received.add(call.requestId); selected = candidate; capture = data.capture; editor = next; calculatedEditor = undefined; calculatedPreview = undefined; calculatedArtifact = undefined; captureOrigin = new URL(sourceUrl).origin;
    editorIndex = undefined; element('column-editor').hidden = true; page = 0;
    element('summary').textContent = `取得 ${capture.rows.length}件。表の表示はまだ完了していません。`;
    invalidate(); preview = undefined; element('preview').replaceChildren(); renderColumns(); describeSelection();
    busy = false; await calculate();
  } catch (error) { if (activeRevision === revision) status(error instanceof Error ? error.message : '取得に失敗しました。今の表はそのまま残します。'); }
  finally { if (activeRevision === revision) finishSourceWork(activeRevision); else if (!busy) updateControls(); }
}
tableSelect.addEventListener('change', () => {
  if (busy || saveStarting || savingUnresolved() || !sourceReady || tableSelect.value === 'content') return;
  void selectRange(candidates.find(value => String(value.index) === tableSelect.value && !value.error));
});
button('scan').addEventListener('click', () => { void scan(); });
button('pick').addEventListener('click', () => { void pick(); });
button('page-content').addEventListener('click', () => { void describeRange('content'); });
button('use-content').addEventListener('click', () => {
  if (selected) { element<HTMLSelectElement>('pick-kind').value = 'content'; void describeRange('content', selected.key.startsWith('content:') ? selected.key : `content:${selected.key}`, 0); }
});
button('show-source').addEventListener('click', () => {
  if (busy || saveStarting || savingUnresolved() || !sourceReady || !selected || selected.error) return;
  const activeRevision = revision, sourceTabId = tabId;
  void inject(request('highlight')).then(() => {
    if (activeRevision === revision) return chrome.tabs.update(sourceTabId, { active: true });
  }).catch(() => {
    if (activeRevision === revision) status('元のページが変わったか、タブが閉じられました。範囲を選び直してください。');
  });
});
button('capture').addEventListener('click', () => { void acquire(); });
button('stop').addEventListener('click', () => {
  if (saveStarting || savingUnresolved()) return;
  const wasCalculating = calculating, wasPicking = !!picker; stopWork();
  if (wasCalculating && calculatedEditor) {
    editor = calculatedEditor; preview = calculatedPreview; artifact = calculatedArtifact;
    confirmation.checked = false; renderPreview();
  }
  element('preview').setAttribute('aria-busy', 'false');
  status(wasCalculating && calculatedEditor ? '更新を中止し、最後に表示した表に戻しました。表を確認して編集・保存を続けられます。' : capture && !preview ? '処理を中止しました。「表を編集」で再開できます。' : wasPicking && capture ? '範囲の選択を取り消しました。以前の表を引き続き編集できます。' : capture ? '処理を中止しました。取り込んだ表は残っています。編集・保存を続けられます。' : '処理を中止しました。範囲を選んでください。'); updateControls();
});
button('previous').addEventListener('click', () => { if (!button('previous').disabled) { page--; renderPreview(); } });
button('next').addEventListener('click', () => { if (!button('next').disabled) { page++; renderPreview(); } });
confirmation.addEventListener('change', updateControls);
button('undo').addEventListener('click', () => changeEditor({ type: 'undo' }));
button('transpose').addEventListener('click', () => changeEditor({ type: 'transpose' }));
button('resume').addEventListener('click', () => { if (!button('resume').disabled && !button('resume').hidden) scheduleCalculate(); });
button('save').addEventListener('click', async () => {
  if (!artifact || !confirmation.checked || preview?.errorCount || busy || calculating || saveStarting || savingUnresolved()) return;
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
document.addEventListener('visibilitychange', () => { if (document.hidden && picker) { stopWork(); updateControls(); status(capture ? '範囲の選択を取り消しました。以前の表を引き続き編集できます。' : '範囲選択を中止しました。もう一度範囲を選んでください。'); } });
if (directTab === null) {
  chrome.tabs.onUpdated.addListener((id, change) => { if (id === tabId && (change.status === 'loading' || change.url && change.url !== sourceUrl)) sourceChanged(); });
  chrome.tabs.onRemoved.addListener(id => { if (id === tabId) sourceChanged(); });
}
async function initialize(): Promise<void> {
  freshSaveController();
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await saveController.reconcile();
    if (directTab !== null) await scan();
    else disposeSource = await watchPanelSource(activateSource, sourceChanged);
  } catch { status('ローカル設定か保存照合情報を確認できません。保存済み設定を上書きせず停止しました。'); }
  renderSave();
}
void initialize();
