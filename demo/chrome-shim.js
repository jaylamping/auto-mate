/**
 * Minimal `chrome.*` shim so auto-mate's real side panel + content scripts can
 * run as a plain web page (no extension install) for UX review and testing.
 *
 * Two execution contexts share one message bus on window.top:
 *   - context "content": the page running the form + content scripts (top).
 *   - context "panel":   the side panel UI (loaded in an iframe).
 *
 * Routing mirrors the real flow:
 *   panel  chrome.tabs.sendMessage(...)   -> content onMessage listeners
 *   content chrome.runtime.sendMessage(.) -> panel  onMessage listeners
 * Storage is backed by localStorage (shared, same origin).
 */
(function () {
  const top = window.top;
  if (!top.__FAA_BUS) {
    top.__FAA_BUS = { content: [], panel: [] };
  }
  const bus = top.__FAA_BUS;

  // Each document that includes this shim declares its context via a global
  // set just before the script tag: window.__FAA_CTX = 'content' | 'panel'.
  const CTX = window.__FAA_CTX || 'content';

  function deliver(targetCtx, message, senderCtx) {
    const listeners = bus[targetCtx].slice();
    let response;
    for (const fn of listeners) {
      try {
        let responded = false;
        const sendResponse = (r) => {
          responded = true;
          response = r;
        };
        const ret = fn(message, { tab: senderCtx === 'content' ? { id: 1 } : undefined }, sendResponse);
        if (responded) return Promise.resolve(response);
        if (ret && typeof ret.then === 'function') return ret;
      } catch (e) {
        // continue to next listener
      }
    }
    return Promise.resolve(response);
  }

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(fn) {
          bus[CTX].push(fn);
        },
        removeListener(fn) {
          bus[CTX] = bus[CTX].filter((f) => f !== fn);
        }
      },
      // content -> panel (background relay is simulated by direct delivery)
      sendMessage(message) {
        return deliver('panel', message, CTX);
      },
      onInstalled: { addListener() {} },
      getURL: (p) => p
    },
    tabs: {
      query(_q) {
        return Promise.resolve([{ id: 1, url: top.location.href, active: true }]);
      },
      // panel -> content
      sendMessage(_tabId, message) {
        return deliver('content', message, CTX);
      }
    },
    scripting: {
      // Content scripts are already present in the demo page.
      executeScript() {
        return Promise.resolve([]);
      }
    },
    sidePanel: {
      setPanelBehavior() {
        return Promise.resolve();
      },
      open() {
        return Promise.resolve();
      }
    },
    action: { onClicked: { addListener() {} } },
    storage: {
      local: {
        get(keys) {
          const out = {};
          const all = JSON.parse(localStorage.getItem('__faa_store') || '{}');
          if (keys == null) Object.assign(out, all);
          else if (typeof keys === 'string') out[keys] = all[keys];
          else if (Array.isArray(keys)) keys.forEach((k) => (out[k] = all[k]));
          else Object.keys(keys).forEach((k) => (out[k] = k in all ? all[k] : keys[k]));
          return Promise.resolve(out);
        },
        set(items) {
          const all = JSON.parse(localStorage.getItem('__faa_store') || '{}');
          Object.assign(all, items);
          localStorage.setItem('__faa_store', JSON.stringify(all));
          return Promise.resolve();
        },
        remove(keys) {
          const all = JSON.parse(localStorage.getItem('__faa_store') || '{}');
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete all[k]);
          localStorage.setItem('__faa_store', JSON.stringify(all));
          return Promise.resolve();
        }
      }
    }
  };

  window.chrome = chrome;
})();
