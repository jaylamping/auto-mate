/**
 * auto-mate background service worker.
 *
 * Responsibilities:
 *  - Open the side panel when the toolbar icon is clicked.
 *  - Relay messages from content scripts up to the side panel. (Side panel ->
 *    content goes directly via chrome.tabs.sendMessage from the panel.)
 */

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (chrome.sidePanel && chrome.sidePanel.open) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (_) {
      // Fallback handled by setPanelBehavior.
    }
  }
});

// Forward content-script-originated messages to the side panel runtime.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;
  const fromContent = !!(sender && sender.tab);
  if (fromContent) {
    // Re-broadcast so the side panel (which has no tab) can receive it.
    chrome.runtime.sendMessage({ ...message, _fromTabId: sender.tab.id }).catch(() => {});
  }
  // Allow async responders elsewhere.
  return false;
});
