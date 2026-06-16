/**
 * Engine tests against the realistic MedHub procedures_log fixture.
 * Exercises the patterns the live form actually uses:
 *  - Location typed into a "specify" box (static IMC)
 *  - Supervisor: a navigation CLICK on the "Search" tab, then autocomplete
 *  - MRN typed into the Encounter field
 *  - Procedures: filter a list + click the "+" add control in the matched row
 *  - Submit via "Log Procedure"
 */
const assert = require('assert');
const { createPage } = require('./harness');

function buildRecipe(MSG) {
  const { ROLE, FIELD } = MSG;
  const css = (v) => [{ type: 'css', value: v }];
  return {
    version: 1,
    url: 'https://ahc.medhub.com/u/r/procedures_log.mh',
    procedureRepeatable: true,
    steps: [
      { field: FIELD.DATE, role: ROLE.INPUT, candidates: css('#procedureDate') },
      { field: FIELD.LOCATION, role: ROLE.STATIC, staticValue: 'IMC', candidates: css('#locationSpecify') },
      { field: FIELD.CLICK, role: ROLE.CLICK, candidates: css('#supTabSearch') },
      { field: FIELD.SUPERVISOR, role: ROLE.AUTOCOMPLETE, optionSelector: 'li.sup_result', candidates: css('#supSearch') },
      { field: FIELD.MRN, role: ROLE.INPUT, candidates: css('#encounterText') },
      { field: FIELD.PROCEDURE, role: ROLE.AUTOCOMPLETE, optionSelector: 'li.proc_row', clickRel: 'a.add', candidates: css('#procSearch') },
      { field: FIELD.SUBMIT, role: ROLE.SUBMIT, candidates: css('#logProcedure') }
    ]
  };
}

const row = {
  date: '06/15/2026',
  supervisor: 'Smith, John',
  mrn: '000123456',
  procedures: ['Colonoscopy', 'Biopsy'],
  location: 'IMC'
};

module.exports = async function run() {
  // ---- Dry run ----
  {
    const page = createPage('medhub-procedure-log.html');
    const { document, ENGINE } = page;
    const result = await ENGINE.runRow(buildRecipe(page.MSG), row, { dryRun: true, fieldDelayMs: 0 });
    assert.ok(result.ok, 'dry run ok: ' + JSON.stringify(result.actions.filter((a) => a.outcome !== 'success')));

    assert.strictEqual(document.getElementById('procedureDate').value, '06/15/2026', 'date');
    assert.strictEqual(document.getElementById('locationSpecify').value, 'IMC', 'location specify = IMC');
    assert.strictEqual(document.getElementById('supSearchPane').style.display, 'block', 'Search tab was clicked to reveal the search pane');
    assert.strictEqual(document.getElementById('supSearch').value, 'Smith, John MD', 'supervisor best-match');
    assert.strictEqual(document.getElementById('supChosen').value, 'Smith, John MD', 'supervisor hidden id set');
    assert.strictEqual(document.getElementById('encounterText').value, '000123456', 'MRN into encounter field');

    const selected = document.querySelectorAll('#selectedProcs .selected_proc');
    assert.strictEqual(selected.length, 2, 'two procedures added');
    assert.deepStrictEqual(Array.from(selected).map((tr) => tr.children[1].textContent), ['Colonoscopy', 'Biopsy']);

    assert.notStrictEqual(document.body.getAttribute('data-submitted'), 'true', 'dry run must not submit');
    console.log('  engine.medhub: dry-run filled date/location/supervisor(tab+search)/MRN/2 procedures, no submit.');
  }

  // ---- Live run ----
  {
    const page = createPage('medhub-procedure-log.html');
    const { document, ENGINE } = page;
    const result = await ENGINE.runRow(buildRecipe(page.MSG), row, { dryRun: false, fieldDelayMs: 0 });
    assert.ok(result.ok, 'live run ok');
    assert.strictEqual(document.body.getAttribute('data-submitted'), 'true', 'submitted');
    assert.strictEqual(document.body.getAttribute('data-submit-count'), '1', 'submitted once');
    console.log('  engine.medhub: live run submitted once via Log Procedure.');
  }
};
