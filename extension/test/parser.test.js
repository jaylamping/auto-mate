/**
 * Node smoke test for parser + report logic (no browser needed).
 * Run: node extension/test/parser.test.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = {};
// Load SheetJS into our fake global.
const XLSX = require('../vendor/xlsx.full.min.js');
root.XLSX = XLSX || global.XLSX;

// Load modules (they attach to the passed-in root via window/globalThis).
global.window = root;
require('../sidepanel/parser.js');
require('../common/messages.js');
require('../sidepanel/report.js');

const PARSER = root.FAA_PARSER;
const REPORT = root.FAA_REPORT;
const { normalizeMatchKey } = root.FAA_MSG;

assert.strictEqual(normalizeMatchKey('Smith, John MD'), 'smithjohnmd');
assert.strictEqual(normalizeMatchKey('Smith John'), 'smithjohn');
assert.strictEqual(root.FAA_MSG.valueMatchesCell('Screening assessment', 'ass'), false);
assert.strictEqual(root.FAA_MSG.valueMatchesCell('Screening assessment', 'assessment'), true);
assert.strictEqual(root.FAA_MSG.valueMatchesCell('F', 'F'), true);

assert.strictEqual(
  root.FAA_MSG.pickPreferredColumnMatch(['Provider Notes', 'Patient Name'], 'Provider Notes'),
  'Patient Name',
  'name in header beats notes when both match'
);
assert.strictEqual(
  root.FAA_MSG.pickPreferredColumnMatch(['Attending Provider', 'Procedure Name'], 'Attending Provider'),
  'Procedure Name',
  'name in header beats provider when both match'
);

const { autoGuessField, guessFieldFromLabel, headerAllowedForFieldKey, ROLE, FIELD } = root.FAA_MSG;
assert.strictEqual(
  autoGuessField({
    role: ROLE.INPUT,
    text: 'Supervisor search',
    sampleValue: 'Procedure completed without complication'
  }),
  FIELD.SUPERVISOR,
  'supervisor label wins over procedure word in pasted notes value'
);
assert.strictEqual(
  guessFieldFromLabel('Procedure Notes', ROLE.INPUT),
  FIELD.NOTES,
  'procedure notes label maps to notes'
);
assert.strictEqual(headerAllowedForFieldKey('Procedure Notes', FIELD.SUPERVISOR), false);
assert.strictEqual(headerAllowedForFieldKey('Attending Provider', FIELD.SUPERVISOR), true);
assert.strictEqual(headerAllowedForFieldKey('Attending Provider', FIELD.NOTES), false);

// --- Build an in-memory workbook from the sample CSV ---
const csv = fs.readFileSync(path.join(__dirname, '../samples/slicer-dicer-sample.csv'), 'utf8');
const wb = root.XLSX.read(csv, { type: 'string' });

// Emulate readFile() output by reusing the same code path on an arrayBuffer.
async function run() {
  const buf = Buffer.from(fs.readFileSync(path.join(__dirname, '../samples/slicer-dicer-sample.csv')));
  const file = { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  const parsed = await PARSER.readFile(file);

  assert.deepStrictEqual(parsed.headers, ['Date of Service', 'Attending Provider', 'Patient MRN', 'Procedure Name']);
  assert.strictEqual(parsed.rows.length, 4, 'should read 4 data rows');

  const mapping = PARSER.guessMapping(parsed.headers);
  assert.strictEqual(mapping.date, 'Date of Service');
  assert.strictEqual(mapping.supervisor, 'Attending Provider');
  assert.strictEqual(mapping.encounter, 'Patient MRN');
  assert.strictEqual(PARSER.matchFieldKeyFromLabel('Patient MRN', parsed.headers), 'encounter');
  assert.strictEqual(PARSER.matchFieldKeyFromLabel('Date of Service', parsed.headers), 'date');
  assert.strictEqual(mapping.procedure, 'Procedure Name');

  const rows = PARSER.buildEngineRows(parsed, mapping, { location: 'IMC' });
  assert.strictEqual(rows.length, 4, 'one engine row per spreadsheet row');
  assert.deepStrictEqual(rows[0].procedures, ['Colonoscopy']);
  assert.strictEqual(rows[0].location, 'IMC');
  assert.strictEqual(rows[0].mrn, '000123456');
  assert.deepStrictEqual(rows[1].procedures, ['Polypectomy']);

  // Delimited cell expands into multiple procedures on that row.
  const last = rows[3];
  assert.deepStrictEqual(last.procedures, ['Colonoscopy', 'Biopsy']);

  // --- Report builder ---
  const session = {
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    dryRun: true,
    rows: [
      { index: 0, mrn: '000123456', result: { ok: true, actions: [{ ts: 't', field: 'date', role: 'input', value: '2026-01-05', outcome: 'success' }] } },
      { index: 1, mrn: '000987654', result: { ok: false, actions: [{ ts: 't', field: 'supervisor', role: 'autocomplete', value: 'Lee', outcome: 'failed', detail: 'no match' }] } }
    ]
  };
  const sum = REPORT.summarize(session);
  assert.strictEqual(sum.total, 2);
  assert.strictEqual(sum.succeeded, 1);
  assert.strictEqual(sum.failed, 1);
  assert.ok(REPORT.toHTML(session).includes('auto-mate session report'));
  assert.ok(REPORT.toHTML(session, { filter: 'failed' }).includes('Row 2'));
  assert.ok(!REPORT.toHTML(session, { filter: 'success' }).includes('Row 2'));
  assert.strictEqual(REPORT.filterRows(session.rows, 'failed').length, 1);
  assert.ok(REPORT.toCSV(session).split('\r\n').length >= 3);
  assert.ok(JSON.parse(REPORT.toJSON(session)).summary.total === 2);

  console.log('All parser/report tests passed.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
