/**
 * auto-mate replay engine (content script).
 *
 * Given a learned recipe and one normalized spreadsheet row, fills each field
 * and (unless dry-run) submits. Emits a structured action-log entry for every
 * field it touches so the side panel can build the audit report.
 */
(function (root) {
  const DOM = root.FAA_DOM;
  const { ROLE, FIELD } = root.FAA_MSG;

  let abortFlag = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  async function typeInto(el, value) {
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

  function scoreOption(text, query) {
    const t = (text || '').trim().toLowerCase();
    const q = (query || '').trim().toLowerCase();
    if (!t || !q) return 0;
    if (t === q) return 100;
    if (t.startsWith(q)) return 80;
    if (t.includes(q)) return 60;
    // token overlap
    const qt = q.split(/\s+/);
    const hits = qt.filter((w) => t.includes(w)).length;
    return Math.round((hits / qt.length) * 40);
  }

  async function selectFromAutocomplete(inputEl, optionSelector, query, opts = {}) {
    const timeout = opts.autocompleteTimeoutMs != null ? opts.autocompleteTimeoutMs : 9000;
    await typeInto(inputEl, query);
    const options = await waitFor(
      () => {
        const list = Array.from(document.querySelectorAll(optionSelector || '[role="option"]'))
          .filter((o) => DOM.isVisible(o) && (o.textContent || '').trim().length > 0);
        return list.length ? list : null;
      },
      { timeout }
    );
    if (!options) {
      throw new Error(`No autocomplete results for "${query}"`);
    }
    let best = null;
    let bestScore = -1;
    for (const o of options) {
      const s = scoreOption(o.textContent, query);
      if (s > bestScore) {
        bestScore = s;
        best = o;
      }
    }
    if (!best || bestScore < 40) {
      throw new Error(`No good match for "${query}" (best option: "${best ? best.textContent.trim().slice(0, 60) : 'none'}")`);
    }
    const chosenText = best.textContent.trim();
    try {
      if (typeof best.scrollIntoView === 'function') best.scrollIntoView({ block: 'center' });
    } catch (_) {
      /* not implemented in headless DOM */
    }
    best.click();
    await sleep(150);
    return chosenText;
  }

  function valueForField(field, row) {
    switch (field) {
      case FIELD.DATE:
        return row.date;
      case FIELD.LOCATION:
        return row.location || 'IMC';
      case FIELD.SUPERVISOR:
        return row.supervisor;
      case FIELD.MRN:
        return row.mrn;
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
    const { dryRun = false, onAction = () => {}, fieldDelayMs = 250, autocompleteTimeoutMs } = opts;
    const acOpts = { autocompleteTimeoutMs };
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
          return found && DOM.isVisible(found) ? found : null;
        });
        if (!el && step.role !== ROLE.SUBMIT) {
          record({ field: step.field, role: step.role, outcome: 'failed', detail: 'Field not found on page' });
          return { ok: false, actions, failedField: step.field };
        }

        if (step.role === ROLE.STATIC) {
          const v = step.staticValue != null ? step.staticValue : valueForField(step.field, row);
          if (DOM.resolveElement(step.candidates)) {
            await typeInto(el, v);
          }
          record({ field: step.field, role: step.role, value: v, outcome: 'success' });
        } else if (step.role === ROLE.INPUT) {
          const v = valueForField(step.field, row);
          if (v == null || v === '') {
            record({ field: step.field, role: step.role, outcome: 'skipped', detail: 'No value in row' });
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
              const inputEl = await waitFor(() => {
                const f = DOM.resolveElement(step.candidates);
                return f && DOM.isVisible(f) ? f : null;
              });
              if (!inputEl) {
                record({ field: step.field, role: step.role, value: proc, outcome: 'failed', detail: 'Procedure field not found' });
                return { ok: false, actions, failedField: step.field };
              }
              try {
                const chosen = await selectFromAutocomplete(inputEl, step.optionSelector, proc, acOpts);
                record({ field: step.field, role: step.role, value: proc, chosen, outcome: 'success' });
              } catch (err) {
                record({ field: step.field, role: step.role, value: proc, outcome: 'failed', detail: err.message });
                return { ok: false, actions, failedField: step.field };
              }
              await sleep(fieldDelayMs);
            }
          } else {
            const v = valueForField(step.field, row);
            const chosen = await selectFromAutocomplete(el, step.optionSelector, v, acOpts);
            record({ field: step.field, role: step.role, value: v, chosen, outcome: 'success' });
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
