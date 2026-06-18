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
    DIAG_EVENT: 'faa:diag-event',
    LEARN_DONE: 'faa:learn-done',
    ROW_PROGRESS: 'faa:row-progress',
    ROW_DONE: 'faa:row-done',
    ACTION_LOG: 'faa:action-log',
    ENGINE_ERROR: 'faa:engine-error'
  };

  /** Bumped when content scripts change; side panel re-injects if mismatch. */
  const BUILD_ID = '21';

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
    { key: FIELD.LOCATION, label: 'Location', required: true, columnOptional: true },
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

  function isDateCandidates(candidates) {
    const hay = candidateHaystack(candidates);
    return /procedure_date|procedure[_-]date|\bproc[_-]date\b|datepicker_icon|hasdatepicker/.test(hay);
  }

  function isLocationCandidates(candidates) {
    const hay = candidateHaystack(candidates);
    if (/procedures_searchterms|proc_search/.test(hay)) return false;
    return /location_other|locationid|locationspecify|location_specify|proc_location|\[name="location"\]|\[name="location_other"\]|\[name="locationid"\]/i.test(
      hay
    );
  }

  /** Site codes users type into MedHub location specify / dropdown fields during Learn. */
  const KNOWN_LOCATION_VALUES = new Set(['imc', 'cicu']);

  function isKnownLocationValue(value) {
    const key = normalizeMatchKey(value);
    return key.length > 0 && KNOWN_LOCATION_VALUES.has(key);
  }

  function isConflictingLocationGuess(candidates) {
    return (
      isProcedureFieldCandidates(candidates) ||
      isSupervisorSearchCandidates(candidates) ||
      isEncounterCandidates(candidates) ||
      isDateCandidates(candidates) ||
      isNotesCandidates(candidates) ||
      isDiagnosisCandidates(candidates) ||
      isComplicationsCandidates(candidates)
    );
  }

  function isProcedureFieldCandidates(candidates) {
    const hay = candidateHaystack(candidates);
    return /procedures_searchterms|proc_search|#procsearch|procedures_list/.test(hay);
  }

  function isEncounterCandidates(candidates) {
    const hay = candidateHaystack(candidates);
    if (/patient_gender|patient_age|gender|patient_age/.test(hay)) return false;
    return /patientid_other|\[name="patientid_other"\]|#patientid_other|patient_mrn|encountertext|\[name="patientid"\]|select\[name="patientid"\]|#patientid\b/.test(
      hay
    );
  }

  function isGenderCandidates(candidates) {
    return /patient_gender|\[name="patient_gender"\]|select patient gender/.test(candidateHaystack(candidates));
  }

  function isAgeCandidates(candidates) {
    return /patient_age|\[name="patient_age"\]|select patient age/.test(candidateHaystack(candidates));
  }

  function isDiagnosisCandidates(candidates) {
    return /\[name="diagnosis"\]|#diagnosis\b|^input\[name="diagnosis"\]/.test(candidateHaystack(candidates));
  }

  function isComplicationsCandidates(candidates) {
    return /\[name="complications"\]|^input\[name="complications"\]/.test(candidateHaystack(candidates));
  }

  function isNotesCandidates(candidates) {
    return /\[name="notes"\]|textarea\[name="notes"\]|^textarea\[name="notes"\]/.test(candidateHaystack(candidates));
  }

  function isLocationDropdownCandidates(candidates) {
    const hay = candidateHaystack(candidates);
    return /locationid|\[name="locationid"\]|select\[name="locationid"\]/.test(hay) && !/location_other/.test(hay);
  }

  /** MedHub procedure date inputs expect MM/DD/YYYY, not ISO YYYY-MM-DD from Excel. */
  function toMedHubDateString(value) {
    const s = String(value == null ? '' : value).trim();
    if (!s) return '';
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
    const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) {
      const mm = slash[1].padStart(2, '0');
      const dd = slash[2].padStart(2, '0');
      return `${mm}/${dd}/${slash[3]}`;
    }
    return s;
  }

  /** Guess logical field from label / accessible name only (not cell values). */
  function guessFieldFromLabel(text, role) {
    const hay = String(text || '').toLowerCase();
    if (!hay) return '';
    if (role === ROLE.SUBMIT) return FIELD.SUBMIT;
    if (role === ROLE.CLICK) return FIELD.CLICK;
    if (/procedure[_\s-]*date|date of service|\bdos\b/.test(hay)) return FIELD.DATE;
    if (/^date\b|\bdate\b/.test(hay) && !/update/.test(hay)) return FIELD.DATE;
    if (/location|site|facility/.test(hay)) return FIELD.LOCATION;
    if (/supervis|attending|precept/.test(hay)) return FIELD.SUPERVISOR;
    if (/patient gender|\bgender\b|\bsex\b|patient_gender/.test(hay)) return FIELD.GENDER;
    if (/patient age|\bage\b|patient_age/.test(hay)) return FIELD.AGE;
    if (/encounter|mrn|patientid_other|select patient\b|medical record|\bpatientid\b/.test(hay)) {
      return FIELD.ENCOUNTER;
    }
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
    if (isDateCandidates(step.candidates)) return FIELD.DATE;
    if (isLocationCandidates(step.candidates)) return FIELD.LOCATION;
    if (isEncounterCandidates(step.candidates)) return FIELD.ENCOUNTER;
    if (isGenderCandidates(step.candidates)) return FIELD.GENDER;
    if (isAgeCandidates(step.candidates)) return FIELD.AGE;
    if (isDiagnosisCandidates(step.candidates)) return FIELD.DIAGNOSIS;
    if (isComplicationsCandidates(step.candidates)) return FIELD.COMPLICATIONS;
    if (isNotesCandidates(step.candidates)) return FIELD.NOTES;
    if (isProcedureFieldCandidates(step.candidates)) return FIELD.PROCEDURE;
    if (
      (step.role === ROLE.INPUT || step.role === ROLE.STATIC) &&
      isKnownLocationValue(step.sampleValue) &&
      !isConflictingLocationGuess(step.candidates)
    ) {
      return FIELD.LOCATION;
    }
    const fromLabel = guessFieldFromLabel(step.text, step.role);
    if (fromLabel) return fromLabel;
    const sample = String(step.sampleValue || '');
    if (sample && sample.length <= 48) {
      const fromValue = guessFieldFromLabel(sample, step.role);
      if (fromValue) return fromValue;
    }
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
    isDateCandidates,
    isLocationCandidates,
    isEncounterCandidates,
    isGenderCandidates,
    isAgeCandidates,
    isDiagnosisCandidates,
    isComplicationsCandidates,
    isNotesCandidates,
    isLocationDropdownCandidates,
    toMedHubDateString,
    isKnownLocationValue,
    isProcedureFieldCandidates,
    headerAllowedForFieldKey,
    isNotesLikeHeader,
    isSupervisorLikeHeader
  };

  // Expose on window (side panel + content scripts share window in their realm).
  root.FAA_MSG = api;
})(typeof window !== 'undefined' ? window : globalThis);
