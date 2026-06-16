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

  // --- Data first (required before Learn) ---
  const fileInput = await panel.$('#fileInput');
  await fileInput.uploadFile(path.join(__dirname, '../extension/samples/slicer-dicer-sample.csv'));
  await panel.evaluate(() => {
    const el = document.getElementById('fileInput');
    if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(400);
  const fileMeta = await panel.$eval('#fileLoadedMeta', (el) => el.textContent).catch(() => '?');
  console.log(`  data loaded: ${fileMeta}`);
  await page.screenshot({ path: path.join(OUT, '02-data-loaded.png') });
  await panel.evaluate(() => document.getElementById('btnDataNext').click());
  await sleep(300);

  // --- Learn: auto-listening; fill form to map columns ---
  await page.type('#procedureDate', '06/15/2026', { delay: 8 });
  await page.type('#locationSpecify', 'IMC', { delay: 8 });
  await page.click('#supTabSearch');
  await sleep(60);
  await page.type('#supSearch', 'Smith, John', { delay: 12 });
  await sleep(120);
  await page.click('#supResults li.sup_result');
  await page.type('#encounterText', '000123456', { delay: 8 });
  await page.type('#procSearch', 'Colonoscopy', { delay: 12 });
  await sleep(120);
  await page.click('#procList .proc_row[data-name="Colonoscopy"] a.add');
  await page.click('#logProcedure');
  await sleep(200);

  await panel.waitForFunction(
    () => {
      const btn = document.getElementById('btnLearnNext');
      return btn && !btn.disabled;
    },
    { timeout: 10000 }
  );
  await panel.click('#btnLearnNext');
  await sleep(400);

  const recipeSaved = await panel.evaluate(() => {
    const el = document.getElementById('recipeStatus');
    return el && !el.classList.contains('hidden') && el.textContent.includes('steps');
  });
  console.log(`  recipe saved: ${recipeSaved}`);
  await page.screenshot({ path: path.join(OUT, '03-learn-captured.png') });

  // --- Data tab already loaded; open Run ---
  await panel.click('.tab-trigger[data-tab="run"]');
  await sleep(100);
  await panel.$eval('#fieldDelay', (el) => {
    el.value = '0';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await panel.click('#btnRun');
  // Wait until the live log reports the session is complete.
  let done = false;
  for (let i = 0; i < 80 && !done; i++) {
    await sleep(300);
    done = await panel
      .$eval('#liveLog', (el) => /Session complete/.test(el.textContent))
      .catch(() => false);
  }
  await page.screenshot({ path: path.join(OUT, '04-run-log.png') });

  // --- Report ---
  await panel.click('.tab-trigger[data-tab="report"]');
  await sleep(200);
  await page.screenshot({ path: path.join(OUT, '05-report.png') });
  const summary = await panel.$eval('#reportSummary', (el) => el.textContent.trim()).catch(() => '');
  console.log(`  report summary: ${summary}`);

  // Validate the mock form actually got filled on the last processed row.
  const formState = await page.evaluate(() => ({
    date: document.getElementById('procedureDate').value,
    location: document.getElementById('locationSpecify').value,
    supervisor: document.getElementById('supSearch').value,
    mrn: document.getElementById('encounterText').value,
    procedures: Array.from(document.querySelectorAll('#selectedProcs .selected_proc')).map((tr) => tr.children[1].textContent)
  }));
  console.log('  final form state:', JSON.stringify(formState));

  await browser.close();

  if (!recipeSaved) throw new Error('expected recipe to save after Learn Next');
  if (!summary || !/Total/.test(summary)) throw new Error('report summary missing');
  console.log('Demo drive complete. Screenshots in demo/screenshots/.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
