/**
 * Engine tests against the LIVE MedHub markup (medhub-procedure-log-live.html),
 * captured from the client's real "Log Procedure/Case" page. These guard the
 * exact selectors the live form uses, which differ from the idealized fixture:
 *   - Procedure Date : input[name="procedure_date"] (no id)
 *   - Location       : typed into input[name="location_other"] (this resident's
 *                      location <select> only offers "(OTHER - Specify...)")
 *   - Supervisor     : List tab <select name="supervisorID"> in #procedures_supervisor_pane
 *   - MRN            : input[name="patientID_other"]
 *   - Procedures     : #procedures_searchterms picker, rows call procedures_add(...),
 *                      selected rows land in #selected_procedures as #prow_N
 *   - Submit         : the form's submit button
 */
const assert = require('assert');
const { createPage } = require('./harness');

function buildRecipe(MSG) {
  const { ROLE, FIELD } = MSG;
  const css = (v) => [{ type: 'css', value: v }];
  return {
    version: 1,
    url: 'https://ahc.medhub.com/u/r/procedures.mh',
    procedureRepeatable: true,
    steps: [
      { field: FIELD.DATE, role: ROLE.INPUT, candidates: css('input[name="procedure_date"]') },
      { field: FIELD.LOCATION, role: ROLE.STATIC, staticValue: 'IMC', candidates: css('input[name="location_other"]') },
      { field: FIELD.CLICK, role: ROLE.CLICK, candidates: css('#supervisor_tab_2') },
      { field: FIELD.SUPERVISOR, role: ROLE.AUTOCOMPLETE, optionSelector: 'div.optionDiv', candidates: css('select[name="supervisorID"]') },
      { field: FIELD.ENCOUNTER, role: ROLE.INPUT, candidates: css('input[name="patientID_other"]') },
      {
        field: FIELD.PROCEDURE,
        role: ROLE.AUTOCOMPLETE,
        optionSelector: '#procedures_list tbody tr',
        clickRel: 'a',
        candidates: css('input[name="procedures_searchterms"]')
      },
      { field: FIELD.SUBMIT, role: ROLE.SUBMIT, candidates: css('#procedureform input[type="submit"]') }
    ]
  };
}

const row = {
  date: '06/17/2026',
  supervisor: 'Smith, John',
  mrn: '000123456',
  procedures: ['Colonoscopy', 'Biopsy'],
  location: 'IMC'
};

function selectedTitles(document) {
  return Array.from(document.querySelectorAll('#selected_procedures tr[id^="prow_"]:not(.hidden)'))
    .filter((tr) => tr.id !== 'prow_0')
    .map((tr) => document.getElementById(tr.id + '_title').textContent);
}

module.exports = async function run() {
  // ---- Dry run fills every field via live selectors ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const result = await ENGINE.runRow(buildRecipe(page.MSG), row, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, 'dry run ok: ' + JSON.stringify(result.actions.filter((a) => a.outcome !== 'success')));

    assert.strictEqual(document.querySelector('input[name="procedure_date"]').value, '06/17/2026', 'date');
    assert.strictEqual(document.getElementById('ui-datepicker-div').style.display, 'none', 'datepicker calendar dismissed after filling the date');
    assert.strictEqual(document.querySelector('input[name="location_other"]').value, 'IMC', 'location_other = IMC');
    assert.strictEqual(document.querySelector('select[name="supervisorID"]').value, '99001', 'supervisor picked from List <select>');
    assert.strictEqual(document.getElementById('supervisor_search_userID').value, '99001', 'live hidden supervisor userID set via select change');
    assert.strictEqual(document.querySelector('input[name="patientID_other"]').value, '000123456', 'MRN into patientID_other');

    assert.deepStrictEqual(selectedTitles(document), ['Colonoscopy', 'Biopsy'], 'two procedures added to #prow rows');
    assert.notStrictEqual(document.body.getAttribute('data-submitted'), 'true', 'dry run must not submit');
    console.log('  engine.medhub-live: filled date/location_other/supervisor(list)/MRN/2 procedures, no submit.');
  }

  // ---- Exact procedure name beats longer sibling ("Biopsy" not "Biopsy w/ scalpel") ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const biopsyRow = { ...row, procedures: ['Biopsy'] };
    const result = await ENGINE.runRow(buildRecipe(page.MSG), biopsyRow, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, 'biopsy row ok');
    assert.deepStrictEqual(selectedTitles(document), ['Biopsy'], 'exact Biopsy wins over Biopsy w/ scalpel');
    console.log('  engine.medhub-live: exact procedure name beats longer sibling.');
  }

  // ---- Live run submits the procedureform once ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const result = await ENGINE.runRow(buildRecipe(page.MSG), row, { dryRun: false, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, 'live run ok');
    assert.strictEqual(document.body.getAttribute('data-submitted'), 'true', 'submitted');
    assert.strictEqual(document.body.getAttribute('data-submit-count'), '1', 'submitted once');
    console.log('  engine.medhub-live: live run submitted the procedureform once.');
  }

  // ---- Second row clears the prior row's selected procedures (procedures_delete) ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const recipe = buildRecipe(page.MSG);
    await ENGINE.runRow(recipe, row, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.deepStrictEqual(selectedTitles(document), ['Colonoscopy', 'Biopsy'], 'row1 adds two');
    const row2 = { ...row, procedures: ['Ablation'] };
    await ENGINE.runRow(recipe, row2, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.deepStrictEqual(selectedTitles(document), ['Ablation'], 'row2 replaces prior procedures');
    console.log('  engine.medhub-live: clears prior procedures via procedures_delete before next row.');
  }
};
