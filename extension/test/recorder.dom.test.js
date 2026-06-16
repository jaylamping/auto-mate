/**
 * Recorder tests against the MedHub procedure-form fixture.
 * Verifies Learn mode captures each field and detects the supervisor and
 * procedure autocompletes (type-then-pick) with an option selector.
 */
const assert = require('assert');
const { createPage, typeValue, clickEl, sleep } = require('./harness');

module.exports = async function run() {
  const page = createPage('medhub-procedure-form.html');
  const { window, document, RECORDER } = page;

  const steps = [];
  RECORDER.start((step) => steps.push(step));

  // Date
  typeValue(window, document.getElementById('proc_date'), '01/05/2026');
  // Location
  typeValue(window, document.getElementById('proc_location'), 'IMC');

  // Supervisor: type, fixture shows results, click the matching option.
  const sup = document.getElementById('sup_search');
  typeValue(window, sup, 'Smith, John');
  await sleep(20);
  const supOption = document.querySelector('#sup_results li.ac_item');
  assert.ok(supOption, 'fixture should render a supervisor option');
  clickEl(window, supOption);

  // Patient MRN
  typeValue(window, document.getElementById('patient_mrn'), '000123456');

  // Procedure: type, results show, click an option.
  const proc = document.getElementById('proc_search');
  typeValue(window, proc, 'Colonoscopy');
  await sleep(20);
  const procOption = document.querySelector('#proc_results li.ac_item');
  assert.ok(procOption, 'fixture should render a procedure option');
  clickEl(window, procOption);

  // Submit
  clickEl(window, document.getElementById('submitBtn'));

  RECORDER.stop();

  const roles = steps.map((s) => s.role);
  assert.ok(roles.includes('autocomplete'), 'should capture at least one autocomplete');
  assert.ok(roles.includes('submit'), 'should capture the submit click');

  const autocompletes = steps.filter((s) => s.role === 'autocomplete');
  assert.ok(autocompletes.length >= 2, `expected supervisor + procedure autocompletes, got ${autocompletes.length}`);
  for (const ac of autocompletes) {
    assert.ok(ac.optionSelector && /ac_item/.test(ac.optionSelector), `optionSelector should target the result item, got "${ac.optionSelector}"`);
    assert.ok(ac.candidates && ac.candidates.length, 'autocomplete step should carry input candidates');
  }

  // Inputs (date, location, mrn) should be captured as plain inputs.
  const inputs = steps.filter((s) => s.role === 'input');
  assert.ok(inputs.length >= 3, `expected >=3 plain input steps, got ${inputs.length}`);

  console.log(`  recorder.dom: ${steps.length} steps captured (${autocompletes.length} autocomplete, ${inputs.length} input).`);
};
