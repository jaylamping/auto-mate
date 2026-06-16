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
  assert.strictEqual(mapping.mrn, 'Patient MRN');
  assert.strictEqual(mapping.procedure, 'Procedure Name');

  const grouped = PARSER.buildEngineRows(parsed, mapping, { groupProcedures: true, location: 'IMC' });
  // Rows 1+2 share MRN/date/supervisor -> merged into one with 2 procedures.
  assert.strictEqual(grouped.length, 3, 'grouped entries');
  const first = grouped[0];
  assert.deepStrictEqual(first.procedures, ['Colonoscopy', 'Polypectomy']);
  assert.strictEqual(first.location, 'IMC');
  assert.strictEqual(first.mrn, '000123456');

  // Delimited cell expands into multiple procedures.
  const last = grouped[2];
  assert.deepStrictEqual(last.procedures, ['Colonoscopy', 'Biopsy']);

  const ungrouped = PARSER.buildEngineRows(parsed, mapping, { groupProcedures: false });
  assert.strictEqual(ungrouped.length, 4, 'ungrouped keeps 4 rows');

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
  assert.ok(REPORT.toCSV(session).split('\r\n').length >= 3);
  assert.ok(JSON.parse(REPORT.toJSON(session)).summary.total === 2);

  console.log('All parser/report tests passed.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
