/**
 * auto-mate spreadsheet parser.
 *
 * Wraps SheetJS to read .xlsx/.xls/.csv, then applies light cleanup tuned for
 * Epic Slicer Dicer exports: trims/normalizes headers, drops blank leading
 * rows, coerces dates, and normalizes MRNs. Produces a clean { headers, rows }.
 */
(function (root) {
  const FIELD_SYNONYMS = {
    date: ['date', 'procedure date', 'service date', 'dos', 'date of service', 'encounter date'],
    supervisor: ['supervisor', 'attending', 'attending provider', 'supervising provider', 'preceptor'],
    mrn: ['mrn', 'patient mrn', 'medical record number', 'patient', 'patient name', 'patient id'],
    procedure: ['procedure', 'procedures', 'procedure name', 'cpt', 'procedure description']
  };

  function normalizeHeader(h) {
    return String(h == null ? '' : h)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function guessMapping(headers) {
    const mapping = {};
    const lower = headers.map((h) => h.toLowerCase());
    for (const [field, syns] of Object.entries(FIELD_SYNONYMS)) {
      let idx = -1;
      for (const syn of syns) {
        idx = lower.findIndex((h) => h === syn);
        if (idx >= 0) break;
      }
      if (idx < 0) {
        for (const syn of syns) {
          idx = lower.findIndex((h) => h.includes(syn));
          if (idx >= 0) break;
        }
      }
      if (idx >= 0) mapping[field] = headers[idx];
    }
    return mapping;
  }

  function excelDateToISO(value) {
    // SheetJS may give a Date, a number (serial), or a string.
    if (value instanceof Date && !isNaN(value)) {
      return value.toISOString().slice(0, 10);
    }
    if (typeof value === 'number') {
      // Excel serial date -> JS date (epoch 1899-12-30).
      const d = new Date(Math.round((value - 25569) * 86400 * 1000));
      if (!isNaN(d)) return d.toISOString().slice(0, 10);
    }
    return String(value == null ? '' : value).trim();
  }

  function normalizeMRN(value) {
    return String(value == null ? '' : value)
      .replace(/\u00a0/g, ' ')
      .trim()
      .replace(/\s+/g, '');
  }

  async function readFile(file) {
    const buf = await file.arrayBuffer();
    // raw:true keeps text cells (e.g. MRNs with leading zeros) as-is instead of
    // coercing them to numbers. Genuine date cells come through as Excel serial
    // numbers, which excelDateToISO() converts deterministically.
    const wb = root.XLSX.read(buf, { type: 'array', raw: true });
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    // header:1 gives array-of-arrays so we can find the real header row.
    const aoa = root.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });

    // Find first non-empty row -> treat as header.
    let headerRowIdx = 0;
    while (headerRowIdx < aoa.length && aoa[headerRowIdx].every((c) => normalizeHeader(c) === '')) {
      headerRowIdx++;
    }
    const headers = (aoa[headerRowIdx] || []).map(normalizeHeader);

    const rows = [];
    for (let i = headerRowIdx + 1; i < aoa.length; i++) {
      const raw = aoa[i];
      if (!raw || raw.every((c) => normalizeHeader(c) === '')) continue;
      const obj = {};
      headers.forEach((h, idx) => {
        if (h) obj[h] = raw[idx];
      });
      rows.push(obj);
    }

    return { sheetName, headers: headers.filter(Boolean), rows };
  }

  /**
   * Turn parsed rows into normalized engine rows using a column mapping.
   * Supports multiple procedures via either a delimited cell or multiple rows
   * sharing the same MRN+date (grouped when groupProcedures is true).
   */
  function buildEngineRows(parsed, mapping, opts = {}) {
    const { procedureDelimiter = /[;,|\/]+|\n/, groupProcedures = true, location = 'IMC' } = opts;
    const dateCol = mapping.date;
    const supCol = mapping.supervisor;
    const mrnCol = mapping.mrn;
    const procCol = mapping.procedure;

    const expanded = parsed.rows.map((r) => {
      const procRaw = procCol ? r[procCol] : '';
      const procedures = String(procRaw == null ? '' : procRaw)
        .split(procedureDelimiter)
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        date: dateCol ? excelDateToISO(r[dateCol]) : '',
        supervisor: supCol ? String(r[supCol] == null ? '' : r[supCol]).trim() : '',
        mrn: mrnCol ? normalizeMRN(r[mrnCol]) : '',
        procedures,
        location
      };
    });

    if (!groupProcedures) return expanded;

    // Group rows that share MRN + date + supervisor, merging procedures.
    const map = new Map();
    const order = [];
    for (const row of expanded) {
      const key = `${row.mrn}|${row.date}|${row.supervisor}`;
      if (!map.has(key)) {
        map.set(key, { ...row, procedures: [...row.procedures] });
        order.push(key);
      } else {
        const existing = map.get(key);
        for (const p of row.procedures) {
          if (!existing.procedures.includes(p)) existing.procedures.push(p);
        }
      }
    }
    return order.map((k) => map.get(k));
  }

  root.FAA_PARSER = { readFile, guessMapping, buildEngineRows, normalizeMRN, excelDateToISO };
})(typeof window !== 'undefined' ? window : globalThis);
