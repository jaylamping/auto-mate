/**
 * auto-mate shared message protocol.
 *
 * Loaded both as a content script and via <script> in the side panel, so it
 * must be safe to evaluate in either context. All message passing between the
 * side panel and the page content scripts flows through these constants.
 */
(function (root) {
  const MSG = {
    // Side panel -> content
    PING: 'faa:ping',
    START_LEARN: 'faa:start-learn',
    STOP_LEARN: 'faa:stop-learn',
    SAVE_STEP_LABEL: 'faa:save-step-label',
    RUN_ROW: 'faa:run-row',
    STOP_RUN: 'faa:stop-run',
    HIGHLIGHT_FIELD: 'faa:highlight-field',
    SCAN_FORM: 'faa:scan-form',
    CLEAR_OVERLAY: 'faa:clear-overlay',
    // Content -> side panel
    PONG: 'faa:pong',
    STEP_RECORDED: 'faa:step-recorded',
    FIELD_INPUT: 'faa:field-input',
    LEARN_DONE: 'faa:learn-done',
    ROW_PROGRESS: 'faa:row-progress',
    ROW_DONE: 'faa:row-done',
    ACTION_LOG: 'faa:action-log',
    ENGINE_ERROR: 'faa:engine-error'
  };

  /** Bumped when content scripts change; side panel re-injects if mismatch. */
  const BUILD_ID = '15';

  // Logical field roles a recorded step can fulfil.
  const ROLE = {
    INPUT: 'input',
    AUTOCOMPLETE: 'autocomplete',
    STATIC: 'static',
    SUBMIT: 'submit',
    CLICK: 'click'
  };

  // Canonical logical field names the recipe maps spreadsheet columns onto.
  const FIELD = {
    DATE: 'date',
    LOCATION: 'location',
    SUPERVISOR: 'supervisor',
    ENCOUNTER: 'encounter',
    PROCEDURE: 'procedure',
    GENDER: 'gender',
    AGE: 'age',
    DIAGNOSIS: 'diagnosis',
    COMPLICATIONS: 'complications',
    NOTES: 'notes',
    SUBMIT: 'submit',
    CLICK: 'click'
  };

  /** Learn tab: form fields in display order. `required` = must have spreadsheet column + row value at run. */
  const FORM_FIELDS = [
    { key: FIELD.DATE, label: 'Procedure Date', required: true },
    { key: FIELD.LOCATION, label: 'Location', required: true },
    { key: FIELD.SUPERVISOR, label: 'Supervisor', required: true },
    { key: FIELD.ENCOUNTER, label: 'Encounter', required: true },
    { key: FIELD.PROCEDURE, label: 'Procedure', required: true },
    { key: FIELD.GENDER, label: 'Patient Gender', required: false, minMappingLen: 1, minColumnInferLen: 1 },
    { key: FIELD.AGE, label: 'Patient Age', required: false, minColumnInferLen: 1 },
    { key: FIELD.DIAGNOSIS, label: 'Diagnosis', required: false },
    { key: FIELD.COMPLICATIONS, label: 'Complications', required: false },
    { key: FIELD.NOTES, label: 'Procedure Notes', required: false }
  ];

  const STORAGE_KEYS = {
    RECIPE: 'faa.recipe',
    MAPPING: 'faa.mapping',
    DATA_SESSION: 'faa.dataSession',
    SETTINGS: 'faa.settings'
  };

  /** Per-row engine timeout (side panel waits for ROW_DONE). */
  const ROW_TIMEOUT_MS = 120000;

  function normalizeRecipeUrl(url) {
    try {
      const u = new URL(String(url));
      return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    } catch (_) {
      return '';
    }
  }

  /** True when tab URL is the same form origin/path learned in the recipe. */
  function tabMatchesRecipeUrl(tabUrl, recipeUrl) {
    const tabNorm = normalizeRecipeUrl(tabUrl);
    const recipeNorm = normalizeRecipeUrl(recipeUrl);
    if (!tabNorm || !recipeNorm) return false;
    if (tabNorm === recipeNorm) return true;
    if (tabNorm.endsWith(recipeNorm) || recipeNorm.endsWith(tabNorm)) return true;
    try {
      const t = new URL(tabUrl);
      return /procedures/i.test(t.pathname);
    } catch (_) {
      return false;
    }
  }

  function minMappingLenForFieldKey(fieldKey) {
    const def = FORM_FIELDS.find((f) => f.key === fieldKey);
    return def && def.minMappingLen != null ? def.minMappingLen : 2;
  }

  function minMappingLenFromHaystack(hay) {
    const s = String(hay || '').toLowerCase();
    if (/patient gender|\bgender\b|\bsex\b/.test(s)) return 1;
    return 2;
  }

  /** Lowercase, strip non-alphanumeric, concatenate — for value/label matching. */
  function normalizeMatchKey(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  }

  /** Min normalized length before substring column matching (avoids "ass" in "assessment"). */
  const MIN_VALUE_MATCH_SUBSTRING_LEN = 4;

  function minColumnInferLenForFieldKey(fieldKey) {
    const def = FORM_FIELDS.find((f) => f.key === fieldKey);
    if (def && def.minColumnInferLen != null) return def.minColumnInferLen;
    if (def && def.minMappingLen != null) return def.minMappingLen;
    return MIN_VALUE_MATCH_SUBSTRING_LEN;
  }

  function valueMatchesCell(cellValue, needle) {
    const v = normalizeMatchKey(cellValue);
    const n = normalizeMatchKey(needle);
    if (!v || !n) return false;
    if (v === n) return true;
    if (n.length < MIN_VALUE_MATCH_SUBSTRING_LEN) return false;
    return v.includes(n);
  }

  function columnInferPreferenceScore(header, preferredCol) {
    let score = 0;
    const hl = String(header || '').toLowerCase();
    if (/\bname\b/.test(hl) || hl.includes('name')) score += 100;
    if (preferredCol && header === preferredCol) score += 10;
    if (/\bnotes?\b|\bcomments?\b/.test(hl)) score -= 50;
    return score;
  }

  function pickPreferredColumnMatch(matches, preferredCol) {
    if (!matches || !matches.length) return null;
    let best = matches[0];
    let bestScore = columnInferPreferenceScore(best, preferredCol);
    for (let i = 1; i < matches.length; i++) {
      const s = columnInferPreferenceScore(matches[i], preferredCol);
      if (s > bestScore) {
        best = matches[i];
        bestScore = s;
      }
    }
    return best;
  }

  function candidateHaystack(candidates) {
    return (candidates || []).map((c) => String(c.value || '')).join(' ').toLowerCase();
  }

  /** Live MedHub Search tab uses a generic input[name="searchterms"], not supervisor_search. */
  function isSupervisorSearchCandidates(candidates) {
    const hay = candidateHaystack(candidates);
    if (/procedures_searchterms|proc_search|#procsearch/.test(hay)) return false;
    if (/supervisor_search|sup_search|supsearch/.test(hay)) return true;
    if (/procedures_supervisor/.test(hay) && /searchterms/.test(hay)) return true;
    if (/input\[name="searchterms"\]|#searchterms\b|\[name="searchterms"\]/.test(hay)) return true;
    return false;
  }

  /** Guess logical field from label / accessible name only (not cell values). */
  function guessFieldFromLabel(text, role) {
    const hay = String(text || '').toLowerCase();
    if (!hay) return '';
    if (role === ROLE.SUBMIT) return FIELD.SUBMIT;
    if (role === ROLE.CLICK) return FIELD.CLICK;
    if (/procedure\s*date|date of service|\bdos\b/.test(hay)) return FIELD.DATE;
    if (/^date\b|\bdate\b/.test(hay) && !/update/.test(hay)) return FIELD.DATE;
    if (/location|site|facility/.test(hay)) return FIELD.LOCATION;
    if (/supervis|attending|precept/.test(hay)) return FIELD.SUPERVISOR;
    if (/encounter|mrn|patient id|medical record/.test(hay)) return FIELD.ENCOUNTER;
    if (/patient gender|\bgender\b|\bsex\b/.test(hay)) return FIELD.GENDER;
    if (/patient age|\bage\b/.test(hay)) return FIELD.AGE;
    if (/diagnos|\bicd\b|\bdx\b/.test(hay)) return FIELD.DIAGNOSIS;
    if (/complicat/.test(hay)) return FIELD.COMPLICATIONS;
    if (/procedure\s*notes?|\bcomments?\b/.test(hay)) return FIELD.NOTES;
    if (/procedure|cpt/.test(hay)) return FIELD.PROCEDURE;
    if (role === ROLE.AUTOCOMPLETE) {
      if (/supervis|attending/.test(hay)) return FIELD.SUPERVISOR;
      return FIELD.PROCEDURE;
    }
    return '';
  }

  /** Label first; only use short typed prefixes from sampleValue when label is empty. */
  function autoGuessField(step) {
    if (isSupervisorSearchCandidates(step.candidates)) return FIELD.SUPERVISOR;
    const fromLabel = guessFieldFromLabel(step.text, step.role);
    if (fromLabel) return fromLabel;
    const sample = String(step.sampleValue || '');
    if (sample && sample.length <= 48) {
      const fromValue = guessFieldFromLabel(sample, step.role);
      if (fromValue) return fromValue;
    }
    if (step.role === ROLE.AUTOCOMPLETE) return FIELD.PROCEDURE;
    return '';
  }

  function isNotesLikeHeader(header) {
    const hl = String(header || '').toLowerCase();
    return /\bprocedure\s*notes?\b|\bnotes?\b|\bcomments?\b/.test(hl);
  }

  function isSupervisorLikeHeader(header) {
    const hl = String(header || '').toLowerCase();
    return /supervis|attending|precept/.test(hl);
  }

  /** Block supervisor↔notes column cross-mapping from value-only infer. */
  function headerAllowedForFieldKey(header, fieldKey) {
    if (!fieldKey || !header) return true;
    if (fieldKey === FIELD.SUPERVISOR && isNotesLikeHeader(header) && !isSupervisorLikeHeader(header)) {
      return false;
    }
    if (fieldKey === FIELD.NOTES && isSupervisorLikeHeader(header) && !isNotesLikeHeader(header)) {
      return false;
    }
    return true;
  }

  const api = {
    MSG,
    ROLE,
    FIELD,
    FORM_FIELDS,
    STORAGE_KEYS,
    BUILD_ID,
    ROW_TIMEOUT_MS,
    normalizeRecipeUrl,
    tabMatchesRecipeUrl,
    minMappingLenForFieldKey,
    minMappingLenFromHaystack,
    minColumnInferLenForFieldKey,
    normalizeMatchKey,
    valueMatchesCell,
    MIN_VALUE_MATCH_SUBSTRING_LEN,
    columnInferPreferenceScore,
    pickPreferredColumnMatch,
    guessFieldFromLabel,
    autoGuessField,
    isSupervisorSearchCandidates,
    headerAllowedForFieldKey,
    isNotesLikeHeader,
    isSupervisorLikeHeader
  };

  // Expose on window (side panel + content scripts share window in their realm).
  root.FAA_MSG = api;
})(typeof window !== 'undefined' ? window : globalThis);
