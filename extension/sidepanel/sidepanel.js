/**
 * auto-mate side panel controller.
 *
 * Orchestrates the three-step UX (Learn -> Data -> Run) plus reporting. Talks
 * to the page's content scripts via chrome.tabs.sendMessage and receives their
 * messages (relayed through the background worker) via chrome.runtime.onMessage.
 */
(function () {
  const { MSG, ROLE, FIELD, STORAGE_KEYS } = window.FAA_MSG;
  const PARSER = window.FAA_PARSER;
  const REPORT = window.FAA_REPORT;

  const state = {
    recordedSteps: [],
    recipe: null,
    parsed: null,
    mapping: {},
    engineRows: [],
    session: null,
    running: false,
    rowResolver: null
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), ms);
  }

  // ---- Tabs ----
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $$('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`.panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
      if (tab.dataset.tab === 'run') refreshRunReadiness();
    });
  });

  // ---- Active tab + content-script injection ----
  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function sendToTab(type, payload) {
    const tab = await getActiveTab();
    if (!tab || !tab.id) throw new Error('No active tab');
    await ensureInjected(tab.id);
    return chrome.tabs.sendMessage(tab.id, { type, payload });
  }

  async function ensureInjected(tabId) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: MSG.PING });
      if (res && res.type === MSG.PONG) return true;
    } catch (_) {
      // not yet injected
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [
          'common/messages.js',
          'common/dom-utils.js',
          'content/recorder.js',
          'content/engine.js',
          'content/overlay.js',
          'content/content.js'
        ]
      });
      return true;
    } catch (err) {
      toast('Could not attach to this page. Reload the form tab and retry.');
      throw err;
    }
  }

  // ---- Messages from content ----
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return;
    switch (message.type) {
      case MSG.STEP_RECORDED:
        onStepRecorded(message.payload);
        break;
      case MSG.ACTION_LOG:
        onActionLog(message.payload);
        break;
      case MSG.ROW_DONE:
        if (state.rowResolver) state.rowResolver(message.payload);
        break;
      case MSG.ENGINE_ERROR:
        logLine(`Engine error on row ${message.payload.index + 1}: ${message.payload.error}`, 'failed');
        if (state.rowResolver) state.rowResolver({ index: message.payload.index, result: { ok: false, actions: [] } });
        break;
      default:
        break;
    }
  });

  // ================= LEARN =================
  $('#btnStartLearn').addEventListener('click', async () => {
    state.recordedSteps = [];
    renderSteps();
    try {
      await sendToTab(MSG.START_LEARN);
      $('#btnStartLearn').classList.add('hidden');
      $('#btnFinishLearn').classList.remove('hidden');
      $('#learnSteps').classList.remove('hidden');
      toast('Learn mode on. Fill the form once in the page.');
    } catch (_) {
      /* toast already shown */
    }
  });

  $('#btnFinishLearn').addEventListener('click', async () => {
    try {
      await sendToTab(MSG.STOP_LEARN);
    } catch (_) {}
    $('#btnFinishLearn').classList.add('hidden');
    $('#btnStartLearn').classList.remove('hidden');
    if (!state.recordedSteps.length) toast('No steps captured. Try again and interact with the form fields.');
  });

  function onStepRecorded(step) {
    state.recordedSteps.push(step);
    renderSteps();
  }

  const FIELD_OPTIONS = [
    { value: '', label: 'Ignore this step' },
    { value: FIELD.DATE, label: 'Date' },
    { value: FIELD.LOCATION, label: 'Location (static "IMC")' },
    { value: FIELD.SUPERVISOR, label: 'Supervisor' },
    { value: FIELD.MRN, label: 'Patient MRN' },
    { value: FIELD.PROCEDURE, label: 'Procedure' },
    { value: FIELD.SUBMIT, label: 'Submit' }
  ];

  function autoGuessField(step) {
    const hay = `${step.text || ''} ${step.sampleValue || ''}`.toLowerCase();
    if (step.role === ROLE.SUBMIT) return FIELD.SUBMIT;
    if (/date|dos/.test(hay)) return FIELD.DATE;
    if (/location|site|facility/.test(hay)) return FIELD.LOCATION;
    if (/supervis|attending|precept/.test(hay)) return FIELD.SUPERVISOR;
    if (/mrn|patient|record/.test(hay)) return FIELD.MRN;
    if (/procedure|cpt/.test(hay)) return FIELD.PROCEDURE;
    if (step.role === ROLE.AUTOCOMPLETE) return FIELD.PROCEDURE;
    return '';
  }

  function renderSteps() {
    const list = $('#stepList');
    list.innerHTML = '';
    state.recordedSteps.forEach((step, i) => {
      const li = document.createElement('li');
      const guess = step._field != null ? step._field : autoGuessField(step);
      step._field = guess;
      const select = document.createElement('select');
      FIELD_OPTIONS.forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (opt.value === guess) o.selected = true;
        select.appendChild(o);
      });
      select.addEventListener('change', () => {
        step._field = select.value;
      });
      const meta = document.createElement('div');
      meta.className = 'step-meta';
      const sel = (step.candidates && step.candidates[0] && step.candidates[0].value) || '(structural)';
      meta.innerHTML =
        `${step.role}${step.text ? ' &middot; "' + escapeHtml(step.text) + '"' : ''} ` +
        `&middot; <code>${escapeHtml(String(sel).slice(0, 50))}</code>` +
        (step.sampleOptionText ? `<br>picked: "${escapeHtml(step.sampleOptionText)}"` : '');
      const wrap = document.createElement('div');
      wrap.className = 'step-row';
      wrap.appendChild(select);
      wrap.appendChild(meta);
      li.appendChild(wrap);
      list.appendChild(li);
    });
  }

  $('#btnSaveRecipe').addEventListener('click', async () => {
    const steps = state.recordedSteps
      .filter((s) => s._field)
      .map((s) => ({
        field: s._field,
        role: s._field === FIELD.LOCATION ? ROLE.STATIC : s.role,
        candidates: s.candidates || [],
        optionSelector: s.optionSelector,
        staticValue: s._field === FIELD.LOCATION ? 'IMC' : undefined
      }));
    if (!steps.length) {
      toast('Label at least one step before saving.');
      return;
    }
    const tab = await getActiveTab();
    const recipe = {
      version: 1,
      url: tab ? tab.url : '',
      createdAt: new Date().toISOString(),
      procedureRepeatable: true,
      steps
    };
    await chrome.storage.local.set({ [STORAGE_KEYS.RECIPE]: recipe });
    state.recipe = recipe;
    $('#learnSteps').classList.add('hidden');
    renderRecipeStatus();
    refreshRunReadiness();
    toast('Recipe saved.');
  });

  $('#btnViewRecipe').addEventListener('click', () => {
    const pre = $('#recipeJson');
    pre.textContent = JSON.stringify(state.recipe, null, 2);
    pre.classList.toggle('hidden');
  });

  $('#btnClearRecipe').addEventListener('click', async () => {
    await chrome.storage.local.remove(STORAGE_KEYS.RECIPE);
    state.recipe = null;
    renderRecipeStatus();
    refreshRunReadiness();
    toast('Recipe cleared.');
  });

  function renderRecipeStatus() {
    const el = $('#recipeStatus');
    if (state.recipe) {
      const fields = state.recipe.steps.map((s) => s.field).join(', ');
      el.innerHTML = `Saved recipe (${state.recipe.steps.length} steps): <b>${escapeHtml(fields)}</b>`;
    } else {
      el.textContent = 'No recipe saved yet.';
    }
  }

  // ================= DATA =================
  const dropzone = $('#dropzone');
  const fileInput = $('#fileInput');

  dropzone.addEventListener('click', () => fileInput.click());
  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add('drag');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag');
    })
  );
  dropzone.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  async function handleFile(file) {
    try {
      $('#fileInfo').textContent = `Reading ${file.name}...`;
      const parsed = await PARSER.readFile(file);
      state.parsed = parsed;
      state.mapping = PARSER.guessMapping(parsed.headers);
      $('#fileInfo').innerHTML = `Loaded <b>${escapeHtml(file.name)}</b> &middot; ${parsed.rows.length} rows, ${parsed.headers.length} columns`;
      $('#mappingBox').classList.remove('hidden');
      renderMapping();
      rebuildEngineRows();
    } catch (err) {
      $('#fileInfo').textContent = `Could not read file: ${err.message}`;
    }
  }

  function renderMapping() {
    $$('select[data-map]').forEach((sel) => {
      const field = sel.dataset.map;
      sel.innerHTML = '';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '(none)';
      sel.appendChild(none);
      state.parsed.headers.forEach((h) => {
        const o = document.createElement('option');
        o.value = h;
        o.textContent = h;
        if (state.mapping[field] === h) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = () => {
        state.mapping[field] = sel.value || undefined;
        rebuildEngineRows();
      };
    });
  }

  $('#groupProcedures').addEventListener('change', rebuildEngineRows);

  function rebuildEngineRows() {
    if (!state.parsed) return;
    state.engineRows = PARSER.buildEngineRows(state.parsed, state.mapping, {
      groupProcedures: $('#groupProcedures').checked,
      location: 'IMC'
    });
    renderPreview();
    refreshRunReadiness();
  }

  function renderPreview() {
    const rows = state.engineRows.slice(0, 50);
    $('#rowCount').textContent = `(${state.engineRows.length} entries)`;
    const head = '<tr><th>Date</th><th>Supervisor</th><th>MRN</th><th>Procedures</th></tr>';
    const body = rows
      .map(
        (r) =>
          `<tr><td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.supervisor)}</td>` +
          `<td>${escapeHtml(r.mrn)}</td><td>${escapeHtml(r.procedures.join(', '))}</td></tr>`
      )
      .join('');
    $('#preview').innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  // ================= RUN =================
  function refreshRunReadiness() {
    const el = $('#runReadiness');
    const issues = [];
    if (!state.recipe) issues.push('no recipe (do step 1)');
    if (!state.engineRows.length) issues.push('no data loaded (do step 2)');
    if (issues.length) {
      el.innerHTML = `Not ready: ${issues.join(' and ')}.`;
      $('#btnRun').disabled = true;
    } else {
      el.innerHTML = `Ready: <b>${state.engineRows.length}</b> entries against saved recipe.`;
      $('#btnRun').disabled = false;
    }
  }

  $('#fieldDelay').addEventListener('input', (e) => {
    $('#delayVal').textContent = e.target.value;
  });

  $('#btnRun').addEventListener('click', runSession);
  $('#btnStop').addEventListener('click', async () => {
    state.running = false;
    try {
      await sendToTab(MSG.STOP_RUN);
    } catch (_) {}
    logLine('Stop requested.', 'info');
  });

  async function runSession() {
    if (!state.recipe || !state.engineRows.length) return;
    const dryRun = $('#dryRun').checked;
    const fieldDelayMs = parseInt($('#fieldDelay').value, 10);

    if (!dryRun) {
      const ok = confirm(
        `LIVE RUN: auto-mate will submit ${state.engineRows.length} entries to the form. ` +
          `This cannot be undone. Continue?`
      );
      if (!ok) return;
    }

    state.running = true;
    state.session = { startedAt: new Date().toISOString(), dryRun, rows: [] };
    $('#liveLog').innerHTML = '';
    $('#progressWrap').classList.remove('hidden');
    $('#btnRun').classList.add('hidden');
    $('#btnStop').classList.remove('hidden');
    logLine(`Session started (${dryRun ? 'DRY RUN' : 'LIVE'}), ${state.engineRows.length} entries.`, 'info');

    for (let i = 0; i < state.engineRows.length; i++) {
      if (!state.running) {
        logLine('Session stopped by user.', 'aborted');
        break;
      }
      const row = state.engineRows[i];
      logLine(`Row ${i + 1}/${state.engineRows.length} - MRN ${row.mrn || 'n/a'}`, 'info');
      const result = await runOneRow(row, i, state.engineRows.length, dryRun, fieldDelayMs);
      state.session.rows.push({ index: i, mrn: row.mrn, result: result.result });
      updateProgress(i + 1, state.engineRows.length);
      if (result.result && result.result.aborted) {
        logLine('Stopped during row.', 'aborted');
        break;
      }
    }

    state.session.finishedAt = new Date().toISOString();
    state.running = false;
    $('#btnRun').classList.remove('hidden');
    $('#btnStop').classList.add('hidden');
    renderReport();
    logLine('Session complete. See Report tab.', 'info');
    toast('Session complete - see Report tab.');
  }

  function runOneRow(row, index, total, dryRun, fieldDelayMs) {
    return new Promise(async (resolve) => {
      state.rowResolver = (payload) => {
        state.rowResolver = null;
        resolve(payload);
      };
      try {
        await sendToTab(MSG.RUN_ROW, { recipe: state.recipe, row, index, total, dryRun, fieldDelayMs });
      } catch (err) {
        resolve({ index, result: { ok: false, actions: [], failedField: 'page' } });
      }
    });
  }

  function onActionLog({ index, entry }) {
    const cls = `log-${entry.outcome}`;
    const detail = entry.detail ? ` (${entry.detail})` : '';
    const val = entry.value != null ? ` = "${entry.value}"` : '';
    const chosen = entry.chosen ? ` -> "${entry.chosen}"` : '';
    logLine(`  [${entry.field}] ${entry.outcome}${val}${chosen}${detail}`, entry.outcome);
  }

  function logLine(text, kind = 'info') {
    const div = document.createElement('div');
    div.className = `log-${kind}`;
    div.textContent = text;
    const log = $('#liveLog');
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function updateProgress(done, total) {
    $('#progressFill').style.width = `${Math.round((done / total) * 100)}%`;
    $('#progressText').textContent = `${done} / ${total} entries processed`;
  }

  // ================= REPORT =================
  function renderReport() {
    if (!state.session) return;
    const s = REPORT.summarize(state.session);
    $('#reportSummary').innerHTML =
      `${s.dryRun ? '<b>DRY RUN</b> &middot; ' : ''}` +
      `Total ${s.total} &middot; <span class="o-success">${s.succeeded} ok</span> &middot; ` +
      `<span class="o-failed">${s.failed} failed</span> &middot; ${s.skipped} stopped`;
    $('#reportBody').innerHTML = REPORT.toHTML(state.session)
      .replace(/^[\s\S]*<body>/, '')
      .replace(/<\/body>[\s\S]*$/, '');
  }

  $('#btnExportHtml').addEventListener('click', () => {
    if (!state.session) return toast('No session to export.');
    REPORT.download(`auto-mate-report-${stamp()}.html`, REPORT.toHTML(state.session), 'text/html');
  });
  $('#btnExportCsv').addEventListener('click', () => {
    if (!state.session) return toast('No session to export.');
    REPORT.download(`auto-mate-report-${stamp()}.csv`, REPORT.toCSV(state.session), 'text/csv');
  });
  $('#btnExportJson').addEventListener('click', () => {
    if (!state.session) return toast('No session to export.');
    REPORT.download(`auto-mate-report-${stamp()}.json`, REPORT.toJSON(state.session), 'application/json');
  });

  function stamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }

  // ---- helpers ----
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---- init ----
  (async function init() {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.RECIPE);
    state.recipe = stored[STORAGE_KEYS.RECIPE] || null;
    renderRecipeStatus();
    refreshRunReadiness();
  })();
})();
