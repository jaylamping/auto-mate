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
    RELEARN_FIELD: 'faa:relearn-field',

    // Content -> side panel
    PONG: 'faa:pong',
    STEP_RECORDED: 'faa:step-recorded',
    LEARN_DONE: 'faa:learn-done',
    ROW_PROGRESS: 'faa:row-progress',
    ROW_DONE: 'faa:row-done',
    ACTION_LOG: 'faa:action-log',
    ENGINE_ERROR: 'faa:engine-error'
  };

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
    MRN: 'mrn',
    PROCEDURE: 'procedure',
    SUBMIT: 'submit',
    CLICK: 'click'
  };

  const STORAGE_KEYS = {
    RECIPE: 'faa.recipe',
    MAPPING: 'faa.mapping',
    SETTINGS: 'faa.settings'
  };

  const api = { MSG, ROLE, FIELD, STORAGE_KEYS };

  // Expose on window (side panel + content scripts share window in their realm).
  root.FAA_MSG = api;
})(typeof window !== 'undefined' ? window : globalThis);
