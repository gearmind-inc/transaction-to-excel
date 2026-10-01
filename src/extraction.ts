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
  const visibility = new WeakMap<Element, boolean>();
  const styles = new WeakMap<Element, CSSStyleDeclaration>();

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

  function readText(cell: Element): string {
    const pieces: string[] = [];
    let length = 0;
    function visit(node: Node): void {
      if (node.nodeType === 3) {
        if (node.parentElement && !shown(node.parentElement)) return;
        const value = node.nodeValue ?? '';
        length += value.length;
        if (length > fixedLimits.cellChars) stop('1セルの文字数が安全上限（10,000文字）を超えています。取得を止めました。');
        pieces.push(value);
      } else if (node.nodeType === 1) {
        const element = node as Element;
        const tag = element.tagName.toLowerCase();
        if (!structurallyShown(element) || ['script', 'style', 'template', 'noscript', 'input', 'select', 'textarea'].includes(tag)) return;
        if (tag === 'br') {
          if (!shown(element)) return;
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

  type Grid = { headers: string[]; rows: (Element | null)[][]; headerShape: number[][]; mergedData: boolean };
  /** Cell slots come from explicit HTML/ARIA spans, never from the displayed values. */
  function tableGrid(root: Element, text: (element: Element) => string, visible: (element: Element) => boolean = () => true, ordinary = false): Grid {
    const htmlTable = root.tagName.toLowerCase() === 'table';
    const role = (element: Element) => element.getAttribute('role');
    const htmlCells = htmlTable || root.tagName.toLowerCase() === 'tr';
    const partialRow = root.tagName.toLowerCase() === 'tr' || role(root) === 'row';
    const sourceRows = htmlTable ? Array.from((root as HTMLTableElement).rows)
      : partialRow ? [root] : Array.from(root.querySelectorAll('[role="row"]')).filter(row => row.closest('[role="table"], [role="grid"], [role="treegrid"]') === root);
    if (sourceRows.length > fixedLimits.rows + 50) stop('データ行数が安全上限（5,000行）を超えています。取得を止めました。');
    const cellsFor = (row: Element) => Array.from(row.children).filter(cell => htmlCells ? ['td', 'th'].includes(cell.tagName.toLowerCase()) : ['cell', 'gridcell', 'columnheader', 'rowheader'].includes(role(cell) ?? ''));
    let headerCount = 0;
    if (!partialRow) {
      if (htmlTable && root.querySelector('thead')) {
        if (root.querySelectorAll(':scope > thead').length > 1) stop('見出しのまとまりが複数あり、表の列を確定できません。');
        headerCount = sourceRows.filter(row => row.parentElement?.tagName.toLowerCase() === 'thead').length;
      } else {
        for (const row of sourceRows) {
          const cells = cellsFor(row);
          if (!cells.length || !cells.every(cell => htmlTable ? cell.tagName.toLowerCase() === 'th' && !['row', 'rowgroup'].includes(cell.getAttribute('scope') ?? '') : role(cell) === 'columnheader')) break;
          headerCount++;
        }
        if (!headerCount && ordinary && sourceRows.length) headerCount = 1;
      }
    }
    if (headerCount > 50) stop('見出し行が多すぎるため、表の列を確定できません。');
    const slots: (Element | null | undefined)[][] = sourceRows.map(() => []);
    const headerOwners: (Element | undefined)[][] = sourceRows.slice(0, headerCount).map(() => []);
    const groupEnds = new Map<Element | null, number>();
    sourceRows.forEach((row, index) => groupEnds.set(row.parentElement, index + 1));
    let width = 0;
    let mergedData = false;
    const headerShape: number[][] = [];
    for (let y = 0; y < sourceRows.length; y++) {
      const row = sourceRows[y];
      let x = 0;
      const groupEnd = partialRow ? y + 1 : groupEnds.get(row.parentElement)!;
      for (const cell of cellsFor(row)) {
        const span = (attribute: string, fallback: number): number => {
          const value = cell.getAttribute(attribute);
          return value === null ? fallback : /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : stop('表の結合セルの指定が正しくありません。');
        };
        if (!htmlCells && cell.hasAttribute('aria-colindex')) {
          const column = span('aria-colindex', 1);
          if (column < 1 || column > fixedLimits.columns) stop('ARIA表の列位置が不正か、安全上限（50列）を超えています。');
          x = column - 1;
        } else while (slots[y][x] !== undefined) x++;
        const colSpan = htmlCells ? (cell as HTMLTableCellElement).colSpan : span('aria-colspan', 1);
        const statedRowSpan = htmlCells ? (cell as HTMLTableCellElement).rowSpan : span('aria-rowspan', 1);
        const rowSpan = partialRow ? 1 : statedRowSpan === 0 ? groupEnd - y : statedRowSpan;
        if (colSpan < 1 || rowSpan < 1 || x + colSpan > fixedLimits.columns) stop('列数が安全上限（50列）を超えているか、結合セルの指定が不正です。');
        if (y + rowSpan > groupEnd) stop('結合セルが行のまとまりを越えるため、表の列を確定できません。');
        if (y < headerCount) headerShape.push([y, x, rowSpan, colSpan]);
        else if (rowSpan > 1 || colSpan > 1) mergedData = true;
        for (let dy = 0; dy < rowSpan; dy++) for (let dx = 0; dx < colSpan; dx++) {
          if (slots[y + dy][x + dx] !== undefined) stop('結合セルが重なっているため、表の列を確定できません。');
          slots[y + dy][x + dx] = dy === 0 && dx === 0 ? cell : null;
          if (y + dy < headerCount) headerOwners[y + dy][x + dx] = cell;
        }
        width = Math.max(width, x + colSpan);
        x += colSpan;
      }
    }
    if (!width) stop('表に取得できる列がありません。');
    if (ordinary && slots.some(row => row.length !== width || Array.from({ length: width }, (_, index) => row[index]).some(cell => cell === undefined))) stop('行ごとの列数が一致しません。列がずれるため取得を止めました。');
    const headers = Array.from({ length: width }, (_, x) => {
      const ancestors: Element[] = [];
      for (let y = 0; y < headerCount; y++) {
        if (!visible(sourceRows[y])) continue;
        const cell = headerOwners[y][x];
        if (cell && visible(cell) && !ancestors.includes(cell)) ancestors.push(cell);
      }
      const labels = ancestors.map(text);
      const name = ordinary && headerCount === 1 ? labels[0] ?? '' : labels.filter(value => value.trim() !== '').join(' / ') || `列${x + 1}`;
      if (name.length > fixedLimits.cellChars) stop('見出しの文字数が安全上限（10,000文字）を超えています。');
      return name;
    });
    const rows = slots.slice(headerCount).filter((_, index) => visible(sourceRows[index + headerCount])).map(row => Array.from({ length: width }, (_, x) => row[x] ?? null));
    if (rows.length > fixedLimits.rows) stop('データ行数が安全上限（5,000行）を超えています。取得を止めました。');
    return { headers, rows, headerShape, mergedData };
  }

  /** Visible text becomes rows without reading form values, attributes, or page variables. */
  function readContent(root: Element): { headers: string[]; rows: string[][]; warnings: string[]; contentSignature: string; label: string; layout?: 'composite' } {
    type Block = { kind: 'prose' | 'table' | 'records'; key: string; headers: string[]; rows: string[][]; shape?: number[][] };
    const blocks: Block[] = [];
    const warnings = new Set<string>();
    const headings: { level: number; text: string }[] = [];
    const headingEvents: [number, string][] = [];
    let sectionHasText = false;
    let accumulatedRows = 0;
    let accumulatedChars = 0;
    let compositeRows = false;

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

    function countRow(row: string[]): void {
      accumulatedRows++;
      if (accumulatedRows > fixedLimits.rows) stop('データ行数が安全上限（5,000行）を超えています。取得を止めました。');
      for (const cell of row) {
        if (cell.length > fixedLimits.cellChars) stop('1つの段落・コード・セルの文字数が安全上限（10,000文字）を超えています。範囲を狭めて選び直してください。');
        accumulatedChars += cell.length;
        if (accumulatedChars > fixedLimits.textChars) stop('取得文字数が安全上限（2,000,000文字）を超えています。取得を止めました。');
      }
    }

    function addBlock(block: Block): void {
      if (block.headers.length > fixedLimits.columns) stop('列数が安全上限（50列）を超えています。取得を止めました。');
      if (blocks.length === 1 && !compositeRows) {
        compositeRows = true;
        if (blocks[0].kind !== 'prose') countRow(blocks[0].headers);
      }
      if (compositeRows && block.kind !== 'prose') countRow(block.headers);
      blocks.push(block);
    }

    function addRow(block: Block, row: string[]): void { countRow(row); block.rows.push(row); }

    function writeRow(title: string, text: string): void {
      if (title.length > fixedLimits.cellChars) stop('タイトルの文字数が安全上限（10,000文字）を超えています。取得を止めました。');
      let block = blocks[blocks.length - 1];
      if (!block || block.kind !== 'prose') {
        block = { kind: 'prose', key: tableKey(root), headers: ['タイトル', '内容'], rows: [] };
        addBlock(block);
      }
      addRow(block, [title, text]);
    }

    function flush(): void {
      if (headings.length && !sectionHasText) {
        writeRow(headings.map(heading => heading.text).join(' / '), '');
        sectionHasText = true;
      }
    }

    function append(text: string): void {
      if (!text || !text.trim()) return;
      if (text.length > fixedLimits.cellChars) stop('1つの段落・コードの文字数が安全上限（10,000文字）を超えています。範囲を狭めて選び直してください。');
      writeRow(headings.length ? headings.map(heading => heading.text).join(' / ') : '選択範囲', text);
      sectionHasText = true;
    }

    function addGrid(element: Element): void {
      const grid = tableGrid(element, cell => rendered([cell]), shown);
      const caption = Array.from(element.children).find(child => child.tagName.toLowerCase() === 'caption' && shown(child));
      if (caption) append(rendered([caption]));
      flush();
      if (grid.mergedData) warnings.add('結合セルは左上の値を取り込み、続きのセルは空欄にしています。値を反復していません。');
      const block: Block = { kind: 'table', key: tableKey(element), headers: grid.headers, rows: [], shape: grid.headerShape };
      addBlock(block);
      for (const row of grid.rows) addRow(block, row.map(cell => cell ? rendered([cell]) : ''));
      sectionHasText = true;
    }

    function definition(element: Element, labelsOnly = false): Map<string, string> | null {
      const values = new Map<string, string>();
      let key = '';
      for (const child of Array.from(element.children)) {
        if (!shown(child)) continue;
        const tag = child.tagName.toLowerCase();
        if (tag === 'dt') {
          key = rendered([child]);
          if (!key || values.has(key)) return null;
          values.set(key, '');
          if (values.size > fixedLimits.rows) stop('データ行数が安全上限（5,000行）を超えています。取得を止めました。');
        } else if (tag === 'dd' && key) { if (!labelsOnly) values.set(key, [values.get(key), rendered([child])].filter(Boolean).join('\n')); }
        else return null;
      }
      return values.size ? values : null;
    }

    function repeated(element: Element, selected?: Element[]): boolean {
      // Direct text belongs to the surrounding prose. Only complete sibling runs may form records.
      if (!selected && Array.from(element.childNodes).some(node => node.nodeType === 3)) return false;
      const children = (selected ?? Array.from(element.children)).filter(shown);
      if (children.length < 2 || !children.every(child => child.tagName === children[0].tagName)) return false;
      const definitions = children.map(child => child.tagName.toLowerCase() === 'dl' ? child : child.querySelector('dl'));
      if (definitions.every((dl): dl is Element => Boolean(dl))) {
        if (children.length + accumulatedRows + (blocks.length ? 1 : 0) > fixedLimits.rows) stop('データ行数が安全上限（5,000行）を超えています。取得を止めました。');
        if (children.some((child, index) => child !== definitions[index] && rendered(Array.from(child.childNodes).filter(node => node !== definitions[index])).trim())) return false;
        const records = definitions.map(dl => definition(dl, true));
        if (records.every((record): record is Map<string, string> => Boolean(record))) {
          const headers = [...new Set(records.flatMap(record => [...record.keys()]))];
          flush();
          const block: Block = { kind: 'records', key: tableKey(element), headers, rows: [] };
          addBlock(block);
          for (const dl of definitions) {
            const record = definition(dl)!;
            addRow(block, headers.map(header => record.get(header) ?? ''));
          }
          sectionHasText = true;
          return true;
        }
      }
      if (children.some(child => child.querySelector('h1,h2,h3,h4,h5,h6,table,dl,[role="table"],[role="grid"]') || rendered(Array.from(child.childNodes).filter(node => node.nodeType === 3)).trim())) return false;
      const cells = children.map(child => Array.from(child.children).filter(shown));
      if (cells[0].length < 2 || cells.some(row => row.length !== cells[0].length || row.some((cell, index) => cell.tagName !== cells[0][index].tagName))) return false;
      flush();
      const block: Block = { kind: 'records', key: tableKey(element), headers: cells[0].map((_, index) => `列${index + 1}`), rows: [] };
      addBlock(block);
      for (const row of cells) addRow(block, row.map(cell => rendered([cell])));
      warnings.add('繰り返し部品の位置から列を作りました。列名の意味は推定していません。');
      sectionHasText = true;
      return true;
    }

    const containers = new Set(['html', 'body', 'main', 'article', 'section', 'div', 'header', 'footer', 'nav', 'aside', 'form', 'ul', 'ol', 'dl', 'li', 'dd', 'details', 'summary', 'figure', 'figcaption', 'blockquote']);
    const special = new Set(['p', 'pre', 'dt', 'table', 'svg', 'canvas', 'img', 'iframe', 'frame', 'video', 'audio', 'object', 'embed']);
    const headingSelector = 'h1,h2,h3,h4,h5,h6';
    const structuralSelector = `${headingSelector},table,tr,dl,[role="table"],[role="grid"],[role="treegrid"],[role="row"]`;
    function walkContainer(element: Element): void {
      let inline: Node[] = [];
      const flushInline = () => { append(rendered(inline)); inline = []; };
      const nodes = Array.from(element.childNodes);
      for (let position = 0; position < nodes.length; position++) {
        const node = nodes[position];
        if (node.nodeType === 1) {
          const child = node as Element;
          const tag = child.tagName.toLowerCase();
          if (['div', 'section', 'article', 'li', 'dl'].includes(tag)) {
            const run = [child];
            let last = position;
            for (let next = position + 1; next < nodes.length; next++) {
              const sibling = nodes[next];
              if (sibling.nodeType === 3 && !(sibling.nodeValue ?? '').trim()) continue;
              if (sibling.nodeType !== 1 || (sibling as Element).tagName !== child.tagName) break;
              run.push(sibling as Element);
              last = next;
            }
            if (run.length > 1) {
              flushInline();
              if (repeated(element, run)) { position = last; continue; }
            }
          }
          const display = styleOf(child).display;
          if (containers.has(tag) || special.has(tag) || /^h[1-6]$/.test(tag) || display === 'block' || display === 'flex' || display === 'grid' || child.matches(structuralSelector) || child.querySelector(structuralSelector)) {
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
        const level = Number(tag[1]);
        if (!sectionHasText && headings.length && level <= headings[headings.length - 1].level) flush();
        while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
        headings.push({ level, text });
        headingEvents.push([level, text]);
        sectionHasText = false;
        return;
      }
      if (tag === 'table' || tag === 'tr' || ['table', 'grid', 'treegrid', 'row'].includes(element.getAttribute('role') ?? '')) {
        if (tag === 'table' && element.querySelector('table')) {
          warnings.add('入れ子の外側の列配置は確定せず、セルごとの文字と内側の表を順番に取り込みます。');
          for (const caption of Array.from(element.children).filter(child => child.tagName.toLowerCase() === 'caption' && shown(child))) append(rendered([caption]));
          for (const row of Array.from(element.querySelectorAll('tr'))) {
            if (row.closest('table') !== element || !shown(row)) continue;
            for (const cell of Array.from(row.children).filter(child => ['td', 'th'].includes(child.tagName.toLowerCase()) && shown(child))) walkContainer(cell);
          }
        } else addGrid(element);
        return;
      }
      if (tag === 'svg') {
        warnings.add('SVGグラフは表示文字だけを取り込みます。図形の座標から値や全データを推定していません。');
        for (const text of svgTexts(element)) append(rendered([text]));
        return;
      }
      if (tag === 'pre') { append(rendered([element], true)); return; }
      if (tag === 'p' && element.querySelector(structuralSelector)) { walkContainer(element); return; }
      if (special.has(tag)) { append(rendered([element])); return; }
      if (tag === 'dl') {
        const values = definition(element);
        if (values) {
          flush();
          const block: Block = { kind: 'records', key: tableKey(element), headers: ['項目', '内容'], rows: [] };
          addBlock(block);
          for (const row of values) addRow(block, row);
          sectionHasText = true;
          return;
        }
      }
      if (element.shadowRoot) warnings.add('部品の内側（Shadow DOM）の表示は、この取得結果に含まれません。');
      if (repeated(element)) return;
      walkContainer(element);
    }

    if (!structurallyShown(root)) stop('選択範囲が非表示になりました。表示されている範囲を選び直してください。');
    walk(root);
    flush();
    if (!blocks.length) stop('選択範囲には取得できる表示文字がありません。画像や図形だけの場合は文字のある範囲も選んでください。');
    const composite = blocks.length > 1;
    const width = blocks.reduce((maximum, block) => Math.max(maximum, block.headers.length), 0);
    if (width > fixedLimits.columns) stop('列数が安全上限（50列）を超えています。取得を止めました。');
    const headers = composite ? Array.from({ length: width }, (_, index) => `列${index + 1}`) : blocks[0].headers;
    const rows = blocks.flatMap(block => composite && block.kind !== 'prose' ? [block.headers, ...block.rows] : block.rows).map(row => [...row, ...Array(width - row.length).fill('')]);
    if (rows.length > fixedLimits.rows) stop('データ行数が安全上限（5,000行）を超えています。取得を止めました。');
    let total = 0;
    for (const row of [headers, ...rows]) for (const cell of row) {
      if (cell.length > fixedLimits.cellChars) stop('1つの段落・コード・セルの文字数が安全上限（10,000文字）を超えています。範囲を狭めて選び直してください。');
      total += cell.length;
      if (total > fixedLimits.textChars) stop('取得文字数が安全上限（2,000,000文字）を超えています。取得を止めました。');
    }
    // A small structural fingerprint catches changed headings while allowing refreshed values.
    let hash = 2166136261;
    for (const char of JSON.stringify([headingEvents, blocks.map(block => [block.kind, block.key, block.headers, block.shape ?? []])])) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
    const contentSignature = `structure:${(hash >>> 0).toString(16)}`;
    return { headers, rows, warnings: [...warnings], contentSignature, label: (headingEvents[0]?.[1] || '選択した範囲').slice(0, 100), ...(composite ? { layout: 'composite' as const } : {}) };
  }

  function describe(table: HTMLTableElement, index: number): TableCandidate {
    const candidate: TableCandidate = { index, key: tableKey(table), headers: [], rowCount: 0 };
    try {
      if (table.parentElement?.closest('table') || table.querySelector('table')) stop('入れ子の表には対応していません。別の通常HTML表を選んでください。');
      if (!shown(table)) stop('非表示の表は取得できません。表示された表を選んでください。');
      if (table.querySelector('form, input, select, textarea, button')) stop('入力部品を含む表は取得しません。入力欄のない表を選んでください。');
      if (!table.rows.length) stop('見出し行がありません。見出し付きの表を選んでください。');
      const grid = tableGrid(table, readText, shown, true);
      candidate.rowCount = grid.rows.length;
      candidate.headers = grid.headers;
      if (grid.mergedData) candidate.warnings = ['結合セルは左上の値を取り込み、続きのセルは空欄にしています。値を反復していません。'];
    } catch (error) {
      candidate.error = error instanceof Error ? error.message : '表の構造を確認できませんでした。';
    }
    return candidate;
  }

  try {
    const allowed = ['mode', 'expectedUrl', 'requestId', 'tableIndex', 'tableKey', 'headers', 'sourceIndexes', 'limits', 'kind', 'contentSignature', 'layout'];
    if (!isObject(request) || Object.keys(request).some(key => !allowed.includes(key))
      || !['list', 'describe', 'highlight', 'capture'].includes(request.mode)
      || (request.kind !== undefined && request.kind !== 'content')
      || (request.layout !== undefined && (request.layout !== 'composite' || request.kind !== 'content'))
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
    if (request.contentSignature !== undefined && (typeof request.contentSignature !== 'string' || !request.contentSignature || request.contentSignature.length > 128 || /[^A-Za-z0-9:_-]/.test(request.contentSignature))) stop('選択範囲の見出し情報が正しくありません。');

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
        if (!request.contentSignature || request.contentSignature !== selected.contentSignature) stop('範囲の見出し情報が変わりました。範囲を選び直してください。');
      }
      const documentText = readContent(root);
      const candidate: TableCandidate = { index: 0, key, headers: documentText.headers, rowCount: documentText.rows.length, kind: 'content', label: documentText.label, contentSignature: documentText.contentSignature, ...(documentText.layout ? { layout: documentText.layout } : {}), ...(documentText.warnings.length ? { warnings: documentText.warnings } : {}) };
      if (request.mode === 'describe') {
        selectionWindow.__transactionToExcelContentV1 = { key, element: root, contentSignature: documentText.contentSignature };
        result.tables = [candidate];
        return result;
      }
      if (request.contentSignature !== documentText.contentSignature) stop('選んだ範囲の見出し構成が変わりました。範囲を選び直してください。');
      if (JSON.stringify(request.headers) !== JSON.stringify(documentText.headers) || request.layout !== documentText.layout) stop('出力する列構成が変わりました。範囲を選び直してください。');
      if (request.mode === 'highlight') {
        highlight(root);
        result.tables = [candidate];
        return result;
      }
      if (!request.sourceIndexes?.length || request.sourceIndexes.some(index => index >= candidate.headers.length)) stop('取得する列を1つ以上、重複なく選んでください。');
      const rows = documentText.rows.map(row => request.sourceIndexes!.map(index => row[index]));
      result.capture = { schemaVersion: 1, requestId, tableKey: key, headers: candidate.headers, sourceIndexes: [...request.sourceIndexes], rows, scope: 'current-page', capturedAt: new Date().toISOString(), contentSignature: documentText.contentSignature, ...(documentText.layout ? { layout: documentText.layout } : {}), ...(documentText.warnings.length ? { warnings: documentText.warnings } : {}) };
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
    const grid = tableGrid(table, readText, shown, true);
    const rows = grid.rows.map(row => request.sourceIndexes!.map(index => {
      const value = row[index] ? readText(row[index]!) : '';
      textCount += value.length;
      if (textCount > fixedLimits.textChars) stop('取得文字数が安全上限（2,000,000文字）を超えています。取得を止めました。');
      return value;
    }));
    result.capture = { schemaVersion: 1, requestId, tableKey: candidate.key, headers: candidate.headers, sourceIndexes: [...request.sourceIndexes], rows, scope: 'current-page', capturedAt: new Date().toISOString(), ...(candidate.warnings ? { warnings: candidate.warnings } : {}) };
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : '取得に失敗しました。表を選び直してください。';
    return result;
  }
}
