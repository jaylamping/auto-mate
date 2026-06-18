/**
 * auto-mate test runner. Runs the parser/report smoke test plus the jsdom
 * recorder and engine suites built around the MedHub procedure form.
 */
const { execFileSync } = require('child_process');
const path = require('path');

async function main() {
  let failures = 0;

  // Parser/report test is a standalone script (sets its own globals).
  console.log('parser/report:');
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'parser.test.js')], { stdio: 'inherit' });
  } catch (_) {
    failures++;
  }

  const suites = [
    ['dom-utils', './dom-utils.test.js'],
    ['recorder.dom', './recorder.dom.test.js'],
    ['engine.dom', './engine.dom.test.js'],
    ['recorder.medhub', './recorder.medhub.test.js'],
    ['engine.medhub', './engine.medhub.test.js'],
    ['recorder.medhub-live', './recorder.medhub-live.test.js'],
    ['engine.medhub-live', './engine.medhub-live.test.js']
  ];

  for (const [name, mod] of suites) {
    console.log(`${name}:`);
    try {
      await require(mod)();
    } catch (err) {
      failures++;
      console.error(`  FAILED: ${err && err.message}`);
      console.error(err && err.stack);
    }
  }

  if (failures) {
    console.error(`\n${failures} suite(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll suites passed.');
}

main();
