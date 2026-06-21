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
    assert.strictEqual(document.querySelector('input[name="procedure_date"]').value, '06/17/2026', 'fixture starts prefilled');
    const result = await ENGINE.runRow(buildRecipe(page.MSG), row, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, 'dry run ok: ' + JSON.stringify(result.actions.filter((a) => a.outcome !== 'success')));

    assert.strictEqual(document.querySelector('input[name="procedure_date"]').value, '06/17/2026', 'date');
    assert.strictEqual(document.getElementById('ui-datepicker-div').style.display, 'none', 'datepicker calendar dismissed after filling the date');
    assert.strictEqual(document.querySelector('input[name="procedure_date"]').classList.contains('hasDatepicker'), true, 'jquery datepicker hook present');
    assert.strictEqual(document.querySelector('select[name="locationID"]').value, '551', 'location dropdown matched IMC');
    assert.strictEqual(document.querySelector('input[name="location_other"]').disabled, true, 'location_other unused when dropdown matches');
    assert.strictEqual(document.querySelector('select[name="supervisorID"]').value, '99001', 'supervisor picked from List <select>');
    assert.strictEqual(document.getElementById('supervisor_search_userID').value, '99001', 'live hidden supervisor userID set via select change');
    assert.strictEqual(document.querySelector('input[name="patientID_other"]').value, '000123456', 'MRN into patientID_other');

    assert.deepStrictEqual(selectedTitles(document), ['Colonoscopy', 'Biopsy'], 'two procedures added to #prow rows');
    assert.notStrictEqual(document.body.getAttribute('data-submitted'), 'true', 'dry run must not submit');
    console.log('  engine.medhub-live: filled date/location_other/supervisor(list)/MRN/2 procedures, no submit.');
  }

  // ---- Date replay clears MedHub's prefilled date before setting row date ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const dateInput = document.querySelector('input[name="procedure_date"]');
    assert.strictEqual(dateInput.value, '06/17/2026', 'fixture starts with MedHub default date');
    const result = await ENGINE.runRow(buildRecipe(page.MSG), { ...row, date: '01/09/2024' }, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, 'dry run ok');
    assert.strictEqual(dateInput.value, '01/09/2024', 'row date replaces prefilled date');
    console.log('  engine.medhub-live: date replay clears prefilled value first.');
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

  // ---- Procedure clearing fallback: table has headers/Delete buttons but no expected id ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const recipe = buildRecipe(page.MSG);
    const selected = document.getElementById('selected_procedures');
    selected.removeAttribute('id');
    await ENGINE.runRow(recipe, row, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.deepStrictEqual(
      Array.from(document.querySelectorAll('tr[id^="prow_"]:not(.hidden)'))
        .filter((tr) => tr.id !== 'prow_0')
        .map((tr) => document.getElementById(tr.id + '_title').textContent),
      ['Colonoscopy', 'Biopsy'],
      'row1 adds two without selected_procedures id'
    );
    const row2 = { ...row, procedures: ['Ablation'] };
    await ENGINE.runRow(recipe, row2, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.deepStrictEqual(
      Array.from(document.querySelectorAll('tr[id^="prow_"]:not(.hidden)'))
        .filter((tr) => tr.id !== 'prow_0')
        .map((tr) => document.getElementById(tr.id + '_title').textContent),
      ['Ablation'],
      'fallback table scan clears prior procedures'
    );
    console.log('  engine.medhub-live: clears procedures from generic Procedure/Actions table.');
  }

  // ---- Supervisor Search tab (live page default): input[name="searchterms"] ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE, window } = page;
    window.procedures_supervisor_tab('search');
    const { ROLE, FIELD } = page.MSG;
    const css = (v) => [{ type: 'css', value: v }];
    const searchRecipe = {
      version: 1,
      url: 'https://ahc.medhub.com/u/r/procedures_log.mh',
      procedureRepeatable: true,
      steps: [
        { field: FIELD.DATE, role: ROLE.INPUT, candidates: css('input[name="procedure_date"]') },
        { field: FIELD.LOCATION, role: ROLE.STATIC, staticValue: 'IMC', candidates: css('input[name="location_other"]') },
        {
          field: FIELD.SUPERVISOR,
          role: ROLE.AUTOCOMPLETE,
          optionSelector: 'div.optionDiv',
          candidates: css('input[name="searchterms"]')
        },
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
    const result = await ENGINE.runRow(searchRecipe, row, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, 'search-tab dry run ok: ' + JSON.stringify(result.actions.filter((a) => a.outcome !== 'success')));
    assert.strictEqual(document.getElementById('supervisor_search_selected').textContent, 'Smith, John', 'supervisor picked via searchterms');
    assert.strictEqual(document.getElementById('supervisor_search_userID').value, '99999', 'hidden supervisor userID set from search pick');
    assert.strictEqual(document.getElementById('supervisor_method').value, 'search', 'supervisor_method stays search');
    console.log('  engine.medhub-live: supervisor Search tab via input[name="searchterms"].');
  }

  // ---- Search-tab supervisor from cold List tab (no manual tab switch) ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const { ROLE, FIELD } = page.MSG;
    const css = (v) => [{ type: 'css', value: v }];
    const searchRecipe = {
      version: 1,
      url: 'https://ahc.medhub.com/u/r/procedures_log.mh',
      procedureRepeatable: true,
      steps: [
        { field: FIELD.DATE, role: ROLE.INPUT, candidates: css('input[name="procedure_date"]') },
        { field: FIELD.LOCATION, role: ROLE.STATIC, staticValue: 'IMC', candidates: css('input[name="location_other"]') },
        {
          field: FIELD.SUPERVISOR,
          role: ROLE.AUTOCOMPLETE,
          optionSelector: 'div.optionDiv',
          candidates: css('input[name="searchterms"]')
        },
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
    assert.ok(document.querySelector('select[name="supervisorID"]'), 'starts on List tab');
    assert.ok(!document.querySelector('input[name="searchterms"]'), 'searchterms absent until Search tab');
    const searchOnlyRow = { ...row, supervisor: 'Smithson, Karen' };
    const result = await ENGINE.runRow(searchRecipe, searchOnlyRow, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, 'cold List→Search supervisor ok: ' + JSON.stringify(result.actions.filter((a) => a.outcome !== 'success')));
    assert.strictEqual(document.getElementById('supervisor_search_selected').textContent, 'Smithson, Karen', 'supervisor resolved after opening Search tab');
    console.log('  engine.medhub-live: Search-tab supervisor works from default List tab.');
  }

  // ---- Search result with trailing context matches extract name with middle initial ----
  for (const [extractName, medhubResult, reportedName] of [
    ['DRIVER, STEVEN L', 'Driver, Steven (AIMMC-Cardio-IM)', 'Driver, Steven'],
    ['DIBS, SAMER R', 'Dibs, Samer (AIMMC - CCE IM)', 'Dibs, Samer'],
    ["D'SILVA, OLIVER J", "D'Silva, Oliver (AIMMC-Cardio-IM)", "D'Silva, Oliver"],
    ['EZIDINMA, AFOMA P', 'Ezidinma, Afoma', 'Ezidinma, Afoma']
  ]) {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const { ROLE, FIELD } = page.MSG;
    const css = (v) => [{ type: 'css', value: v }];
    const searchRecipe = {
      version: 1,
      url: 'https://ahc.medhub.com/u/r/procedures_log.mh',
      procedureRepeatable: true,
      steps: [
        { field: FIELD.DATE, role: ROLE.INPUT, candidates: css('input[name="procedure_date"]') },
        { field: FIELD.LOCATION, role: ROLE.STATIC, staticValue: 'IMC', candidates: css('input[name="location_other"]') },
        { field: FIELD.SUPERVISOR, role: ROLE.AUTOCOMPLETE, optionSelector: 'div.optionDiv', candidates: css('input[name="searchterms"]') },
        { field: FIELD.ENCOUNTER, role: ROLE.INPUT, candidates: css('input[name="patientID_other"]') }
      ]
    };
    const result = await ENGINE.runRow(searchRecipe, { ...row, supervisor: extractName }, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, `${extractName} supervisor search ok: ` + JSON.stringify(result.actions.filter((a) => a.outcome !== 'success')));
    assert.strictEqual(document.getElementById('supervisor_search_selected').textContent, medhubResult, `${extractName} supervisor picked from contextual result`);
    if (extractName === "D'SILVA, OLIVER J") {
      assert.ok(
        result.actions.some((a) => a.field === FIELD.SUPERVISOR && a.value === extractName && a.chosen === reportedName),
        'D apostrophe supervisor uses override and still reports selected result'
      );
    }
    assert.ok(
      result.actions.some((a) => a.field === FIELD.SUPERVISOR && a.chosen === reportedName),
      `${extractName} supervisor report omits parenthetical context`
    );
  }
  console.log('  engine.medhub-live: supervisor Search matches middle-initial extract names.');

  // ---- Search tab selected state: CHANGE restores the search input between rows ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const { ROLE, FIELD } = page.MSG;
    const css = (v) => [{ type: 'css', value: v }];
    const searchRecipe = {
      version: 1,
      url: 'https://ahc.medhub.com/u/r/procedures_log.mh',
      procedureRepeatable: true,
      steps: [
        { field: FIELD.DATE, role: ROLE.INPUT, candidates: css('input[name="procedure_date"]') },
        { field: FIELD.LOCATION, role: ROLE.STATIC, staticValue: 'IMC', candidates: css('input[name="location_other"]') },
        { field: FIELD.SUPERVISOR, role: ROLE.AUTOCOMPLETE, optionSelector: 'div.optionDiv', candidates: css('input[name="searchterms"]') },
        { field: FIELD.ENCOUNTER, role: ROLE.INPUT, candidates: css('input[name="patientID_other"]') }
      ]
    };
    const first = await ENGINE.runRow(searchRecipe, { ...row, supervisor: 'DRIVER, STEVEN L' }, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(first.ok, 'first supervisor search ok');
    assert.ok(document.getElementById('supervisor_search_change'), 'selected state exposes CHANGE');
    const second = await ENGINE.runRow(searchRecipe, { ...row, supervisor: 'DIBS, SAMER R' }, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(second.ok, 'second supervisor search ok after CHANGE: ' + JSON.stringify(second.actions.filter((a) => a.outcome !== 'success')));
    assert.strictEqual(document.getElementById('supervisor_search_selected').textContent, 'Dibs, Samer (AIMMC - CCE IM)', 'second supervisor selected after CHANGE reset');
    console.log('  engine.medhub-live: supervisor Search clicks CHANGE between dry-run rows.');
  }

  // ---- Search result matches extract names with extra last-name tokens ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const { ROLE, FIELD } = page.MSG;
    const css = (v) => [{ type: 'css', value: v }];
    const searchRecipe = {
      version: 1,
      url: 'https://ahc.medhub.com/u/r/procedures_log.mh',
      procedureRepeatable: true,
      steps: [
        { field: FIELD.DATE, role: ROLE.INPUT, candidates: css('input[name="procedure_date"]') },
        { field: FIELD.LOCATION, role: ROLE.STATIC, staticValue: 'IMC', candidates: css('input[name="location_other"]') },
        { field: FIELD.SUPERVISOR, role: ROLE.AUTOCOMPLETE, optionSelector: 'div.optionDiv', candidates: css('input[name="searchterms"]') },
        { field: FIELD.ENCOUNTER, role: ROLE.INPUT, candidates: css('input[name="patientID_other"]') }
      ]
    };
    const result = await ENGINE.runRow(searchRecipe, { ...row, supervisor: 'BEALL SACASA, ALLAN J' }, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, 'beall supervisor search ok: ' + JSON.stringify(result.actions.filter((a) => a.outcome !== 'success')));
    assert.strictEqual(document.getElementById('supervisor_search_selected').textContent, 'Beall, Allan (AIMMC-Cardio-IM)', 'beall supervisor picked from contextual result');
    console.log('  engine.medhub-live: supervisor Search matches extra last-name tokens.');
  }

  // ---- log_another checkbox (live name="log_another") on multi-row submit ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const recipe = buildRecipe(page.MSG);
    const logAnother = document.querySelector('input[name="log_another"]');
    assert.ok(logAnother, 'live fixture has name="log_another" checkbox');
    logAnother.checked = false;
    const result = await ENGINE.runRow(recipe, row, { dryRun: false, fieldDelayMs: 0, typeCharDelayMs: 0, index: 0, total: 2 });
    assert.ok(result.ok, 'first row submit ok');
    assert.strictEqual(logAnother.checked, true, 'log_another checked when more rows remain');
    console.log('  engine.medhub-live: checks name="log_another" for batch runs.');
  }

  // ---- ISO spreadsheet date converts to MM/DD/YYYY on replay ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const isoRow = { ...row, date: '2026-06-17' };
    const result = await ENGINE.runRow(buildRecipe(page.MSG), isoRow, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, 'ISO date dry run ok');
    assert.strictEqual(document.querySelector('input[name="procedure_date"]').value, '06/17/2026', 'ISO date converted for MedHub');
    console.log('  engine.medhub-live: ISO YYYY-MM-DD date converts to MM/DD/YYYY.');
  }

  // ---- Optional fields + location dropdown match ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const { ROLE, FIELD } = page.MSG;
    const css = (v) => [{ type: 'css', value: v }];
    const optionalRecipe = {
      version: 1,
      url: 'https://ahc.medhub.com/u/r/procedures_log.mh',
      procedureRepeatable: true,
      steps: [
        { field: FIELD.LOCATION, role: ROLE.INPUT, candidates: css('select[name="locationID"]') },
        { field: FIELD.GENDER, role: ROLE.INPUT, candidates: css('select[name="patient_gender"]') },
        { field: FIELD.AGE, role: ROLE.INPUT, candidates: css('select[name="patient_age"]') },
        { field: FIELD.DIAGNOSIS, role: ROLE.INPUT, candidates: css('input[name="diagnosis"]') },
        { field: FIELD.COMPLICATIONS, role: ROLE.INPUT, candidates: css('input[name="complications"]') },
        { field: FIELD.NOTES, role: ROLE.INPUT, candidates: css('textarea[name="notes"]') }
      ]
    };
    const optionalRow = {
      location: 'IMC',
      gender: 'F',
      age: '40',
      diagnosis: 'K57.30',
      complications: 'None',
      notes: 'Completed without issue'
    };
    const result = await ENGINE.runRow(optionalRecipe, optionalRow, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, 'optional fields ok: ' + JSON.stringify(result.actions.filter((a) => a.outcome !== 'success')));
    assert.strictEqual(document.querySelector('select[name="locationID"]').value, '551', 'location dropdown matched IMC');
    assert.strictEqual(document.querySelector('select[name="patient_gender"]').value, 'F', 'gender select');
    assert.strictEqual(document.querySelector('select[name="patient_age"]').value, '40', 'age select');
    assert.strictEqual(document.querySelector('input[name="diagnosis"]').value, 'K57.30', 'diagnosis');
    assert.strictEqual(document.querySelector('input[name="complications"]').value, 'None', 'complications');
    assert.strictEqual(document.querySelector('textarea[name="notes"]').value, 'Completed without issue', 'notes');
    console.log('  engine.medhub-live: optional fields + location dropdown replay.');
  }

  // ---- Location falls back to location_other when dropdown has no match ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const { ROLE, FIELD } = page.MSG;
    const css = (v) => [{ type: 'css', value: v }];
    const otherRecipe = {
      version: 1,
      url: 'https://ahc.medhub.com/u/r/procedures_log.mh',
      procedureRepeatable: true,
      steps: [{ field: FIELD.LOCATION, role: ROLE.STATIC, staticValue: 'Offsite Clinic', candidates: css('input[name="location_other"]') }]
    };
    const result = await ENGINE.runRow(otherRecipe, { location: 'Offsite Clinic' }, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, 'location_other fallback ok');
    assert.strictEqual(document.querySelector('input[name="location_other"]').value, 'Offsite Clinic', 'typed into location_other');
    assert.strictEqual(document.querySelector('input[name="location_other"]').disabled, false, 'location_other enabled via OTHER select');
    console.log('  engine.medhub-live: location_other fallback when dropdown has no match.');
  }

  // ---- Dry run loops every row and NEVER submits ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const recipe = buildRecipe(page.MSG);
    const rows = [
      { ...row, mrn: '111', procedures: ['Colonoscopy'] },
      { ...row, mrn: '222', procedures: ['Biopsy'] },
      { ...row, mrn: '333', procedures: ['Ablation'] }
    ];
    const logAnother = document.querySelector('input[name="log_another"]');
    logAnother.checked = false;

    // Mirror the side panel loop: one runRow per row, dryRun=true, with index/total.
    for (let i = 0; i < rows.length; i++) {
      const result = await ENGINE.runRow(recipe, rows[i], {
        dryRun: true,
        fieldDelayMs: 0,
        typeCharDelayMs: 0,
        index: i,
        total: rows.length
      });
      assert.ok(result.ok, `dry row ${i + 1} ok: ` + JSON.stringify(result.actions.filter((a) => a.outcome !== 'success')));
      const submitAction = result.actions.find((a) => a.role === page.MSG.ROLE.SUBMIT);
      assert.ok(submitAction, `row ${i + 1} reached the submit step`);
      assert.strictEqual(submitAction.outcome, 'skipped', `row ${i + 1} submit skipped in dry run`);
      assert.ok(/DRY RUN/i.test(submitAction.detail || ''), `row ${i + 1} marked DRY RUN`);
      // Each row replaces the prior row's procedures (loop advances cleanly).
      assert.deepStrictEqual(selectedTitles(document), [rows[i].procedures[0]], `row ${i + 1} shows only its own procedure`);
    }

    assert.notStrictEqual(document.body.getAttribute('data-submitted'), 'true', 'dry run never submitted the form');
    assert.ok(
      !document.body.getAttribute('data-submit-count') || document.body.getAttribute('data-submit-count') === '0',
      'submit count stayed at 0 across all dry-run rows'
    );
    assert.strictEqual(logAnother.checked, false, 'dry run never touches Log Another (no inter-row submit)');
    console.log('  engine.medhub-live: dry run loops all rows and never submits.');
  }

  // ---- Filling required fields enables the dithered "Next" button ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const nextBtn = document.getElementById('nextBtn');
    assert.strictEqual(nextBtn.disabled, true, 'Next button starts dithered/disabled');
    const result = await ENGINE.runRow(buildRecipe(page.MSG), row, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, 'dry run ok');
    assert.strictEqual(nextBtn.disabled, false, 'Next button enabled after required fields committed (blur/change fired)');
    console.log('  engine.medhub-live: required-field commit un-dithers the Next button.');
  }

  // ---- Old recipes recorded on "Other" no longer type into Other ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const { ROLE, FIELD } = page.MSG;
    const css = (v) => [{ type: 'css', value: v }];
    const otherRecipe = {
      version: 1,
      url: 'https://ahc.medhub.com/u/r/procedures_log.mh',
      procedureRepeatable: true,
      steps: [
        { field: FIELD.DATE, role: ROLE.INPUT, candidates: css('input[name="procedure_date"]') },
        { field: FIELD.LOCATION, role: ROLE.STATIC, staticValue: 'IMC', candidates: css('input[name="location_other"]') },
        { field: FIELD.CLICK, role: ROLE.CLICK, candidates: css('#supervisor_tab_3') },
        { field: FIELD.SUPERVISOR, role: ROLE.INPUT, candidates: css('input[name="supervisor_other"]') },
        { field: FIELD.ENCOUNTER, role: ROLE.INPUT, candidates: css('input[name="patientID_other"]') }
      ]
    };
    const otherRow = { ...row, supervisor: 'Dr. Freetext Name' };
    const result = await ENGINE.runRow(otherRecipe, otherRow, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.strictEqual(result.ok, false, 'legacy Other supervisor recipe should not use free-text Other');
    const otherInput = document.querySelector('input[name="supervisor_other"]');
    assert.strictEqual(otherInput ? otherInput.value : '', '', 'free-text Other supervisor is not used');
    console.log('  engine.medhub-live: legacy Other supervisor recipe does not type into Other.');
  }

  // ---- Supervisor fails when name isn't in List/Search ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const { ROLE, FIELD } = page.MSG;
    const css = (v) => [{ type: 'css', value: v }];
    const recipe = {
      version: 1,
      url: 'https://ahc.medhub.com/u/r/procedures_log.mh',
      procedureRepeatable: true,
      steps: [
        { field: FIELD.DATE, role: ROLE.INPUT, candidates: css('input[name="procedure_date"]') },
        { field: FIELD.LOCATION, role: ROLE.STATIC, staticValue: 'IMC', candidates: css('input[name="location_other"]') },
        { field: FIELD.SUPERVISOR, role: ROLE.AUTOCOMPLETE, optionSelector: 'div.optionDiv', candidates: css('select[name="supervisorID"]') },
        { field: FIELD.ENCOUNTER, role: ROLE.INPUT, candidates: css('input[name="patientID_other"]') }
      ]
    };
    const unknownRow = { ...row, supervisor: 'Nonexistent Attending' };
    const result = await ENGINE.runRow(recipe, unknownRow, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.strictEqual(result.ok, false, 'unmatched supervisor should fail without Other fallback');
    assert.ok(
      result.actions.some((a) => a.field === FIELD.SUPERVISOR && a.outcome === 'failed' && /No autocomplete results|Could not resolve|does not match/.test(a.detail || '')),
      'failure is reported on supervisor field'
    );
    const otherInput = document.querySelector('input[name="supervisor_other"]');
    assert.strictEqual(otherInput ? otherInput.value : '', '', 'unmatched supervisor does not use free-text Other');
    console.log('  engine.medhub-live: unmatched supervisor fails without Other fallback.');
  }

  // ---- Procedure: types the name into the search box, then selects ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const { ROLE, FIELD } = page.MSG;
    const css = (v) => [{ type: 'css', value: v }];
    // Recipe whose procedure input candidate WRONGLY points at the header nav
    // "Procedures" link (the live mis-resolution). The engine must still find the
    // real search box, type the name to filter, then click the match.
    const recipe = {
      version: 1,
      url: 'https://ahc.medhub.com/u/r/procedures_log.mh',
      procedureRepeatable: true,
      steps: [
        { field: FIELD.DATE, role: ROLE.INPUT, candidates: css('input[name="procedure_date"]') },
        { field: FIELD.LOCATION, role: ROLE.STATIC, staticValue: 'IMC', candidates: css('input[name="location_other"]') },
        { field: FIELD.SUPERVISOR, role: ROLE.AUTOCOMPLETE, optionSelector: 'div.optionDiv', candidates: css('select[name="supervisorID"]') },
        { field: FIELD.ENCOUNTER, role: ROLE.INPUT, candidates: css('input[name="patientID_other"]') },
        {
          field: FIELD.PROCEDURE,
          role: ROLE.AUTOCOMPLETE,
          optionSelector: '#procedures_list tbody tr',
          clickRel: 'a',
          candidates: css('a[aria-label="Procedures Link"]')
        }
      ]
    };
    const result = await ENGINE.runRow(recipe, { ...row, procedures: ['Colonoscopy'] }, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, 'procedure type+select ok: ' + JSON.stringify(result.actions.filter((a) => a.outcome !== 'success')));
    assert.strictEqual(document.getElementById('procedures_searchterms').value, '', 'search box reset by procedures_add after typing+selecting');
    assert.deepStrictEqual(selectedTitles(document), ['Colonoscopy'], 'procedure added by typing then selecting, despite nav-link candidate');
    console.log('  engine.medhub-live: procedure typed into search box then selected.');
  }

  // ---- Procedure aliases map spreadsheet values to MedHub labels ----
  for (const [sheetProcedure, medhubProcedure] of [
    ['CORONARY ANGIOGRAM', 'Coronary Angiography/Diagnostic Cath'],
    ['CORONARY ANGIOGRAM/POSSIBLE PTCA - CV', 'Coronary Angiography/Diagnostic Cath'],
    ['PTCA WITH STENT - CV', 'PTCA Stent'],
    ['PTCA - CV', 'PTCA Stent'],
    ['TRANSVENOUS PACEMAKER - CV', 'Pacemaker - Temporary'],
    ['IABP INSERTION - CV', 'IABP'],
    ['LEFT HEART CATH - CV', 'Left Heart Cath'],
    ['RIGHT HEART CATH - CV', 'Right Heart Cath'],
    ['LOWER EXTREMITY ANGIOGRAM/POSSIBLE PTA - CV', 'Peripheral Angiography'],
    ['AORTA BIFEMORAL ANGIOGRAM/POSSIBLE PTA/POSSIBLE STENT - CV', 'Peripheral Angiography'],
    ['ABDOMINAL AORTIC ANGIOGRAM/POSSIBLE PTA/POSSIBLE STENT - CV', 'Peripheral Angiography'],
    ['PERICARDIOCENTESIS - CV', 'Pericardiocentesis'],
    ['PATENT FORAMEN OVALE CLOSURE - CV', 'Atrial septal defect closure'],
    ['ABLATION ATRIAL FIB - CV', 'Ablation'],
    ['ABLATION PREMATURE VENTRICULAR CONTRACTION - CV', 'Ablation'],
    ['PPM LEADLESS SINGLE IMPLANT - CV', 'Pacemaker Permanent']
  ]) {
    const page = createPage('medhub-procedure-log-live.html');
    const { document, ENGINE } = page;
    const { ROLE, FIELD } = page.MSG;
    const css = (v) => [{ type: 'css', value: v }];
    const recipe = {
      version: 1,
      url: 'https://ahc.medhub.com/u/r/procedures_log.mh',
      procedureRepeatable: true,
      steps: [
        { field: FIELD.DATE, role: ROLE.INPUT, candidates: css('input[name="procedure_date"]') },
        { field: FIELD.LOCATION, role: ROLE.STATIC, staticValue: 'IMC', candidates: css('input[name="location_other"]') },
        { field: FIELD.SUPERVISOR, role: ROLE.AUTOCOMPLETE, optionSelector: 'div.optionDiv', candidates: css('select[name="supervisorID"]') },
        { field: FIELD.ENCOUNTER, role: ROLE.INPUT, candidates: css('input[name="patientID_other"]') },
        {
          field: FIELD.PROCEDURE,
          role: ROLE.AUTOCOMPLETE,
          optionSelector: '#procedures_list tbody tr',
          clickRel: 'a',
          candidates: css('input[name="procedures_searchterms"]')
        }
      ]
    };
    const result = await ENGINE.runRow(recipe, { ...row, procedures: [sheetProcedure] }, { dryRun: true, fieldDelayMs: 0, typeCharDelayMs: 0 });
    assert.ok(result.ok, `${sheetProcedure} alias ok: ` + JSON.stringify(result.actions.filter((a) => a.outcome !== 'success')));
    assert.deepStrictEqual(selectedTitles(document), [medhubProcedure], `${sheetProcedure} selected desired MedHub row`);
  }
  console.log('  engine.medhub-live: procedure aliases select desired MedHub rows.');
};
