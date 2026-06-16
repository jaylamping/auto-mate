/**
 * auto-mate content orchestrator.
 *
 * Bridges side-panel messages to the recorder, engine, and overlay running in
 * the page. Side panel -> content arrives via chrome.tabs.sendMessage; content
 * -> side panel goes via chrome.runtime.sendMessage (relayed by background).
 */
(function (root) {
  const { MSG } = root.FAA_MSG;
  const RECORDER = root.FAA_RECORDER;
  const ENGINE = root.FAA_ENGINE;
  const OVERLAY = root.FAA_OVERLAY;
  const DOM = root.FAA_DOM;

  function toPanel(type, payload) {
    chrome.runtime.sendMessage({ type, payload }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    switch (message.type) {
      case MSG.PING:
        sendResponse({ type: MSG.PONG, url: location.href });
        return true;

      case MSG.START_LEARN:
        OVERLAY.setBadge('<b>auto-mate</b><br>Learn mode is recording. Fill the form once, then click Finish in the panel.');
        RECORDER.start((step) => {
          toPanel(MSG.STEP_RECORDED, step);
        });
        sendResponse({ ok: true });
        return true;

      case MSG.STOP_LEARN:
        RECORDER.stop();
        OVERLAY.hideBadge();
        toPanel(MSG.LEARN_DONE, {});
        sendResponse({ ok: true });
        return true;

      case MSG.HIGHLIGHT_FIELD: {
        const el = DOM.resolveElement(message.payload && message.payload.candidates);
        if (el) {
          OVERLAY.highlight(el);
          setTimeout(() => OVERLAY.clearHighlight(), 1600);
        }
        sendResponse({ ok: !!el });
        return true;
      }

      case MSG.RUN_ROW: {
        const { recipe, row, index, total, dryRun, fieldDelayMs } = message.payload;
        OVERLAY.setBadge(
          `<b>auto-mate</b><br>${dryRun ? 'DRY RUN' : 'Running'} row ${index + 1} of ${total}` +
            (row.mrn ? `<br>MRN ${row.mrn}` : '')
        );
        ENGINE.runRow(recipe, row, {
          dryRun,
          fieldDelayMs,
          onAction: (entry) => toPanel(MSG.ACTION_LOG, { index, entry })
        })
          .then((result) => {
            toPanel(MSG.ROW_DONE, { index, total, result, mrn: row.mrn });
          })
          .catch((err) => {
            toPanel(MSG.ENGINE_ERROR, { index, error: err.message });
          });
        sendResponse({ ok: true });
        return true;
      }

      case MSG.STOP_RUN:
        ENGINE.abort();
        OVERLAY.setBadge('<b>auto-mate</b><br>Stopping after current action...');
        setTimeout(() => OVERLAY.hideBadge(), 1500);
        sendResponse({ ok: true });
        return true;

      default:
        return false;
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
