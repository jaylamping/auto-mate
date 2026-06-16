/**
 * auto-mate background service worker.
 *
 * Responsibilities:
 *  - Open the side panel when the toolbar icon is clicked.
 *  - Close the side panel when the panel requests it (sidePanel.close from SW).
 *  - Relay messages from content scripts up to the side panel. (Side panel ->
 *    content goes directly via chrome.tabs.sendMessage from the panel.)
 */

importScripts('common/messages.js');

const MSG = globalThis.FAA_MSG?.MSG || {};

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

async function closeExtensionSidePanel({ windowId, tabId } = {}) {
  if (!chrome.sidePanel || !chrome.sidePanel.close) return false;

  if (windowId != null) {
    try {
      await chrome.sidePanel.close({ windowId });
      return true;
    } catch (_) {}
  }
  if (tabId != null) {
    try {
      await chrome.sidePanel.close({ tabId });
      return true;
    } catch (_) {}
  }
  return false;
}

// Forward content-script-originated messages to the side panel runtime.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === MSG.CLOSE_SIDE_PANEL) {
    closeExtensionSidePanel({
      windowId: message.windowId,
      tabId: message.tabId
    })
      .then((ok) => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  const fromContent = !!(sender && sender.tab);
  if (fromContent) {
    // Re-broadcast so the side panel (which has no tab) can receive it.
    chrome.runtime.sendMessage({ ...message, _fromTabId: sender.tab.id }).catch(() => {});
  }
  return false;
});
