/**
 * DOM label / accessible-name resolution tests (MedHub fixture patterns).
 */
const assert = require('assert');
const { createPage } = require('./harness');

module.exports = async function run() {
  const page = createPage('medhub-procedure-log.html');
  const { document, DOM } = page;

  assert.strictEqual(
    DOM.accessibleNameFor(document.getElementById('procedureDate')),
    'Procedure Date',
    'label[for] association'
  );
  assert.strictEqual(
    DOM.accessibleNameFor(document.getElementById('locationSpecify')),
    'Location specify',
    'aria-label'
  );
  assert.strictEqual(
    DOM.accessibleNameFor(document.getElementById('supSearch')),
    'Supervisor search',
    'aria-label on search input'
  );

  const supField = document.querySelector('.field-label');
  assert.ok(supField && /supervisor/i.test(supField.textContent), 'fixture has field-label');

  console.log('  dom-utils: accessible names resolve for date, location, supervisor.');
};
