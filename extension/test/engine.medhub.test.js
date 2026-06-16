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
      { field: FIELD.ENCOUNTER, role: ROLE.INPUT, candidates: css('#encounterText') },
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
    const result = await ENGINE.runRow(buildRecipe(page.MSG), row, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, 'dry run ok: ' + JSON.stringify(result.actions.filter((a) => a.outcome !== 'success')));

    assert.strictEqual(document.getElementById('procedureDate').value, '06/15/2026', 'date');
    assert.strictEqual(document.getElementById('locationSpecify').value, 'IMC', 'location specify = IMC');
    assert.strictEqual(document.getElementById('supSelect').value, 'smith_john', 'supervisor picked from List dropdown');
    assert.strictEqual(document.getElementById('supChosen').value, 'Smith, John MD', 'supervisor hidden id set from list');
    assert.strictEqual(document.getElementById('supSearchPane').style.display, 'none', 'Search pane stays hidden when List matches');
    assert.strictEqual(document.getElementById('encounterText').value, '000123456', 'MRN into encounter field');

    const selected = document.querySelectorAll('#selectedProcs .selected_proc');
    assert.strictEqual(selected.length, 2, 'two procedures added');
    assert.deepStrictEqual(Array.from(selected).map((tr) => tr.children[1].textContent), ['Colonoscopy', 'Biopsy']);

    assert.notStrictEqual(document.body.getAttribute('data-submitted'), 'true', 'dry run must not submit');
    console.log('  engine.medhub: dry-run filled date/location/supervisor(list)/MRN/2 procedures, no submit.');
  }

  // ---- Supervisor not on List tab → Search until one result ----
  {
    const page = createPage('medhub-procedure-log.html');
    const { document, ENGINE } = page;
    const leeRow = { ...row, supervisor: 'Lee, Karen' };
    const result = await ENGINE.runRow(buildRecipe(page.MSG), leeRow, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, 'lee row ok');
    assert.strictEqual(document.getElementById('supSearchPane').style.display, 'block', 'Search pane shown for non-list supervisor');
    assert.strictEqual(document.getElementById('supSearch').value, 'Lee, Karen MD', 'supervisor search pick');
    assert.strictEqual(document.getElementById('supChosen').value, 'Lee, Karen MD', 'supervisor hidden id from search');
    console.log('  engine.medhub: supervisor falls back to Search tab when not on List.');
  }

  // ---- Live run ----
  {
    const page = createPage('medhub-procedure-log.html');
    const { document, ENGINE } = page;
    const result = await ENGINE.runRow(buildRecipe(page.MSG), row, { dryRun: false, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, 'live run ok');
    assert.strictEqual(document.body.getAttribute('data-submitted'), 'true', 'submitted');
    assert.strictEqual(document.body.getAttribute('data-submit-count'), '1', 'submitted once');
    console.log('  engine.medhub: live run submitted once via Log Procedure.');
  }

  // ---- Similar procedure names: exact CSV value should beat longer prefix sibling ----
  {
    const page = createPage('medhub-procedure-log.html');
    const { document, ENGINE } = page;
    const biopsyRow = { ...row, procedures: ['Biopsy'] };
    const result = await ENGINE.runRow(buildRecipe(page.MSG), biopsyRow, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, 'biopsy row should succeed');
    const selected = document.querySelectorAll('#selectedProcs .selected_proc');
    assert.strictEqual(selected.length, 1, 'one procedure added');
    assert.strictEqual(selected[0].children[1].textContent, 'Biopsy', 'exact Biopsy wins over Biopsy w/ scalpel');
    console.log('  engine.medhub: exact procedure name beats longer similar sibling.');
  }

  // ---- Stale recipe: NOTES INPUT bound to supervisor search must not type notes there ----
  {
    const page = createPage('medhub-procedure-log.html');
    const { document, ENGINE, MSG } = page;
    const { ROLE, FIELD } = MSG;
    const css = (v) => [{ type: 'css', value: v }];
    const badRecipe = {
      version: 1,
      steps: [
        { field: FIELD.DATE, role: ROLE.INPUT, candidates: css('#procedureDate') },
        { field: FIELD.LOCATION, role: ROLE.STATIC, staticValue: 'IMC', candidates: css('#locationSpecify') },
        {
          field: FIELD.NOTES,
          role: ROLE.INPUT,
          candidates: css('#supSearch')
        },
        {
          field: FIELD.SUPERVISOR,
          role: ROLE.AUTOCOMPLETE,
          optionSelector: 'li.sup_result',
          candidates: css('#supSearch')
        },
        { field: FIELD.ENCOUNTER, role: ROLE.INPUT, candidates: css('#encounterText') },
        { field: FIELD.SUBMIT, role: ROLE.SUBMIT, candidates: css('#logProcedure') }
      ]
    };
    const notesRow = {
      ...row,
      notes: 'Procedure note should not land in supervisor search',
      procedures: []
    };
    const result = await ENGINE.runRow(badRecipe, notesRow, {
      dryRun: true,
      fieldDelayMs: 0,
      typeCharDelayMs: 0
    });
    assert.ok(result.ok, 'run should continue when mis-bound notes step is skipped');
    assert.strictEqual(document.getElementById('supSearch').value, '', 'supervisor search stays empty until supervisor step');
    const notesAction = result.actions.find((a) => a.field === 'notes' && a.role === 'input');
    assert.ok(notesAction && notesAction.outcome === 'skipped', 'mis-bound notes step skipped');
    assert.strictEqual(document.getElementById('supChosen').value, 'Smith, John MD', 'supervisor still picked');
    console.log('  engine.medhub: notes INPUT on supervisor search is skipped at replay.');
  }
};
