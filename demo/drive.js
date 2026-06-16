/**
 * Drives the auto-mate demo with headless Chrome to (a) validate the full
 * workflow wires up via the chrome shim and (b) capture preview screenshots.
 *
 * Usage: node demo/drive.js [baseUrl]
 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const BASE = process.argv[2] || 'http://localhost:8777';
const OUT = path.join(__dirname, 'screenshots');
const CHROME =
  ['/usr/bin/google-chrome-stable', '/usr/local/bin/google-chrome'].find((p) => fs.existsSync(p)) ||
  '/usr/bin/google-chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,860']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860 });
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  [page error]', m.text());
  });

  await page.goto(`${BASE}/demo/demo.html`, { waitUntil: 'networkidle0' });
  await sleep(500);
  const panel = (await page.frames()).find((f) => f.url().includes('panel.html'));
  if (!panel) throw new Error('panel iframe not found');

  await page.screenshot({ path: path.join(OUT, '01-initial.png') });

  // --- Learn mode ---
  await panel.click('#btnStartLearn');
  await sleep(150);
  await page.type('#proc_date', '01/05/2026', { delay: 8 });
  await page.type('#proc_location', 'IMC', { delay: 8 });
  await page.type('#sup_search', 'Smith, John', { delay: 12 });
  await sleep(120);
  await page.click('#sup_results li.ac_item');
  await page.type('#patient_mrn', '000123456', { delay: 8 });
  await page.type('#proc_search', 'Colonoscopy', { delay: 12 });
  await sleep(120);
  await page.click('#proc_results li.ac_item');
  await page.click('#submitBtn');
  await sleep(150);
  await panel.click('#btnFinishLearn');
  await sleep(200);
  await page.screenshot({ path: path.join(OUT, '02-learn-captured.png') });

  const stepCount = await panel.$$eval('#stepList > li', (els) => els.length);
  console.log(`  captured steps in UI: ${stepCount}`);
  await panel.click('#btnSaveRecipe');
  await sleep(200);

  // --- Data: load the sample CSV via the hidden file input ---
  await panel.click('.tab[data-tab="data"]');
  await sleep(100);
  const fileInput = await panel.$('#fileInput');
  await fileInput.uploadFile(path.join(__dirname, '../extension/samples/slicer-dicer-sample.csv'));
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, '03-data-mapping.png') });
  const rowCount = await panel.$eval('#rowCount', (el) => el.textContent).catch(() => '?');
  console.log(`  data preview: ${rowCount}`);

  // --- Run (dry run) ---
  await panel.click('.tab[data-tab="run"]');
  await sleep(100);
  await panel.click('#btnRun');
  // Wait for the run to finish (button toggles back).
  for (let i = 0; i < 60; i++) {
    const running = await panel.$eval('#btnStop', (el) => !el.classList.contains('hidden')).catch(() => false);
    if (!running && i > 2) break;
    await sleep(300);
  }
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, '04-run-log.png') });

  // --- Report ---
  await panel.click('.tab[data-tab="report"]');
  await sleep(200);
  await page.screenshot({ path: path.join(OUT, '05-report.png') });
  const summary = await panel.$eval('#reportSummary', (el) => el.textContent.trim()).catch(() => '');
  console.log(`  report summary: ${summary}`);

  // Validate the mock form actually got filled on the last processed row.
  const formState = await page.evaluate(() => ({
    date: document.getElementById('proc_date').value,
    location: document.getElementById('proc_location').value,
    supervisor: document.getElementById('sup_search').value,
    mrn: document.getElementById('patient_mrn').value,
    procedures: Array.from(document.querySelectorAll('#selected_procedures .proc_chip')).map((c) => c.textContent)
  }));
  console.log('  final form state:', JSON.stringify(formState));

  await browser.close();

  if (stepCount < 6) throw new Error(`expected >=6 captured steps, got ${stepCount}`);
  if (!summary || !/Total/.test(summary)) throw new Error('report summary missing');
  console.log('Demo drive complete. Screenshots in demo/screenshots/.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
