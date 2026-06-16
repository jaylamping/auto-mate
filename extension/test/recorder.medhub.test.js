/**
 * Recorder tests against the realistic MedHub procedures_log fixture.
 * Confirms Learn mode captures the navigation click (Supervisor "Search" tab),
 * both autocompletes, and records a relative click target (clickRel) for the
 * procedure "+" add control.
 */
const assert = require('assert');
const { createPage, typeValue, clickEl, sleep } = require('./harness');

module.exports = async function run() {
  const page = createPage('medhub-procedure-log.html');
  const { window, document, RECORDER } = page;

  const steps = [];
  RECORDER.start((step) => steps.push(step));

  // Date + Location specify (OTHER is preselected; user types IMC)
  typeValue(window, document.getElementById('procedureDate'), '06/15/2026');
  typeValue(window, document.getElementById('locationSpecify'), 'IMC');

  // Supervisor: click Search tab (navigation), then type + pick
  clickEl(window, document.getElementById('supTabSearch'));
  await sleep(10);
  const sup = document.getElementById('supSearch');
  typeValue(window, sup, 'Smith, John');
  await sleep(20);
  clickEl(window, document.querySelector('#supResults li.sup_result'));

  // MRN into encounter field
  typeValue(window, document.getElementById('encounterText'), '000123456');

  // Procedure: filter then click the "+" add control in the matched row
  const procSearch = document.getElementById('procSearch');
  typeValue(window, procSearch, 'Colonoscopy');
  await sleep(20);
  const addLink = document.querySelector('#procList .proc_row[data-name="Colonoscopy"] a.add');
  assert.ok(addLink, 'colonoscopy add link present');
  clickEl(window, addLink);

  // Submit
  clickEl(window, document.getElementById('logProcedure'));
  RECORDER.stop();

  const clicks = steps.filter((s) => s.role === 'click');
  assert.ok(clicks.length >= 1, 'should capture the Search-tab navigation click');
  assert.ok(
    clicks.some((c) => (c.candidates || []).some((cand) => /supTabSearch/.test(cand.value))),
    'navigation click should target the Search tab'
  );

  const autos = steps.filter((s) => s.role === 'autocomplete');
  assert.strictEqual(autos.length, 2, `expected supervisor + procedure autocompletes, got ${autos.length}`);

  const procAuto = autos.find((a) => /proc_row/.test(a.optionSelector || ''));
  assert.ok(procAuto, 'procedure autocomplete should use the proc_row option selector');
  assert.strictEqual(procAuto.clickRel, 'a.add', 'procedure step records the "+" add control as clickRel');

  // Procedure "+" without typing in search still records as autocomplete.
  const steps2 = [];
  RECORDER.start((step) => steps2.push(step));
  const biopsyAdd = document.querySelector('#procList .proc_row[data-name="Biopsy"] a.add');
  clickEl(window, biopsyAdd);
  RECORDER.stop();
  const procOnly = steps2.find((s) => s.role === 'autocomplete' && /proc_row/.test(s.optionSelector || ''));
  assert.ok(procOnly, 'procedure "+" without search typing should still record');

  assert.ok(steps.some((s) => s.role === 'submit'), 'should capture Log Procedure as submit');

  console.log(
    `  recorder.medhub: ${steps.length} steps (${clicks.length} nav-click, ${autos.length} autocomplete), procedure clickRel="${procAuto.clickRel}".`
  );

  // Supervisor result pick without pending type (e.g. recorder restarted / blur cleared type state).
  {
    const page2 = createPage('medhub-procedure-log.html');
    const { RECORDER: REC2 } = page2;
    const steps3 = [];
    REC2.start((step) => steps3.push(step));
    clickEl(page2.window, page2.document.getElementById('supTabSearch'));
    typeValue(page2.window, page2.document.getElementById('supSearch'), 'Lee, Karen');
    await sleep(20);
    REC2.stop();
    REC2.start((step) => steps3.push(step));
    clickEl(page2.window, page2.document.querySelector('#supResults li.sup_result'));
    REC2.stop();
    const supAuto = steps3.find((s) => s.role === 'autocomplete' && /sup/i.test(s.optionSelector || ''));
    assert.ok(supAuto, 'supervisor result click should record autocomplete');
    assert.ok(supAuto.sampleOptionText, 'supervisor autocomplete should carry picked label');
    console.log('  recorder.medhub: supervisor result click records autocomplete without pending type.');
  }
};