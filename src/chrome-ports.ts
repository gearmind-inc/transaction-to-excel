import type { Preset, SaveAttempt } from './contracts';
import type { SavePort } from './save';
import { PresetStore } from './presets';

export function locked<T>(name: string, work: () => Promise<T>): Promise<T> {
  if (!navigator.locks) return Promise.reject(new Error('このChromeでは設定・保存の排他処理が使えません。'));
  return navigator.locks.request(name, work);
}

export const presetStore = new PresetStore({
  async read() { return (await chrome.storage.local.get('presetsV1')).presetsV1; },
  async write(presets: Preset[]) {
    const bytes = new TextEncoder().encode(JSON.stringify(presets)).byteLength;
    const oldBytes = await chrome.storage.local.getBytesInUse('presetsV1');
    const usedBytes = await chrome.storage.local.getBytesInUse();
    if (bytes + usedBytes - oldBytes + 128 > chrome.storage.local.QUOTA_BYTES) throw new Error('ローカル設定の容量が足りません。不要な設定を削除してください。旧設定は保持しています。');
    await chrome.storage.local.set({ presetsV1: presets });
  },
});

export function chromeSavePort(): SavePort {
  const urls = new Set<string>();
  const releaseUrls = () => { for (const url of urls) URL.revokeObjectURL(url); urls.clear(); };
  return {
    async read() { return (await chrome.storage.local.get('saveAttemptV1')).saveAttemptV1 as SaveAttempt | undefined; },
    async write(attempt) {
      await chrome.storage.local.set({ saveAttemptV1: attempt });
      if (['saved', 'cancelled', 'interrupted'].includes(attempt.state)) releaseUrls();
    },
    async download(bytes, filename) {
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'text/csv; charset=utf-8; header=present' }));
      urls.add(url);
      // Keep unknown/in-flight URLs until the workspace unloads or terminal proof.
      return chrome.downloads.download({ url, filename, saveAs: true, conflictAction: 'uniquify' });
    },
    async search(id) {
      const items = await chrome.downloads.search({ id });
      const item = items.find(value => value.id === id);
      if (!item) return undefined;
      return { id: item.id, state: item.state, error: item.error };
    },
    async cancel(id) { await chrome.downloads.cancel(id); },
    listen(onChange) {
      const listener = (delta: chrome.downloads.DownloadDelta) => { onChange(delta.id); };
      chrome.downloads.onChanged.addListener(listener);
      const unload = () => releaseUrls();
      window.addEventListener('pagehide', unload, { once: true });
      return () => { chrome.downloads.onChanged.removeListener(listener); window.removeEventListener('pagehide', unload); releaseUrls(); };
    },
    now: () => new Date().toISOString(),
    uuid: () => crypto.randomUUID(),
    async digest(bytes) {
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
      return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    },
    withLock: work => locked('mvp-save-attempt', work),
  };
}
