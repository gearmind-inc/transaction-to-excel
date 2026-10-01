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

  function tableKey(table: Element): string {
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

  function resolveContentKey(key: string): Element | null {
    if (!key.startsWith('content:')) return null;
    const source = key.slice(8);
    if (source.startsWith('id:')) {
      const id = source.slice(3);
      const matches = Array.from(document.querySelectorAll('[id]')).filter(element => element.getAttribute('id') === id);
      return matches.length === 1 ? matches[0] : null;
    }
    if (!source.startsWith('dom:')) return null;
    const path = source.slice(4).split('/');
    let element: Element | null = document.documentElement;
    for (let index = 0; index < path.length; index++) {
      const part = /^([a-z][a-z0-9-]*)\[([1-9][0-9]*)\]$/.exec(path[index]);
      if (!part || !Number.isSafeInteger(Number(part[2]))) return null;
      if (index === 0) {
        if (Number(part[2]) !== 1) return null;
      } else element = element?.children.item(Number(part[2]) - 1) ?? null;
      if (!element || element.tagName.toLowerCase() !== part[1]) return null;
    }
    return element;
  }

  function highlight(element: Element): void {
    if (!(element instanceof HTMLElement)) return;
    const properties = ['outline', 'outline-offset'] as const;
    const previous = properties.map(property => ({ property, value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property) }));
    element.style.setProperty('outline', '3px solid #2563eb', 'important');
    element.style.setProperty('outline-offset', '3px', 'important');
    const applied = properties.map(property => element.style.getPropertyValue(property));
    window.setTimeout(() => {
      previous.forEach(({ property, value, priority }, index) => {
        // Do not overwrite styling changed by the page while the highlight was visible.
        if (element.style.getPropertyValue(property) !== applied[index] || element.style.getPropertyPriority(property) !== 'important') return;
        if (value) element.style.setProperty(property, value, priority); else element.style.removeProperty(property);
      });
    }, 1800);
    if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  type ContentSelection = { key: string; element: Element; contentSignature: string };
  const selectionWindow = window as unknown as {
    __transactionToExcelContentV1?: ContentSelection;
    __transactionToExcelPickedV1?: { requestId: string; key: string; element: Element };
  };

  /** Visible text becomes rows without reading form values, attributes, or page variables. */
  function readContent(root: Element): { rows: string[][]; warnings: string[]; contentSignature: string; label: string } {
    const rows: string[][] = [];
    const warnings = new Set<string>();
    const headings: { level: number; text: string }[] = [];
    const headingEvents: [number, string][] = [];
    const visibility = new WeakMap<Element, boolean>();
    const styles = new WeakMap<Element, CSSStyleDeclaration>();
    let content: string[] = [];
    let contentLength = 0;
    let total = 0;
    let sectionHasText = false;

    function styleOf(element: Element): CSSStyleDeclaration {
      let style = styles.get(element);
      if (!style) { style = getComputedStyle(element); styles.set(element, style); }
      return style;
    }

    function structurallyShown(element: Element): boolean {
      const cached = visibility.get(element);
      if (cached !== undefined) return cached;
      const parent = element.parentElement;
      const style = styleOf(element);
      let visible = !element.hasAttribute('hidden') && style.display !== 'none' && style.contentVisibility !== 'hidden' && style.opacity !== '0';
      if (visible && parent) {
        visible = structurallyShown(parent);
        if (visible && parent.tagName.toLowerCase() === 'details' && !parent.hasAttribute('open')) {
          const summary = Array.from(parent.children).find(child => child.tagName.toLowerCase() === 'summary');
          visible = element === summary;
        }
      }
      visibility.set(element, visible);
      return visible;
    }

    function shown(element: Element): boolean {
      const style = styleOf(element);
      return structurallyShown(element) && style.visibility !== 'hidden' && style.visibility !== 'collapse';
    }

    function svgTexts(element: Element): Element[] {
      return Array.from(element.querySelectorAll('text')).filter(text => !text.closest('defs, symbol, clipPath, mask, pattern') && shown(text));
    }

    const excluded = new Set(['script', 'style', 'template', 'noscript']);
    const formControls = new Set(['input', 'select', 'textarea']);
    const formWarning = '選択範囲に入力欄があります。input・select・textareaの値は取り込まず、表示ラベルだけを取り込みます。';
    function rendered(nodes: Node[], preserve = false): string {
      const pieces: string[] = [];
      const boundary = () => { if (pieces.length && !pieces[pieces.length - 1].endsWith('\n')) pieces.push('\n'); };
      function visit(node: Node, topLevel = false): void {
        if (node.nodeType === 3) {
          if (node.parentElement && !shown(node.parentElement)) return;
          pieces.push(preserve ? node.nodeValue ?? '' : (node.nodeValue ?? '').replace(/[ \t\r\n\f]+/g, ' '));
          return;
        }
        if (node.nodeType !== 1) return;
        const element = node as Element;
        const tag = element.tagName.toLowerCase();
        if (!structurallyShown(element) || excluded.has(tag)) return;
        if (formControls.has(tag)) { if (shown(element)) warnings.add(formWarning); return; }
        if (!shown(element)) { for (const child of Array.from(element.childNodes)) visit(child); return; }
        if (tag === 'br') { pieces.push('\n'); return; }
        if (tag === 'canvas' || tag === 'img' || tag === 'video' || tag === 'audio' || tag === 'object' || tag === 'embed') {
          warnings.add('画像・Canvasなどの図形や映像は文字へ変換していません。表示文字だけを取り込みます。');
          return;
        }
        if (tag === 'iframe' || tag === 'frame') {
          warnings.add('iframe（別の文書を表示する枠）の内側は、この取得結果に含まれません。');
          return;
        }
        if (tag === 'svg') {
          warnings.add('SVGグラフは表示文字だけを取り込みます。図形の座標から値や全データを推定していません。');
          pieces.push('\n');
          for (const text of svgTexts(element)) { visit(text); pieces.push('\n'); }
          return;
        }
        const display = styleOf(element).display;
        const block = !topLevel && /^(block|flex|grid|flow-root|list-item|table)(\b|$)/.test(display) && !display.startsWith('inline');
        if (block) boundary();
        for (const child of Array.from(element.childNodes)) visit(child);
        if (block) boundary();
      }
      nodes.forEach(node => visit(node, true));
      const joined = pieces.join('');
      return preserve ? joined : joined.replace(/ *\n */g, '\n').replace(/^[ \t\r\n\f]+|[ \t\r\n\f]+$/g, '');
    }

    function writeRow(title: string, text: string): void {
      if (title.length > fixedLimits.cellChars) stop('タイトルの文字数が安全上限（10,000文字）を超えています。取得を止めました。');
      rows.push([title, text]);
      if (rows.length > fixedLimits.rows) stop('データ行数が安全上限（5,000行）を超えています。取得を止めました。');
      total += title.length + text.length;
      if (total > fixedLimits.textChars) stop('取得文字数が安全上限（2,000,000文字）を超えています。取得を止めました。');
    }

    function flush(): void {
      if (!content.length) return;
      const title = headings.length ? headings.map(heading => heading.text).join(' / ') : '選択範囲';
      writeRow(title, content.join('\n'));
      content = [];
      contentLength = 0;
    }

    function append(text: string): void {
      if (!text || !text.trim()) return;
      if (text.length > fixedLimits.cellChars) stop('1つの段落・コードの文字数が安全上限（10,000文字）を超えています。範囲を狭めて選び直してください。');
      const separator = content.length ? 1 : 0;
      if (contentLength + separator + text.length > fixedLimits.cellChars) flush();
      contentLength += (content.length ? 1 : 0) + text.length;
      content.push(text);
      sectionHasText = true;
    }

    const containers = new Set(['html', 'body', 'main', 'article', 'section', 'div', 'header', 'footer', 'nav', 'aside', 'form', 'ul', 'ol', 'dl', 'li', 'dd', 'details', 'summary', 'figure', 'figcaption', 'blockquote']);
    const special = new Set(['p', 'pre', 'dt', 'table', 'svg', 'canvas', 'img', 'iframe', 'frame', 'video', 'audio', 'object', 'embed']);
    const headingSelector = 'h1,h2,h3,h4,h5,h6';
    function walkContainer(element: Element): void {
      let inline: Node[] = [];
      const flushInline = () => { append(rendered(inline)); inline = []; };
      for (const node of Array.from(element.childNodes)) {
        if (node.nodeType === 1) {
          const child = node as Element;
          const tag = child.tagName.toLowerCase();
          const display = styleOf(child).display;
          if (containers.has(tag) || special.has(tag) || /^h[1-6]$/.test(tag) || display === 'block' || display === 'flex' || display === 'grid' || child.querySelector(headingSelector)) {
            flushInline();
            walk(child);
            continue;
          }
        }
        inline.push(node);
      }
      flushInline();
    }

    function walk(element: Element): void {
      if (!structurallyShown(element)) return;
      const tag = element.tagName.toLowerCase();
      if (excluded.has(tag)) return;
      if (formControls.has(tag)) { if (shown(element)) warnings.add(formWarning); return; }
      if (!shown(element)) { walkContainer(element); return; }
      if (/^h[1-6]$/.test(tag)) {
        const text = rendered([element]);
        if (!text) return;
        if (text.length > fixedLimits.cellChars) stop('見出しの文字数が安全上限（10,000文字）を超えています。');
        flush();
        const level = Number(tag[1]);
        if (!sectionHasText && headings.length && level <= headings[headings.length - 1].level) writeRow(headings.map(heading => heading.text).join(' / '), '');
        while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
        headings.push({ level, text });
        headingEvents.push([level, text]);
        sectionHasText = false;
        return;
      }
      if (tag === 'table') {
        warnings.add('HTML表は表示された行の文字をタブで区切って取り込みます。結合セルの列配置は再現していません。');
        for (const row of Array.from(element.querySelectorAll('tr'))) {
          if (row.closest('table') !== element || !shown(row)) continue;
          const values = Array.from(row.children).filter(cell => ['td', 'th'].includes(cell.tagName.toLowerCase()) && shown(cell)).map(cell => rendered([cell]));
          if (values.length) append(values.join('\t'));
        }
        return;
      }
      if (tag === 'svg') {
        warnings.add('SVGグラフは表示文字だけを取り込みます。図形の座標から値や全データを推定していません。');
        for (const text of svgTexts(element)) append(rendered([text]));
        return;
      }
      if (tag === 'pre') { append(rendered([element], true)); return; }
      if (tag === 'p' && element.querySelector(headingSelector)) { walkContainer(element); return; }
      if (special.has(tag)) { append(rendered([element])); return; }
      if (element.shadowRoot) warnings.add('部品の内側（Shadow DOM）の表示は、この取得結果に含まれません。');
      walkContainer(element);
    }

    if (!structurallyShown(root)) stop('選択範囲が非表示になりました。表示されている範囲を選び直してください。');
    walk(root);
    flush();
    if (headings.length && !sectionHasText) writeRow(headings.map(heading => heading.text).join(' / '), '');
    if (!rows.length) stop('選択範囲には取得できる表示文字がありません。画像や図形だけの場合は文字のある範囲も選んでください。');
    // A small structural fingerprint catches changed headings while allowing refreshed values.
    let hash = 2166136261;
    for (const char of JSON.stringify(headingEvents)) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
    const contentSignature = `headings:${headingEvents.length}:${(hash >>> 0).toString(16)}`;
    return { rows, warnings: [...warnings], contentSignature, label: (headingEvents[0]?.[1] || '選択した範囲').slice(0, 100) };
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
      const spanningCells = table.querySelectorAll<HTMLTableCellElement>('th[rowspan], th[colspan], td[rowspan], td[colspan]');
      if (Array.from(spanningCells).some(cell => cell.rowSpan !== 1 || cell.colSpan !== 1)) stop('結合セル（rowspan・colspan）のある表には対応していません。');
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
    const allowed = ['mode', 'expectedUrl', 'requestId', 'tableIndex', 'tableKey', 'headers', 'sourceIndexes', 'limits', 'kind', 'contentSignature'];
    if (!isObject(request) || Object.keys(request).some(key => !allowed.includes(key))
      || !['list', 'describe', 'highlight', 'capture'].includes(request.mode)
      || (request.kind !== undefined && request.kind !== 'content')
      || (request.mode === 'list' && request.kind !== undefined)
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
    if (request.contentSignature !== undefined && (typeof request.contentSignature !== 'string' || !request.contentSignature || request.contentSignature.length > 128)) stop('選択範囲の見出し情報が正しくありません。');

    if (request.kind === 'content') {
      const root = request.tableKey ? resolveContentKey(request.tableKey) : request.mode === 'describe' ? document.body : null;
      if (!root) stop('選んだ範囲が見つかりません。ページ上で範囲を選び直してください。');
      const key = `content:${tableKey(root)}`;
      if (request.tableKey && request.tableKey !== key) stop('選んだ範囲の位置が変わりました。範囲を選び直してください。');
      const picked = selectionWindow.__transactionToExcelPickedV1;
      if (picked && (picked.key === key || picked.key === key.slice(8)) && picked.element !== root) stop('選んだ範囲が差し替わりました。範囲を選び直してください。');
      if (request.mode !== 'describe') {
        const selected = selectionWindow.__transactionToExcelContentV1;
        if (!selected || selected.key !== key || selected.element !== root || !selected.element.isConnected) stop('選んだ範囲が変わりました。範囲を選び直してください。');
        if (request.tableIndex !== undefined && request.tableIndex !== 0) stop('範囲の選択が正しくありません。');
        if (JSON.stringify(request.headers) !== JSON.stringify(['タイトル', '内容'])) stop('出力する見出しが変わりました。範囲を選び直してください。');
        if (!request.contentSignature || request.contentSignature !== selected.contentSignature) stop('範囲の見出し情報が変わりました。範囲を選び直してください。');
      }
      const documentText = readContent(root);
      const candidate: TableCandidate = { index: 0, key, headers: ['タイトル', '内容'], rowCount: documentText.rows.length, kind: 'content', label: documentText.label, contentSignature: documentText.contentSignature, ...(documentText.warnings.length ? { warnings: documentText.warnings } : {}) };
      if (request.mode === 'describe') {
        selectionWindow.__transactionToExcelContentV1 = { key, element: root, contentSignature: documentText.contentSignature };
        result.tables = [candidate];
        return result;
      }
      if (request.contentSignature !== documentText.contentSignature) stop('選んだ範囲の見出し構成が変わりました。範囲を選び直してください。');
      if (request.mode === 'highlight') {
        highlight(root);
        result.tables = [candidate];
        return result;
      }
      if (!request.sourceIndexes?.length || request.sourceIndexes.some(index => index >= 2)) stop('取得する列を1つ以上、重複なく選んでください。');
      const rows = documentText.rows.map(row => request.sourceIndexes!.map(index => row[index]));
      result.capture = { schemaVersion: 1, requestId, tableKey: key, headers: candidate.headers, sourceIndexes: [...request.sourceIndexes], rows, scope: 'current-page', capturedAt: new Date().toISOString(), contentSignature: documentText.contentSignature, ...(documentText.warnings.length ? { warnings: documentText.warnings } : {}) };
      return result;
    }

    const tables = Array.from(document.querySelectorAll('table'));
    if (request.mode === 'list') {
      result.tables = tables.map((table, index) => describe(table, index));
      return result;
    }
    if (request.tableIndex === undefined || request.tableIndex >= tables.length || request.tableKey === undefined || (request.mode !== 'describe' && !request.headers?.length)) stop('選んだ表が見つかりません。本人がページとログイン状態を確認し、表を選び直してください。');
    const table = tables[request.tableIndex];
    const picked = selectionWindow.__transactionToExcelPickedV1;
    if (picked?.key === request.tableKey && picked.element !== table) stop('選んだ表が差し替わりました。表を選び直してください。');
    const candidate = describe(table, request.tableIndex);
    if (candidate.key !== request.tableKey) stop('表の位置または識別情報が変わりました。表を選び直してください。');
    if (request.mode === 'describe') {
      result.tables = [candidate];
      return result;
    }
    if (candidate.error) stop(candidate.error);
    const expectedHeaders = request.headers;
    if (!expectedHeaders?.length || candidate.headers.length !== expectedHeaders.length || candidate.headers.some((header, index) => header !== expectedHeaders[index])) stop('表の見出しが変わりました。列の設定を確認してから再取得してください。');

    if (request.mode === 'highlight') {
      highlight(table);
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
