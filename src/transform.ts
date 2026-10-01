import { LIMITS, type Capture, type CellPreview, type ColumnConfig, type DateFormat, type Preview } from './contracts.js';
import { countMatrixChars } from './text-budget.js';

const DATE_PATTERNS: Record<DateFormat, RegExp> = {
  'YYYY-MM-DD': /^(\d{4})-(\d{2})-(\d{2})$/,
  'YYYY/MM/DD': /^(\d{4})\/(\d{2})\/(\d{2})$/,
  'YYYY年M月D日': /^(\d{4})年(\d{1,2})月(\d{1,2})日$/,
  'MM/DD/YYYY': /^(\d{2})\/(\d{2})\/(\d{4})$/,
  'DD/MM/YYYY': /^(\d{2})\/(\d{2})\/(\d{4})$/,
};
const PROTECTION_REASON = 'Excelで数式として解釈されるおそれがあるため、先頭に保護用タブを追加しました。文字列型で取り込んでください。';

/** Tabs and line breaks are preserved; other controls cannot be exported safely. */
export function textProblem(value: string): string | undefined {
  const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.exec(value);
  if (control) return `出力できない制御文字 U+${control[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} が含まれています。元ページを確認してください。`;
  // TextEncoder replaces malformed UTF-16 with U+FFFD. Diagnose it instead of
  // silently replacing an original value during UTF-8 generation.
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return '対応する文字のないサロゲート（Unicode文字の片側）が含まれています。元ページを確認してください。';
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return '対応する文字のないサロゲート（Unicode文字の片側）が含まれています。元ページを確認してください。';
    }
  }
  return undefined;
}

/** Inspect invisible prefixes without trimming or normalizing the original. */
export function looksLikeFormula(value: string): boolean {
  return /^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]*[=+\-@＝＋－＠]/u.test(value);
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function dateValue(raw: string, column: ColumnConfig): string {
  const match = DATE_PATTERNS[column.dateFormat].exec(raw);
  if (!match) throw new Error(`指定した入力書式 ${column.dateFormat} と一致しません。空白・時刻・年の省略は補完しません。`);
  const [first, second, third] = match.slice(1).map(Number);
  const [year, month, day] = column.dateFormat === 'MM/DD/YYYY' ? [third, first, second]
    : column.dateFormat === 'DD/MM/YYYY' ? [third, second, first] : [first, second, third];
  if (!validCalendarDate(year, month, day)) throw new Error('西暦1〜9999年の実在する日付ではありません。');
  const separator = column.dateOutput === 'YYYY-MM-DD' ? '-' : '/';
  return [String(year).padStart(4, '0'), String(month).padStart(2, '0'), String(day).padStart(2, '0')].join(separator);
}

function configurationProblem(column: ColumnConfig): string | undefined {
  if (column.kind === 'date' && (!Object.hasOwn(DATE_PATTERNS, column.dateFormat) || !['YYYY-MM-DD', 'YYYY/MM/DD'].includes(column.dateOutput))) return '日付の入力・出力書式を明示して選んでください。';
  if (column.kind === 'amount') {
    const format = column.amount;
    if (!format || !['', '¥', '円', '$', '€'].includes(format.symbol) || !['', ',', '.'].includes(format.grouping)
      || !['.', ','].includes(format.decimal) || !['minus', 'parentheses'].includes(format.negative)) return '金額の通貨記号・桁区切り・小数点・負数書式を明示して選んでください。';
    if (format.grouping === format.decimal) return '桁区切りと小数点に同じ記号は指定できません。';
  }
  return undefined;
}

/** Decimal strings, never floating-point numbers: even very long amounts stay exact. */
function amountValue(raw: string, column: ColumnConfig): string {
  const format = column.amount;
  let digits = raw;
  let negative = false;
  if (format.negative === 'minus' && digits.startsWith('-')) {
    negative = true;
    digits = digits.slice(1);
  } else if (format.negative === 'parentheses' && digits.startsWith('(') && digits.endsWith(')')) {
    negative = true;
    digits = digits.slice(1, -1);
  }
  if (format.symbol === '円') {
    if (!digits.endsWith('円')) throw new Error('指定した通貨記号「円」が末尾にありません。');
    digits = digits.slice(0, -1);
  } else if (format.symbol !== '') {
    if (!digits.startsWith(format.symbol)) throw new Error(`指定した通貨記号「${format.symbol}」が先頭にありません。`);
    digits = digits.slice(format.symbol.length);
  }
  const parts = digits.split(format.decimal);
  if (parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1]))) throw new Error('小数点または小数部が指定した金額書式と一致しません。');
  const integer = parts[0];
  if (format.grouping && integer.includes(format.grouping)) {
    const groups = integer.split(format.grouping);
    if (!/^\d{1,3}$/.test(groups[0]) || groups.slice(1).some(group => !/^\d{3}$/.test(group))) throw new Error('桁区切りは先頭1〜3桁、その後3桁ずつにしてください。');
  } else if (!/^\d+$/.test(integer)) {
    throw new Error('金額の整数部が指定書式と一致しません。空白・全角数字・演算式・別の負数記号は解釈しません。');
  }
  const ungrouped = format.grouping ? integer.split(format.grouping).join('') : integer;
  const normalized = ungrouped.replace(/^0+(?=\d)/, '');
  return (negative ? '-' : '') + normalized + (parts.length === 2 ? '.' + parts[1] : '');
}

function excelWarning(value: string, kind: ColumnConfig['kind']): string | undefined {
  if (kind === 'text') {
    const text = value.trim();
    if (/^0\d+$/.test(text) || /^\d{16,}$/.test(text)
      || /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+$/.test(text)
      || /^\d{1,4}[-/]\d{1,2}(?:[-/]\d{1,4})?$/.test(text)
      || /^\d{4}年\d{1,2}月\d{1,2}日$/.test(text)) {
      return 'Excelが番号・日付・指数表記へ自動変換する可能性があります。取り込む前にこの列を文字列型に指定してください。';
    }
  } else if (kind === 'amount' && value.replace(/[-.]/g, '').replace(/^0+/, '').replace(/0+$/, '').length > 15) {
    return 'Excelの数値は15桁を超える精度を保持できません。桁を残す場合は文字列型で取り込んでください。CSVの数字は丸めていません。';
  }
  return undefined;
}

function previewCell(raw: string, column: ColumnConfig): CellPreview {
  const cell: CellPreview = { raw, logical: raw, output: raw, kind: column.kind };
  const error = textProblem(raw) ?? configurationProblem(column) ?? (raw === '' && column.required ? '必須列が空欄です。元ページまたは必須の設定を確認してください。' : undefined);
  if (error) return { ...cell, error };
  if (raw !== '') {
    try {
      cell.logical = column.kind === 'date' ? dateValue(raw, column) : column.kind === 'amount' ? amountValue(raw, column) : raw;
    } catch (failure) {
      return { ...cell, error: failure instanceof Error ? failure.message : '値を指定書式で変換できません。' };
    }
  }
  cell.output = cell.logical;
  if (column.kind === 'text' && looksLikeFormula(cell.logical)) {
    cell.output = '\t' + cell.logical;
    cell.protection = PROTECTION_REASON;
  }
  const warning = excelWarning(cell.logical, column.kind);
  if (warning) cell.warning = warning;
  return cell;
}

/** Columns use original table indexes; captured row positions may be different. */
export function buildPreview(capture: Capture, columns: ColumnConfig[]): Preview {
  if (capture.layout !== undefined && capture.layout !== 'composite') throw new Error('取得結果の配置が不正です。元ページから再取得してください。');
  if (capture.layout === 'composite' && Array.isArray(columns) && columns.some(column => column && (column.kind !== 'text' || column.required))) throw new Error('複数の表や文章が混在する範囲は、文字列のまま、空欄を許可して出力してください。');
  if (capture.schemaVersion !== 1 || capture.scope !== 'current-page' || typeof capture.requestId !== 'string'
    || !Array.isArray(capture.headers) || capture.headers.length < 1 || capture.headers.length > LIMITS.columns
    || capture.headers.some(header => typeof header !== 'string' || header.length > LIMITS.cellChars)
    || !Array.isArray(capture.rows) || capture.rows.length > LIMITS.rows || !Array.isArray(capture.sourceIndexes)
    || capture.sourceIndexes.length < 1 || capture.sourceIndexes.length > capture.headers.length) throw new Error('取得結果の形式が不正です。元ページから再取得してください。');
  if (capture.sourceIndexes.some(index => !Number.isInteger(index) || index < 0 || index >= capture.headers.length)
    || new Set(capture.sourceIndexes).size !== capture.sourceIndexes.length) throw new Error('取得列の対応が不正です。元ページから再取得してください。');
  if (!Array.isArray(columns) || columns.length < 1 || columns.length > LIMITS.columns
    || columns.some(column => !column || !Number.isInteger(column.sourceIndex) || !capture.sourceIndexes.includes(column.sourceIndex)
      || typeof column.outputName !== 'string' || column.outputName.trim() === '' || column.outputName.length > 100
      || !['text', 'date', 'amount'].includes(column.kind) || typeof column.required !== 'boolean')
    || new Set(columns.map(column => column.sourceIndex)).size !== columns.length
    || new Set(columns.map(column => column.outputName)).size !== columns.length) throw new Error('取得列・出力列名・列の型を確認してください。取得列と出力列名の重複は使えません。');
  for (const row of capture.rows) {
    if (!Array.isArray(row) || row.length !== capture.sourceIndexes.length || row.some(value => typeof value !== 'string' || value.length > LIMITS.cellChars)) throw new Error('取得結果の行・列・値が不正です。元ページから再取得してください。');
  }
  if (countMatrixChars(capture.headers, capture.rows) > LIMITS.textChars) throw new Error('取得した文字数が処理上限を超えています。');
  const preview: Preview = { headers: [], rows: [], sourceCount: capture.rows.length, emptyCount: 0, errorCount: 0, protectionCount: 0, scope: capture.scope, requestId: capture.requestId };
  for (const column of columns) {
    const error = textProblem(column.outputName);
    if (error) preview.errorCount++;
    const protect = !error && looksLikeFormula(column.outputName);
    preview.headers.push((protect ? '\t' : '') + column.outputName);
    if (protect) preview.protectionCount++;
    if (capture.rows.length === 0 && configurationProblem(column)) preview.errorCount++;
  }
  const positions = columns.map(column => capture.sourceIndexes.indexOf(column.sourceIndex));
  preview.rows = capture.rows.map(row => columns.map((column, index) => {
    const cell = previewCell(row[positions[index]], column);
    if (cell.raw === '') preview.emptyCount++;
    if (cell.error) preview.errorCount++;
    if (cell.protection) preview.protectionCount++;
    return cell;
  }));
  if (countMatrixChars(columns.map(column => column.outputName), preview.rows.map(row => row.map(cell => cell.raw))) > LIMITS.textChars) throw new Error('出力する文字数が処理上限を超えています。列名を短くするか、出力する行または列を減らしてください。');
  return preview;
}
