/**
 * auto-mate replay engine (content script).
 *
 * Given a learned recipe and one normalized spreadsheet row, fills each field
 * and (unless dry-run) submits. Emits a structured action-log entry for every
 * field it touches so the side panel can build the audit report.
 */
(function (root) {
  const DOM = root.FAA_DOM;
  const { ROLE, FIELD, normalizeMatchKey } = root.FAA_MSG;

  let abortFlag = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const DEFAULT_TYPE_CHAR_MS = 50;

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

  async function typeInto(el, value, opts = {}) {
    const charDelayMs = opts.charDelayMs != null ? opts.charDelayMs : 0;
    if (charDelayMs > 0) {
      await typeChars(el, String(value), charDelayMs);
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

  function supervisorNamesMatch(label, query) {
    const a = normalizeMatchKey(label);
    const b = normalizeMatchKey(query);
    if (!a || !b) return false;
    if (a === b) return true;
    const stripMd = (k) => (k.length > 2 && k.endsWith('md') ? k.slice(0, -2) : k);
    return stripMd(a) === stripMd(b);
  }

  function findSupervisorListSelect() {
    const byId = document.getElementById('supSelect');
    if (byId && DOM.isVisible(byId)) return byId;
    const pane = document.getElementById('supListPane');
    if (pane) {
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
        const hidden = document.getElementById('supChosen');
        if (hidden) setNativeValue(hidden, label || val);
        fireInput(hidden);
        return label || val;
      }
    }
    return null;
  }

  function findSupervisorSearchTab() {
    const byId = document.getElementById('supTabSearch');
    if (byId) return byId;
    const tabs = document.querySelector('.sup-tabs');
    if (!tabs) return null;
    for (const link of tabs.querySelectorAll('a, button, [role="tab"]')) {
      if (normalizeMatchKey(link.textContent) === 'search') return link;
    }
    return null;
  }

  function elementFieldHay(el) {
    if (!el) return '';
    const name = DOM.accessibleNameFor ? DOM.accessibleNameFor(el) : '';
    return `${el.id || ''} ${el.name || ''} ${name}`.toLowerCase();
  }

  function isSupervisorLikeElement(el) {
    return /supervis|attending|precept/.test(elementFieldHay(el));
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
    const byId = document.getElementById('supSearch') || document.getElementById('sup_search');
    if (byId && isTextEntry(byId)) return byId;
    const nodes = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])');
    for (const el of nodes) {
      if (isTextEntry(el) && isSupervisorLikeElement(el)) return el;
    }
    return null;
  }

  function visibleSupervisorOptions(optionSelector) {
    return Array.from(document.querySelectorAll(optionSelector || 'li.sup_result'))
      .filter((o) => DOM.isVisible(o) && extractOptionLabel(o).length > 0);
  }

  async function selectSupervisorFromSearch(inputEl, optionSelector, query, opts = {}) {
    const searchTab = findSupervisorSearchTab();
    if (searchTab) {
      searchTab.click();
      await sleep(40);
    }

    const q = String(query).trim();
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
        visible[0].click();
        await sleep(50);
        return chosen;
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
      const exact = visible.find((o) => supervisorNamesMatch(extractOptionLabel(o), query));
      if (exact) {
        const chosen = extractOptionLabel(exact);
        exact.click();
        await sleep(50);
        return chosen;
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
    if (!inputEl) inputEl = DOM.resolveElement(step.candidates);
    if (!inputEl) throw new Error('Supervisor search input not found');

    return selectSupervisorFromSearch(inputEl, step.optionSelector, query, opts);
  }

  function isSkippableSupervisorNavClick(step) {
    if (step.role !== ROLE.CLICK) return false;
    if ((step.candidates || []).some((c) => /supTabSearch/i.test(String(c.value || '')))) return true;
    const el = DOM.resolveElement(step.candidates);
    if (!el) return false;
    const id = (el.id || '').toLowerCase();
    if (id === 'suptabsearch') return true;
    if (normalizeMatchKey(el.textContent) === 'search' && el.closest('.sup-tabs')) return true;
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

  /**
   * Run a single row against the recipe.
   * @param {object} recipe
   * @param {object} row normalized { date, supervisor, mrn, procedures:[], location? }
   * @param {object} opts { dryRun, onAction, fieldDelayMs }
   * @returns {Promise<{ok:boolean, actions:Array}>}
   */
  async function runRow(recipe, row, opts = {}) {
    resetAbort();
    const { dryRun = false, onAction = () => {}, fieldDelayMs = 250, autocompleteTimeoutMs, typeCharDelayMs } = opts;
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
          if (el.tagName.toLowerCase() === 'select') {
            setNativeValue(el, String(v));
            fireInput(el);
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
          } else if (el.tagName.toLowerCase() === 'select') {
            setNativeValue(el, String(v));
            fireInput(el);
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
              const inputEl = await waitFor(() => {
                const f = DOM.resolveElement(step.candidates);
                return f && DOM.isVisible(f) ? f : null;
              });
              if (!inputEl) {
                record({ field: step.field, role: step.role, value: proc, outcome: 'failed', detail: 'Procedure field not found' });
                return { ok: false, actions, failedField: step.field };
              }
              try {
                const chosen = await selectFromAutocomplete(inputEl, step.optionSelector, proc, { ...acOpts, clickRel: step.clickRel });
                record({ field: step.field, role: step.role, value: proc, chosen, outcome: 'success' });
              } catch (err) {
                record({ field: step.field, role: step.role, value: proc, outcome: 'failed', detail: err.message });
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
            submitEl.click();
            record({ field: step.field, role: step.role, outcome: 'success', detail: 'Submitted' });
          }
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
