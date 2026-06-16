/**
 * auto-mate content orchestrator.
 *
 * Bridges side-panel messages to the recorder, engine, and overlay running in
 * the page. Side panel -> content arrives via chrome.tabs.sendMessage; content
 * -> side panel goes via chrome.runtime.sendMessage (relayed by background).
 */
(function (root) {
  const { MSG, BUILD_ID } = root.FAA_MSG;
  const RECORDER = root.FAA_RECORDER;
  const ENGINE = root.FAA_ENGINE;
  const OVERLAY = root.FAA_OVERLAY;
  const DOM = root.FAA_DOM;

  function toPanel(type, payload) {
    chrome.runtime.sendMessage({ type, payload }).catch(() => {});
  }

  function fieldText(el) {
    const dom = root.FAA_DOM;
    if (dom && typeof dom.accessibleNameFor === 'function') {
      return (dom.accessibleNameFor(el) || '').trim();
    }
    return (
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      (dom && dom.labelTextFor ? dom.labelTextFor(el) || '' : '') ||
      (el.name || '') ||
      ''
    ).trim();
  }

  function isTextEntry(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (el.isContentEditable) return true;
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'search', 'email', 'tel', 'url', 'number', 'date', ''].includes(t);
    }
    return false;
  }

  function scanFormFields() {
    const fields = [];
    const seen = new Set();
    const nodes = document.querySelectorAll('input, textarea, select, [contenteditable="true"]');
    for (const el of nodes) {
      if (!DOM.isVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      if (tag === 'input' && !isTextEntry(el)) continue;
      const candidates = DOM.generateCandidateSelectors(el);
      const sig = candidates[0] ? `${candidates[0].type}::${candidates[0].value}` : el.id || fieldText(el);
      if (!sig || seen.has(sig)) continue;
      seen.add(sig);
      fields.push({
        role: tag === 'select' ? 'input' : 'input',
        candidates,
        text: fieldText(el),
        tag,
        sampleValue: tag === 'select' ? el.value : el.value || ''
      });
    }
    return fields;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    switch (message.type) {
      case MSG.PING:
        sendResponse({ type: MSG.PONG, url: location.href, buildId: BUILD_ID });
        return true;

      case MSG.START_LEARN:
        RECORDER.start(
          (step) => toPanel(MSG.STEP_RECORDED, step),
          (live) => toPanel(MSG.FIELD_INPUT, live)
        );
        sendResponse({ ok: true });
        return true;

      case MSG.STOP_LEARN:
        RECORDER.stop();
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

      case MSG.SCAN_FORM: {
        const fields = scanFormFields();
        sendResponse({ ok: true, fields });
        return true;
      }

      case MSG.CLEAR_OVERLAY:
        OVERLAY.hideBadge();
        sendResponse({ ok: true });
        return true;

      case MSG.RUN_ROW: {
        const { recipe, row, index, total, dryRun, fieldDelayMs } = message.payload;
        ENGINE.runRow(recipe, row, {
          dryRun,
          fieldDelayMs,
          onAction: (entry) => toPanel(MSG.ACTION_LOG, { index, entry })
        })
          .then((result) => {
            OVERLAY.hideBadge();
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
