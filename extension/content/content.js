/**
 * auto-mate content orchestrator.
 *
 * Bridges side-panel messages to the recorder, engine, and overlay running in
 * the page. Side panel -> content arrives via chrome.tabs.sendMessage; content
 * -> side panel goes via chrome.runtime.sendMessage (relayed by background).
 */
(function (root) {
  // Guard against double-binding. The same scripts can load twice on one page:
  // once from the manifest content_scripts entry (<all_urls>) and again when the
  // side panel calls chrome.scripting.executeScript via ensureInjected. Without
  // this guard, two message listeners + two recorders run, producing duplicate
  // recorded steps and double engine execution. The first copy to load wins.
  if (root.__FAA_CONTENT_OWNER__) return;
  root.__FAA_CONTENT_OWNER__ = true;

  const { MSG, BUILD_ID } = root.FAA_MSG;
  const recorder = () => root.FAA_RECORDER;
  const engine = () => root.FAA_ENGINE;
  const overlay = () => root.FAA_OVERLAY;
  const domUtils = () => root.FAA_DOM;

  function sendRuntimeMessage(message) {
    try {
      const maybePromise = chrome.runtime.sendMessage(message);
      if (maybePromise && typeof maybePromise.catch === 'function') maybePromise.catch(() => {});
    } catch (_) {}
  }

  function toPanel(type, payload) {
    sendRuntimeMessage({ type, payload });
  }

  function emitDebug(kind, data = {}) {
    toPanel(MSG.DEBUG_EVENT, {
      kind,
      source: 'content',
      url: location.href,
      visibilityState: document.visibilityState,
      ...data
    });
  }

  function attachLifecycleDebug() {
    window.addEventListener('beforeunload', () => {
      emitDebug('page:beforeunload');
    });
    window.addEventListener('pagehide', (event) => {
      emitDebug('page:pagehide', { persisted: Boolean(event.persisted) });
    });
    document.addEventListener('visibilitychange', () => {
      emitDebug('page:visibilitychange');
    });
  }

  function fieldText(el) {
    const dom = domUtils();
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
      if (!domUtils().isVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      if (tag === 'input' && !isTextEntry(el)) continue;
      const candidates = domUtils().generateCandidateSelectors(el);
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
        recorder().start(
          (step) => toPanel(MSG.STEP_RECORDED, step),
          (live) => toPanel(MSG.FIELD_INPUT, live),
          (diag) => toPanel(MSG.DIAG_EVENT, diag)
        );
        sendResponse({ ok: true });
        return true;

      case MSG.STOP_LEARN:
        recorder().stop();
        toPanel(MSG.LEARN_DONE, {});
        sendResponse({ ok: true });
        return true;

      case MSG.HIGHLIGHT_FIELD: {
        const el = domUtils().resolveElement(message.payload && message.payload.candidates);
        if (el) {
          overlay().highlight(el);
          setTimeout(() => overlay().clearHighlight(), 1600);
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
        overlay().hideBadge();
        sendResponse({ ok: true });
        return true;

      case MSG.RUN_ROW: {
        const { recipe, row, index, total, dryRun, fieldDelayMs } = message.payload;
        engine().runRow(recipe, row, {
          dryRun,
          fieldDelayMs,
          index,
          total,
          onAction: (entry) => toPanel(MSG.ACTION_LOG, { index, entry })
        })
          .then((result) => {
            overlay().hideBadge();
            toPanel(MSG.ROW_DONE, { index, total, result, mrn: row.mrn });
          })
          .catch((err) => {
            toPanel(MSG.ENGINE_ERROR, { index, error: err.message });
          });
        sendResponse({ ok: true });
        return true;
      }

      case MSG.STOP_RUN:
        engine().abort();
        overlay().setBadge('<b>auto-mate</b><br>Stopping after current action...');
        setTimeout(() => overlay().hideBadge(), 1500);
        sendResponse({ ok: true });
        return true;

      default:
        return false;
    }
  });

  attachLifecycleDebug();
})(typeof window !== 'undefined' ? window : globalThis);
