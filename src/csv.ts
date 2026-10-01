import { LIMITS, type Preview } from './contracts.js';
import { looksLikeFormula, textProblem } from './transform.js';
import { countMatrixChars } from './text-budget.js';

function invalid(): never {
  throw new Error('プレビューに未解決エラー、保護不足、または不整合があります。設定を確認して再プレビューしてください。');
}

/** Serialize only the confirmed output values; never re-read settings or raw data. */
export function generateCsv(preview: Preview): Uint8Array {
  if (preview.scope !== 'current-page' || !Array.isArray(preview.headers) || preview.headers.length < 1
    || preview.headers.length > LIMITS.columns || !Array.isArray(preview.rows) || preview.rows.length > LIMITS.rows
    || preview.errorCount !== 0 || preview.sourceCount !== preview.rows.length
    || !Number.isSafeInteger(preview.emptyCount) || preview.emptyCount < 0
    || !Number.isSafeInteger(preview.protectionCount) || preview.protectionCount < 0) invalid();
  let emptyCount = 0;
  let protectionCount = 0;
  const logicalHeaders: string[] = [];
  for (const header of preview.headers) {
    if (typeof header !== 'string' || header.trim() === '' || header.length > 101 || textProblem(header)) invalid();
    if (looksLikeFormula(header)) {
      if (!header.startsWith('\t')) invalid();
      protectionCount++;
    }
    // Remove only the tab added by formula protection, retaining original tabs.
    logicalHeaders.push(looksLikeFormula(header) ? header.slice(1) : header);
  }
  for (const row of preview.rows) {
    if (!Array.isArray(row) || row.length !== preview.headers.length) invalid();
    for (const cell of row) {
      if (!cell || cell.error || typeof cell.raw !== 'string' || typeof cell.logical !== 'string' || typeof cell.output !== 'string'
        || cell.raw.length > LIMITS.cellChars || cell.logical.length > LIMITS.cellChars || cell.output.length > LIMITS.cellChars + 1
        || textProblem(cell.raw) || textProblem(cell.logical) || textProblem(cell.output)) invalid();
      if (cell.raw === '') emptyCount++;
      if (cell.kind === 'text') {
        if (cell.logical !== cell.raw) invalid();
        const protect = looksLikeFormula(cell.logical);
        if (cell.output !== (protect ? '\t' + cell.logical : cell.logical) || Boolean(cell.protection) !== protect) invalid();
        if (protect) protectionCount++;
      } else if (cell.kind === 'amount') {
        if (cell.output !== cell.logical || cell.protection || (cell.logical !== '' && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(cell.logical))) invalid();
      } else if (cell.kind === 'date') {
        if (cell.output !== cell.logical || cell.protection || (cell.logical !== '' && !/^\d{4}([-\/])\d{2}\1\d{2}$/.test(cell.logical))) invalid();
      } else invalid();
    }
  }
  if (countMatrixChars(logicalHeaders, preview.rows.map(row => row.map(cell => cell.raw))) > LIMITS.textChars || emptyCount !== preview.emptyCount || protectionCount !== preview.protectionCount) invalid();
  const quote = (value: string): string => '"' + value.replace(/"/g, '""') + '"';
  const records = [preview.headers, ...preview.rows.map(row => row.map(cell => cell.output))];
  return new TextEncoder().encode('\uFEFF' + records.map(record => record.map(quote).join(',') + '\r\n').join(''));
}
