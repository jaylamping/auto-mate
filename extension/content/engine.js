/**
 * auto-mate replay engine (content script).
 *
 * Given a learned recipe and one normalized spreadsheet row, fills each field
 * and (unless dry-run) submits. Emits a structured action-log entry for every
 * field it touches so the side panel can build the audit report.
 */
(function (root) {
  const DOM = root.FAA_DOM;
  const { ROLE, FIELD, normalizeMatchKey, toMedHubDateString } = root.FAA_MSG;

  let abortFlag = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const DEFAULT_TYPE_CHAR_MS = 20;

  function abort() {
    abortFlag = true;
  }
  function resetAbort() {
    abortFlag = false;
  }

  async function waitFor(fn, { timeout = 8000, interval = 120 } = {}) {
    const start = Date.now();
    for (;;) {
      if (abortFlag) throw new Error('aborted');
      const v = fn();
      if (v) return v;
      if (Date.now() - start > timeout) return null;
      await sleep(interval);
    }
  }

  // React/Vue-friendly value setter that bypasses framework value tracking.
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fireInput(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fireKeystrokes(el) {
    // Some autocompletes only react to key events.
    for (const type of ['keydown', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: 'a' }));
    }
  }

  // After filling a field, MedHub re-validates required fields on blur/change to
  // enable the "Next"/submit button. We set values programmatically (which does
  // not move focus), so without this the last field never blurs and the button
  // can stay disabled even though every required field is filled.
  function commitField(el) {
    if (!el || el.nodeType !== 1) return;
    try {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) {}
    try {
      el.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    } catch (_) {
      try {
        el.dispatchEvent(new Event('blur', { bubbles: false }));
      } catch (_) {}
    }
    try {
      el.dispatchEvent(new Event('focusout', { bubbles: true }));
    } catch (_) {}
  }

  // MedHub's Procedure Date is a jQuery UI datepicker (class="datepicker_icon").
  // Focusing/typing opens a #ui-datepicker-div calendar overlay; if left open it
  // can sit on top of the next control and swallow the click. We type the value
  // directly (robust + locale-proof) and then explicitly dismiss the calendar.
  function isDatePickerField(el) {
    if (!el || el.nodeType !== 1) return false;
    const cls = el.className && typeof el.className === 'string' ? el.className : '';
    if (/datepicker|hasdatepicker|flatpickr/i.test(cls)) return true;
    const hay = `${el.getAttribute('name') || ''} ${el.id || ''}`;
    return /(^|[_\s-])date($|[_\s-])/i.test(hay);
  }

  function dismissDatePicker(el) {
    // Escape closes the jQuery UI datepicker; blur is the secondary dismissal.
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', keyCode: 27, which: 27 }));
    } catch (_) {}
    try {
      if (typeof el.blur === 'function') el.blur();
    } catch (_) {}
    // Hard fallback: force-hide any lingering calendar overlay so it can't
    // intercept the next click.
    const widgetSelectors = ['#ui-datepicker-div', '.ui-datepicker', '.flatpickr-calendar.open', '.datepicker-dropdown'];
    for (const sel of widgetSelectors) {
      try {
        document.querySelectorAll(sel).forEach((w) => {
          if (w.classList) w.classList.remove('open');
          if (w.style) w.style.display = 'none';
        });
      } catch (_) {}
    }
  }

  async function fillDateField(el, value, opts = {}) {
    const str = toMedHubDateString(value);
    dismissDatePicker(el);
    el.focus();
    // MedHub may prefill today's date. Clear first so typing/replay replaces it
    // instead of appending or leaving the datepicker's prior state active.
    setNativeValue(el, '');
    fireInput(el);
    // Live MedHub uses jQuery UI datepicker; setDate keeps widget state in sync.
    try {
      const win = el.ownerDocument && el.ownerDocument.defaultView;
      const jq = win && (win.jQuery || win.$);
      if (jq && jq.fn && jq.fn.datepicker && jq(el).datepicker) {
        const hasPicker =
          (el.classList && el.classList.contains('hasDatepicker')) ||
          typeof jq(el).data === 'function' && jq(el).data('datepicker');
        if (hasPicker) {
          setNativeValue(el, '');
          fireInput(el);
          jq(el).datepicker('setDate', str);
          jq(el).datepicker('hide');
          fireInput(el);
          dismissDatePicker(el);
          return;
        }
      }
    } catch (_) {}
    const charDelayMs = opts.charDelayMs != null ? opts.charDelayMs : 0;
    if (charDelayMs > 0) {
      await typeChars(el, str, charDelayMs);
    } else {
      setNativeValue(el, str);
      fireInput(el);
      fireKeystrokes(el);
    }
    dismissDatePicker(el);
  }

  async function typeInto(el, value, opts = {}) {
    const charDelayMs = opts.charDelayMs != null ? opts.charDelayMs : 0;
    if (charDelayMs > 0) {
      await typeChars(el, String(value), charDelayMs);
      if (isDatePickerField(el)) dismissDatePicker(el);
      return;
    }
    el.focus();
    if (el.isContentEditable) {
      el.textContent = '';
      el.textContent = String(value);
    } else {
      setNativeValue(el, '');
      fireInput(el);
      setNativeValue(el, String(value));
    }
    fireInput(el);
    fireKeystrokes(el);
    if (isDatePickerField(el)) dismissDatePicker(el);
  }

  /** Type one character at a time so autocompletes can filter incrementally. */
  async function typeChars(el, value, charDelayMs = DEFAULT_TYPE_CHAR_MS) {
    const str = String(value);
    el.focus();
    if (el.isContentEditable) {
      el.textContent = '';
    } else {
      setNativeValue(el, '');
    }
    fireInput(el);
    for (let i = 0; i < str.length; i++) {
      const partial = str.slice(0, i + 1);
      if (el.isContentEditable) {
        el.textContent = partial;
      } else {
        setNativeValue(el, partial);
      }
      fireInput(el);
      fireKeystrokes(el);
      if (i < str.length - 1 && charDelayMs > 0) {
        await sleep(charDelayMs);
      }
    }
  }

  function scoreOption(text, query) {
    const t = normalizeMatchKey(text);
    const q = normalizeMatchKey(query);
    if (!t || !q) return 0;
    if (t === q) return 100;
    if (t.startsWith(q)) return 80;
    if (q.startsWith(t)) return 75;
    if (t.includes(q)) return 60;
    if (q.includes(t)) return 55;
    const qt = String(query)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 0);
    if (!qt.length) return 0;
    const hits = qt.filter((w) => t.includes(w)).length;
    return Math.round((hits / qt.length) * 40);
  }

  const PROCEDURE_SEARCH_ALIASES = new Map(
    [
      ['CORONARY ANGIOGRAM', 'Coronary Angiography/Diagnostic Cath'],
      ['CORONARY ANGIOGRAM/POSSIBLE PTCA - CV', 'Coronary Angiography/Diagnostic Cath'],
      ['PTCA WITH STENT - CV', 'PTCA Stent'],
      ['PTCA - CV', 'PTCA Stent'],
      ['TRANSVENOUS PACEMAKER - CV', 'Pacemaker - Temporary'],
      ['IABP INSERTION - CV', 'IABP'],
      ['LEFT HEART CATH - CV', 'Left Heart Cath'],
      ['RIGHT HEART CATH - CV', 'Right Heart Cath'],
      ['LOWER EXTREMITY ANGIOGRAM/POSSIBLE PTA - CV', 'Peripheral Angiography'],
      ['AORTA BIFEMORAL ANGIOGRAM/POSSIBLE PTA/POSSIBLE STENT - CV', 'Peripheral Angiography'],
      ['ABDOMINAL AORTIC ANGIOGRAM/POSSIBLE PTA/POSSIBLE STENT - CV', 'Peripheral Angiography'],
      ['PERICARDIOCENTESIS - CV', 'Pericardiocentesis'],
      ['PATENT FORAMEN OVALE CLOSURE - CV', 'Atrial septal defect closure'],
      ['ABLATION ATRIAL FIB - CV', 'Ablation'],
      ['ABLATION PREMATURE VENTRICULAR CONTRACTION - CV', 'Ablation'],
      ['PPM LEADLESS SINGLE IMPLANT - CV', 'Pacemaker Permanent']
    ].map(([from, to]) => [normalizeMatchKey(from), to])
  );

  function procedureSearchQuery(value) {
    const raw = String(value == null ? '' : value).trim();
    return PROCEDURE_SEARCH_ALIASES.get(normalizeMatchKey(raw)) || raw;
  }

  /** Canonical option label — avoids scoring "+ CPT noise" in MedHub procedure rows. */
  function extractOptionLabel(optionEl) {
    if (!optionEl) return '';
    const dataName = optionEl.getAttribute && optionEl.getAttribute('data-name');
    if (dataName && String(dataName).trim()) return String(dataName).trim();
    const nameEl = optionEl.querySelector && optionEl.querySelector('.name');
    if (nameEl && nameEl.textContent.trim()) return nameEl.textContent.trim();
    if (optionEl.dataset && optionEl.dataset.value) return String(optionEl.dataset.value).trim();
    return (optionEl.textContent || '').trim();
  }

  function findLocationSelect() {
    return document.querySelector('select[name="locationID"]');
  }

  function findLocationOtherInput() {
    return document.querySelector('input[name="location_other"]');
  }

  /** Live MedHub only enables location_other after choosing OTHER on locationID. */
  function ensureLocationOtherEnabled() {
    const other = findLocationOtherInput();
    if (!other || !other.disabled) return other;
    const sel = findLocationSelect();
    if (!sel) return other;
    for (const opt of sel.options) {
      if ((opt.value || '') === '') {
        setNativeValue(sel, opt.value);
        fireInput(sel);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      }
    }
    return other;
  }

  async function fillLocationOther(el, value, opts = {}) {
    const target =
      el && el.name === 'location_other' ? el : findLocationOtherInput() || el;
    ensureLocationOtherEnabled();
    if (target && target.disabled) {
      throw new Error('Location specify field could not be enabled');
    }
    await typeInto(target, value, opts);
  }

  function setSelectByQuery(selectEl, query) {
    if (!selectEl || query == null || String(query).trim() === '') return null;
    const q = String(query).trim();
    const qk = normalizeMatchKey(q);
    for (const opt of selectEl.options) {
      if (opt.value === q) {
        setNativeValue(selectEl, opt.value);
        fireInput(selectEl);
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        return (opt.textContent || '').trim() || opt.value;
      }
    }
    for (const opt of selectEl.options) {
      const label = (opt.textContent || '').trim();
      const val = (opt.value || '').trim();
      if (!label && !val) continue;
      const lk = normalizeMatchKey(label);
      const vk = normalizeMatchKey(val);
      if (lk === qk || vk === qk || (qk.length >= 2 && (lk.includes(qk) || qk.includes(lk)))) {
        setNativeValue(selectEl, opt.value);
        fireInput(selectEl);
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        return label || val;
      }
    }
    return null;
  }

  async function fillLocation(el, value, opts = {}) {
    const v = String(value == null ? '' : value).trim();
    if (!v) return;
    const sel = findLocationSelect();
    if (sel) {
      for (const opt of sel.options) {
        const val = (opt.value || '').trim();
        const label = (opt.textContent || '').trim();
        if (val === '') continue;
        const lk = normalizeMatchKey(label);
        const vk = normalizeMatchKey(v);
        if (lk.includes(vk) || vk.includes(lk) || val === v) {
          setNativeValue(sel, opt.value);
          fireInput(sel);
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
    }
    await fillLocationOther(el, v, opts);
  }

  function supervisorNamesMatch(label, query) {
    const a = normalizeMatchKey(label);
    const b = normalizeMatchKey(query);
    if (!a || !b) return false;
    if (a === b) return true;
    const stripMd = (k) => (k.length > 2 && k.endsWith('md') ? k.slice(0, -2) : k);
    return stripMd(a) === stripMd(b);
  }

  function stripSupervisorContext(label) {
    return String(label || '').replace(/\s*\(.*/, '').trim();
  }

  function supervisorNameParts(value) {
    const base = stripSupervisorContext(value);
    const parts = base.split(',');
    if (parts.length < 2) return null;
    const rawLast = parts[0].trim().split(/\s+/)[0] || '';
    const rawFirst = parts[1].trim().split(/\s+/)[0] || '';
    const last = normalizeMatchKey(rawLast);
    const first = normalizeMatchKey(rawFirst);
    if (!last || !first) return null;
    return { rawLast, rawFirst, last, first, key: `${last}${first}` };
  }

  function supervisorResultMatches(label, query) {
    const a = normalizeMatchKey(label);
    const b = normalizeMatchKey(query);
    if (!a || !b) return false;
    const withoutParen = normalizeMatchKey(stripSupervisorContext(label));
    const labelParts = supervisorNameParts(label);
    const queryParts = supervisorNameParts(query);
    return (
      supervisorNamesMatch(label, query) ||
      a.startsWith(b) ||
      b.startsWith(withoutParen) ||
      (labelParts && queryParts && labelParts.key === queryParts.key)
    );
  }

  function supervisorSearchPlan(query) {
    const raw = String(query == null ? '' : query).trim();
    const parts = supervisorNameParts(raw);
    if (!parts) return { search: raw };
    const search = /['’]/.test(parts.rawLast) ? parts.rawFirst : parts.rawLast;
    return { search };
  }

  function findSupervisorListSelect() {
    const byId = document.getElementById('supSelect');
    if (byId && DOM.isVisible(byId)) return byId;
    // Live MedHub: the List tab pane holds <select name="supervisorID">.
    const live = document.querySelector('#procedures_supervisor_pane select[name="supervisorID"], select[name="supervisorID"]');
    if (live && DOM.isVisible(live)) return live;
    const panes = ['supListPane', 'procedures_supervisor_pane'];
    for (const id of panes) {
      const pane = document.getElementById(id);
      if (!pane) continue;
      const sel = pane.querySelector('select');
      if (sel && DOM.isVisible(sel)) return sel;
    }
    return null;
  }

  function trySelectSupervisorFromList(selectEl, query) {
    for (const opt of selectEl.options) {
      const label = (opt.textContent || '').trim();
      const val = (opt.value || '').trim();
      if (!label && !val) continue;
      if (supervisorNamesMatch(label, query) || supervisorNamesMatch(val, query)) {
        setNativeValue(selectEl, opt.value);
        fireInput(selectEl);
        // Idealized fixture mirrors the chosen label into a hidden field.
        // Live MedHub instead wires the <select> onchange to a hidden userID,
        // so only update the hidden field when it actually exists.
        const hidden = document.getElementById('supChosen');
        if (hidden) {
          setNativeValue(hidden, label || val);
          fireInput(hidden);
        }
        return label || val;
      }
    }
    return null;
  }

  function findSupervisorSearchTab() {
    const byId = document.getElementById('supTabSearch') || document.getElementById('supervisor_tab_2');
    if (byId) return byId;
    for (const link of document.querySelectorAll('a, button, [role="tab"]')) {
      const text = normalizeMatchKey(link.textContent || link.getAttribute('aria-label') || '');
      const onclick = String(link.getAttribute('onclick') || '').toLowerCase();
      const href = String(link.getAttribute('href') || '').toLowerCase();
      if (text === 'search' && link.closest('.sup-tabs, .mhSubTabs, #procedures_supervisor_pane, form')) return link;
      if ((onclick.includes('supervisor') || href.includes('supervisor')) && (onclick.includes('search') || href.includes('search'))) return link;
    }
    return null;
  }

  async function openSupervisorSearchTab() {
    try {
      const win = document.defaultView || root;
      if (win && typeof win.procedures_supervisor_tab === 'function') {
        win.procedures_supervisor_tab('search');
        await sleep(40);
        await resetSupervisorSearchInput();
        return;
      }
    } catch (_) {}
    const searchTab = findSupervisorSearchTab();
    if (searchTab) {
      searchTab.click();
      await waitFor(() => findSupervisorSearchInput() || findSupervisorChangeButton(), { timeout: 1500, interval: 50 });
      await resetSupervisorSearchInput();
    }
  }

  function elementFieldHay(el) {
    if (!el) return '';
    const name = DOM.accessibleNameFor ? DOM.accessibleNameFor(el) : '';
    return `${el.id || ''} ${el.name || ''} ${name}`.toLowerCase();
  }

  function isSupervisorLikeElement(el) {
    if (!el) return false;
    if (/supervis|attending|precept/.test(elementFieldHay(el))) return true;
    // Live MedHub Search tab: generic input[name="searchterms"] inside supervisor pane.
    if ((el.name === 'searchterms' || el.id === 'searchterms') && isInSupervisorPane(el)) return true;
    const method = document.getElementById('supervisor_method');
    return !!(method && method.value === 'search' && el.name === 'searchterms');
  }

  function isSupervisorSearchInput(el) {
    if (!el || el.nodeType !== 1) return false;
    const explicit =
      el.name === 'searchterms' ||
      el.id === 'searchterms' ||
      el.name === 'supervisor_search' ||
      el.id === 'supSearch' ||
      el.id === 'sup_search' ||
      el.id === 'supervisor_search';
    const hay = `${elementFieldHay(el)} ${el.getAttribute('placeholder') || ''}`.toLowerCase();
    const nameSearch = isInSupervisorPane(el) && /name/.test(hay) && /search/.test(hay);
    if (!explicit && !nameSearch) {
      return false;
    }
    return nameSearch || isInSupervisorPane(el) || el.name === 'supervisor_search' || el.id === 'supSearch' || el.id === 'sup_search' || el.id === 'supervisor_search';
  }

  function isInSupervisorPane(el) {
    return !!(el && el.closest && el.closest('#procedures_supervisor_pane'));
  }

  function isNotesLikeElement(el) {
    return /procedure\s*notes?|\bnotes?\b|\bcomments?\b/.test(elementFieldHay(el));
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
    if (byId && isTextEntry(byId) && isSupervisorSearchInput(byId)) return byId;
    const nodes = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])');
    for (const el of nodes) {
      if (isTextEntry(el) && isSupervisorSearchInput(el)) return el;
    }
    return null;
  }

  function findSupervisorChangeButton() {
    const scope = document.getElementById('procedures_supervisor_pane') || document;
    for (const el of scope.querySelectorAll('a, button, input[type="button"], input[type="submit"]')) {
      if (!DOM.isVisible(el)) continue;
      const text = normalizeMatchKey(el.textContent || el.value || el.getAttribute('aria-label') || '');
      const href = String(el.getAttribute('href') || '').toLowerCase();
      const onclick = String(el.getAttribute('onclick') || '').toLowerCase();
      if (text === 'change' || ((href.includes('supervisor') || onclick.includes('supervisor')) && (href.includes('change') || onclick.includes('change')))) {
        return el;
      }
    }
    return null;
  }

  async function resetSupervisorSearchInput() {
    const input = findSupervisorSearchInput();
    if (input) return input;
    const change = findSupervisorChangeButton();
    if (!change) return null;
    change.click();
    await sleep(80);
    return waitFor(() => findSupervisorSearchInput(), { timeout: 2000, interval: 50 });
  }

  // ---- Procedure search input ----------------------------------------------
  // At replay we always type the procedure name from the spreadsheet into the
  // search box, then pick the matching row. We resolve the real search input
  // here (rather than trusting the recorded candidates, which on the live page
  // can mis-resolve to the header nav "Procedures" link).
  function isProcedureSearchInput(el) {
    if (!el || !isTextEntry(el)) return false;
    const hay = elementFieldHay(el) + ' ' + (el.getAttribute('placeholder') || '').toLowerCase();
    if (/date|note|location|site|facility|patientid|encounter|mrn|supervis/.test(hay)) return false;
    if (/procedures?[_\s]*search/.test(hay)) return true;
    return /\bproc\b/.test(hay) && /\bsearch\b/.test(hay);
  }

  function findProcedureSearchInput() {
    const direct = [
      '#procedures_searchterms',
      'input[name="procedures_searchterms"]',
      '#procSearch',
      '#proc_search'
    ];
    for (const sel of direct) {
      const el = document.querySelector(sel);
      if (el && isTextEntry(el) && DOM.isVisible(el)) return el;
    }
    for (const el of document.querySelectorAll('input, textarea')) {
      if (isProcedureSearchInput(el) && DOM.isVisible(el)) return el;
    }
    return null;
  }

  // ---- Supervisor "Other" free-text tab ------------------------------------
  function isSupervisorOtherElement(el) {
    return !!(el && (el.id === 'supervisor_other' || el.name === 'supervisor_other'));
  }

  function stepUsesSupervisorOther(step) {
    return (step.candidates || []).some((c) =>
      /supervisor_other|supervisor_tab_3|procedures_supervisor_tab\('other'/i.test(String(c.value || ''))
    );
  }

  function findSupervisorOtherTab() {
    const byId = document.getElementById('supTabOther') || document.getElementById('supervisor_tab_3');
    if (byId) return byId;
    const byHandler = document.querySelector('[onclick*="procedures_supervisor_tab(\'other\'"]');
    if (byHandler) return byHandler;
    const tabs = document.querySelector('.sup-tabs, .mhSubTabs');
    if (tabs) {
      for (const link of tabs.querySelectorAll('a, button, [role="tab"]')) {
        if (normalizeMatchKey(link.textContent) === 'other') return link;
      }
    }
    return null;
  }

  function findSupervisorOtherInput() {
    const el =
      document.getElementById('supervisor_other') ||
      document.querySelector('input[name="supervisor_other"]');
    return el && isTextEntry(el) ? el : null;
  }

  async function ensureSupervisorOtherOpen() {
    let input = findSupervisorOtherInput();
    if (input && DOM.isVisible(input) && !input.disabled) return input;
    const tab = findSupervisorOtherTab();
    if (tab) {
      tab.click();
      await sleep(40);
    }
    input = findSupervisorOtherInput();
    if (input && input.disabled) input.disabled = false;
    return input || null;
  }

  // Supervisor is free text on the "Other" tab: open it, type the name, and sync
  // the hidden fields MedHub uses to persist the value.
  async function selectSupervisorFromOther(query, opts = {}) {
    const q = String(query == null ? '' : query).trim();
    if (!q) throw new Error('Empty supervisor value');
    const input = await ensureSupervisorOtherOpen();
    if (!input) throw new Error('Supervisor "Other" field not available');
    const charDelayMs = opts.typeCharDelayMs != null ? opts.typeCharDelayMs : DEFAULT_TYPE_CHAR_MS;
    await typeInto(input, q, { charDelayMs });
    const save = document.getElementById('supervisor_other_save');
    if (save) {
      setNativeValue(save, q);
      fireInput(save);
    }
    const method = document.getElementById('supervisor_method');
    if (method) {
      setNativeValue(method, 'other');
      fireInput(method);
    }
    return q;
  }

  function visibleSupervisorOptions(optionSelector) {
    const sel =
      optionSelector ||
      '#ajax_listOfOptions div.optionDiv, #procedures_supervisor_pane div.optionDiv, li.sup_result, #ajax_listOfOptions [class*="option"]';
    return Array.from(document.querySelectorAll(sel))
      .filter((o) => DOM.isVisible(o) && extractOptionLabel(o).length > 0);
  }

  async function selectSupervisorFromSearch(inputEl, optionSelector, query, opts = {}) {
    if (!inputEl || !DOM.isVisible(inputEl)) {
      await openSupervisorSearchTab();
      inputEl = await resetSupervisorSearchInput();
    }
    if (!inputEl) throw new Error('Supervisor search input not found');

    const plan = supervisorSearchPlan(query);
    const q = plan.search;
    if (!q) throw new Error('Empty supervisor value');

    const timeout = opts.autocompleteTimeoutMs != null ? opts.autocompleteTimeoutMs : 9000;
    const charDelayMs = opts.typeCharDelayMs != null ? opts.typeCharDelayMs : DEFAULT_TYPE_CHAR_MS;
    const quickWaitMs = Math.max(charDelayMs + 60, 100);

    inputEl.focus();
    if (inputEl.isContentEditable) {
      inputEl.textContent = '';
    } else {
      setNativeValue(inputEl, '');
    }
    fireInput(inputEl);

    for (let len = 1; len <= q.length; len++) {
      const partial = q.slice(0, len);
      if (inputEl.isContentEditable) {
        inputEl.textContent = partial;
      } else {
        setNativeValue(inputEl, partial);
      }
      fireInput(inputEl);
      fireKeystrokes(inputEl);

      await waitFor(() => visibleSupervisorOptions(optionSelector).length > 0, {
        timeout: len < q.length ? quickWaitMs : timeout,
        interval: 25
      });
      const visible = visibleSupervisorOptions(optionSelector);

      if (visible.length === 1) {
        const chosen = extractOptionLabel(visible[0]);
        if (!supervisorResultMatches(chosen, query)) {
          if (len < q.length) {
            if (charDelayMs > 0) await sleep(charDelayMs);
            continue;
          }
          throw new Error(`Supervisor result "${chosen}" does not match "${query}"`);
        }
        visible[0].click();
        await sleep(50);
        return stripSupervisorContext(chosen) || chosen;
      }
      if (visible.length === 0 && len < q.length) {
        if (charDelayMs > 0) await sleep(charDelayMs);
        continue;
      }
      if (visible.length > 1 && len < q.length) {
        if (charDelayMs > 0) await sleep(charDelayMs);
        continue;
      }

      if (visible.length === 0) {
        throw new Error(`No autocomplete results for "${query}"`);
      }
      const exact = visible.find((o) => supervisorResultMatches(extractOptionLabel(o), query));
      if (exact) {
        const chosen = extractOptionLabel(exact);
        exact.click();
        await sleep(50);
        return stripSupervisorContext(chosen) || chosen;
      }
      throw new Error(`Multiple supervisor matches for "${query}" (${visible.length} results)`);
    }

    throw new Error(`Could not resolve supervisor "${query}"`);
  }

  async function selectSupervisor(query, step, opts = {}) {
    const listSelect = findSupervisorListSelect();
    if (listSelect) {
      const fromList = trySelectSupervisorFromList(listSelect, query);
      if (fromList) return fromList;
    }

    let inputEl = findSupervisorSearchInput();
    if (!inputEl) {
      const resolved = DOM.resolveElement(step.candidates);
      if (resolved && isSupervisorSearchInput(resolved)) inputEl = resolved;
    }
    if (!inputEl) {
      await openSupervisorSearchTab();
      inputEl = await waitFor(() => {
        const found = findSupervisorSearchInput();
        if (found) return found;
        const resolved = DOM.resolveElement(step.candidates);
        return resolved && isSupervisorSearchInput(resolved) ? resolved : null;
      }, { timeout: 3000, interval: 80 });
    }
    if (!inputEl) inputEl = await resetSupervisorSearchInput();
    if (!inputEl) {
      const tab = findSupervisorSearchTab();
      throw new Error(`Supervisor search input not found for "${query}"${tab ? ' after opening Search tab' : ' (Search tab not found)'}`);
    }

    return selectSupervisorFromSearch(inputEl, step.optionSelector, query, opts);
  }

  function isSkippableSupervisorNavClick(step) {
    if (step.role !== ROLE.CLICK) return false;
    if (
      (step.candidates || []).some((c) =>
        /supTabSearch|supervisor_tab_2|procedures_supervisor_tab\('search'/i.test(String(c.value || ''))
      )
    ) {
      return true;
    }
    const el = DOM.resolveElement(step.candidates);
    if (!el) return false;
    const id = (el.id || '').toLowerCase();
    if (id === 'suptabsearch' || id === 'supervisor_tab_2') return true;
    const onclick = (el.getAttribute && el.getAttribute('onclick')) || '';
    if (/procedures_supervisor_tab\('search'/i.test(onclick)) return true;
    if (normalizeMatchKey(el.textContent) === 'search' && el.closest('.sup-tabs, .mhSubTabs')) return true;
    return false;
  }

  async function selectFromAutocomplete(inputEl, optionSelector, query, opts = {}) {
    const timeout = opts.autocompleteTimeoutMs != null ? opts.autocompleteTimeoutMs : 9000;
    const charDelayMs = opts.typeCharDelayMs != null ? opts.typeCharDelayMs : 0;
    await typeInto(inputEl, query, { charDelayMs });
    const options = await waitFor(
      () => {
        const list = Array.from(document.querySelectorAll(optionSelector || '[role="option"]'))
          .filter((o) => DOM.isVisible(o) && extractOptionLabel(o).length > 0);
        return list.length ? list : null;
      },
      { timeout }
    );
    if (!options) {
      throw new Error(`No autocomplete results for "${query}"`);
    }
    let best = null;
    let bestScore = -1;
    let bestLabelLen = Infinity;
    for (const o of options) {
      const label = extractOptionLabel(o);
      const s = scoreOption(label, query);
      // Same score → shorter label wins (Biopsy beats Biopsy w/ scalpel on substring ties).
      if (s > bestScore || (s === bestScore && s > 0 && label.length < bestLabelLen)) {
        bestScore = s;
        best = o;
        bestLabelLen = label.length;
      }
    }
    if (!best || bestScore < 40) {
      const hint = best ? extractOptionLabel(best) : 'none';
      throw new Error(`No good match for "${query}" (best option: "${String(hint).slice(0, 60)}")`);
    }
    const chosenText = extractOptionLabel(best);
    // Some forms (e.g. MedHub's procedure list) require clicking a control
    // *inside* the matched row (a "+" add link) rather than the row text. If a
    // relative click target was recorded, use it; otherwise click the match.
    let clickTarget = best;
    if (opts.clickRel) {
      try {
        const inner = best.querySelector(opts.clickRel);
        if (inner) clickTarget = inner;
      } catch (_) {}
    }
    try {
      if (typeof clickTarget.scrollIntoView === 'function') clickTarget.scrollIntoView({ block: 'center' });
    } catch (_) {
      /* not implemented in headless DOM */
    }
    clickTarget.click();
    await sleep(150);
    return chosenText;
  }

  const OPTIONAL_FIELDS = new Set([
    FIELD.GENDER,
    FIELD.AGE,
    FIELD.DIAGNOSIS,
    FIELD.COMPLICATIONS,
    FIELD.NOTES
  ]);

  function isOptionalField(field) {
    return OPTIONAL_FIELDS.has(field);
  }

  function shouldResolveWithoutVisibility(step, found) {
    if (!found) return false;
    if (step.role === ROLE.AUTOCOMPLETE && step.field === FIELD.SUPERVISOR) return true;
    // Supervisor "Other" field may be hidden until its tab is opened at replay.
    if (step.role === ROLE.INPUT && step.field === FIELD.SUPERVISOR && isSupervisorOtherElement(found)) return true;
    if (step.role === ROLE.INPUT && step.field === FIELD.NOTES && !isNotesLikeElement(found)) return true;
    if (
      step.role === ROLE.INPUT &&
      step.field === FIELD.SUPERVISOR &&
      !isSupervisorLikeElement(found) &&
      found.tagName.toLowerCase() !== 'select'
    ) {
      return true;
    }
    return false;
  }

  function valueForField(field, row) {
    switch (field) {
      case FIELD.DATE:
        return row.date;
      case FIELD.LOCATION:
        return row.location || 'IMC';
      case FIELD.SUPERVISOR:
        return row.supervisor;
      case FIELD.ENCOUNTER:
      case 'mrn':
        return row.mrn;
      case FIELD.GENDER:
        return row.gender;
      case FIELD.AGE:
        return row.age;
      case FIELD.DIAGNOSIS:
        return row.diagnosis;
      case FIELD.COMPLICATIONS:
        return row.complications;
      case FIELD.NOTES:
        return row.notes;
      default:
        return undefined;
    }
  }

  function isProcedureRemoveControl(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    const type = String(el.getAttribute('type') || '').toLowerCase();
    if (tag !== 'a' && tag !== 'button' && el.getAttribute('role') !== 'button' && !(tag === 'input' && ['button', 'submit', 'image'].includes(type))) return false;
    const hay = `${el.className || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.value || ''}`.toLowerCase();
    if (/\bremove\b|\bdelete\b|\bunspec/.test(hay)) return true;
    const txt = (el.textContent || '').trim();
    return /\bdelete\b/i.test(txt) || txt === '×' || txt === '✕' || txt === 'X' || txt === 'x';
  }

  function isSelectedProcedureTable(table) {
    if (!table || table.nodeType !== 1) return false;
    const text = normalizeMatchKey(table.textContent || '');
    return text.includes('procedure') && text.includes('actions') && text.includes('role');
  }

  function findProceduresTable() {
    const byId = document.getElementById('selected_procedures');
    if (byId) return byId;
    for (const heading of document.querySelectorAll('h1, h2, h3, .mhSectionHeader, caption')) {
      const text = (heading.textContent || '').trim();
      if (!/^procedures\b/i.test(text)) continue;
      let sibling = heading.nextElementSibling;
      while (sibling) {
        if (sibling.tagName === 'TABLE') return sibling;
        const nested = sibling.querySelector && sibling.querySelector('table');
        if (nested) return nested;
        sibling = sibling.nextElementSibling;
      }
    }
    for (const table of document.querySelectorAll('table')) {
      if (isSelectedProcedureTable(table)) return table;
    }
    return null;
  }

  function isProcedureTableDeleteControl(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest('#procedures_list, #AddStandardProcedure')) return false;
    const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''} ${el.value || ''}`;
    return /\bdelete\b/i.test(label) || isProcedureRemoveControl(el);
  }

  function isVisibleProcedureRow(row) {
    if (!row || row.nodeType !== 1) return false;
    if (row.id === 'prow_0' || row.id === 'noProcRow') return false;
    const rowText = normalizeMatchKey(row.textContent || '');
    if (rowText.includes('noprocedures') || rowText.includes('norequired')) return false;
    if (row.id && /^prow_\d+$/.test(row.id)) {
      const cls = String(row.className || '');
      if (/\bhidden\b/.test(cls)) return false;
      const titleEl = document.getElementById(row.id + '_title');
      if (titleEl && (titleEl.textContent || '').trim()) return true;
      return DOM.isVisible(row);
    }
    return DOM.isVisible(row);
  }

  function findVisibleProcedureRows() {
    const rows = [];
    const seen = new Set();
    const table = findProceduresTable();
    if (table) {
      for (const row of table.querySelectorAll('tr')) {
        if (!isVisibleProcedureRow(row) || seen.has(row)) continue;
        seen.add(row);
        rows.push(row);
      }
    }
    for (const row of document.querySelectorAll('tr[id^="prow_"]')) {
      if (seen.has(row)) continue;
      if (!isVisibleProcedureRow(row)) continue;
      seen.add(row);
      rows.push(row);
    }
    return rows;
  }

  function procedureDeleteIndexFromControl(el) {
    if (!el) return null;
    const href = el.getAttribute('href') || '';
    const onclick = el.getAttribute('onclick') || '';
    const hay = `${href} ${onclick}`;
    const m = hay.match(/procedures_delete\s*\(\s*(\d+)\s*\)/);
    return m ? Number(m[1]) : null;
  }

  function invokeProcedureDelete(control) {
    if (!control) return false;
    const idx = procedureDeleteIndexFromControl(control);
    if (idx != null && typeof window.procedures_delete === 'function') {
      window.procedures_delete(idx);
      return true;
    }
    try {
      control.click();
      return true;
    } catch (_) {}
    return false;
  }

  function findProcedureDeleteButtons() {
    const buttons = [];
    const seen = new Set();
    for (const row of findVisibleProcedureRows()) {
      for (const el of row.querySelectorAll('a, button, input, [role="button"]')) {
        if (!isProcedureTableDeleteControl(el)) continue;
        if (seen.has(el)) continue;
        seen.add(el);
        buttons.push(el);
      }
    }
    const table = findProceduresTable();
    if (table) {
      for (const el of table.querySelectorAll(
        'a[href*="procedures_delete"], button[onclick*="procedures_delete"], [onclick*="procedures_delete"]'
      )) {
        if (seen.has(el)) continue;
        const row = el.closest('tr');
        if (row && !isVisibleProcedureRow(row)) continue;
        if (!isProcedureTableDeleteControl(el)) continue;
        seen.add(el);
        buttons.push(el);
      }
    }
    return buttons;
  }

  async function clearSelectedProcedures(fieldDelayMs = 100) {
    const table = findProceduresTable();
    if (table && typeof table.scrollIntoView === 'function') {
      try {
        table.scrollIntoView({ block: 'center' });
      } catch (_) {}
    }
    let cleared = 0;
    const pause = Math.max(80, Math.min(fieldDelayMs, 150));
    for (let attempt = 0; attempt < 40; attempt++) {
      let acted = false;
      for (const row of findVisibleProcedureRows()) {
        if (abortFlag) break;
        const prowMatch = row.id && row.id.match(/^prow_(\d+)$/);
        if (prowMatch && typeof window.procedures_delete === 'function') {
          window.procedures_delete(Number(prowMatch[1]));
          cleared++;
          acted = true;
          await sleep(pause);
          continue;
        }
        for (const el of row.querySelectorAll('a, button, input, [role="button"]')) {
          if (!isProcedureTableDeleteControl(el)) continue;
          invokeProcedureDelete(el);
          cleared++;
          acted = true;
          await sleep(pause);
          break;
        }
      }
      if (!acted) {
        const buttons = findProcedureDeleteButtons();
        if (!buttons.length) break;
        for (const btn of buttons) {
          if (abortFlag) break;
          invokeProcedureDelete(btn);
          cleared++;
          await sleep(pause);
        }
        acted = buttons.length > 0;
      }
      if (!findVisibleProcedureRows().length) break;
      if (!acted) break;
      await sleep(120);
    }
    return cleared;
  }

  function findLogAnotherCheckbox() {
    const byName = document.querySelector('input[type="checkbox"][name="log_another"]');
    if (byName) return byName;
    const byId = document.getElementById('logAnother');
    if (byId && String(byId.type).toLowerCase() === 'checkbox') return byId;
    for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
      const label =
        cb.closest('label') ||
        (cb.id ? document.querySelector(`label[for="${CSS.escape(cb.id)}"]`) : null);
      const hay = `${label ? label.textContent : ''} ${cb.getAttribute('aria-label') || ''}`.toLowerCase();
      if (/log\s*another\s*procedure/.test(hay)) return cb;
    }
    return null;
  }

  async function ensureLogAnotherProcedure(fieldDelayMs = 100) {
    const cb = findLogAnotherCheckbox();
    if (!cb) return { found: false, checked: false };
    if (cb.checked) return { found: true, checked: true, already: true };
    cb.click();
    if (!cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      cb.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await sleep(Math.min(fieldDelayMs, 150));
    return { found: true, checked: cb.checked, already: false };
  }

  function hasMoreRowsAfter(index, total) {
    if (index == null || total == null) return false;
    return index < total - 1;
  }

  /**
   * @param {object} recipe
   * @param {object} row normalized { date, supervisor, mrn, procedures:[], location? }
   * @param {object} opts { dryRun, onAction, fieldDelayMs, index, total }
   * @returns {Promise<{ok:boolean, actions:Array}>}
   */
  async function runRow(recipe, row, opts = {}) {
    resetAbort();
    const {
      dryRun = false,
      onAction = () => {},
      fieldDelayMs = 200,
      autocompleteTimeoutMs,
      typeCharDelayMs,
      index,
      total
    } = opts;
    const acOpts = {
      autocompleteTimeoutMs,
      typeCharDelayMs: typeCharDelayMs != null ? typeCharDelayMs : DEFAULT_TYPE_CHAR_MS
    };
    const actions = [];

    const record = (entry) => {
      const full = { ts: new Date().toISOString(), mrn: row.mrn, ...entry };
      actions.push(full);
      onAction(full);
    };

    const clearedProcs = await clearSelectedProcedures(fieldDelayMs);
    if (clearedProcs > 0) {
      record({
        field: FIELD.PROCEDURE,
        role: ROLE.CLICK,
        outcome: 'success',
        detail: `Cleared ${clearedProcs} prior procedure(s)`
      });
    }

    for (const step of recipe.steps) {
      if (abortFlag) {
        record({ field: step.field, role: step.role, outcome: 'aborted', detail: 'Stopped by user' });
        return { ok: false, actions, aborted: true };
      }

      try {
        const el = await waitFor(() => {
          const found = DOM.resolveElement(step.candidates);
          if (!found) return null;
          if (shouldResolveWithoutVisibility(step, found)) return found;
          return DOM.isVisible(found) ? found : null;
        });
        const needsVisibleEl =
          step.role !== ROLE.SUBMIT &&
          !isSkippableSupervisorNavClick(step) &&
          !(step.role === ROLE.AUTOCOMPLETE && step.field === FIELD.SUPERVISOR);
        if (!el && needsVisibleEl) {
          if (isOptionalField(step.field)) {
            record({
              field: step.field,
              role: step.role,
              outcome: 'skipped',
              detail: 'Field not found on page'
            });
            await sleep(fieldDelayMs);
            continue;
          }
          record({ field: step.field, role: step.role, outcome: 'failed', detail: 'Field not found on page' });
          return { ok: false, actions, failedField: step.field };
        }

        if (step.role === ROLE.CLICK) {
          if (isSkippableSupervisorNavClick(step)) {
            record({
              field: step.field,
              role: step.role,
              outcome: 'skipped',
              detail: 'Supervisor Search tab — picker handles List/Search'
            });
          } else {
            el.click();
            record({ field: step.field, role: step.role, outcome: 'success', detail: 'clicked' });
          }
        } else if (step.role === ROLE.STATIC) {
          const v = step.staticValue != null ? step.staticValue : valueForField(step.field, row);
          if (step.field === FIELD.LOCATION) {
            await fillLocation(el, v, { charDelayMs: typeCharDelayMs });
          } else if (el.tagName.toLowerCase() === 'select') {
            setSelectByQuery(el, v);
          } else {
            await typeInto(el, v);
          }
          record({ field: step.field, role: step.role, value: v, outcome: 'success' });
        } else if (step.role === ROLE.INPUT) {
          const v = valueForField(step.field, row);
          if (v == null || v === '') {
            record({ field: step.field, role: step.role, outcome: 'skipped', detail: 'No value in row' });
          } else if (
            step.field === FIELD.NOTES &&
            el &&
            !isNotesLikeElement(el)
          ) {
            record({
              field: step.field,
              role: step.role,
              outcome: 'skipped',
              detail: 'Wrong target for Procedure Notes — not typing into supervisor/search field'
            });
          } else if (
            step.field === FIELD.SUPERVISOR &&
            el &&
            !isSupervisorLikeElement(el) &&
            el.tagName.toLowerCase() !== 'select'
          ) {
            record({
              field: step.field,
              role: step.role,
              outcome: 'skipped',
              detail: 'Wrong target for Supervisor'
            });
          } else if (step.field === FIELD.SUPERVISOR && isSupervisorOtherElement(el)) {
            const chosen = await selectSupervisor(v, step, acOpts);
            record({ field: step.field, role: step.role, value: v, chosen, outcome: 'success' });
          } else if (el.tagName.toLowerCase() === 'select') {
            setSelectByQuery(el, v);
            record({ field: step.field, role: step.role, value: v, outcome: 'success' });
          } else if (step.field === FIELD.DATE || isDatePickerField(el)) {
            await fillDateField(el, v, { charDelayMs: typeCharDelayMs });
            record({ field: step.field, role: step.role, value: v, outcome: 'success' });
          } else if (step.field === FIELD.LOCATION) {
            await fillLocation(el, v, { charDelayMs: typeCharDelayMs });
            record({ field: step.field, role: step.role, value: v, outcome: 'success' });
          } else {
            await typeInto(el, v);
            record({ field: step.field, role: step.role, value: v, outcome: 'success' });
          }
        } else if (step.role === ROLE.AUTOCOMPLETE) {
          if (step.field === FIELD.PROCEDURE && Array.isArray(row.procedures)) {
            for (const proc of row.procedures) {
              if (abortFlag) break;
              if (!proc || String(proc).trim() === '') {
                record({ field: step.field, role: step.role, outcome: 'skipped', detail: 'No value in row' });
                continue;
              }
              // Always type the procedure name into the real search box, then
              // pick the matching row. Prefer the live search input over the
              // recorded candidates (which can mis-resolve to the nav link).
              const inputEl = await waitFor(() => {
                const f = findProcedureSearchInput() || DOM.resolveElement(step.candidates);
                return f && DOM.isVisible(f) ? f : null;
              });
              if (!inputEl) {
                record({ field: step.field, role: step.role, value: proc, outcome: 'failed', detail: 'Procedure field not found' });
                return { ok: false, actions, failedField: step.field };
              }
              try {
                const searchValue = procedureSearchQuery(proc);
                const chosen = await selectFromAutocomplete(inputEl, step.optionSelector, searchValue, { ...acOpts, clickRel: step.clickRel });
                record({
                  field: step.field,
                  role: step.role,
                  value: proc,
                  chosen,
                  outcome: 'success',
                  detail: searchValue !== proc ? `searched "${searchValue}"` : ''
                });
              } catch (err) {
                const searchValue = procedureSearchQuery(proc);
                const detail = searchValue !== proc ? `${err.message}; searched "${searchValue}"` : err.message;
                record({ field: step.field, role: step.role, value: proc, outcome: 'failed', detail });
                return { ok: false, actions, failedField: step.field };
              }
              await sleep(fieldDelayMs);
            }
          } else {
            const v = valueForField(step.field, row);
            if (v == null || v === '') {
              record({ field: step.field, role: step.role, outcome: 'skipped', detail: 'No value in row' });
            } else if (step.field === FIELD.SUPERVISOR) {
              const chosen = await selectSupervisor(v, step, acOpts);
              record({ field: step.field, role: step.role, value: v, chosen, outcome: 'success' });
            } else {
              const chosen = await selectFromAutocomplete(el, step.optionSelector, v, { ...acOpts, clickRel: step.clickRel });
              record({ field: step.field, role: step.role, value: v, chosen, outcome: 'success' });
            }
          }
        } else if (step.role === ROLE.SUBMIT) {
          if (dryRun) {
            record({ field: step.field, role: step.role, outcome: 'skipped', detail: 'DRY RUN - not submitted' });
          } else {
            const submitEl = el || DOM.resolveElement(step.candidates);
            if (!submitEl) {
              record({ field: step.field, role: step.role, outcome: 'failed', detail: 'Submit control not found' });
              return { ok: false, actions, failedField: step.field };
            }
            if (hasMoreRowsAfter(index, total)) {
              const logAnother = await ensureLogAnotherProcedure(fieldDelayMs);
              if (!logAnother.found) {
                record({
                  field: FIELD.CLICK,
                  role: ROLE.CLICK,
                  outcome: 'skipped',
                  detail: 'Log Another Procedure checkbox not found'
                });
              } else if (!logAnother.checked) {
                record({
                  field: FIELD.CLICK,
                  role: ROLE.CLICK,
                  outcome: 'failed',
                  detail: 'Could not check Log Another Procedure'
                });
                return { ok: false, actions, failedField: step.field };
              } else {
                record({
                  field: FIELD.CLICK,
                  role: ROLE.CLICK,
                  outcome: 'success',
                  detail: logAnother.already
                    ? 'Log Another Procedure already checked'
                    : 'Checked Log Another Procedure for next row'
                });
              }
            }
            submitEl.click();
            record({ field: step.field, role: step.role, outcome: 'success', detail: 'Submitted' });
          }
        }

        // Nudge the page's required-field validation so the Next/submit button
        // enables. Only for plain fills — autocomplete picks already commit via
        // their own option click and must not be blurred mid-selection.
        if ((step.role === ROLE.INPUT || step.role === ROLE.STATIC) && el) {
          commitField(el);
        }
      } catch (err) {
        if (err && err.message === 'aborted') {
          record({ field: step.field, role: step.role, outcome: 'aborted', detail: 'Stopped by user' });
          return { ok: false, actions, aborted: true };
        }
        record({ field: step.field, role: step.role, outcome: 'failed', detail: err.message });
        return { ok: false, actions, failedField: step.field };
      }

      await sleep(fieldDelayMs);
    }

    return { ok: true, actions };
  }

  root.FAA_ENGINE = { runRow, abort, resetAbort };
})(typeof window !== 'undefined' ? window : globalThis);
