import { LIMITS, type Capture } from './contracts';
import { countMatrixChars } from './text-budget';

export const EDIT_HISTORY_LIMIT = 50;
export type EditorColumn = Readonly<{ id: number; valueIndex: number; name: string; included: boolean }>;
export type EditorRow = Readonly<{ id: number; sourceRow: number | null; label: string; values: readonly string[]; included: boolean }>;
export type EditorTable = Readonly<{ columns: readonly EditorColumn[]; rows: readonly EditorRow[]; sourceCount: number }>;
export type EditorState = Readonly<{ table: EditorTable; history: readonly EditorTable[]; nextColumnId: number; nextRowId: number; discardedHistory: number }>;
export type EditorAction =
  | { type: 'rename-column'; id: number; name: string }
  | { type: 'move-column'; id: number; toVisibleIndex: number }
  | { type: 'exclude-column' | 'restore-column' | 'exclude-row' | 'restore-row'; id: number }
  | { type: 'transpose' }
  | { type: 'undo' };
export type EditorView = { headers: string[]; rows: string[][]; columnIds: number[]; rowIds: number[]; rowLabels: string[]; sourceCount: number };

/** Transactions remain in this screen's memory. History shares immutable cells. */
function table(columns: readonly EditorColumn[], rows: readonly EditorRow[], sourceCount: number): EditorTable {
  return Object.freeze({ columns: Object.freeze(columns), rows: Object.freeze(rows), sourceCount });
}
function initialNames(headers: string[], sourceIndexes: number[]): string[] {
  const used = new Set<string>();
  const clip = (text: string, length: number) => text.slice(0, length).replace(/[\uD800-\uDBFF]$/, '');
  return headers.map((header, index) => {
    const base = header.trim() ? header : `列${sourceIndexes[index] + 1}`;
    let name = clip(base, 100), suffix = 1;
    while (used.has(name)) { const ending = `（${++suffix}）`; name = clip(base, 100 - ending.length) + ending; }
    used.add(name); return name;
  });
}
function validateCapture(capture: Capture): void {
  if (!capture || capture.schemaVersion !== 1 || capture.scope !== 'current-page' || typeof capture.requestId !== 'string'
    || !Array.isArray(capture.headers) || capture.headers.length < 1 || capture.headers.length > LIMITS.columns
    || !Array.isArray(capture.sourceIndexes) || capture.sourceIndexes.length < 1 || capture.sourceIndexes.length > capture.headers.length
    || capture.sourceIndexes.some(index => !Number.isInteger(index) || index < 0 || index >= capture.headers.length)
    || new Set(capture.sourceIndexes).size !== capture.sourceIndexes.length
    || !Array.isArray(capture.rows) || capture.rows.length > LIMITS.rows) throw new Error('取得結果の行・列の形式が不正です。範囲を選び直してください。');
  if (capture.headers.some(header => typeof header !== 'string' || header.length > LIMITS.cellChars)) throw new Error('見出しの文字数が取得上限を超えています。');
  for (const row of capture.rows) {
    if (!Array.isArray(row) || row.length !== capture.sourceIndexes.length) throw new Error('取得結果の行と列の対応が不正です。');
    for (const value of row) {
      if (typeof value !== 'string' || value.length > LIMITS.cellChars) throw new Error('セルの文字数が取得上限を超えています。');
    }
  }
  if (countMatrixChars(capture.headers, capture.rows) > LIMITS.textChars) throw new Error('取得した文字数が処理上限を超えています。');
}
function visibleChars(value: EditorTable): number {
  const columns = value.columns.filter(column => column.included);
  return countMatrixChars(columns.map(column => column.name), value.rows.filter(row => row.included).map(row => columns.map(column => row.values[column.valueIndex])));
}
function validateVisibleBudget(value: EditorTable): void {
  if (visibleChars(value) > LIMITS.textChars) throw new Error('編集後の文字数が処理上限を超えます。列名を短くするか、出力する行または列を減らしてください。');
}
export function createEditor(capture: Capture): EditorState {
  validateCapture(capture);
  const names = initialNames(capture.sourceIndexes.map(index => capture.headers[index]), capture.sourceIndexes);
  const columns = capture.sourceIndexes.map((id, valueIndex) => Object.freeze({ id, valueIndex, name: names[valueIndex], included: true }));
  const rows = capture.rows.map((values, id) => Object.freeze({ id, sourceRow: id + 1, label: `元の行${id + 1}`, values: Object.freeze([...values]), included: true }));
  const initial = table(columns, rows, capture.rows.length);
  validateVisibleBudget(initial);
  return Object.freeze({ table: initial, history: Object.freeze([]), nextColumnId: Math.max(...capture.sourceIndexes) + 1, nextRowId: capture.rows.length, discardedHistory: 0 });
}
export function editorView(state: EditorState): EditorView {
  const columns = state.table.columns.filter(column => column.included), rows = state.table.rows.filter(row => row.included);
  return { headers: columns.map(column => column.name), rows: rows.map(row => columns.map(column => row.values[column.valueIndex])), columnIds: columns.map(column => column.id), rowIds: rows.map(row => row.id), rowLabels: rows.map(row => row.label), sourceCount: state.table.sourceCount };
}
/** Invalid or oversized operations throw before any input or history changes. */
export function editTable(state: EditorState, action: EditorAction): EditorState {
  if (action.type === 'undo') {
    if (!canUndo(state)) return state;
    return Object.freeze({ ...state, table: state.history.at(-1)!, history: Object.freeze(state.history.slice(0, -1)) });
  }
  let next: EditorTable;
  let nextColumnId = state.nextColumnId, nextRowId = state.nextRowId;
  if (action.type === 'transpose') {
    const problem = transposeProblem(state); if (problem) throw new Error(problem);
    const visible = editorView(state);
    const columns = ['元の列', ...visible.rowLabels].map((name, valueIndex) => Object.freeze({ id: nextColumnId++, valueIndex, name, included: true }));
    const rows = visible.headers.map((name, index) => Object.freeze({ id: nextRowId++, sourceRow: null, label: `元の列${index + 1}`, values: Object.freeze([name, ...visible.rows.map(row => row[index])]), included: true }));
    next = table(columns, rows, state.table.sourceCount);
  } else if (action.type === 'exclude-row' || action.type === 'restore-row') {
    const index = state.table.rows.findIndex(row => row.id === action.id);
    if (index < 0) throw new Error('編集する行がありません。現在の表から選んでください。');
    const included = action.type === 'restore-row';
    if (state.table.rows[index].included === included) return state;
    const rows = [...state.table.rows]; rows[index] = Object.freeze({ ...rows[index], included });
    next = table(state.table.columns, rows, state.table.sourceCount);
  } else {
    const index = state.table.columns.findIndex(column => column.id === action.id);
    if (index < 0) throw new Error('編集する列がありません。現在の表から選んでください。');
    const column = state.table.columns[index];
    let columns = [...state.table.columns];
    if (action.type === 'rename-column') {
      if (typeof action.name !== 'string' || action.name.length > 100) throw new Error('列名の文字数は100文字までです。');
      if (column.name === action.name) return state;
      columns[index] = Object.freeze({ ...column, name: action.name });
    } else if (action.type === 'move-column') {
      const visible = columns.filter(value => value.included), from = visible.findIndex(value => value.id === action.id);
      if (from < 0 || !Number.isInteger(action.toVisibleIndex) || action.toVisibleIndex < 0 || action.toVisibleIndex >= visible.length) throw new Error('列を移す位置を現在の表から選んでください。');
      if (from === action.toVisibleIndex) return state;
      visible.splice(action.toVisibleIndex, 0, visible.splice(from, 1)[0]);
      let visibleIndex = 0; columns = columns.map(value => value.included ? visible[visibleIndex++] : value);
    } else {
      const included = action.type === 'restore-column';
      if (column.included === included) return state;
      columns[index] = Object.freeze({ ...column, included });
    }
    next = table(columns, state.table.rows, state.table.sourceCount);
  }
  validateVisibleBudget(next);
  const history = [...state.history, state.table], discarded = Math.max(0, history.length - EDIT_HISTORY_LIMIT);
  return Object.freeze({ table: next, history: Object.freeze(history.slice(discarded)), nextColumnId, nextRowId, discardedHistory: state.discardedHistory + discarded });
}
export function canUndo(state: EditorState): boolean { return state.history.length > 0; }
export function transposeProblem(state: EditorState): string | undefined {
  const columns = state.table.columns.filter(column => column.included), rows = state.table.rows.filter(row => row.included);
  if (!columns.length) return '行列を入れ替えるには、列を1つ以上戻してください。';
  // Reject the common large-table case before allocating a visible cell matrix.
  if (rows.length + 1 > LIMITS.columns) return `行列を入れ替えると${LIMITS.columns}列の上限を超えます。元の見出しを残す列も必要なため、出力する行を${LIMITS.columns - 1}件以下にしてください。`;
  // Current headers become data; generated row labels become new headers.
  const chars = visibleChars(state.table) + countMatrixChars(['元の列', ...rows.map(row => row.label)], []);
  if (chars > LIMITS.textChars) return '行列を入れ替えると文字数の処理上限を超えます。出力する行または列を減らしてください。';
  return undefined;
}
