/**
 * auto-mate in-page overlay.
 *
 * Provides a floating status badge and a highlight box used during Learn mode
 * (to confirm which element was captured) and Dry-Run (to show what would be
 * filled). Purely cosmetic; never blocks the page.
 */
(function (root) {
  let badge = null;
  let highlightBox = null;

  function ensureStyles() {
    if (document.getElementById('faa-overlay-styles')) return;
    const style = document.createElement('style');
    style.id = 'faa-overlay-styles';
    style.textContent = `
      .faa-badge{position:fixed;z-index:2147483647;bottom:16px;right:16px;
        background:#0f172a;color:#e2e8f0;font:13px/1.4 system-ui,sans-serif;
        padding:10px 14px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);
        max-width:280px;pointer-events:none;}
      .faa-badge b{color:#7dd3fc;}
      .faa-highlight{position:absolute;z-index:2147483646;border:2px solid #38bdf8;
        background:rgba(56,189,248,.12);border-radius:4px;pointer-events:none;
        transition:all .12s ease;box-shadow:0 0 0 9999px rgba(15,23,42,.04);}
    `;
    document.documentElement.appendChild(style);
  }

  function setBadge(html) {
    ensureStyles();
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'faa-badge';
      document.documentElement.appendChild(badge);
    }
    badge.innerHTML = html;
    badge.style.display = 'block';
  }

  function hideBadge() {
    if (badge) badge.style.display = 'none';
  }

  function highlight(el) {
    if (!el) return;
    ensureStyles();
    if (!highlightBox) {
      highlightBox = document.createElement('div');
      highlightBox.className = 'faa-highlight';
      document.documentElement.appendChild(highlightBox);
    }
    const r = el.getBoundingClientRect();
    highlightBox.style.top = `${r.top + window.scrollY - 2}px`;
    highlightBox.style.left = `${r.left + window.scrollX - 2}px`;
    highlightBox.style.width = `${r.width}px`;
    highlightBox.style.height = `${r.height}px`;
    highlightBox.style.display = 'block';
  }

  function clearHighlight() {
    if (highlightBox) highlightBox.style.display = 'none';
  }

  root.FAA_OVERLAY = { setBadge, hideBadge, highlight, clearHighlight };
})(typeof window !== 'undefined' ? window : globalThis);
