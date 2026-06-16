/**
 * auto-mate recorder (content script).
 *
 * Active only during Learn mode. Captures the user's interactions with the
 * form and turns each into a "step" with resilient candidate selectors and a
 * guessed role. The side panel then asks the user to label each step with a
 * logical field name. Autocomplete (type-then-pick) interactions are detected
 * and recorded with the chosen option's selector so they can be replayed.
 */
(function (root) {
  const DOM = root.FAA_DOM;
  const { ROLE } = root.FAA_MSG;

  let active = false;
  let onStep = null;
  let stepSeq = 0;

  // Tracks the most recent typing into a text-like field, so a subsequent
  // click on a popup option can be recognized as an autocomplete selection.
  let pendingType = null; // { el, value, candidates, ts, stepId }
  const AUTOCOMPLETE_WINDOW_MS = 8000;

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

  function isSubmitLike(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') {
      const t = (el.getAttribute('type') || 'submit').toLowerCase();
      if (t === 'submit') return true;
    }
    if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'submit') return true;
    const text = (el.textContent || '').trim().toLowerCase();
    // "Log Procedure" is MedHub's submit button.
    return /\b(submit|save|accept|sign|file|done|finish|log)\b/.test(text);
  }

  // Whether a clicked element looks like an autocomplete/list option (so a
  // click after typing is a selection) vs. ordinary navigation (e.g. a tab).
  function isOptionLike(el) {
    let node = el;
    for (let i = 0; i < 5 && node && node.nodeType === 1; i++) {
      const role = node.getAttribute && node.getAttribute('role');
      const tag = node.tagName.toLowerCase();
      if (role === 'option' || tag === 'li' || tag === 'tr') return true;
      if (node.className && typeof node.className === 'string' && /option|result|item|suggest|row|ac_/i.test(node.className)) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  // Interactive elements that aren't text entry/submit and are worth recording
  // as ordered navigation steps (e.g. the Supervisor "Search" tab).
  function isNavClick(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' || tag === 'button') return true;
    const role = el.getAttribute && el.getAttribute('role');
    if (role === 'tab' || role === 'button') return true;
    if (tag === 'input') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      return t === 'button';
    }
    return false;
  }

  // Build a selector for `target` relative to `container`, so replay can click
  // the right control inside a matched option row (e.g. the "+" add link).
  function relSelector(container, target) {
    if (!container || container === target) return null;
    const tag = target.tagName.toLowerCase();
    let sel = tag;
    if (target.className && typeof target.className === 'string') {
      const c = target.className.trim().split(/\s+/).filter(Boolean)[0];
      if (c) sel = `${tag}.${DOM.CSS_ESCAPE(c)}`;
    }
    try {
      if (container.querySelector(sel)) return sel;
    } catch (_) {}
    return tag;
  }

  function fieldText(el) {
    return (
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      (DOM.labelTextFor(el) || '') ||
      (el.name || '') ||
      ''
    ).trim();
  }

  function guessRole(el) {
    if (isSubmitLike(el)) return ROLE.SUBMIT;
    if (isTextEntry(el)) return ROLE.INPUT;
    if (el.tagName.toLowerCase() === 'select') return ROLE.INPUT;
    return ROLE.INPUT;
  }

  function emit(step) {
    step.stepId = `step-${++stepSeq}`;
    if (onStep) onStep(step);
  }

  // Build a generalized selector for an autocomplete option element so any
  // future option in the same list can be located, then matched by text.
  function optionContainerSelector(optionEl) {
    // Prefer role=option / li ancestry.
    let node = optionEl;
    let best = null;
    for (let i = 0; i < 5 && node && node.nodeType === 1; i++) {
      const role = node.getAttribute && node.getAttribute('role');
      const tag = node.tagName.toLowerCase();
      if (
        role === 'option' ||
        tag === 'li' ||
        tag === 'tr' ||
        (node.className && /option|result|item|suggest|row/i.test(node.className))
      ) {
        best = node;
        break;
      }
      node = node.parentElement;
    }
    const target = best || optionEl;
    const cands = DOM.generateCandidateSelectors(target);
    // For options we want a class/role-based selector, not a positional one,
    // because the matching row changes per query. Prefer role/class.
    const role = target.getAttribute('role');
    const tag = target.tagName.toLowerCase();
    let optionSelector;
    if (role === 'option') optionSelector = '[role="option"]';
    else if (target.className && typeof target.className === 'string') {
      const cls = target.className.trim().split(/\s+/).filter(Boolean)[0];
      optionSelector = cls ? `${tag}.${DOM.CSS_ESCAPE(cls)}` : tag;
    } else {
      optionSelector = tag;
    }
    return { optionSelector, candidates: cands, container: target };
  }

  function handleFocusIn(e) {
    if (!active) return;
    // No-op: focus alone isn't a step, but we use it to scope context.
  }

  function handleInput(e) {
    if (!active) return;
    const el = e.target;
    if (!isTextEntry(el)) return;
    // If typing has moved to a different field without an intervening click
    // (e.g. tabbing between inputs), flush the previous field as a plain input
    // so it is not lost. Same-element keystrokes just update the pending value.
    if (pendingType && pendingType.el !== el && !pendingType.emitted) {
      flushPendingTypeAsInput();
    }
    const value = el.isContentEditable ? el.textContent : el.value;
    pendingType = {
      el,
      value,
      candidates: DOM.generateCandidateSelectors(el),
      text: fieldText(el),
      ts: Date.now(),
      stepId: null,
      emitted: false
    };
  }

  function flushPendingTypeAsInput() {
    if (pendingType && !pendingType.emitted) {
      emit({
        role: ROLE.INPUT,
        candidates: pendingType.candidates,
        sampleValue: pendingType.value,
        text: pendingType.text,
        tag: pendingType.el.tagName.toLowerCase()
      });
      pendingType.emitted = true;
    }
  }

  function handleClick(e) {
    if (!active) return;
    const el = e.target.closest('a,button,[role="button"],[role="option"],li,div,span,input,select,td') || e.target;

    // Autocomplete detection: a recent type, and this click is on a different
    // element that looks like a results option.
    if (
      pendingType &&
      Date.now() - pendingType.ts < AUTOCOMPLETE_WINDOW_MS &&
      el !== pendingType.el &&
      !pendingType.el.contains(el) &&
      isOptionLike(el)
    ) {
      const { optionSelector, candidates, container } = optionContainerSelector(el);
      emit({
        role: ROLE.AUTOCOMPLETE,
        candidates: pendingType.candidates,
        optionSelector,
        optionCandidates: candidates,
        clickRel: relSelector(container, el),
        sampleValue: pendingType.value,
        sampleOptionText: (el.textContent || '').trim().slice(0, 120),
        text: pendingType.text,
        tag: pendingType.el.tagName.toLowerCase()
      });
      pendingType.emitted = true;
      pendingType = null;
      return;
    }

    // A plain text field was filled, then user moved on by clicking elsewhere.
    flushPendingTypeAsInput();
    pendingType = null;

    if (isSubmitLike(el)) {
      emit({
        role: ROLE.SUBMIT,
        candidates: DOM.generateCandidateSelectors(el),
        text: (el.textContent || el.value || '').trim().slice(0, 80),
        tag: el.tagName.toLowerCase()
      });
    } else if (isNavClick(el)) {
      emit({
        role: ROLE.CLICK,
        candidates: DOM.generateCandidateSelectors(el),
        text: (el.textContent || el.value || '').trim().slice(0, 80),
        tag: el.tagName.toLowerCase()
      });
    }
  }

  function handleChange(e) {
    if (!active) return;
    const el = e.target;
    if (el.tagName.toLowerCase() === 'select') {
      emit({
        role: ROLE.INPUT,
        candidates: DOM.generateCandidateSelectors(el),
        sampleValue: el.value,
        text: fieldText(el),
        tag: 'select'
      });
    }
  }

  function start(cb) {
    if (active) return;
    active = true;
    onStep = cb;
    stepSeq = 0;
    pendingType = null;
    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('change', handleChange, true);
    document.addEventListener('click', handleClick, true);
  }

  function stop() {
    if (!active) return;
    flushPendingTypeAsInput();
    active = false;
    onStep = null;
    pendingType = null;
    document.removeEventListener('focusin', handleFocusIn, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('change', handleChange, true);
    document.removeEventListener('click', handleClick, true);
  }

  root.FAA_RECORDER = { start, stop, isActive: () => active };
})(typeof window !== 'undefined' ? window : globalThis);
