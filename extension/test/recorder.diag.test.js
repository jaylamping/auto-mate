/**
 * Diagnostic session-recorder tests against the LIVE MedHub markup.
 *
 * The session recorder is a raw, complete interaction log (separate from the
 * inference layer). It streams every focus/change/blur/click/submit with full
 * element metadata plus auto-mate's field guess, so the user can export the log
 * and we can verify each field mapped to the right logical field.
 */
const assert = require('assert');
const { createPage, typeValue, clickEl } = require('./harness');

module.exports = async function run() {
  const page = createPage('medhub-procedure-log-live.html');
  const { window, document, RECORDER } = page;

  const steps = [];
  const diags = [];
  RECORDER.start(
    (s) => steps.push(s),
    null,
    (d) => diags.push(d)
  );

  // Procedure date (MM/DD/YYYY text input with datepicker)
  typeValue(window, document.querySelector('input[name="procedure_date"]'), '06/17/2026');

  // Location: type IMC into the OTHER specify box
  const loc = document.querySelector('input[name="location_other"]');
  typeValue(window, loc, 'IMC');
  loc.dispatchEvent(new window.FocusEvent('blur', { bubbles: true }));

  // Supervisor via the List <select>
  const sup = document.querySelector('select[name="supervisorID"]');
  sup.value = '99001';
  sup.dispatchEvent(new window.Event('change', { bubbles: true }));

  // MRN / Encounter
  typeValue(window, document.querySelector('input[name="patientID_other"]'), '000123456');

  // Submit
  clickEl(window, document.querySelector('#procedureform input[type="submit"]'));

  RECORDER.stop();

  assert.ok(diags.length > 0, 'diagnostic events captured');

  // Every event has a monotonic seq, a relative timestamp and element metadata.
  diags.forEach((d, i) => {
    assert.strictEqual(d.seq, i + 1, 'seq is monotonic');
    assert.ok(typeof d.t === 'number' && d.t >= 0, 'relative timestamp present');
    assert.ok(d.element && d.element.tag, 'element metadata present');
    assert.ok(Array.isArray(d.element.candidates), 'candidate selectors captured');
  });

  const dateEvent = diags.find(
    (d) => d.element.name === 'procedure_date' && d.value === '06/17/2026'
  );
  assert.ok(dateEvent, 'date interaction captured with value');
  assert.strictEqual(dateEvent.guessField, 'date', 'date field guessed correctly');

  const locEvent = diags.find((d) => d.element.name === 'location_other' && d.value === 'IMC');
  assert.ok(locEvent, 'location interaction captured with value IMC');
  assert.strictEqual(locEvent.guessField, 'location', 'location field guessed correctly');

  const supEvent = diags.find((d) => d.element.name === 'supervisorID');
  assert.ok(supEvent, 'supervisor select interaction captured');
  assert.strictEqual(supEvent.guessField, 'supervisor', 'supervisor field guessed correctly');
  assert.strictEqual(supEvent.optionText, 'Smith, John', 'selected option text captured');

  const mrnEvent = diags.find((d) => d.element.name === 'patientID_other' && d.value === '000123456');
  assert.ok(mrnEvent, 'encounter/MRN interaction captured');
  assert.strictEqual(mrnEvent.guessField, 'encounter', 'encounter field guessed correctly');

  const submitEvent = diags.find(
    (d) => d.event === 'click' && d.element.id === 'procedure_submit'
  );
  assert.ok(submitEvent, 'submit click captured in the session log');

  console.log(`  recorder.diag: captured ${diags.length} raw interactions with field guesses.`);
};
