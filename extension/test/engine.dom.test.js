/**
 * Replay-engine tests against the MedHub procedure-form fixture.
 * Builds a recipe (as Learn mode would) and verifies a row is filled
 * correctly: date, static location, supervisor autocomplete match, MRN,
 * multiple procedures, and submit behavior under dry-run vs live.
 */
const assert = require('assert');
const { createPage } = require('./harness');

function buildRecipe(FAA) {
  const { ROLE, FIELD } = FAA.MSG;
  const css = (v) => [{ type: 'css', value: v }];
  return {
    version: 1,
    url: 'https://ahc.medhub.com/u/r/procedures.mh',
    procedureRepeatable: true,
    steps: [
      { field: FIELD.DATE, role: ROLE.INPUT, candidates: css('#proc_date') },
      { field: FIELD.LOCATION, role: ROLE.STATIC, staticValue: 'IMC', candidates: css('#proc_location') },
      { field: FIELD.SUPERVISOR, role: ROLE.AUTOCOMPLETE, optionSelector: 'li.ac_item', candidates: css('#sup_search') },
      { field: FIELD.MRN, role: ROLE.INPUT, candidates: css('#patient_mrn') },
      { field: FIELD.PROCEDURE, role: ROLE.AUTOCOMPLETE, optionSelector: 'li.ac_item', candidates: css('#proc_search') },
      { field: FIELD.SUBMIT, role: ROLE.SUBMIT, candidates: css('#submitBtn') }
    ]
  };
}

const row = {
  date: '01/05/2026',
  supervisor: 'Smith, John',
  mrn: '000123456',
  procedures: ['Colonoscopy', 'Biopsy'],
  location: 'IMC'
};

module.exports = async function run() {
  // ---- Dry run: fills everything but must NOT submit ----
  {
    const page = createPage('medhub-procedure-form.html');
    const { window, document, ENGINE } = page;
    const recipe = buildRecipe({ MSG: page.MSG });

    const result = await ENGINE.runRow(recipe, row, { dryRun: true, fieldDelayMs: 0 });
    assert.ok(result.ok, 'dry run should complete ok: ' + JSON.stringify(result.actions.filter((a) => a.outcome !== 'success')));

    assert.strictEqual(document.getElementById('proc_date').value, '01/05/2026', 'date filled');
    assert.strictEqual(document.getElementById('proc_location').value, 'IMC', 'location is static IMC');
    assert.strictEqual(document.getElementById('sup_search').value, 'Smith, John MD', 'supervisor best-match selected');
    assert.strictEqual(document.getElementById('sup_id').value, 'Smith, John MD', 'supervisor hidden id set via option click');
    assert.strictEqual(document.getElementById('patient_mrn').value, '000123456', 'MRN preserved with leading zeros');

    const chips = document.querySelectorAll('#selected_procedures .proc_chip');
    assert.strictEqual(chips.length, 2, 'both procedures selected');
    assert.deepStrictEqual(Array.from(chips).map((c) => c.textContent), ['Colonoscopy', 'Biopsy']);

    assert.notStrictEqual(document.body.getAttribute('data-submitted'), 'true', 'dry run must NOT submit');
    const submitAction = result.actions.find((a) => a.field === 'submit');
    assert.strictEqual(submitAction.outcome, 'skipped', 'submit logged as skipped in dry run');

    console.log('  engine.dom: dry-run filled all fields, no submit.');
  }

  // ---- Live run: should submit exactly once ----
  {
    const page = createPage('medhub-procedure-form.html');
    const { document, ENGINE } = page;
    const recipe = buildRecipe({ MSG: page.MSG });

    const result = await ENGINE.runRow(recipe, row, { dryRun: false, fieldDelayMs: 0 });
    assert.ok(result.ok, 'live run should complete ok');
    assert.strictEqual(document.body.getAttribute('data-submitted'), 'true', 'live run submits');
    assert.strictEqual(document.body.getAttribute('data-submit-count'), '1', 'submitted exactly once');

    console.log('  engine.dom: live run submitted once.');
  }

  // ---- No-match supervisor should fail the row cleanly ----
  {
    const page = createPage('medhub-procedure-form.html');
    const { ENGINE } = page;
    const recipe = buildRecipe({ MSG: page.MSG });
    const badRow = { ...row, supervisor: 'Nonexistent Person' };
    const result = await ENGINE.runRow(recipe, badRow, { dryRun: true, fieldDelayMs: 0, autocompleteTimeoutMs: 300 });
    assert.ok(!result.ok, 'row with unmatched supervisor should fail');
    assert.strictEqual(result.failedField, 'supervisor');
    console.log('  engine.dom: unmatched supervisor fails the row cleanly.');
  }
};
