# auto-mate

**auto-mate** is a Chrome extension that fills out a web form repeatedly from a
spreadsheet — using *your own* logged-in browser session. You log in yourself,
show auto-mate how to fill the form **one time** ("Learn mode"), then drop in
your spreadsheet and let it do the rest.

It was built for logging procedures into **MedHub** (`ahc.medhub.com`, the
*Procedures* tab) from an **Epic Slicer Dicer** spreadsheet export — by date,
location, supervisor, patient MRN, and one or more procedures. The form fields
are *learned by recording*, not hard-coded, so it adapts if the page changes
and can be pointed at other forms too.

- **No passwords stored.** auto-mate never sees or saves your credentials. It
  runs inside the tab you already logged into.
- **No selectors to write.** A guided Learn mode records the form for you.
- **Dry-run first.** Verify everything fills correctly before anything is
  submitted.
- **Full audit report.** Every field it touches is logged and exportable.

---

## Table of contents

1. [Install (load unpacked)](#install-load-unpacked)
2. [The 3-step workflow](#the-3-step-workflow)
3. [Step 1 — Learn mode (detailed)](#step-1--learn-mode-detailed)
4. [Step 2 — Load your spreadsheet](#step-2--load-your-spreadsheet)
5. [Step 3 — Run](#step-3--run)
6. [The session report](#the-session-report)
7. [Spreadsheet format](#spreadsheet-format)
8. [Troubleshooting](#troubleshooting)
9. [Privacy & security](#privacy--security)
10. [How it works (for developers)](#how-it-works-for-developers)

---

## Styling (shadcn + Tailwind)

The side panel uses **shadcn/ui design tokens** (slate dark theme) via **Tailwind CSS**. Source styles live in [`extension/sidepanel/input.css`](extension/sidepanel/input.css); the compiled bundle is [`extension/sidepanel/sidepanel.css`](extension/sidepanel/sidepanel.css).

After editing styles:

```bash
npm install
npm run build:css    # or npm run dev:css while iterating
```

No React build — component classes (`btn-primary`, `card`, `tabs-list`, etc.) are plain CSS compiled from Tailwind `@apply`, which keeps the extension loadable as unpacked files.

---

## Try it without installing (demo harness)

For UX review you can run the **real** side panel + content scripts as a plain
web page against a built-in mock MedHub form — no extension install, no login.

```bash
# from the repo root
python3 -m http.server 8777
# then open: http://localhost:8777/demo/demo.html
```

The left pane is a mock MedHub "Add Procedure" form; the right pane is the
actual auto-mate side panel (a `chrome.*` shim wires them together and backs
storage with `localStorage`). Click through Learn → Data (drop
[`extension/samples/slicer-dicer-sample.csv`](extension/samples/slicer-dicer-sample.csv))
→ Run (dry-run) → Report.

You can also drive it headlessly and capture screenshots:

```bash
npm install            # installs puppeteer-core (dev only)
node demo/drive.js     # screenshots land in demo/screenshots/
```

> The demo is for UX/UI iteration only. Real selectors still come from running
> Learn mode against the live MedHub form in the installed extension.

---

## Install (load unpacked)

auto-mate is distributed as an unpacked Chrome extension.

1. Open **Chrome** and go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the **`extension/`** folder from this project.
5. auto-mate appears in your toolbar. Click the puzzle-piece icon and **pin** it
   for easy access.

> Chrome only. (Safari is not supported — it uses a different extension system.)

---

## The 3-step workflow

```
  Log in yourself  ─▶  1. Learn (once)  ─▶  2. Load spreadsheet  ─▶  3. Run
```

Open the form you want to fill in a normal tab and **log in manually**. Then
click the auto-mate icon to open its side panel. The panel has three tabs that
match the workflow: **Learn**, **Data**, **Run** (plus a **Report** tab).

---

## Step 1 — Learn mode (detailed)

Learn mode is a **one-time** setup. auto-mate watches you fill the form once and
remembers *where* each field is and *how* it behaves (including search/
autocomplete fields). The result is saved as a "recipe" so you never have to do
this again — unless the form itself changes.

### Before you start
- Be **logged in** to the site.
- Have the **form open and visible** in the active browser tab.
- Have one real (or test) set of values handy so you can fill the form for real.

### Recording

1. Open the auto-mate side panel and go to the **Learn** tab.
2. Click **Start Learn mode**. A small dark badge appears in the bottom-right of
   the page: *"Learn mode is recording."*
3. **Fill the form exactly as you normally would**, one field at a time:
   - **Date** — type/pick the date.
   - **Location** — set it to `IMC` (auto-mate will hard-code this as a static
     value, so it is the same every time).
   - **Supervisor** — click the field, type the supervisor's name, **wait for
     the dropdown**, and **click the correct result**. This type-then-click is
     how auto-mate learns it is a search field.
   - **Patient MRN** — click the patient/name field and type an MRN.
   - **Procedure(s)** — click the procedure search, type a procedure, and
     **click the matching result**. If multiple procedures apply, add them the
     way you normally would; you only need to demonstrate the procedure field
     *once* — auto-mate marks it repeatable.
   - **Submit** — click the button that submits/saves the form.
4. Back in the side panel, the **Captured steps** list fills in as you go. Each
   row shows what was captured (a field, an autocomplete, the submit button).
5. Click **Finish & review**.

### Labeling the steps

auto-mate can see *that* you typed into a box, but not *what the box means*. So
for each captured step there is a dropdown — confirm it:

| If the step was…             | Choose…                     |
| ---------------------------- | --------------------------- |
| The date field               | **Date**                    |
| The location field           | **Location (static "IMC")** |
| The supervisor search        | **Supervisor**              |
| The patient/MRN field        | **Patient MRN**             |
| A procedure search           | **Procedure**               |
| The submit/save button       | **Submit**                  |
| Anything irrelevant          | **Ignore this step**        |

auto-mate pre-guesses these from the field labels; just fix any that are wrong.
Leave junk steps as **Ignore this step**.

Click **Save recipe**. You will see *"Recipe saved (N steps)."* You're done with
setup.

### Re-learning later
If the website changes and a field stops working, open **Learn → Manage recipe
→ Clear recipe**, then record again. (Learn mode takes under a minute.)

---

## Step 2 — Load your spreadsheet

1. Go to the **Data** tab.
2. **Drag your Slicer Dicer export** (`.xlsx`, `.xls`, or `.csv`) onto the drop
   zone — or click it to browse. auto-mate parses it automatically; there is no
   "import" button.
3. auto-mate cleans the data behind the scenes (trims headers, drops blank
   leading rows, normalizes dates, preserves MRNs including leading zeros) and
   shows a **preview table**.
4. Check the **Column mapping**. auto-mate auto-detects common Slicer Dicer
   column names, but you can override any of them:
   - Date → your date column
   - Supervisor → attending/supervisor column
   - Patient MRN → MRN column
   - Procedure → procedure column
5. **Multiple procedures per patient:** leave *"Combine multiple procedure rows
   that share the same MRN + date"* checked if your export lists each procedure
   on its own row. auto-mate will merge them into a single entry with several
   procedures. (A single cell with several procedures separated by `;`, `,`,
   `|`, or `/` is also supported.)

---

## Step 3 — Run

1. Go to the **Run** tab. It shows whether you're ready (recipe + data present).
2. **Leave "Dry run" checked the first time.** In dry-run, auto-mate fills every
   field exactly as it would live, but **does not click Submit** — so you can
   watch it and confirm the supervisor and procedures resolve correctly.
3. Optionally adjust **Delay between fields** (slower = more reliable on laggy
   pages).
4. Click **Start**. Keep the form tab visible. auto-mate processes each entry,
   streaming a live log. Use **Stop** at any time to halt.
5. When the dry run looks correct, **uncheck Dry run** and click **Start** again
   for the live run. You'll be asked to confirm before any real submissions.

---

## The session report

After every run (dry or live), the **Report** tab shows a summary (rows
succeeded / failed / stopped) and a per-field ledger of **every action
auto-mate took** — the value written into each field, the option chosen from
each search dropdown, and the outcome.

Export it for your records:
- **Export HTML** — human-readable report.
- **Export CSV** — one row per action, for spreadsheets.
- **Export JSON** — full structured data.

Reports stay on your machine; nothing is uploaded.

---

## Spreadsheet format

Structure is consistent with Epic Slicer Dicer exports. auto-mate recognizes
common header names automatically (and you can always remap):

| Logical field | Recognized headers (examples)                              |
| ------------- | ---------------------------------------------------------- |
| Date          | Date, Date of Service, DOS, Service Date, Encounter Date   |
| Supervisor    | Supervisor, Attending, Attending Provider, Preceptor       |
| Patient MRN   | MRN, Patient MRN, Medical Record Number, Patient           |
| Procedure     | Procedure, Procedures, Procedure Name, CPT                 |

A sample file lives at [`extension/samples/slicer-dicer-sample.csv`](extension/samples/slicer-dicer-sample.csv).
Location is **not** read from the spreadsheet — it is always `IMC`.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Could not attach to this page." | Reload the form tab, then reopen the panel. The page must finish loading first. |
| Learn captured nothing | Make sure you actually clicked into and typed in the fields; then click **Finish & review**. |
| A supervisor/procedure isn't selected | The spreadsheet text must be close enough to match a dropdown result. Check spelling; the search needs to return a result that contains your text. |
| "Field not found on page" during a run | The form layout likely changed. **Clear recipe** and re-learn. |
| Dates fill wrong | In the **Data** preview, confirm dates show as `YYYY-MM-DD`. If your column was text, remap it or fix the export. |
| MRN lost leading zeros | auto-mate preserves them; if your source already dropped them, export the MRN column as text from Epic. |

---

## Privacy & security

- **auto-mate stores no credentials.** It relies entirely on your existing
  logged-in browser session. There is no login feature, by design — storing EHR
  credentials locally would be insecure and a likely HIPAA/IT-policy violation.
- The learned **recipe** (field selectors only — no patient data) is stored in
  `chrome.storage.local` on your machine.
- Spreadsheet data and reports are processed **locally in the browser** and are
  never transmitted anywhere by auto-mate.
- Reports contain PHI (MRNs, procedures, names). Store and share exported
  reports according to your organization's policies.

---

## How it works (for developers)

```
extension/
├── manifest.json            MV3 manifest
├── background.js            Opens side panel; relays content→panel messages
├── common/
│   ├── messages.js          Shared message/role/field constants
│   └── dom-utils.js         Resilient selector generation + element resolution
├── content/
│   ├── recorder.js          Learn mode: captures steps, detects autocompletes
│   ├── engine.js            Replay: fills fields, autocomplete, submit, logging
│   ├── overlay.js           In-page status badge + highlight box
│   └── content.js           Message bridge (panel ↔ recorder/engine/overlay)
├── sidepanel/
│   ├── sidepanel.html/.css  Three-step UI + report
│   ├── sidepanel.js         Controller / run loop
│   ├── parser.js            SheetJS wrapper + Slicer Dicer cleanup + mapping
│   └── report.js            Audit log → HTML/CSV/JSON
├── vendor/xlsx.full.min.js  SheetJS (spreadsheet parsing)
├── samples/                 Example spreadsheet
└── test/parser.test.js      Node smoke test for parser + report
```

**Recipe shape** (saved to `chrome.storage.local`):

```json
{
  "version": 1,
  "url": "https://...",
  "procedureRepeatable": true,
  "steps": [
    { "field": "date", "role": "input", "candidates": [{ "type": "css", "value": "#date" }] },
    { "field": "location", "role": "static", "staticValue": "IMC", "candidates": [/* ... */] },
    { "field": "supervisor", "role": "autocomplete", "optionSelector": "[role=\"option\"]", "candidates": [/* ... */] },
    { "field": "mrn", "role": "input", "candidates": [/* ... */] },
    { "field": "procedure", "role": "autocomplete", "optionSelector": "li.result", "candidates": [/* ... */] },
    { "field": "submit", "role": "submit", "candidates": [/* ... */] }
  ]
}
```

Each field stores **multiple candidate selectors** (id → name → aria-label →
data-* → placeholder → label text → structural path). On replay the engine
tries them in order, so a single brittle selector never breaks a run.

### Tests

The suite runs in Node with **jsdom** and is built around a MedHub procedure
form. It covers the spreadsheet parser/report, the Learn-mode recorder (field +
autocomplete capture), and the replay engine (filling, supervisor/procedure
autocomplete matching, multi-procedure selection, dry-run vs. live submit, and
clean failure on an unmatched supervisor).

```bash
npm install   # installs jsdom (dev dependency)
npm test
```

Fixtures live in [`extension/test/fixtures/`](extension/test/fixtures/):

- `medhub-home.html` — the client's MedHub home page (confirms platform/nav).
- `medhub-procedure-form.html` — a synthetic MedHub *Add Procedure* form with a
  jQuery-style autocomplete, used to exercise record + replay end to end.

> Note: the client's saved HTML was the MedHub **home page** (Safari flattens it
> into styled text), so it does not contain the live procedure form's inputs.
> The synthetic fixture mirrors MedHub's classic autocomplete pattern; the
> *real* selectors are captured on the user's machine via Learn mode. When the
> live Procedures form is captured, drop it in as another fixture and the same
> tests apply.
