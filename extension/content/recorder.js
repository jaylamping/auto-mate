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
  const { ROLE, minMappingLenFromHaystack } = root.FAA_MSG;

  let active = false;
  let onStep = null;
  let onLiveInput = null;
  let stepSeq = 0;
  let liveInputTimer = null;
  const LIVE_INPUT_MS = 300;

  // Tracks the most recent typing into a text-like field, so a subsequent
  // click on a popup option can be recognized as an autocomplete selection.
  let pendingType = null; // { el, value, candidates, ts, stepId }
  const AUTOCOMPLETE_WINDOW_MS = 8000;
  let fieldInteracted = new WeakMap();
  let fieldFocusValue = new WeakMap();

  function markFieldInteracted(el) {
    if (el && el.nodeType === 1) fieldInteracted.set(el, true);
  }

  function wasFieldInteracted(el) {
    return el && fieldInteracted.get(el) === true;
  }

  function rememberFocusValue(el) {
    if (!el || el.nodeType !== 1) return;
    fieldFocusValue.set(el, fieldValue(el));
  }

  function valueChangedSinceFocus(el) {
    if (!el) return false;
    const baseline = fieldFocusValue.get(el);
    if (baseline === undefined) return false;
    return fieldValue(el) !== baseline;
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
    const el = e.target;
    const tag = el.tagName.toLowerCase();
    if (!isTextEntry(el) && tag !== 'select') return;
    rememberFocusValue(el);
  }

  function handleInput(e) {
    if (!active) return;
    const el = e.target;
    if (!isTextEntry(el)) return;
    markFieldInteracted(el);
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
      text: supervisorFieldText(el),
      ts: Date.now(),
      stepId: null,
      emitted: false
    };
    if (onLiveInput) {
      clearTimeout(liveInputTimer);
      liveInputTimer = setTimeout(() => {
        if (!pendingType || pendingType.el !== el) return;
        const val = String(pendingType.value || '').trim();
        if (val.length < minLiveValueLen(el)) return;
        emitLiveFieldState(el, { debounced: true });
      }, LIVE_INPUT_MS);
    }
  }

  function fieldValue(el) {
    if (!el) return '';
    return String(el.isContentEditable ? el.textContent : el.value).trim();
  }

  function minLiveValueLen(el) {
    return minMappingLenFromHaystack(fieldText(el));
  }

  function emitLiveFieldState(el, opts = {}) {
    if (!onLiveInput || !el || el.nodeType !== 1) return;
    if (!wasFieldInteracted(el)) return;
    if (opts.blurred && !valueChangedSinceFocus(el)) return;
    const tag = el.tagName.toLowerCase();
    const value = fieldValue(el);
    const minLen = tag === 'select' ? 1 : minLiveValueLen(el);
    if (value.length < minLen) return;
    onLiveInput({
      role: ROLE.INPUT,
      candidates: DOM.generateCandidateSelectors(el),
      sampleValue: value,
      text: supervisorFieldText(el),
      tag,
      blurred: Boolean(opts.blurred),
      debounced: Boolean(opts.debounced)
    });
  }

  function handleBlur(e) {
    if (!active) return;
    const el = e.target;
    const tag = el.tagName.toLowerCase();
    if (!isTextEntry(el) && tag !== 'select') return;

    clearTimeout(liveInputTimer);
    liveInputTimer = null;

    if (pendingType && pendingType.el === el) {
      pendingType.value = el.isContentEditable ? el.textContent : el.value;
    }

    emitLiveFieldState(el, { blurred: true });
  }

  function flushPendingTypeAsInput() {
    if (!pendingType || pendingType.emitted || !wasFieldInteracted(pendingType.el)) return;
    if (!valueChangedSinceFocus(pendingType.el)) return;
    // Procedure search without clicking "+" / a result is not a completed pick.
    if (isProcedureSearchField(pendingType.el)) {
      pendingType.emitted = true;
      return;
    }
    emit({
        role: ROLE.INPUT,
        candidates: pendingType.candidates,
        sampleValue: pendingType.value,
        text: pendingType.text,
        tag: pendingType.el.tagName.toLowerCase()
    });
    pendingType.emitted = true;
  }

  function isProcedureSearchField(el) {
    if (!el) return false;
    const hay = `${el.id || ''} ${el.name || ''} ${fieldText(el)}`.toLowerCase();
    if (/date|note|location|site|facility/.test(hay)) return false;
    // Live MedHub: <input name="procedures_searchterms" onkeyup="procedures_search()">.
    if (/procedures?[_\s]*search/.test(hay)) return true;
    if (/proc_search|procedure\s*search/.test(hay.replace(/\s+/g, ' '))) return true;
    return /\bproc\b/.test(hay) && /\bsearch\b/.test(hay);
  }

  // The "+" add control. Idealized fixture uses <a class="add">; live MedHub
  // uses <a onClick="procedures_add(249,'- -','Ablation', ...)"> with a fa-plus
  // icon, where all three links in the row call procedures_add.
  function procedureAddControl(el) {
    if (!el || !el.closest) return null;
    return el.closest(
      'a.add, button.add, [onclick*="procedures_add"], a[href*="procedures_add"]'
    );
  }

  function procedureRow(add) {
    if (!add || !add.closest) return null;
    return add.closest('.proc_row, li[data-name], #procedures_list tr, tr, li');
  }

  function isProcedureAddClick(el) {
    const add = procedureAddControl(el);
    if (!add) return false;
    // Idealized fixture pairs the add link with a .proc_row/[data-name] row;
    // live MedHub nests it inside the #procedures_list table rows.
    return !!(add.closest('.proc_row, [data-name]') || add.closest('#procedures_list'));
  }

  function emitProcedureAddStep(el) {
    const add = procedureAddControl(el) || el;
    const row = procedureRow(add);
    const container = row || add;
    const inProcList = !!(container.closest && container.closest('#procedures_list'));
    let { optionSelector, candidates, container: optContainer } = optionContainerSelector(container);
    // Live MedHub procedure rows have empty or inconsistent classes
    // (class='' or class='verify_supervisor'), so a class/tag selector is
    // unreliable and a bare <tr> would match every row on the page. Scope to
    // the picker's own table whenever the row lives inside #procedures_list.
    if (inProcList) {
      optionSelector = '#procedures_list tbody tr';
    }
    const procPending = pendingType && isProcedureSearchField(pendingType.el) ? pendingType : null;
    const procInput =
      procPending?.el ||
      document.querySelector(
        '#procSearch, #proc_search, #procedures_searchterms, [name="procedures_searchterms"], [aria-label*="Procedure" i], [name*="procedure" i][type="text"]'
      );
    const inputCandidates = procPending
      ? procPending.candidates
      : procInput
        ? DOM.generateCandidateSelectors(procInput)
        : [];
    const sampleVal = procPending ? procPending.value : procInput ? procInput.value : '';
    const label = procPending ? procPending.text : procInput ? fieldText(procInput) : 'Procedure';
    const relRoot = optContainer || container;
    emit({
      role: ROLE.AUTOCOMPLETE,
      candidates: inputCandidates,
      optionSelector,
      optionCandidates: candidates,
      clickRel: relSelector(relRoot, add),
      sampleValue: sampleVal,
      sampleOptionText: (row?.getAttribute('data-name') || relRoot.textContent || '').trim().slice(0, 120),
      text: label,
      tag: 'input'
    });
  }

  function isSupervisorSearchInput(el) {
    if (!el) return false;
    const hay = `${el.id || ''} ${el.name || ''} ${fieldText(el)}`.toLowerCase();
    if (/supervis|attending|precept/.test(hay)) return true;
    if ((el.name === 'searchterms' || el.id === 'searchterms') && isInSupervisorPane(el)) return true;
    const method = document.getElementById('supervisor_method');
    return !!(method && method.value === 'search' && el.name === 'searchterms');
  }

  function isInSupervisorPane(el) {
    return !!(el && el.closest && el.closest('#procedures_supervisor_pane'));
  }

  function supervisorFieldText(el) {
    return isSupervisorSearchInput(el) ? 'Supervisor' : fieldText(el);
  }

  function findSupervisorSearchInput() {
    const scoped =
      document.querySelector('#procedures_supervisor_pane input[name="searchterms"]') ||
      document.querySelector('#procedures_supervisor_pane #searchterms');
    if (scoped && isTextEntry(scoped)) return scoped;
    const byId =
      document.getElementById('supSearch') ||
      document.getElementById('sup_search') ||
      document.getElementById('supervisor_search') ||
      document.getElementById('searchterms') ||
      document.querySelector('input[name="supervisor_search"], input[name="searchterms"]');
    if (byId && isTextEntry(byId) && byId.name !== 'procedures_searchterms') return byId;
    const nodes = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])');
    for (const el of nodes) {
      if (isTextEntry(el) && isSupervisorSearchInput(el)) return el;
    }
    return null;
  }

  function isSupervisorResultClick(el) {
    if (!el) return false;
    if (el.closest && el.closest('#ajax_listOfOptions') && findSupervisorSearchInput()) return true;
    const row = el.closest && el.closest('li, [role="option"], tr, div.optionDiv, div.option');
    if (!row) return false;
    const list = row.closest('ul, ol, [role="listbox"], .ac_results, #ajax_listOfOptions');
    const listHay = `${list && list.id || ''} ${list && list.className || ''} ${row.className || ''}`.toLowerCase();
    if (/proc_result|proc_list|proc_row|procedure/.test(listHay)) return false;
    if (!/sup|supervisor|ac_result|ac_item|sup_result|ac_results|ajax_listofoptions|optiondiv|option/.test(listHay)) {
      return false;
    }
    return Boolean(findSupervisorSearchInput());
  }

  function emitSupervisorAutocompleteStep(el) {
    const row = el.closest('li, [role="option"], tr') || el;
    const input = findSupervisorSearchInput();
    if (!input) return;
    markFieldInteracted(input);
    const { optionSelector, candidates, container } = optionContainerSelector(row);
    const sampleOptionText = String(
      (row.dataset && row.dataset.value) || row.textContent || ''
    ).trim().slice(0, 120);
    emit({
      role: ROLE.AUTOCOMPLETE,
      candidates: DOM.generateCandidateSelectors(input),
      optionSelector,
      optionCandidates: candidates,
      clickRel: relSelector(container, el),
      sampleValue: input.value || (pendingType && pendingType.el === input ? pendingType.value : ''),
      sampleOptionText,
      text: supervisorFieldText(input),
      tag: input.tagName.toLowerCase()
    });
    if (pendingType && pendingType.el === input) {
      pendingType.emitted = true;
      pendingType = null;
    }
  }

  // Clicks inside a date-picker calendar overlay (jQuery UI / flatpickr / bootstrap)
  // should not be recorded: the chosen date is captured from the input's own
  // value via the live input/blur path, and a calendar-cell selector is brittle.
  function isInsideDatePicker(el) {
    return !!(el && el.closest && el.closest('#ui-datepicker-div, .ui-datepicker, .flatpickr-calendar, .datepicker-dropdown'));
  }

  function handleClick(e) {
    if (!active) return;
    if (isInsideDatePicker(e.target)) return;
    const el = e.target.closest('a,button,[role="button"],[role="option"],li,div,span,input,select,td') || e.target;

    // MedHub procedure "+" add — always an autocomplete pick, even without typing first.
    if (isProcedureAddClick(el)) {
      emitProcedureAddStep(el);
      pendingType = null;
      return;
    }

    if (isSupervisorResultClick(el)) {
      emitSupervisorAutocompleteStep(el);
      return;
    }

    // Autocomplete detection: a recent type, and this click is on a different
    // element that looks like a results option.
    if (
      pendingType &&
      Date.now() - pendingType.ts < AUTOCOMPLETE_WINDOW_MS &&
      el !== pendingType.el &&
      !pendingType.el.contains(el) &&
      isOptionLike(el)
    ) {
      markFieldInteracted(pendingType.el);
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
      markFieldInteracted(el);
      emit({
        role: ROLE.INPUT,
        candidates: DOM.generateCandidateSelectors(el),
        sampleValue: el.value,
        text: fieldText(el),
        tag: 'select'
      });
    }
  }

  function handlePaste(e) {
    if (!active) return;
    const el = e.target;
    if (isTextEntry(el)) markFieldInteracted(el);
  }

  function start(cb, liveCb) {
    if (active) return;
    active = true;
    onStep = cb;
    onLiveInput = liveCb || null;
    stepSeq = 0;
    pendingType = null;
    liveInputTimer = null;
    fieldInteracted = new WeakMap();
    fieldFocusValue = new WeakMap();
    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('paste', handlePaste, true);
    document.addEventListener('change', handleChange, true);
    document.addEventListener('blur', handleBlur, true);
    document.addEventListener('click', handleClick, true);
  }

  function stop() {
    if (!active) return;
    flushPendingTypeAsInput();
    active = false;
    onStep = null;
    onLiveInput = null;
    if (liveInputTimer) clearTimeout(liveInputTimer);
    liveInputTimer = null;
    pendingType = null;
    document.removeEventListener('focusin', handleFocusIn, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('paste', handlePaste, true);
    document.removeEventListener('change', handleChange, true);
    document.removeEventListener('blur', handleBlur, true);
    document.removeEventListener('click', handleClick, true);
  }

  root.FAA_RECORDER = { start, stop, isActive: () => active };
})(typeof window !== 'undefined' ? window : globalThis);
