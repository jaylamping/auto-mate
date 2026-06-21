/**
 * auto-mate background service worker.
 *
 * Responsibilities:
 *  - Open the side panel when the toolbar icon is clicked.
 *  - Relay messages from content scripts up to the side panel. (Side panel ->
 *    content goes directly via chrome.tabs.sendMessage from the panel.)
 */

importScripts('common/messages.js');

const MSG = globalThis.FAA_MSG?.MSG || {};
const STORAGE_KEYS = globalThis.FAA_MSG?.STORAGE_KEYS || {};
const MAX_DEBUG_EVENTS = 1500;

function sendRuntimeMessage(message) {
  try {
    const maybePromise = chrome.runtime.sendMessage(message);
    if (maybePromise && typeof maybePromise.catch === 'function') maybePromise.catch(() => {});
  } catch (_) {}
}

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

async function appendDebugEvent(event) {
  if (!STORAGE_KEYS.DEBUG_LOG) return;
  const entry = {
    ts: new Date().toISOString(),
    ...event
  };
  const stored = await chrome.storage.local.get(STORAGE_KEYS.DEBUG_LOG);
  const events = Array.isArray(stored[STORAGE_KEYS.DEBUG_LOG])
    ? stored[STORAGE_KEYS.DEBUG_LOG]
    : [];
  events.push(entry);
  if (events.length > MAX_DEBUG_EVENTS) {
    events.splice(0, events.length - MAX_DEBUG_EVENTS);
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.DEBUG_LOG]: events });
  sendRuntimeMessage({ type: MSG.DEBUG_EVENT, payload: entry, _debugBroadcast: true });
}

async function openDebugLogWindow() {
  const url = chrome.runtime.getURL('debug/debug.html');
  await chrome.windows.create({
    url,
    type: 'popup',
    width: 980,
    height: 760,
    focused: true
  });
}

// Forward content-script-originated messages to the side panel runtime.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;
  if (message._debugBroadcast) return false;

  if (message.type === MSG.OPEN_DEBUG_LOG) {
    openDebugLogWindow()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MSG.DEBUG_EVENT) {
    appendDebugEvent(message.payload || {})
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MSG.CLEAR_DEBUG_LOG) {
    chrome.storage.local
      .set({ [STORAGE_KEYS.DEBUG_LOG]: [] })
      .then(() => {
        sendRuntimeMessage({
          type: MSG.DEBUG_EVENT,
          payload: { kind: 'debug:cleared' },
          _debugBroadcast: true
        });
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  const fromContent = !!(sender && sender.tab);
  if (fromContent) {
    // Re-broadcast so the side panel (which has no tab) can receive it.
    sendRuntimeMessage({ ...message, _fromTabId: sender.tab.id });
  }
  return false;
});
