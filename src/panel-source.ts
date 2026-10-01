/** Window-scoped toolbar activation; no URL or page data lives in session storage. */
export async function watchPanelSource(activate: (tabId: number) => Promise<void>, invalidate: () => void): Promise<() => void> {
  const current = await chrome.windows.getCurrent();
  if (current.id === undefined) throw new Error('対象のブラウザ画面を確認できません。');
  const windowId = current.id, key = `panelActivationV1:${windowId}`;
  let generation = 0, lastActivation = '', disposed = false;
  const apply = async (value: unknown): Promise<void> => {
    if (disposed) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) { invalidate(); return; }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || !Number.isSafeInteger(record.tabId) || (record.tabId as number) < 0 || typeof record.activationId !== 'string' || !record.activationId || record.activationId.length > 128) { invalidate(); return; }
    if (record.activationId === lastActivation) return;
    lastActivation = record.activationId;
    const activeGeneration = generation;
    const isCurrent = () => !disposed && generation === activeGeneration;
    let tab: chrome.tabs.Tab;
    try { tab = await chrome.tabs.get(record.tabId as number); }
    catch {
      // A closed old tab is not evidence that the newer source is invalid.
      if (isCurrent()) invalidate();
      return;
    }
    if (!isCurrent()) return;
    if (tab.windowId !== windowId || tab.active === false) { invalidate(); return; }
    try { await activate(record.tabId as number); }
    catch {
      // Callback failures belong to the activation that invoked them, too.
      if (isCurrent()) invalidate();
    }
  };
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'session' || !Object.hasOwn(changes, key)) return;
    generation++;
    // apply owns source failure handling; never turn an old rejected callback
    // into an unconditional invalidation of the current screen.
    void apply(changes[key].newValue).catch(() => {});
  };
  // Install the subscription first; an initial read is only valid if no newer
  // toolbar event arrived while it was waiting.
  chrome.storage.onChanged.addListener(changed);
  const active = (info: { tabId: number; windowId: number }) => { if (info.windowId === windowId) { generation++; invalidate(); } };
  chrome.tabs.onActivated.addListener(active);
  const dispose = () => { disposed = true; chrome.storage.onChanged.removeListener(changed); chrome.tabs.onActivated.removeListener(active); };
  const initialGeneration = generation;
  try {
    const values = await chrome.storage.session.get(key);
    if (generation === initialGeneration) await apply(values[key]);
  } catch (error) {
    // A later toolbar event supersedes a failed initial read just as it
    // supersedes a successful stale snapshot; keep observing that new source.
    if (disposed || generation !== initialGeneration) return dispose;
    dispose(); throw error;
  }
  return dispose;
}
