// No transactions, CSV bytes, or long-running work in the service worker.
const restrictStorage = () => chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
chrome.runtime.onInstalled.addListener(() => { void restrictStorage().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void restrictStorage().catch(() => {}); });
chrome.action.onClicked.addListener((tab) => {
  if (typeof tab.id !== 'number' || !Number.isSafeInteger(tab.id) || tab.id < 0
    || !Number.isSafeInteger(tab.windowId) || tab.windowId < 0) return;

  // This call must stay in the original toolbar gesture, before any async work.
  try {
    void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  } catch { return; }

  try {
    void chrome.storage.session.set({
      [`panelActivationV1:${tab.windowId}`]: { tabId: tab.id, activationId: crypto.randomUUID() },
    }).catch(() => {});
  } catch { /* A failed activation must not throw from the toolbar listener. */ }
});
