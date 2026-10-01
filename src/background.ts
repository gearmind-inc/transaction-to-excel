// No transactions, CSV bytes, or long-running work in the service worker.
const restrictStorage = () => chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
chrome.runtime.onInstalled.addListener(() => { void restrictStorage(); });
chrome.runtime.onStartup.addListener(() => { void restrictStorage(); });
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  void restrictStorage().then(() => chrome.tabs.create({
    url: chrome.runtime.getURL(`workspace.html?tab=${tab.id}`),
  }));
});
