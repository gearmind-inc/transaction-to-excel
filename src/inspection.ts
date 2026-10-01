import { LIMITS, type Capture, type InspectRequest, type InspectResult, type TableCandidate } from './contracts';
import type { PickerRequest, PickerResult } from './picker';

const validWarnings = (value: unknown): boolean => value === undefined || (Array.isArray(value) && value.length <= 50 && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 1000));
const validSignature = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;

/** A picker returns identifiers only; provenance comes from Chrome, never a page message. */
export function acceptPicked(results: chrome.scripting.InjectionResult<PickerResult>[], request: PickerRequest, expectedDocument: string): { data: PickerResult; documentId: string } {
  const result = results[0];
  if (results.length !== 1 || result?.frameId !== 0 || result.documentId !== expectedDocument) throw new Error('選択中に元のページが変わりました。範囲を選び直してください。');
  const data = result.result;
  if (!data || data.schemaVersion !== 1 || data.requestId !== request.requestId || data.url !== request.expectedUrl) throw new Error('選択結果の出所が一致しません。範囲を選び直してください。');
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : '範囲を選択できませんでした。');
  if (!['table', 'content'].includes(data.kind ?? '') || typeof data.key !== 'string' || !data.key || data.key.length > LIMITS.cellChars || !Number.isSafeInteger(data.index) || data.index! < 0 || (data.kind === 'content') !== data.key.startsWith('content:')) throw new Error('選択した範囲の識別情報が正しくありません。');
  return { data, documentId: expectedDocument };
}

// Browser-supplied provenance plus a strict data boundary; never trust page data as code.
export function acceptInspection(results: chrome.scripting.InjectionResult<InspectResult>[], request: InspectRequest, expectedDocument?: string): { data: InspectResult; documentId: string } {
  if (results.length !== 1) throw new Error('選択した文書だけを取得できませんでした。');
  const result = results[0];
  if (result.frameId !== 0 || typeof result.documentId !== 'string' || !result.documentId || (expectedDocument && result.documentId !== expectedDocument)) throw new Error('元のページが変わりました。表を選び直してください。');
  const data = result.result;
  if (!data || data.schemaVersion !== 1 || data.requestId !== request.requestId || data.url !== request.expectedUrl) throw new Error('取得結果の出所が一致しません。再取得してください。');
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : '取得に失敗しました。');
  const validText = (value: unknown) => typeof value === 'string' && value.length <= LIMITS.cellChars;
  const validHeaders = (headers: unknown): headers is string[] => Array.isArray(headers) && headers.length > 0 && headers.length <= LIMITS.columns && headers.every(validText);
  if (request.mode === 'list' || request.mode === 'describe' || request.mode === 'highlight') {
    if (!Array.isArray(data.tables) || data.tables.length > 1000) throw new Error('表候補が多すぎるか、取得結果が不正です。');
    for (const table of data.tables as TableCandidate[]) {
      if (!Number.isSafeInteger(table.index) || table.index < 0 || !validText(table.key) || (!table.error && !validHeaders(table.headers)) || !Number.isSafeInteger(table.rowCount) || table.rowCount < 0 || (table.error && typeof table.error !== 'string')) throw new Error('表の構造を確認できませんでした。');
      if (table.kind !== undefined && table.kind !== 'content' || !validWarnings(table.warnings) || table.label !== undefined && (typeof table.label !== 'string' || table.label.length > 100) || !table.error && table.rowCount > LIMITS.rows) throw new Error('範囲の構造を確認できませんでした。');
      if (table.kind === 'content' && (!table.key.startsWith('content:') || !table.error && (!validSignature(table.contentSignature) || JSON.stringify(table.headers) !== JSON.stringify(['タイトル', '内容'])))) throw new Error('本文の構造を確認できませんでした。');
    }
    if (request.mode !== 'list' && (data.tables.length !== 1 || data.tables[0].kind !== request.kind || request.tableKey && data.tables[0].key !== request.tableKey)) throw new Error('選択した範囲と取得結果が一致しません。');
  }
  if (request.mode === 'capture') {
    const capture = data.capture as Capture | undefined;
    if (!capture || capture.schemaVersion !== 1 || capture.requestId !== request.requestId || capture.scope !== 'current-page' || capture.tableKey !== request.tableKey || !validHeaders(capture.headers) || JSON.stringify(capture.headers) !== JSON.stringify(request.headers) || JSON.stringify(capture.sourceIndexes) !== JSON.stringify(request.sourceIndexes) || !Array.isArray(capture.rows) || capture.rows.length > LIMITS.rows || typeof capture.capturedAt !== 'string' || !Number.isFinite(Date.parse(capture.capturedAt))) throw new Error('取得の範囲・件数・列が一致しません。');
    let chars = 0;
    for (const row of capture.rows) {
      if (!Array.isArray(row) || row.length !== capture.sourceIndexes.length || !row.every(validText)) throw new Error('取得した行の構造が不正です。');
      for (const value of row) chars += value.length;
    }
    if (chars > LIMITS.textChars) throw new Error('取得文字数の上限を超えました。');
    if (!validWarnings(capture.warnings) || request.kind === 'content' && (!validSignature(capture.contentSignature) || capture.contentSignature !== request.contentSignature)) throw new Error('選択した本文の見出しか取得範囲が変わりました。範囲を選び直してください。');
  }
  return { data, documentId: result.documentId };
}
