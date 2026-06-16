/**
 * auto-mate side panel controller.
 *
 * Orchestrates the four-step UX (Data -> Mapping -> Run -> Report). Talks
 * to the page's content scripts via chrome.tabs.sendMessage and receives their
 * messages (relayed through the background worker) via chrome.runtime.onMessage.
 */
(function () {
  const { MSG, ROLE, FIELD, FORM_FIELDS, STORAGE_KEYS, BUILD_ID, minMappingLenForFieldKey, minMappingLenFromHaystack, minColumnInferLenForFieldKey, normalizeMatchKey, valueMatchesCell, MIN_VALUE_MATCH_SUBSTRING_LEN, pickPreferredColumnMatch, autoGuessField, guessFieldFromLabel, headerAllowedForFieldKey } = window.FAA_MSG;
  const PARSER = window.FAA_PARSER;
  const REPORT = window.FAA_REPORT;

  const TAB_ORDER = ['data', 'mapping', 'run', 'report'];
  const FORM_FIELD_KEYS = FORM_FIELDS.map((f) => f.key);
  const REQUIRED_FIELD_KEYS = FORM_FIELDS.filter((f) => f.required).map((f) => f.key);
  const FIELD_LABEL_BY_KEY = Object.fromEntries(FORM_FIELDS.map((f) => [f.key, f.label]));

  const state = {
    recordedSteps: [],
    recipe: null,
    parsed: null,
    mapping: {},
    formBindings: {},
    engineRows: [],
    session: null,
    running: false,
    rowResolver: null,
    maxTabIndex: 0,
    learnRecording: false,
    fieldRevealOrder: [],
    reportFilter: 'all'
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

  function hasData() {
    return state.engineRows.length > 0;
  }

  function switchTab(tabName) {
    const prevTab = getActiveTabName();
    if (prevTab === 'mapping' && tabName !== 'mapping') stopLearnRecording();

    $$('.tab-trigger').forEach((t) => t.classList.toggle('active', t.dataset.tab === tabName));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tabName));
    if (tabName === 'run') refreshRunReadiness();
    if (tabName === 'mapping') {
      refreshLearnReadiness();
      prepareMappingTab();
      startLearnRecording();
    }
  }

  function refreshTabLocks() {
    $$('.tab-trigger').forEach((tab) => {
      const idx = TAB_ORDER.indexOf(tab.dataset.tab);
      const locked = idx > state.maxTabIndex;
      tab.disabled = locked;
      tab.classList.toggle('tab-locked', locked);
    });
  }

  function advanceToTab(tabName) {
    const idx = TAB_ORDER.indexOf(tabName);
    if (idx > state.maxTabIndex) state.maxTabIndex = idx;
    refreshTabLocks();
    switchTab(tabName);
  }

  function refreshDataStepNav() {
    const next = $('#btnDataNext');
    if (!next) return;
    const loaded = Boolean(state.parsed);
    next.disabled = !loaded;
    next.classList.toggle('btn-primary-ready', loaded);
  }

  function refreshLearnMappingVisibility() {
    const formBox = $('#mappingBox');
    const nav = $('#learnStepNav');
    const show = Boolean(state.parsed);
    if (formBox) formBox.classList.toggle('hidden', !show);
    if (nav) nav.classList.toggle('hidden', !show);
    if (state.parsed) {
      renderFormMapping();
      refreshLearnStepNav();
    }
  }

  function hasDocumentedWorkflow() {
    return isProcedureRegistered() || state.recordedSteps.some((s) => s.role === ROLE.SUBMIT);
  }

  function isColumnMappingComplete() {
    return REQUIRED_FIELD_KEYS.every((f) => state.mapping[f]);
  }

  /** Next when user documented once (selectors) and required columns are mapped. */
  function isMappingComplete() {
    return hasDocumentedWorkflow() && isColumnMappingComplete();
  }

  function missingRequiredValuesForRow(row) {
    const missing = [];
    for (const f of REQUIRED_FIELD_KEYS) {
      if (f === FIELD.PROCEDURE) {
        if (!row.procedures || !row.procedures.length) missing.push(FIELD_LABEL_BY_KEY[f]);
        continue;
      }
      if (f === FIELD.ENCOUNTER) {
        if (!row.mrn || !String(row.mrn).trim()) missing.push(FIELD_LABEL_BY_KEY[f]);
        continue;
      }
      const v = row[f];
      if (v == null || String(v).trim() === '') missing.push(FIELD_LABEL_BY_KEY[f]);
    }
    return missing;
  }

  function refreshLearnStepNav() {
    const next = $('#btnLearnNext');
    if (!next) return;
    const ready = isMappingComplete();
    next.disabled = !ready;
    next.classList.toggle('btn-primary-ready', ready);
  }

  function refreshLearnReadiness() {
    const el = $('#learnReadiness');
    if (!el) return;
    if (!state.parsed) {
      el.textContent = 'Go to the Data tab and load your file before continuing.';
    } else {
      el.textContent = '';
    }
  }

  function refreshMappingListeningBadge() {
    const badge = $('#mappingListeningBadge');
    if (!badge) return;
    const onMapping = getActiveTabName() === 'mapping';
    badge.classList.toggle('hidden', !onMapping || !state.parsed || !state.learnRecording);
  }

  async function startLearnRecording() {
    if (!state.parsed || state.learnRecording) return;
    try {
      await sendToTab(MSG.START_LEARN);
      state.learnRecording = true;
      refreshMappingListeningBadge();
    } catch (_) {
      /* toast already shown */
    }
  }

  async function stopLearnRecording() {
    if (!state.learnRecording) return;
    try {
      await sendToTab(MSG.STOP_LEARN);
    } catch (_) {}
    state.learnRecording = false;
    refreshMappingListeningBadge();
  }

  function prepareMappingTab() {
    if (!state.parsed) return;
    rebuildFieldRevealOrderFromState();
    renderFormMapping();
    refreshMappingListeningBadge();
    if (REQUIRED_FIELD_KEYS.some((f) => state.mapping[f])) {
      rebuildEngineRows();
    } else {
      state.engineRows = [];
      refreshRunReadiness();
    }
    refreshLearnStepNav();
  }

  function discoverField(mapKey) {
    if (!mapKey || state.fieldRevealOrder.includes(mapKey)) return;
    state.fieldRevealOrder.push(mapKey);
  }

  function rebuildFieldRevealOrderFromState() {
    if (state.fieldRevealOrder.length) return;
    for (const key of FORM_FIELD_KEYS) {
      if (key === FIELD.PROCEDURE && !isProcedureRegistered()) continue;
      if (state.formBindings[key] || state.mapping[key]) discoverField(key);
    }
  }

  function isProcedureLearnStep(step) {
    if (!step || step.role !== ROLE.AUTOCOMPLETE) return false;
    if (step.clickRel && /\badd\b/i.test(step.clickRel)) return true;
    const opt = String(step.optionSelector || '');
    const picked = String(step.sampleOptionText || '').trim();
    if (picked && /proc_row|proc/i.test(opt)) return true;
    return false;
  }

  function isProcedureRegistered() {
    if (state.fieldRevealOrder.includes(FIELD.PROCEDURE)) return true;
    return state.recordedSteps.some((s) => isProcedureLearnStep(s));
  }

  function shouldRevealMappingField(mapKey, step) {
    if (mapKey === FIELD.PROCEDURE) return isProcedureLearnStep(step);
    return true;
  }

  function normalizeLearnStep(step) {
    if (!step._field) step._field = autoGuessField(step);
    else if (step.role === ROLE.INPUT && step.text) {
      const fromLabel = guessFieldFromLabel(step.text, step.role);
      if (fromLabel && fromLabel !== FIELD.CLICK && fromLabel !== step._field) {
        step._field = fromLabel;
      }
    }
    if (isProcedureLearnStep(step)) step._field = FIELD.PROCEDURE;
  }

  function revealProcedureInMapping(step) {
    discoverField(FIELD.PROCEDURE);
    state.formBindings[FIELD.PROCEDURE] = { ...step, _field: FIELD.PROCEDURE };
    renderFormMapping();
    flashColField(FIELD.PROCEDURE);
  }

  function formLabelForKey(mapKey) {
    const def = FORM_FIELDS.find((f) => f.key === mapKey);
    if (mapKey === FIELD.PROCEDURE && def) return def.label;
    const binding = state.formBindings[mapKey];
    if (binding && binding.text) return binding.text;
    return def ? def.label : mapKey;
  }

  // ---- Tabs ----
  $$('.tab-trigger').forEach((tab) => {
    tab.addEventListener('click', () => {
      const idx = TAB_ORDER.indexOf(tab.dataset.tab);
      if (idx > state.maxTabIndex) return;
      switchTab(tab.dataset.tab);
    });
  });

  $('#btnDataNext').addEventListener('click', () => {
    if (!state.parsed) {
      toast('Upload a procedure file first.');
      return;
    }
    advanceToTab('mapping');
  });

  $('#btnLearnNext').addEventListener('click', async () => {
    if (!hasDocumentedWorkflow()) {
      toast('Document one procedure on the form first — we need those field selectors.');
      return;
    }
    if (!isColumnMappingComplete()) {
      toast('Map all required spreadsheet columns before continuing.');
      return;
    }
    inferMappingFromLearn();
    renderFormMapping();
    rebuildEngineRows();
    await stopLearnRecording();
    await saveRecipeFromSteps();
    if (!state.recipe) return;
    advanceToTab('run');
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
      if (res && res.type === MSG.PONG && res.buildId === BUILD_ID) return true;
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
      case MSG.FIELD_INPUT:
        onLiveFieldInput(message.payload);
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
  function fieldValueForMapping(step) {
    if (step.role === ROLE.AUTOCOMPLETE) {
      const picked = String(step.sampleOptionText ?? '').trim();
      const typed = String(step.sampleValue ?? '').trim();
      if (picked && picked.length >= typed.length) return picked;
      return typed || picked;
    }
    return String(step.sampleValue ?? step.sampleOptionText ?? '').trim();
  }

  function minMappingLenForStep(step) {
    const mapKey = STEP_FIELD_TO_MAP[step._field];
    if (mapKey) return minMappingLenForFieldKey(mapKey);
    return minMappingLenFromHaystack(`${step.text || ''} ${step.sampleValue || ''}`);
  }

  function shouldRunFieldMapping(step) {
    return fieldValueForMapping(step).length >= minMappingLenForStep(step);
  }

  function shouldInferColumnMapping(mapKey, step) {
    const val = fieldValueForMapping(step);
    const minLen = mapKey
      ? minColumnInferLenForFieldKey(mapKey)
      : minMappingLenFromHaystack(`${step.text || ''} ${val}`);
    return val.length >= minLen;
  }

  function onLiveFieldInput(live) {
    if (!live || (!live.blurred && !live.debounced)) return;
    const step = { ...live, _field: autoGuessField(live) };
    if (
      step.role === ROLE.INPUT &&
      guessFieldFromLabel(step.text, step.role) === FIELD.PROCEDURE
    ) {
      return;
    }
    if (!shouldRunFieldMapping(step)) return;
    const mapKey = STEP_FIELD_TO_MAP[step._field];
    if (!mapKey) return;
    applyStepFormBinding(step);
    if (live.blurred) inferAndSetColumnForField(mapKey, step);
    refreshLearnStepNav();
  }

  function onStepRecorded(step) {
    state.recordedSteps.push(step);
    normalizeLearnStep(step);
    if (isProcedureLearnStep(step)) {
      revealProcedureInMapping(step);
    } else {
      applyStepFormBinding(step);
    }
    inferAndSetColumnForField(STEP_FIELD_TO_MAP[step._field], step);
    refreshLearnStepNav();
  }

  const STEP_FIELD_TO_MAP = {
    [FIELD.DATE]: FIELD.DATE,
    [FIELD.LOCATION]: FIELD.LOCATION,
    [FIELD.SUPERVISOR]: FIELD.SUPERVISOR,
    [FIELD.ENCOUNTER]: FIELD.ENCOUNTER,
    [FIELD.PROCEDURE]: FIELD.PROCEDURE,
    [FIELD.GENDER]: FIELD.GENDER,
    [FIELD.AGE]: FIELD.AGE,
    [FIELD.DIAGNOSIS]: FIELD.DIAGNOSIS,
    [FIELD.COMPLICATIONS]: FIELD.COMPLICATIONS,
    [FIELD.NOTES]: FIELD.NOTES
  };

  function flashMapRow(mapKey) {
    const row = document.querySelector(`.map-field-row[data-form-field="${mapKey}"]`);
    if (!row) return;
    row.classList.remove('map-field-flash');
    row.offsetWidth;
    row.classList.add('map-field-flash');
    setTimeout(() => row.classList.remove('map-field-flash'), 1200);
  }

  function flashColField(mapKey) {
    flashMapRow(mapKey);
  }

  function applyStepFormBinding(step) {
    const mapKey = STEP_FIELD_TO_MAP[step._field];
    if (!mapKey || !shouldRevealMappingField(mapKey, step)) return;

    const val = fieldValueForMapping(step);
    const blurReveal = step.blurred && val.length > 0;
    const autocompleteReveal = step.role === ROLE.AUTOCOMPLETE && val.length > 0;
    if (!blurReveal && !autocompleteReveal && !shouldRunFieldMapping(step)) return;

    const wasRevealed = state.fieldRevealOrder.includes(mapKey);
    const prev = state.formBindings[mapKey];
    state.formBindings[mapKey] = step;

    discoverField(mapKey);

    const bindingChanged =
      !prev ||
      prev.stepId !== step.stepId ||
      prev.sampleValue !== step.sampleValue ||
      prev.text !== step.text;

    if (!wasRevealed || bindingChanged || step.blurred) {
      renderFormMapping();
      if (mapKey === FIELD.PROCEDURE) flashColField(mapKey);
      refreshLearnStepNav();
    }
  }

  function inferColumnForField(mapKey, step) {
    if (!state.parsed || !mapKey || !step) return null;
    const preferredCol = PARSER.guessMapping(state.parsed.headers)[mapKey];
    return inferColumnFromTypedValue(step, preferredCol, mapKey);
  }

  function columnOwnerField(col, exceptKey) {
    if (!col) return null;
    for (const [key, mapped] of Object.entries(state.mapping)) {
      if (key === exceptKey) continue;
      if (mapped === col) return key;
    }
    return null;
  }

  function setColumnMapping(mapKey, col, flash) {
    if (!mapKey || !col) return;
    const prevOwner = columnOwnerField(col, mapKey);
    const stolen = Boolean(prevOwner);
    if (stolen) delete state.mapping[prevOwner];

    const changed = state.mapping[mapKey] !== col || stolen;
    state.mapping[mapKey] = col;
    if (mapKey !== FIELD.PROCEDURE) discoverField(mapKey);
    renderFormMapping();
    if (changed) {
      if (flash) flashColField(mapKey);
      rebuildEngineRows();
    }
    refreshLearnStepNav();
  }

  function inferAndSetColumnForField(mapKey, step) {
    if (!mapKey || !shouldInferColumnMapping(mapKey, step)) return;
    const col = inferColumnForField(mapKey, step);
    if (!col) return;
    const flash = Boolean(step?.blurred || step?.debounced) || state.mapping[mapKey] !== col;
    setColumnMapping(mapKey, col, flash);
  }

  function wireColumnSelect(sel) {
    if (!state.parsed) return;
    const field = sel.dataset.colMap;
    const prev = state.mapping[field];
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '(pick column)';
    sel.appendChild(none);
    state.parsed.headers.forEach((h) => {
      const owner = columnOwnerField(h, field);
      const o = document.createElement('option');
      o.value = h;
      o.textContent = owner ? `${h} (→ ${formLabelForKey(owner)})` : h;
      sel.appendChild(o);
    });
    sel.value = prev || '';
    sel.onchange = () => {
      const v = sel.value;
      if (!v) {
        delete state.mapping[field];
        rebuildEngineRows();
        refreshLearnStepNav();
        return;
      }
      setColumnMapping(field, v, true);
    };
  }

  function mapFieldColHtml(key, label) {
    if (key === FIELD.PROCEDURE) {
      return (
        `<div class="map-field-col-wrap map-field-col-mapped">` +
        `<span class="map-field-check" title="Procedure input registered" aria-label="Procedure input registered">` +
        `<span class="map-field-check-icon" aria-hidden="true">✓</span></span></div>`
      );
    }
    return (
      `<div class="map-field-col-wrap">` +
      `<select class="select" data-col-map="${key}" aria-label="Spreadsheet column for ${label}">` +
      `</select></div>`
    );
  }

  function renderFormMapping() {
    const loading = $('#mappingFieldLoading');
    const list = $('#mappingFieldsList');
    if (!list || !state.parsed) return;

    const keys = state.fieldRevealOrder;
    if (!keys.length) {
      if (loading) loading.classList.remove('hidden');
      list.classList.add('hidden');
      list.innerHTML = '';
      return;
    }

    if (loading) loading.classList.add('hidden');
    list.classList.remove('hidden');

    list.innerHTML = keys
      .map((key) => {
        const label = escapeHtml(formLabelForKey(key));
        const def = FORM_FIELDS.find((f) => f.key === key);
        const optional = def && !def.required;
        const optTag = optional ? ' <span class="label-optional">optional</span>' : '';
        return (
          `<div class="map-field-row" data-form-field="${key}">` +
          `<span class="map-field-form-label">${label}${optTag}</span>` +
          mapFieldColHtml(key, label) +
          `</div>`
        );
      })
      .join('');

    keys.forEach((key) => {
      const sel = list.querySelector(`select[data-col-map="${key}"]`);
      if (sel) wireColumnSelect(sel);
    });
  }

  function inferColumnFromTypedValue(step, preferredCol, mapKey) {
    if (!state.parsed) return null;
    const typed = fieldValueForMapping(step);
    const minLen = mapKey
      ? minColumnInferLenForFieldKey(mapKey)
      : minMappingLenFromHaystack(`${step.text || ''} ${typed}`);
    if (!typed || typed.length < minLen) return null;

    const rows = state.parsed.rows.slice(0, 100);
    const matches = state.parsed.headers.filter(
      (h) =>
        headerAllowedForFieldKey(h, mapKey) &&
        rows.some((row) => valueMatchesCell(row[h], typed))
    );
    if (!matches.length) return null;

    const nKey = normalizeMatchKey(typed);
    if (nKey.length < MIN_VALUE_MATCH_SUBSTRING_LEN && matches.length > 1) {
      return pickPreferredColumnMatch(matches, preferredCol);
    }
    if (nKey.length < MIN_VALUE_MATCH_SUBSTRING_LEN) return matches[0];

    return pickPreferredColumnMatch(matches, preferredCol);
  }

  function applyStepColumnMatch(step) {
    const mapKey = STEP_FIELD_TO_MAP[step._field];
    inferAndSetColumnForField(mapKey, step);
  }

  function inferMappingFromLearn() {
    if (!state.parsed || !state.recordedSteps.length) return;
    for (const step of state.recordedSteps) {
      if (!step._field) step._field = autoGuessField(step);
      applyStepColumnMatch(step);
    }
  }

  function isSupervisorSearchTabLearnStep(s) {
    if (s.role !== ROLE.CLICK || s._field !== FIELD.CLICK) return false;
    return (s.candidates || []).some((c) => /supTabSearch/i.test(String(c.value || '')));
  }

  function stepToRecipeStep(s) {
    let role = s.role || ROLE.INPUT;
    if (s._field === FIELD.LOCATION) role = ROLE.STATIC;
    else if (s._field === FIELD.CLICK) role = ROLE.CLICK;
    return {
      field: s._field,
      role,
      candidates: s.candidates || [],
      optionSelector: s.optionSelector,
      clickRel: s.clickRel,
      staticValue: s._field === FIELD.LOCATION ? (s.staticValue || 'IMC') : undefined
    };
  }

  async function saveRecipeFromSteps() {
    const recorded = state.recordedSteps.filter((s) => s._field);
    if (!recorded.length) {
      toast('Document one procedure on the form first — that teaches us where each field lives.');
      return;
    }
    const steps = recorded
      .filter((s) => !isSupervisorSearchTabLearnStep(s))
      .filter((s) => {
        if (s.role !== ROLE.INPUT || !s.text) return true;
        const fromLabel = guessFieldFromLabel(s.text, s.role);
        return !fromLabel || fromLabel === FIELD.CLICK || fromLabel === s._field;
      })
      .map(stepToRecipeStep);
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
    renderRecipeStatus();
    state.maxTabIndex = Math.max(state.maxTabIndex, TAB_ORDER.indexOf('run'));
    refreshTabLocks();
    refreshRunReadiness();
  }

  $('#btnViewRecipe').addEventListener('click', () => {
    const pre = $('#recipeJson');
    pre.textContent = JSON.stringify(state.recipe, null, 2);
    pre.classList.toggle('hidden');
  });

  $('#btnClearRecipe').addEventListener('click', async () => {
    await chrome.storage.local.remove(STORAGE_KEYS.RECIPE);
    state.recipe = null;
    state.maxTabIndex = state.parsed ? 1 : 0;
    if (TAB_ORDER.indexOf(getActiveTabName()) > state.maxTabIndex) {
      switchTab(state.maxTabIndex === 0 ? 'data' : 'mapping');
    }
    refreshTabLocks();
    renderRecipeStatus();
    refreshRunReadiness();
    toast('Recipe cleared.');
  });

  function getActiveTabName() {
    const active = $('.tab-trigger.active');
    return active ? active.dataset.tab : 'data';
  }

  function renderRecipeStatus() {
    const el = $('#recipeStatus');
    if (!el) return;
    if (state.recipe) {
      el.classList.remove('hidden');
      const fields = state.recipe.steps.map((s) => s.field).join(', ');
      el.innerHTML = `<span class="badge-secondary">Recipe saved</span> ${state.recipe.steps.length} steps: <strong>${escapeHtml(fields)}</strong>`;
    } else {
      el.classList.add('hidden');
      el.innerHTML = '';
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

  function showDataUploadUI() {
    $('#uploadArea').classList.remove('hidden');
    $('#dropzone').classList.remove('hidden');
    $('#fileLoadedBar').classList.add('hidden');
    $('#fileInfo').textContent = '';
    refreshLearnMappingVisibility();
  }

  function showDataLoadedUI(fileName, rowCount, colCount) {
    $('#uploadArea').classList.add('hidden');
    $('#fileLoadedBar').classList.remove('hidden');
    $('#fileLoadedName').textContent = fileName;
    $('#fileLoadedMeta').textContent = `${rowCount} rows, ${colCount} columns`;
  }

  function clearLoadedFile() {
    stopLearnRecording();
    state.parsed = null;
    state.mapping = {};
    state.formBindings = {};
    state.engineRows = [];
    state.recordedSteps = [];
    state.fieldRevealOrder = [];
    state.maxTabIndex = 0;
    fileInput.value = '';
    showDataUploadUI();
    refreshTabLocks();
    refreshDataStepNav();
    refreshLearnReadiness();
    refreshRunReadiness();
    switchTab('data');
  }

  $('#btnClearFile').addEventListener('click', clearLoadedFile);

  async function handleFile(file) {
    $('#fileInfo').textContent = '';
    $('#fileLoadedName').textContent = file.name;
    $('#fileLoadedMeta').textContent = 'Reading…';
    $('#uploadArea').classList.add('hidden');
    $('#fileLoadedBar').classList.remove('hidden');
    try {
      const parsed = await PARSER.readFile(file);
      state.parsed = parsed;
      state.mapping = {};
    state.formBindings = {};
    state.recordedSteps = [];
    state.fieldRevealOrder = [];
      showDataLoadedUI(file.name, parsed.rows.length, parsed.headers.length);
      refreshDataStepNav();
      refreshLearnReadiness();
      refreshLearnMappingVisibility();
    } catch (err) {
      showDataUploadUI();
      $('#fileInfo').textContent = `Could not read file: ${err.message}`;
    }
  }

  function rebuildEngineRows() {
    if (!state.parsed) return;
    state.engineRows = PARSER.buildEngineRows(state.parsed, state.mapping, { location: 'IMC' });
    refreshRunReadiness();
    refreshLearnStepNav();
  }

  // ================= RUN =================
  function refreshRunReadiness() {
    const el = $('#runReadiness');
    const issues = [];
    if (!state.recipe) issues.push('no recipe (do step 2 — Mapping)');
    if (!hasData()) issues.push('no data loaded (do step 1 — Data)');
    if (issues.length) {
      el.innerHTML = `<span class="badge-outline border-amber-500/50 text-amber-400">Not ready</span> ${issues.join(' and ')}.`;
      $('#btnRun').disabled = true;
    } else {
      el.innerHTML = `<span class="badge-secondary">Ready</span> <strong>${state.engineRows.length}</strong> entries against saved recipe.`;
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

  function confirmLiveRun(entryCount) {
    return new Promise((resolve) => {
      const modal = $('#liveConfirmModal');
      const body = $('#liveConfirmBody');
      const okBtn = $('#liveConfirmOk');
      const cancelBtn = $('#liveConfirmCancel');
      if (!modal || !body || !okBtn || !cancelBtn) {
        resolve(false);
        return;
      }
      body.textContent =
        `auto-mate will submit ${entryCount} entries to the form on this page. This cannot be undone.`;
      modal.classList.remove('hidden');
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      function cleanup(ok) {
        modal.classList.add('hidden');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        resolve(ok);
      }
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
    });
  }

  async function runSession() {
    if (!state.recipe || !state.engineRows.length) return;
    const dryRun = $('#dryRun').checked;
    const fieldDelayMs = parseInt($('#fieldDelay').value, 10);

    if (!dryRun) {
      const ok = await confirmLiveRun(state.engineRows.length);
      if (!ok) return;
    }

    try {
      await sendToTab(MSG.CLEAR_OVERLAY);
    } catch (_) {}

    state.running = true;
    state.session = { startedAt: new Date().toISOString(), dryRun, rows: [] };
    state.reportFilter = 'all';
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
      const missing = missingRequiredValuesForRow(row);
      if (missing.length) {
        const label = `Row ${i + 1}/${state.engineRows.length} (MRN ${row.mrn || 'n/a'})`;
        const msg = `${label}: no value for ${missing.join(', ')} — enter manually or fix your file.`;
        toast(msg);
        logLine(msg, 'failed');
        state.session.rows.push({
          index: i,
          mrn: row.mrn,
          result: { ok: false, actions: [], skipped: true, missingFields: missing }
        });
        updateProgress(i + 1, state.engineRows.length);
        continue;
      }
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
    state.maxTabIndex = Math.max(state.maxTabIndex, TAB_ORDER.indexOf('report'));
    refreshTabLocks();
    logLine('Session complete. See Report tab.', 'info');
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
    const detail = entry.detail ? ` (${entry.detail})` : '';
    const val = entry.value != null ? ` = "${escapeHtml(String(entry.value))}"` : '';
    const chosen = entry.chosen ? ` -> "${escapeHtml(String(entry.chosen))}"` : '';
    const outcomeHtml = formatOutcomeLabel(entry.outcome);
    logLine(
      `  [${escapeHtml(String(entry.field))}] ${outcomeHtml}${val}${chosen}${escapeHtml(detail)}`,
      entry.outcome,
      true
    );
  }

  function formatOutcomeLabel(outcome) {
    if (outcome === 'failed') return '<span class="log-outcome-failed">failed</span>';
    if (outcome === 'success') return '<span class="log-outcome-success">success</span>';
    if (outcome === 'skipped') return '<span class="log-outcome-skipped">skipped</span>';
    if (outcome === 'aborted') return '<span class="log-outcome-aborted">aborted</span>';
    return escapeHtml(String(outcome || ''));
  }

  function logLine(text, kind = 'info', asHtml = false) {
    const div = document.createElement('div');
    div.className = `log-${kind}`;
    if (asHtml) {
      div.innerHTML = text;
    } else if (kind === 'failed') {
      div.innerHTML = escapeHtml(text).replace(/\bfailed\b/gi, '<span class="log-outcome-failed">failed</span>');
    } else {
      div.textContent = text;
    }
    const log = $('#liveLog');
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function updateProgress(done, total) {
    $('#progressFill').style.width = `${Math.round((done / total) * 100)}%`;
    $('#progressText').textContent = `${done} / ${total} entries processed`;
  }

  // ================= REPORT =================
  function renderReportSummaryHtml(s, activeFilter) {
    const chip = (filter, label, count, tone) => {
      const active = activeFilter === filter ? ' is-active' : '';
      return (
        `<button type="button" class="report-filter report-filter-${tone}${active}" data-report-filter="${filter}" aria-pressed="${activeFilter === filter}">` +
        `<span class="report-filter-count">${count}</span> ${label}</button>`
      );
    };
    return (
      `${s.dryRun ? '<span class="badge-outline mr-1">DRY RUN</span>' : ''}` +
      chip('all', 'total', s.total, 'neutral') +
      chip('success', 'ok', s.succeeded, 'success') +
      chip('failed', 'failed', s.failed, 'failed') +
      chip('stopped', 'stopped', s.skipped, 'stopped')
    );
  }

  function wireReportFilters() {
    const onFilterClick = (e) => {
      const el = e.target.closest('[data-report-filter]');
      if (!el || !$('#reportPreview').contains(el)) return;
      e.preventDefault();
      const filter = el.getAttribute('data-report-filter');
      if (!filter || filter === state.reportFilter) return;
      state.reportFilter = filter;
      renderReport();
    };
    const preview = $('#reportPreview');
    if (!preview) return;
    preview.removeEventListener('click', preview._reportFilterClick);
    preview._reportFilterClick = onFilterClick;
    preview.addEventListener('click', onFilterClick);
  }

  function renderReport() {
    if (!state.session) return;
    const s = REPORT.summarize(state.session);
    $('#reportSummary').innerHTML = renderReportSummaryHtml(s, state.reportFilter);
    $('#reportBody').innerHTML = REPORT.toHTML(state.session, { filter: state.reportFilter })
      .replace(/^[\s\S]*<body>/, '')
      .replace(/<\/body>[\s\S]*$/, '');
    $('#reportBody').querySelectorAll('.card-filter').forEach((card) => {
      const f = card.getAttribute('data-report-filter');
      card.classList.toggle('is-active', f === state.reportFilter);
    });
    wireReportFilters();
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

  function kanyeImageUrl(filename) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      const url = chrome.runtime.getURL('assets/kanye/' + filename);
      if (url.startsWith('chrome-extension://')) return url;
    }
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      return '../assets/kanye/' + filename;
    }
    // Demo panel (demo/panel.html)
    return '../extension/assets/kanye/' + filename;
  }

  function setRandomKanyePortrait() {
    const img = $('#kanyePortrait');
    const list = window.FAA_KANYE_IMAGES;
    if (!img || !list || !list.length) return;

    const reveal = () => img.classList.add('is-loaded');
    const pick = list[Math.floor(Math.random() * list.length)];
    const url = kanyeImageUrl(pick);

    img.onload = reveal;
    img.onerror = () => img.classList.remove('is-loaded');
    img.classList.remove('is-loaded');
    img.src = url;

    if (img.complete && img.naturalWidth > 0) reveal();
  }

  // ---- init ----
  (async function init() {
    const tagline = $('#tagline');
    if (tagline && typeof window.FAA_randomQuote === 'function') {
      tagline.textContent = window.FAA_randomQuote();
    }
    setRandomKanyePortrait();
    refreshDataStepNav();
    refreshLearnMappingVisibility();
    const stored = await chrome.storage.local.get(STORAGE_KEYS.RECIPE);
    state.recipe = stored[STORAGE_KEYS.RECIPE] || null;
    if (state.recipe) state.maxTabIndex = TAB_ORDER.indexOf('run');
    refreshTabLocks();
    renderRecipeStatus();
    refreshLearnReadiness();
    refreshRunReadiness();
  })();
})();
