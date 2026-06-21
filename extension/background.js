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

/**
 * Runs in the page MAIN world via chrome.scripting.executeScript.
 * MedHub: <a aria-label="Delete" href="javascript:procedures_delete(n);" class="button">
 */
function faaClearMedHubProcedures(deleteIndex) {
  function parseIdx(el) {
    const m = (el.getAttribute('href') || '').match(/procedures_delete\s*\(\s*(\d+)\s*\)/);
    return m ? Number(m[1]) : null;
  }
  function isFilledTitle(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return false;
    if (/^[-\s.]+$/.test(t)) return false;
    return true;
  }
  function isVisible(el) {
    if (!el) return false;
    if (el.hidden) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }
  function isFilledSlot(i) {
    const title = document.getElementById('prow_' + i + '_title');
    if (!isFilledTitle(title && title.textContent)) return false;
    const tr = document.getElementById('prow_' + i);
    if (!tr) return true;
    const link = tr.querySelector('a[href*="procedures_delete"]');
    if (link && !isVisible(link) && !isVisible(tr)) return false;
    return true;
  }
  function countFilledSlots() {
    let n = 0;
    for (let i = 1; i <= 20; i++) {
      if (isFilledSlot(i)) n++;
    }
    return n;
  }
  function procedureRowHasContent(tr) {
    if (!tr || tr.id === 'prow_0') return false;
    const trText = (tr.textContent || '').toLowerCase();
    if (trText.indexOf('no procedures') !== -1) return false;
    if (tr.querySelector('th')) return false;
    const prowMatch = tr.id && tr.id.match(/^prow_(\d+)$/);
    if (prowMatch) return isFilledSlot(Number(prowMatch[1]));
    const text = (tr.textContent || '').replace(/\s+/g, ' ').trim();
    return text.length >= 12 && trText.indexOf('delete') !== -1;
  }
  function deleteLinks() {
    return Array.from(
      document.querySelectorAll(
        'a[aria-label="Delete"][href*="procedures_delete"], a.button[href*="procedures_delete"], a[href*="procedures_delete"]'
      )
    ).filter((el) => {
      if (el.closest('#procedures_list') || el.closest('#AddStandardProcedure')) return false;
      const tr = el.closest('tr');
      if (!tr) return false;
      return procedureRowHasContent(tr);
    });
  }
  function purgeFilledSlots() {
    if (typeof procedures_delete !== 'function') return;
    for (let i = 1; i <= 20; i++) {
      if (!isFilledSlot(i)) continue;
      try {
        procedures_delete(i);
      } catch (_) {}
    }
  }
  function purgeLink(el) {
    const idx = parseIdx(el);
    if (typeof procedures_delete === 'function' && idx != null) {
      try {
        procedures_delete(idx);
      } catch (_) {}
    }
    try {
      el.click();
    } catch (_) {}
  }
  if (deleteIndex != null && !Number.isNaN(deleteIndex)) {
    if (typeof procedures_delete === 'function') {
      try {
        procedures_delete(deleteIndex);
      } catch (_) {}
    }
    deleteLinks().forEach((el) => {
      if (parseIdx(el) === deleteIndex) purgeLink(el);
    });
    return countFilledSlots();
  }
  for (let pass = 0; pass < 3; pass++) {
    purgeFilledSlots();
    const links = deleteLinks();
    links.forEach(purgeLink);
    if (!countFilledSlots()) return 0;
  }
  return countFilledSlots();
}

// Forward content-script-originated messages to the side panel runtime.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;
  if (message._debugBroadcast) return false;

  if (message.type === MSG.CLEAR_PROCEDURES_PAGE) {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'no tab' });
      return true;
    }
    const rawIndex = message.payload && message.payload.index;
    const deleteIndex = rawIndex == null ? null : Number(rawIndex);
    chrome.scripting
      .executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        func: faaClearMedHubProcedures,
        args: [deleteIndex]
      })
      .then((results) => {
        const remaining = results && results[0] && results[0].result;
        const payload = {
          kind: 'procedure:clear:main-world',
          source: 'background',
          deleteIndex,
          tabId,
          remaining: typeof remaining === 'number' ? remaining : null,
          frameResults: (results || []).map((r) => ({
            frameId: r.frameId,
            remaining: r.result
          }))
        };
        appendDebugEvent(payload).catch(() => {});
        sendResponse({
          ok: true,
          remaining: typeof remaining === 'number' ? remaining : null
        });
      })
      .catch((err) => {
        appendDebugEvent({
          kind: 'procedure:clear:main-world',
          source: 'background',
          deleteIndex,
          tabId,
          ok: false,
          error: err.message
        }).catch(() => {});
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

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
