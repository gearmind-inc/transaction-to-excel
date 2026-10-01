export type PickerRequest = { requestId: string; expectedUrl: string; kind?: 'content' };
export type PickerResult = { schemaVersion: 1; requestId: string; url: string; kind?: 'table' | 'content'; key?: string; index?: number; error?: string };

/** Serialized by Chrome: runtime dependencies deliberately stay inside this function. */
export async function pickRegion(request: PickerRequest): Promise<PickerResult> {
  const requestId = request && typeof request.requestId === 'string' ? request.requestId : '';
  const result = (): PickerResult => ({ schemaVersion: 1, requestId, url: location.href });
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => !['requestId', 'expectedUrl', 'kind'].includes(key))
    || !requestId || requestId.length > 128 || typeof request.expectedUrl !== 'string'
    || request.expectedUrl !== location.href || (request.kind !== undefined && request.kind !== 'content')) {
    return { ...result(), error: '対象ページまたは範囲選択の依頼が変わりました。元のページで選び直してください。' };
  }
  const scope = window as Window & {
    __transactionToExcelPickerV1?: { requestId: string; cancel(): void };
    __transactionToExcelPickedV1?: { requestId: string; key: string; element: Element };
  };
  scope.__transactionToExcelPickerV1?.cancel();
  delete scope.__transactionToExcelPickedV1;

  // Use the same identity format as extraction. A resolved node is also kept
  // below so an identical replacement cannot stand in for the chosen region.
  function keyFor(element: Element, kind: 'table' | 'content'): string {
    const id = element.getAttribute('id');
    let key: string;
    if (id && id.length <= 197 && Array.from(document.querySelectorAll('[id]')).filter(node => node.getAttribute('id') === id).length === 1) {
      key = `id:${id}`;
    } else {
      const path: string[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const siblings = node.parentElement?.children;
        const position = siblings ? Array.from(siblings).indexOf(node) + 1 : 1;
        path.push(`${node.tagName.toLowerCase()}[${position}]`);
      }
      key = `dom:${path.reverse().join('/')}`;
    }
    return kind === 'content' ? `content:${key}` : key;
  }
  function visible(element: Element): boolean {
    if (!element.isConnected || element.closest('[data-transaction-to-excel-picker]')) return false;
    // visibility is inherited but a descendant can explicitly restore it.
    // Other rendering blockers still apply through the whole ancestor chain.
    const visibility = getComputedStyle(element).visibility;
    if (visibility === 'hidden' || visibility === 'collapse') return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hasAttribute('hidden') || style.display === 'none' || style.contentVisibility === 'hidden' || style.opacity === '0') return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function fromTarget(target: EventTarget | null): Element | undefined {
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    if (!element || !visible(element)) return undefined;
    return request.kind === 'content' ? element : element.closest('table') ?? element;
  }

  return new Promise<PickerResult>(resolve => {
    let current: Element | undefined, hovered: Element | undefined, closed = false;
    let ancestors: Element[] = [];
    let overlay: HTMLDivElement | undefined;
    let expiry: number | undefined, monitor: number | undefined;
    const removers: Array<() => void> = [];
    let observer: MutationObserver | undefined;
    const controller = { requestId, cancel: () => finish('範囲選択を中止しました。') };

    function finish(error?: string, selected?: Element): void {
      if (closed) return;
      closed = true;
      removers.forEach(remove => remove());
      if (expiry !== undefined) window.clearTimeout(expiry);
      if (monitor !== undefined) window.clearInterval(monitor);
      observer?.disconnect(); overlay?.remove(); overlay = undefined;
      if (scope.__transactionToExcelPickerV1 === controller) delete scope.__transactionToExcelPickerV1;
      if (selected) {
        const kind = request.kind !== 'content' && selected.tagName.toLowerCase() === 'table' ? 'table' : 'content';
        const key = keyFor(selected, kind);
        scope.__transactionToExcelPickedV1 = { requestId, key, element: selected };
        resolve({ ...result(), kind, key, index: kind === 'table' ? Array.from(document.querySelectorAll('table')).indexOf(selected as HTMLTableElement) : 0 });
      } else {
        delete scope.__transactionToExcelPickedV1;
        resolve({ ...result(), error: error || '範囲選択を中止しました。' });
      }
    }
    function validDocument(): boolean {
      if (location.href !== request.expectedUrl) { finish('対象ページが変わりました。元のページで選び直してください。'); return false; }
      if (document.hidden) { finish('対象タブが表示されなくなったため、範囲選択を止めました。'); return false; }
      if (current && !current.isConnected) { finish('選んでいた範囲が差し替わりました。選び直してください。'); return false; }
      return !closed;
    }
    function draw(): void {
      if (!validDocument()) return;
      if (!current || !visible(current)) { overlay?.remove(); overlay = undefined; return; }
      const rect = current.getBoundingClientRect();
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.setAttribute('data-transaction-to-excel-picker', ''); overlay.setAttribute('aria-hidden', 'true');
        Object.assign(overlay.style, { position: 'fixed', pointerEvents: 'none', boxSizing: 'border-box', border: '3px solid #2563eb', backgroundColor: 'rgba(37, 99, 235, 0.14)', zIndex: '2147483647' });
        document.documentElement.append(overlay);
      }
      Object.assign(overlay.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    }
    function hover(event: Event): void {
      if (!validDocument()) return;
      const next = fromTarget(event.target);
      if (next !== hovered) { hovered = next; current = next; ancestors = []; }
      draw();
    }
    function suppress(event: Event): void {
      if (!validDocument()) return;
      if (fromTarget(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); }
    }
    function click(event: Event): void {
      if (!validDocument()) return;
      const target = fromTarget(event.target);
      if (!target) return;
      event.preventDefault(); event.stopImmediatePropagation();
      // Keep a keyboard-expanded range when the click is inside it. If the
      // pointer moved without a hover event, select the actual clicked region.
      const selected = current?.contains(target) ? current : target;
      if (!visible(selected)) { finish('選んだ範囲が表示されなくなりました。選び直してください。'); return; }
      finish(undefined, selected);
    }
    function keyboard(event: Event): void {
      if (!validDocument()) return;
      const key = (event as KeyboardEvent).key;
      if (key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish(); return; }
      if (!current || !['ArrowUp', 'ArrowDown'].includes(key)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (key === 'ArrowUp' && current.parentElement && current.parentElement !== document.documentElement && visible(current.parentElement)) {
        ancestors.push(current); current = current.parentElement;
      } else if (key === 'ArrowDown' && ancestors.length) {
        current = ancestors.pop();
      }
      draw();
    }
    function listen(target: EventTarget, type: string, listener: EventListener): void {
      target.addEventListener(type, listener, true);
      removers.push(() => target.removeEventListener(type, listener, true));
    }
    scope.__transactionToExcelPickerV1 = controller;
    listen(document, 'pointermove', hover);
    listen(document, 'click', click);
    listen(document, 'keydown', keyboard);
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) listen(document, type, suppress);
    listen(window, 'scroll', draw); listen(window, 'resize', draw);
    listen(window, 'pagehide', () => finish('対象ページを閉じたため、範囲選択を止めました。'));
    listen(document, 'visibilitychange', () => { validDocument(); });
    listen(window, 'popstate', () => { validDocument(); }); listen(window, 'hashchange', () => { validDocument(); });
    observer = new MutationObserver(() => { draw(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    // replaceState/pushState need not dispatch a navigation event. Poll only
    // while this user-initiated picker is active; do not patch the site's APIs.
    monitor = window.setInterval(() => { validDocument(); }, 250);
    expiry = window.setTimeout(() => finish('範囲選択の待ち時間が終了しました。もう一度「画面で範囲を選ぶ」を押してください。'), 120_000);
  });
}

/** Serialized separately; a stale stop request cannot cancel a newer picker. */
export function cancelRegion(requestId?: string): void {
  const scope = window as Window & {
    __transactionToExcelPickerV1?: { requestId: string; cancel(): void };
    __transactionToExcelPickedV1?: { requestId: string; key: string; element: Element };
  };
  const active = scope.__transactionToExcelPickerV1;
  if (active && (requestId === undefined || active.requestId === requestId)) active.cancel();
  if (scope.__transactionToExcelPickedV1 && (requestId === undefined || scope.__transactionToExcelPickedV1.requestId === requestId)) delete scope.__transactionToExcelPickedV1;
}
