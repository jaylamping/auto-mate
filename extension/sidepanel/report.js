/**
 * auto-mate session report builder.
 *
 * Collects the per-action ledger streamed from the engine and renders an
 * end-of-session report. Exports to HTML, CSV, and JSON. Local-first: nothing
 * is transmitted off-device.
 */
(function (root) {
  function summarize(session) {
    const rows = session.rows || [];
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    for (const r of rows) {
      if (r.result && r.result.ok) succeeded++;
      else if (r.result && r.result.aborted) skipped++;
      else failed++;
    }
    return {
      total: rows.length,
      succeeded,
      failed,
      skipped,
      dryRun: !!session.dryRun,
      startedAt: session.startedAt,
      finishedAt: session.finishedAt
    };
  }

  function rowStatus(row) {
    if (!row || !row.result) return 'failed';
    if (row.result.ok) return 'success';
    if (row.result.aborted) return 'stopped';
    return 'failed';
  }

  function filterRows(rows, filter) {
    if (!filter || filter === 'all') return rows || [];
    return (rows || []).filter((r) => rowStatus(r) === filter);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function rowBlocksHtml(session, filter) {
    const visibleRows = filterRows(session.rows, filter);
    if (!visibleRows.length) {
      return `<p class="report-empty">No ${esc(filter)} rows in this session.</p>`;
    }
    return visibleRows
      .map((r) => {
        const actions = (r.result && r.result.actions) || [];
        const actionRows = actions
          .map(
            (a) => `<tr>
              <td>${esc(a.ts)}</td>
              <td>${esc(a.field)}</td>
              <td>${esc(a.role)}</td>
              <td>${esc(a.value != null ? a.value : '')}</td>
              <td>${esc(a.chosen != null ? a.chosen : '')}</td>
              <td class="o-${esc(a.outcome)}">${esc(a.outcome)}</td>
              <td>${esc(a.detail != null ? a.detail : '')}</td>
            </tr>`
          )
          .join('');
        const status = r.result && r.result.ok ? 'success' : r.result && r.result.aborted ? 'aborted' : 'failed';
        return `<section class="row-block">
          <h3>Row ${r.index + 1} &mdash; MRN ${esc(r.mrn || 'n/a')} <span class="o-${status}">[${status}]</span></h3>
          <table><thead><tr><th>Time</th><th>Field</th><th>Type</th><th>Value</th><th>Selected</th><th>Outcome</th><th>Detail</th></tr></thead>
          <tbody>${actionRows}</tbody></table>
        </section>`;
      })
      .join('');
  }

  /** HTML fragment for side panel preview (no duplicate summary cards). */
  function toBodyHtml(session, options = {}) {
    const filter = options.filter || 'all';
    const s = summarize(session);
    const filterBanner =
      filter !== 'all'
        ? `<div class="banner report-filter-banner">Showing <b>${filterRows(session.rows, filter).length}</b> of ${s.total} rows (${esc(filter)} only).</div>`
        : '';
    return filterBanner + rowBlocksHtml(session, filter);
  }

  function toHTML(session, options = {}) {
    const filter = options.filter || 'all';
    const s = summarize(session);
    const visibleRows = filterRows(session.rows, filter);
    const rowsHtml = rowBlocksHtml(session, filter);

  const filterBanner =
    filter !== 'all'
      ? `<div class="banner report-filter-banner">Showing <b>${visibleRows.length}</b> of ${s.total} rows (${esc(filter)} only). Click a summary card to change filter.</div>`
      : '';

    return `<!doctype html><html><head><meta charset="utf-8"><title>auto-mate session report</title>
      <style>
        body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#0f172a;}
        h1{margin:0 0 4px;} .sub{color:#64748b;margin-bottom:18px;}
        .cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px;}
        .card{border:1px solid #e2e8f0;border-radius:10px;padding:12px 16px;min-width:90px;}
        .card b{font-size:22px;display:block;}
        table{border-collapse:collapse;width:100%;margin:8px 0 20px;}
        th,td{border:1px solid #e2e8f0;padding:6px 8px;text-align:left;font-size:13px;}
        th{background:#f8fafc;}
        .o-success{color:#15803d;font-weight:600;} .o-failed{color:#b91c1c;font-weight:600;}
        .o-skipped{color:#b45309;} .o-aborted{color:#b45309;font-weight:600;}
        .banner{background:#fef3c7;border:1px solid #fde68a;padding:8px 12px;border-radius:8px;margin-bottom:16px;}
      </style></head><body>
      <h1>auto-mate session report</h1>
      <div class="sub">Started ${esc(s.startedAt)} &middot; Finished ${esc(s.finishedAt)}</div>
      ${s.dryRun ? '<div class="banner"><b>DRY RUN</b> &mdash; no submissions were made.</div>' : ''}
      ${filterBanner}
      <div class="cards">
        <div class="card card-filter" data-report-filter="all" role="button" tabindex="0"><b>${s.total}</b>Rows</div>
        <div class="card card-filter" data-report-filter="success" role="button" tabindex="0"><b>${s.succeeded}</b>Succeeded</div>
        <div class="card card-filter" data-report-filter="failed" role="button" tabindex="0"><b>${s.failed}</b>Failed</div>
        <div class="card card-filter" data-report-filter="stopped" role="button" tabindex="0"><b>${s.skipped}</b>Stopped</div>
      </div>
      ${rowsHtml}
    </body></html>`;
  }

  function toCSV(session) {
    const lines = [['timestamp', 'row', 'mrn', 'field', 'type', 'value', 'selected', 'outcome', 'detail']];
    for (const r of session.rows || []) {
      const actions = (r.result && r.result.actions) || [];
      for (const a of actions) {
        lines.push([
          a.ts,
          r.index + 1,
          r.mrn || '',
          a.field || '',
          a.role || '',
          a.value != null ? a.value : '',
          a.chosen != null ? a.chosen : '',
          a.outcome || '',
          a.detail != null ? a.detail : ''
        ]);
      }
    }
    return lines
      .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
  }

  function toJSON(session) {
    return JSON.stringify({ summary: summarize(session), session }, null, 2);
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  root.FAA_REPORT = { summarize, rowStatus, filterRows, toHTML, toBodyHtml, toCSV, toJSON, download };
})(typeof window !== 'undefined' ? window : globalThis);
