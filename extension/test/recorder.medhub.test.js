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

  assert.ok(steps.some((s) => s.role === 'submit'), 'should capture Log Procedure as submit');

  console.log(`  recorder.medhub: ${steps.length} steps (${clicks.length} nav-click, ${autos.length} autocomplete), procedure clickRel="${procAuto.clickRel}".`);
};
