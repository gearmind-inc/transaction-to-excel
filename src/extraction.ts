import type { InspectRequest, InspectResult, TableCandidate } from './contracts.js';

/** This function is serialized by chrome.scripting; every runtime dependency stays inside it. */
export function inspectPage(request: InspectRequest): InspectResult {
  const url = location.href;
  const requestId = request && typeof request.requestId === 'string' ? request.requestId : '';
  const result: InspectResult = { schemaVersion: 1, requestId, url };
  // Intentionally local: imported constants/closures do not survive Chrome's function injection.
  const fixedLimits = { rows: 5000, columns: 50, cellChars: 10000, textChars: 2_000_000, presets: 50 };
  function stop(message: string): never { throw new Error(message); }
  const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

  function readText(cell: Element): string {
    const pieces: string[] = [];
    let length = 0;
    function visit(node: Node): void {
      if (node.nodeType === 3) {
        const value = node.nodeValue ?? '';
        length += value.length;
        if (length > fixedLimits.cellChars) stop('1セルの文字数が安全上限（10,000文字）を超えています。取得を止めました。');
        pieces.push(value);
      } else if (node.nodeType === 1) {
        const tag = (node as Element).tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'template') return;
        if (tag === 'br') {
          length++;
          if (length > fixedLimits.cellChars) stop('1セルの文字数が安全上限（10,000文字）を超えています。取得を止めました。');
          pieces.push('\n');
          return;
        }
        for (const child of Array.from(node.childNodes)) visit(child);
      }
    }
    visit(cell);
    return pieces.join('');
  }

  function tableKey(table: HTMLTableElement): string {
    const id = table.getAttribute('id');
    if (id && id.length <= 197 && Array.from(document.querySelectorAll('[id]')).filter(element => element.getAttribute('id') === id).length === 1) return `id:${id}`;
    const path: string[] = [];
    for (let element: Element | null = table; element; element = element.parentElement) {
      const siblings = element.parentElement?.children;
      const position = siblings ? Array.from(siblings).indexOf(element) + 1 : 1;
      path.push(`${element.tagName.toLowerCase()}[${position}]`);
    }
    return `dom:${path.reverse().join('/')}`;
  }

  function describe(table: HTMLTableElement, index: number): TableCandidate {
    const candidate: TableCandidate = { index, key: tableKey(table), headers: [], rowCount: 0 };
    try {
      if (table.parentElement?.closest('table') || table.querySelector('table')) stop('入れ子の表には対応していません。別の通常HTML表を選んでください。');
      for (let element: Element | null = table; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (element.hasAttribute('hidden') || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden') stop('非表示の表は取得できません。表示された表を選んでください。');
      }
      if (table.querySelector('form, input, select, textarea, button')) stop('入力部品を含む表は取得しません。入力欄のない表を選んでください。');
      if (table.querySelector('[rowspan], [colspan]')) stop('結合セル（rowspan・colspan）のある表には対応していません。');
      const heads = table.querySelectorAll('thead');
      if (heads.length > 1 || (heads[0] && heads[0].querySelectorAll('tr').length !== 1)) stop('見出しは最初の1行だけの表に対応しています。');
      const rows = Array.from(table.rows);
      if (!rows.length) stop('見出し行がありません。見出し付きの表を選んでください。');
      const columnCount = rows[0].cells.length;
      if (!columnCount) stop('見出しに列がありません。');
      if (columnCount > fixedLimits.columns) stop('列数が安全上限（50列）を超えています。取得を止めました。');
      candidate.rowCount = rows.length - 1;
      if (candidate.rowCount > fixedLimits.rows) stop('データ行数が安全上限（5,000行）を超えています。取得を止めました。');
      if (rows.some(row => row.cells.length !== columnCount)) stop('行ごとの列数が一致しません。列がずれるため取得を止めました。');
      candidate.headers = Array.from(rows[0].cells, cell => readText(cell));
    } catch (error) {
      candidate.error = error instanceof Error ? error.message : '表の構造を確認できませんでした。';
    }
    return candidate;
  }

  try {
    const allowed = ['mode', 'expectedUrl', 'requestId', 'tableIndex', 'tableKey', 'headers', 'sourceIndexes', 'limits'];
    if (!isObject(request) || Object.keys(request).some(key => !allowed.includes(key))
      || !['list', 'highlight', 'capture'].includes(request.mode)
      || typeof request.expectedUrl !== 'string' || !request.expectedUrl
      || !requestId || requestId.length > 128
      || !isObject(request.limits)
      || Object.keys(request.limits).length !== Object.keys(fixedLimits).length
      || Object.entries(fixedLimits).some(([key, value]) => (request.limits as unknown as Record<string, unknown>)[key] !== value)) stop('取得の依頼形式が正しくありません。画面から選び直してください。');
    if (url !== request.expectedUrl) stop('対象ページが変わりました。本人がページとログイン状態を確認し、表を選び直してください。');
    if (request.tableIndex !== undefined && (!Number.isSafeInteger(request.tableIndex) || request.tableIndex < 0)) stop('表の選択が正しくありません。');
    if (request.tableKey !== undefined && (typeof request.tableKey !== 'string' || !request.tableKey || request.tableKey.length > 10000)) stop('表の識別情報が正しくありません。');
    if (request.headers !== undefined && (!Array.isArray(request.headers) || request.headers.length > fixedLimits.columns || request.headers.some(value => typeof value !== 'string' || value.length > fixedLimits.cellChars))) stop('見出しの確認情報が正しくありません。');
    if (request.sourceIndexes !== undefined && (!Array.isArray(request.sourceIndexes) || request.sourceIndexes.length > fixedLimits.columns || request.sourceIndexes.some(value => !Number.isSafeInteger(value) || value < 0) || new Set(request.sourceIndexes).size !== request.sourceIndexes.length)) stop('取得列の選択が正しくありません。');

    const tables = Array.from(document.querySelectorAll('table'));
    if (request.mode === 'list') {
      result.tables = tables.map((table, index) => describe(table, index));
      return result;
    }
    if (request.tableIndex === undefined || request.tableIndex >= tables.length || request.tableKey === undefined || !request.headers?.length) stop('選んだ表が見つかりません。本人がページとログイン状態を確認し、表を選び直してください。');
    const table = tables[request.tableIndex];
    const candidate = describe(table, request.tableIndex);
    if (candidate.error) stop(candidate.error);
    if (candidate.key !== request.tableKey) stop('表の位置または識別情報が変わりました。表を選び直してください。');
    if (candidate.headers.length !== request.headers.length || candidate.headers.some((header, index) => header !== request.headers![index])) stop('表の見出しが変わりました。列の設定を確認してから再取得してください。');

    if (request.mode === 'highlight') {
      const properties = ['outline', 'outline-offset'] as const;
      const previous = properties.map(property => ({ property, value: table.style.getPropertyValue(property), priority: table.style.getPropertyPriority(property) }));
      table.style.setProperty('outline', '3px solid #2563eb', 'important');
      table.style.setProperty('outline-offset', '3px', 'important');
      const applied = properties.map(property => table.style.getPropertyValue(property));
      window.setTimeout(() => {
        previous.forEach(({ property, value, priority }, index) => {
          // Do not overwrite styling changed by the page while the highlight was visible.
          if (table.style.getPropertyValue(property) !== applied[index] || table.style.getPropertyPriority(property) !== 'important') return;
          if (value) table.style.setProperty(property, value, priority); else table.style.removeProperty(property);
        });
      }, 1800);
      if (typeof table.scrollIntoView === 'function') table.scrollIntoView({ block: 'center', behavior: 'smooth' });
      result.tables = [candidate];
      return result;
    }
    if (!request.sourceIndexes?.length || request.sourceIndexes.some(index => index >= candidate.headers.length)) stop('取得する列を1つ以上、重複なく選んでください。');
    let textCount = 0;
    const rows = Array.from(table.rows).slice(1).map(row => request.sourceIndexes!.map(index => {
      const value = readText(row.cells[index]);
      textCount += value.length;
      if (textCount > fixedLimits.textChars) stop('取得文字数が安全上限（2,000,000文字）を超えています。取得を止めました。');
      return value;
    }));
    result.capture = { schemaVersion: 1, requestId, tableKey: candidate.key, headers: candidate.headers, sourceIndexes: [...request.sourceIndexes], rows, scope: 'current-page', capturedAt: new Date().toISOString() };
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : '取得に失敗しました。表を選び直してください。';
    return result;
  }
}
