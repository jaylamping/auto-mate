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
    location: ['location', 'site', 'facility'],
    supervisor: ['supervisor', 'attending', 'attending provider', 'supervising provider', 'preceptor'],
    encounter: ['encounter', 'mrn', 'patient mrn', 'medical record number', 'patient', 'patient id'],
    procedure: ['procedure', 'procedures', 'procedure name', 'cpt', 'procedure description'],
    gender: ['gender', 'patient gender', 'sex'],
    age: ['age', 'patient age'],
    diagnosis: ['diagnosis', 'dx', 'icd'],
    complications: ['complications', 'complication'],
    notes: ['notes', 'procedure notes', 'comment', 'comments']
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

  /** Match a form label / header text to a logical field key using headers + synonyms. */
  function matchFieldKeyFromLabel(text, headers) {
    const norm = normalizeHeader(text).toLowerCase();
    if (!norm) return null;
    const guessed = guessMapping(headers);

    for (const h of headers) {
      if (normalizeHeader(h).toLowerCase() === norm) {
        for (const [field, col] of Object.entries(guessed)) {
          if (col === h) return field;
        }
        const hl = h.toLowerCase();
        for (const [field, syns] of Object.entries(FIELD_SYNONYMS)) {
          if (syns.some((syn) => hl === syn || hl.includes(syn))) return field;
        }
      }
    }

    for (const [field, col] of Object.entries(guessed)) {
      if (col && normalizeHeader(col).toLowerCase() === norm) return field;
    }

    for (const [field, syns] of Object.entries(FIELD_SYNONYMS)) {
      for (const syn of syns) {
        if (norm === syn || norm.includes(syn) || syn.includes(norm)) return field;
      }
    }
    return null;
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
   * One spreadsheet row = one engine row. Delimited procedure cells still split.
   */
  function buildEngineRows(parsed, mapping, opts = {}) {
    const { procedureDelimiter = /[;,|\/]+|\n/, location = 'IMC' } = opts;
    const dateCol = mapping.date;
    const supCol = mapping.supervisor;
    const encounterCol = mapping.encounter || mapping.mrn;
    const procCol = mapping.procedure;
    const locationCol = mapping.location;
    const genderCol = mapping.gender;
    const ageCol = mapping.age;
    const diagnosisCol = mapping.diagnosis;
    const complicationsCol = mapping.complications;
    const notesCol = mapping.notes;

    const expanded = parsed.rows.map((r) => {
      const procRaw = procCol ? r[procCol] : '';
      const procedures = String(procRaw == null ? '' : procRaw)
        .split(procedureDelimiter)
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        date: dateCol ? excelDateToISO(r[dateCol]) : '',
        supervisor: supCol ? String(r[supCol] == null ? '' : r[supCol]).trim() : '',
        mrn: encounterCol ? normalizeMRN(r[encounterCol]) : '',
        procedures,
        location: locationCol
          ? String(r[locationCol] == null ? '' : r[locationCol]).trim()
          : location,
        gender: genderCol ? String(r[genderCol] == null ? '' : r[genderCol]).trim() : '',
        age: ageCol ? String(r[ageCol] == null ? '' : r[ageCol]).trim() : '',
        diagnosis: diagnosisCol ? String(r[diagnosisCol] == null ? '' : r[diagnosisCol]).trim() : '',
        complications: complicationsCol ? String(r[complicationsCol] == null ? '' : r[complicationsCol]).trim() : '',
        notes: notesCol ? String(r[notesCol] == null ? '' : r[notesCol]).trim() : ''
      };
    });

    return expanded;
  }

  root.FAA_PARSER = {
    readFile,
    guessMapping,
    matchFieldKeyFromLabel,
    buildEngineRows,
    normalizeMRN,
    excelDateToISO
  };
})(typeof window !== 'undefined' ? window : globalThis);
