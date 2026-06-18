/**
 * Recorder tests against the LIVE MedHub markup (medhub-procedure-log-live.html).
 * Confirms Learn mode recognizes the real fields the idealized fixture hid:
 *   - the supervisor List <select name="supervisorID"> (change -> input step)
 *   - the procedure "+" add control which calls procedures_add(...) (no a.add class)
 *   - the procedure search box input[name="procedures_searchterms"]
 *   - the form submit button
 */
const assert = require('assert');
const { createPage, typeValue, clickEl, sleep } = require('./harness');

module.exports = async function run() {
  const page = createPage('medhub-procedure-log-live.html');
  const { window, document, RECORDER } = page;

  const steps = [];
  RECORDER.start((step) => steps.push(step));

  // Date + location_other (OTHER specify box)
  typeValue(window, document.querySelector('input[name="procedure_date"]'), '06/17/2026');
  typeValue(window, document.querySelector('input[name="location_other"]'), 'IMC');

  // Supervisor via the List <select>
  const sup = document.querySelector('select[name="supervisorID"]');
  sup.value = '99001';
  sup.dispatchEvent(new window.Event('change', { bubbles: true }));

  // MRN
  typeValue(window, document.querySelector('input[name="patientID_other"]'), '000123456');

  // Procedure: filter then click the "+" add (an <a onClick="procedures_add(...)">)
  const procSearch = document.getElementById('procedures_searchterms');
  typeValue(window, procSearch, 'Colonoscopy');
  await sleep(20);
  // user clicks the fa-plus icon inside the add anchor
  const plusIcon = Array.from(document.querySelectorAll('#procedures_list tbody tr'))
    .map((tr) => tr.querySelector('a[onclick*="procedures_add"] i.fa-plus'))
    .find((i) => i && /Colonoscopy/.test(i.closest('tr').textContent));
  assert.ok(plusIcon, 'colonoscopy "+" icon present');
  clickEl(window, plusIcon);

  // Submit
  clickEl(window, document.querySelector('#procedureform input[type="submit"]'));
  RECORDER.stop();

  const procAuto = steps.find((s) => s.role === 'autocomplete' && /procedures_list/.test(s.optionSelector || ''));
  assert.ok(procAuto, 'procedure add recorded as autocomplete scoped to #procedures_list');
  assert.strictEqual(procAuto.clickRel, 'a', 'records the "+" anchor as the relative click target');
  assert.ok(
    (procAuto.candidates || []).some((c) => /procedures_searchterms/.test(c.value)),
    'procedure autocomplete input resolves to procedures_searchterms'
  );

  const supInput = steps.find(
    (s) => s.role === 'input' && (s.candidates || []).some((c) => /supervisorID/.test(c.value))
  );
  assert.ok(supInput, 'supervisor List <select> change recorded as an input step');

  assert.ok(steps.some((s) => s.role === 'submit'), 'form submit recorded');

  console.log(
    `  recorder.medhub-live: ${steps.length} steps; procedure clickRel="${procAuto.clickRel}", optionSelector="${procAuto.optionSelector}".`
  );

  // Clicking the "+" without typing in search still records a procedure pick.
  {
    const page2 = createPage('medhub-procedure-log-live.html');
    const steps2 = [];
    page2.RECORDER.start((step) => steps2.push(step));
    const ablationPlus = Array.from(page2.document.querySelectorAll('#procedures_list tbody tr'))
      .map((tr) => tr.querySelector('a[onclick*="procedures_add"]'))
      .find((a) => a && /Ablation/.test(a.closest('tr').textContent));
    clickEl(page2.window, ablationPlus);
    page2.RECORDER.stop();
    const procOnly = steps2.find((s) => s.role === 'autocomplete' && /procedures_list/.test(s.optionSelector || ''));
    assert.ok(procOnly, 'procedure "+" without search typing still records');
    console.log('  recorder.medhub-live: procedure "+" without search typing still records.');
  }

  // ---- Supervisor Search tab: generic input[name="searchterms"] ----
  {
    const page = createPage('medhub-procedure-log-live.html');
    const { window, document, RECORDER } = page;
    window.procedures_supervisor_tab('search');
    const steps = [];
    RECORDER.start((step) => steps.push(step));
    const supSearch = document.querySelector('input[name="searchterms"]');
    assert.ok(supSearch, 'search tab exposes input[name="searchterms"]');
    typeValue(window, supSearch, 'Smith');
    await sleep(20);
    const option = document.querySelector('#ajax_listOfOptions div.optionDiv');
    assert.ok(option, 'supervisor search renders optionDiv results');
    clickEl(window, option);
    RECORDER.stop();
    const supAuto = steps.find(
      (s) => s.role === 'autocomplete' && (s.candidates || []).some((c) => /searchterms/.test(c.value))
    );
    assert.ok(supAuto, 'supervisor search autocomplete recorded');
    assert.strictEqual(supAuto.text, 'Supervisor', 'searchterms step labeled Supervisor for mapping');
    console.log('  recorder.medhub-live: supervisor Search tab searchterms autocomplete recorded.');
  }
};
