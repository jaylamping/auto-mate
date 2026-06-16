# auto-mate

Chrome extension: fill a web form from a spreadsheet using your logged-in browser session. Log in yourself, load your spreadsheet, show auto-mate the form once (Mapping / learn), then run the rest.

Built for MedHub procedure logging (`ahc.medhub.com`, Procedures tab) from Epic Slicer Dicer exports — date, location, supervisor, MRN, procedure(s). Fields are learned by recording, not hard-coded.

- **No passwords stored** — runs in the tab you already logged into.
- **No selectors to write** — guided learn records the form.
- **Dry run first** — fills everything without submitting.
- **Audit report** — every field action logged and exportable.

## Install

`chrome://extensions` → Developer mode → Load unpacked → select the `extension/` folder.

## Use

1. **Data** — upload `.xlsx`, `.xls`, or `.csv` (see `extension/samples/`).
2. **Mapping** — fill the form once on the MedHub tab; column mapping infers as you go. Finish when required fields are mapped.
3. **Run** — dry run first, then live (confirmation modal). **Report** — summary + export.

Location defaults to `IMC` (not from the spreadsheet).

## Samples

| File | Purpose |
|------|---------|
| `extension/samples/slicer-dicer-sample.csv` | Minimal 4-row example |
| `extension/samples/medhub-eval-test.csv` | Edge cases, blanks, intentional failures |

## Dev

```bash
npm install
npm test              # jsdom suites
npm run build:css     # after editing sidepanel/input.css
```

Demo (no extension): `python -m http.server 8777` → `http://localhost:8777/demo/demo.html`

Recipe and mapping stay in `chrome.storage.local`. Spreadsheet data and reports are processed locally only.
