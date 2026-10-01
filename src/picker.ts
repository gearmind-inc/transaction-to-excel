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
    let shield: HTMLDivElement | undefined, frame: HTMLIFrameElement | undefined;
    const previousFocus = document.activeElement;
    let expiry: number | undefined, monitor: number | undefined;
    let settle: (() => void) | undefined;
    const removers: Array<() => void> = [];
    let observer: MutationObserver | undefined;
    const controller = { requestId, cancel: () => { if (settle) settle(); else finish('範囲選択を中止しました。'); } };

    function finish(error?: string, selected?: Element, holdInput = false): void {
      if (closed) return;
      closed = true;
      if (expiry !== undefined) window.clearTimeout(expiry);
      if (monitor !== undefined) window.clearInterval(monitor);
      observer?.disconnect(); overlay?.remove(); overlay = undefined;
      let answer: PickerResult;
      if (selected) {
        const kind = request.kind !== 'content' && selected.tagName.toLowerCase() === 'table' ? 'table' : 'content';
        const key = keyFor(selected, kind);
        scope.__transactionToExcelPickedV1 = { requestId, key, element: selected };
        answer = { ...result(), kind, key, index: kind === 'table' ? Array.from(document.querySelectorAll('table')).indexOf(selected as HTMLTableElement) : 0 };
      } else {
        delete scope.__transactionToExcelPickedV1;
        answer = { ...result(), error: error || '範囲選択を中止しました。' };
      }
      let settled = false, trailingInput: number | undefined;
      settle = () => {
        if (settled) return; settled = true;
        if (trailingInput !== undefined) window.clearTimeout(trailingInput);
        removers.forEach(remove => remove());
        shield?.remove(); shield = undefined; frame = undefined;
        if (scope.__transactionToExcelPickerV1 === controller) {
          delete scope.__transactionToExcelPickerV1;
          if (previousFocus instanceof HTMLElement && previousFocus.isConnected && location.href === request.expectedUrl) previousFocus.focus({ preventScroll: true });
        }
        settle = undefined; resolve(answer);
      };
      // Removing the frame during a trusted click exposes the second click
      // of a rapid double click to the business page. Hold the blank input
      // surface briefly, and resolve only once normal input can resume.
      if (holdInput) trailingInput = window.setTimeout(settle, 400);
      else settle();
    }
    function validDocument(): boolean {
      if (location.href !== request.expectedUrl) { finish('対象ページが変わりました。元のページで選び直してください。'); return false; }
      if (document.hidden) { finish('対象タブが表示されなくなったため、範囲選択を止めました。'); return false; }
      if (shield && (!shield.isConnected || !frame?.isConnected || !frame.contentDocument)) { finish('安全に範囲を選べなくなりました。もう一度範囲を選んでください。'); return false; }
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
        shield!.append(overlay);
      }
      Object.assign(overlay.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    }
    function pointTarget(event: Event): Element | undefined {
      const pointer = (event as TouchEvent).changedTouches?.[0] ?? event as MouseEvent;
      if (!shield || !frame || !Number.isFinite(pointer.clientX) || !Number.isFinite(pointer.clientY)) return undefined;
      // A pointer event stays in the iframe's document even while the parent
      // overlay is synchronously excluded from this read-only hit test.
      shield.style.setProperty('pointer-events', 'none', 'important');
      frame.style.setProperty('pointer-events', 'none', 'important');
      try { return fromTarget(document.elementFromPoint(pointer.clientX, pointer.clientY)); }
      finally {
        shield.style.setProperty('pointer-events', 'auto', 'important');
        frame.style.setProperty('pointer-events', 'auto', 'important');
      }
    }
    function hover(event: Event): void {
      if (!validDocument()) return;
      const next = pointTarget(event);
      if (next !== hovered) { hovered = next; current = next; ancestors = []; }
      draw();
    }
    function suppress(event: Event): void {
      if (!validDocument()) return;
      event.preventDefault(); event.stopImmediatePropagation();
    }
    function click(event: Event): void {
      if (!validDocument()) return;
      const target = pointTarget(event);
      if (!target) return;
      event.preventDefault(); event.stopImmediatePropagation();
      // Keep a keyboard-expanded range when the click is inside it. If the
      // pointer moved without a hover event, select the actual clicked region.
      const selected = current?.contains(target) ? current : target;
      if (!visible(selected)) { finish('選んだ範囲が表示されなくなりました。選び直してください。'); return; }
      finish(undefined, selected, event.isTrusted);
    }
    function keyboard(event: Event): void {
      // Tab/Shift+Tab must never move focus out of the frame into a page
      // button while selection is active. Keep the trap through trailing
      // keyup/click input until the frame is actually removed.
      event.preventDefault(); event.stopImmediatePropagation();
      if (!validDocument()) return;
      const key = (event as KeyboardEvent).key;
      if (key === 'Escape') { finish(undefined, undefined, event.isTrusted); return; }
      if (!current || !['ArrowUp', 'ArrowDown'].includes(key)) return;
      if (key === 'ArrowUp' && current.parentElement && current.parentElement !== document.documentElement && visible(current.parentElement)) {
        ancestors.push(current); current = current.parentElement;
      } else if (key === 'ArrowDown' && ancestors.length) {
        current = ancestors.pop();
      }
      draw();
    }
    function listen(target: EventTarget, type: string, listener: EventListener): void {
      target.addEventListener(type, listener, { capture: true, passive: false });
      removers.push(() => target.removeEventListener(type, listener, true));
    }
    scope.__transactionToExcelPickerV1 = controller;
    // Late listeners in the page's propagation tree cannot beat earlier
    // window/document capture handlers. Receive selection input in a separate
    // browsing context instead; its pointer/keyboard events never bubble into
    // the source page. A manual popover places it above ordinary page content.
    shield = document.createElement('div');
    shield.setAttribute('data-transaction-to-excel-input-shield', '');
    shield.setAttribute('popover', 'manual');
    function styles(element: HTMLElement, values: Record<string, string>): void {
      for (const [name, value] of Object.entries(values)) element.style.setProperty(name, value, 'important');
    }
    styles(shield, { position: 'fixed', inset: '0', margin: '0', padding: '0', border: '0', width: '100vw', height: '100vh', 'max-width': 'none', 'max-height': 'none', background: 'transparent', overflow: 'hidden', 'pointer-events': 'auto', 'z-index': '2147483647' });
    frame = document.createElement('iframe');
    frame.setAttribute('title', 'ページの範囲を選択する操作面');
    styles(frame, { position: 'absolute', inset: '0', margin: '0', padding: '0', border: '0', width: '100%', height: '100%', background: 'transparent', 'pointer-events': 'auto' });
    shield.append(frame);
    function placeShield(): boolean {
      if (!shield || !frame || closed) return false;
      shield.style.setProperty('pointer-events', 'none', 'important'); frame.style.setProperty('pointer-events', 'none', 'important');
      let host: Element;
      try {
        const focused = document.activeElement?.closest('dialog');
        const dialog = focused?.matches(':modal') ? focused : document.elementFromPoint(0, 0)?.closest('dialog');
        host = dialog?.matches(':modal') ? dialog : document.documentElement;
      }
      finally { shield.style.setProperty('pointer-events', 'auto', 'important'); frame.style.setProperty('pointer-events', 'auto', 'important'); }
      // A popover outside an existing modal dialog is inert. Keep the input
      // surface inside the foremost modal's subtree when one is present.
      if (shield.parentElement !== host) {
        host.append(shield);
        shield.showPopover();
        return true;
      }
      return false;
    }
    function bindInput(): void {
      const input = frame?.contentDocument;
      if (!input || !frame?.contentWindow) throw new Error('unavailable input frame');
      styles(input.documentElement, { background: 'transparent', margin: '0', padding: '0', height: '100%', cursor: 'crosshair' });
      styles(input.body, { background: 'transparent', margin: '0', padding: '0', height: '100%' });
      listen(input, 'pointermove', hover); listen(input, 'touchmove', hover);
      listen(input, 'click', click); listen(input, 'touchend', click); listen(input, 'keydown', keyboard);
      listen(input, 'keyup', event => { event.preventDefault(); event.stopImmediatePropagation(); });
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick', 'dblclick', 'contextmenu', 'dragstart', 'touchstart']) listen(input, type, suppress);
      listen(input, 'wheel', event => {
        if (!validDocument()) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const wheel = event as WheelEvent, factor = wheel.deltaMode === 1 ? 16 : wheel.deltaMode === 2 ? innerHeight : 1;
        window.scrollBy(wheel.deltaX * factor, wheel.deltaY * factor); draw();
      });
      frame.focus({ preventScroll: true });
    }
    try {
      if (typeof shield.showPopover !== 'function' || typeof document.elementFromPoint !== 'function') throw new Error('unavailable input surface');
      placeShield(); bindInput();
    } catch {
      finish('このページでは安全に範囲を選べません。ページの表示を確認してから、もう一度お試しください。'); return;
    }
    listen(window, 'scroll', draw); listen(window, 'resize', draw);
    listen(window, 'pagehide', () => finish('対象ページを閉じたため、範囲選択を止めました。'));
    listen(document, 'visibilitychange', () => { validDocument(); });
    listen(window, 'popstate', () => { validDocument(); }); listen(window, 'hashchange', () => { validDocument(); });
    observer = new MutationObserver(() => {
      if (!validDocument()) return;
      try {
        if (placeShield()) {
          // Reparenting an iframe creates a fresh browsing context. Rebind
          // its isolated input listeners before the next physical event.
          current = undefined; hovered = undefined; ancestors = []; bindInput();
        }
        draw();
      } catch { finish('ページの表示が変わり、安全に範囲を選べなくなりました。もう一度範囲を選んでください。'); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
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
