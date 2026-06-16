/**
 * auto-mate DOM utilities: resilient selector generation + element resolution.
 *
 * The recorder uses generateCandidateSelectors() to capture several selectors
 * per element (most stable first). The engine uses resolveElement() to find a
 * recorded element again on later rows, trying each candidate in order so a
 * single brittle selector never breaks a run.
 */
(function (root) {
  const CSS_ESCAPE = (s) =>
    (root.CSS && root.CSS.escape ? root.CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));

  function isUsableId(id) {
    // Reject ids that look auto-generated (random hashes, framework ids).
    if (!id) return false;
    if (/^\d/.test(id)) return false;
    if (/[0-9a-f]{8,}/i.test(id)) return false; // long hex chunk
    if (/(^|[-_:])\d{3,}([-_:]|$)/.test(id)) return false; // long numeric segment
    return true;
  }

  function cleanLabelText(s) {
    return String(s == null ? '' : s)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s*\*\s*$/g, '')
      .trim();
  }

  function labelLikeText(el) {
    if (!el || el.nodeType !== 1) return null;
    const tag = el.tagName.toLowerCase();
    const cls = el.className && typeof el.className === 'string' ? el.className : '';
    if (tag === 'label' || tag === 'legend' || /\bfield-label\b/i.test(cls)) {
      const t = cleanLabelText(el.textContent);
      if (t) return t;
    }
    return null;
  }

  function ariaLabelledByText(el) {
    const raw = el.getAttribute && el.getAttribute('aria-labelledby');
    if (!raw || !raw.trim()) return null;
    const parts = raw
      .trim()
      .split(/\s+/)
      .map((id) => {
        const ref = document.getElementById(id);
        return ref ? cleanLabelText(ref.textContent) : '';
      })
      .filter(Boolean);
    return parts.length ? parts.join(' ') : null;
  }

  /**
   * Walk ancestors (and immediate previous siblings) for human-readable field text.
   * Mirrors what Playwright getByLabel / Testing Library use: associated label first,
   * then proximity heuristics for broken markup.
   */
  function nearbyLabelText(el, maxDepth = 5) {
    let node = el;
    for (let d = 0; d < maxDepth && node; d++) {
      const parent = node.parentElement;
      if (!parent) break;

      const prev = node.previousElementSibling;
      if (prev) {
        const fromLike = labelLikeText(prev);
        if (fromLike) return fromLike;
        const fromPrev = cleanLabelText(prev.textContent);
        if (fromPrev && fromPrev.length <= 80) return fromPrev;
      }

      if (parent.tagName.toLowerCase() === 'label') {
        const t = cleanLabelText(parent.textContent);
        if (t) return t;
      }

      for (const sel of ['label', '.field-label', 'legend']) {
        const labelChild = parent.querySelector(`:scope > ${sel}`);
        if (labelChild && labelChild !== node && !node.contains(labelChild)) {
          const t = labelLikeText(labelChild) || cleanLabelText(labelChild.textContent);
          if (t && t.length <= 80) return t;
        }
      }

      node = parent;
    }
    return null;
  }

  function accessibleNameFor(el, maxDepth = 5) {
    if (!el || el.nodeType !== 1) return '';
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return cleanLabelText(ariaLabel);

    const fromLabelledBy = ariaLabelledByText(el);
    if (fromLabelledBy) return fromLabelledBy;

    const fromAssoc = labelTextFor(el);
    if (fromAssoc) return cleanLabelText(fromAssoc);

    const near = nearbyLabelText(el, maxDepth);
    if (near) return near;

    const ph = el.getAttribute('placeholder');
    if (ph && ph.trim()) return cleanLabelText(ph);

    const name = el.getAttribute('name');
    if (name && name.trim()) return cleanLabelText(name.replace(/_/g, ' '));

    return '';
  }

  function labelTextFor(el) {
    // <label for=id> or wrapping <label>
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS_ESCAPE(el.id)}"]`);
      if (lbl && lbl.textContent.trim()) return lbl.textContent.trim();
    }
    let p = el.closest('label');
    if (p && p.textContent.trim()) return p.textContent.trim();
    // aria-labelledby
    const labelledby = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledby) {
      const ref = document.getElementById(labelledby);
      if (ref && ref.textContent.trim()) return ref.textContent.trim();
    }
    return null;
  }

  function nthOfTypePath(el, maxDepth = 5) {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < maxDepth && node.tagName.toLowerCase() !== 'html') {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) {
          part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      if (node.id && isUsableId(node.id)) {
        parts[0] = `#${CSS_ESCAPE(node.id)} ` + (parts[1] ? '' : '');
        break;
      }
      node = parent;
      depth++;
    }
    return parts.join(' > ');
  }

  /**
   * Returns an ordered list of candidate selector descriptors for an element.
   * Each descriptor: { type, value }. resolveElement() understands every type.
   */
  function generateCandidateSelectors(el) {
    const out = [];
    if (!el || el.nodeType !== 1) return out;

    if (el.id && isUsableId(el.id)) {
      out.push({ type: 'css', value: `#${CSS_ESCAPE(el.id)}` });
    }
    const name = el.getAttribute('name');
    if (name) {
      out.push({ type: 'css', value: `${el.tagName.toLowerCase()}[name="${CSS_ESCAPE(name)}"]` });
    }
    const aria = el.getAttribute('aria-label');
    if (aria) {
      out.push({ type: 'css', value: `${el.tagName.toLowerCase()}[aria-label="${CSS_ESCAPE(aria)}"]` });
    }
    for (const attr of ['data-testid', 'data-test', 'data-id', 'data-automation-id']) {
      const v = el.getAttribute(attr);
      if (v) out.push({ type: 'css', value: `[${attr}="${CSS_ESCAPE(v)}"]` });
    }
    const ph = el.getAttribute('placeholder');
    if (ph) {
      out.push({ type: 'css', value: `${el.tagName.toLowerCase()}[placeholder="${CSS_ESCAPE(ph)}"]` });
    }
    const label = accessibleNameFor(el);
    if (label) {
      out.push({ type: 'label', value: label.slice(0, 120) });
    }
    // Always include a structural fallback last.
    const path = nthOfTypePath(el);
    if (path) out.push({ type: 'css', value: path });

    // De-dupe by serialized form.
    const seen = new Set();
    return out.filter((c) => {
      const k = `${c.type}::${c.value}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function matchByLabel(labelText, scope) {
    const root2 = scope || document;
    const wanted = labelText.trim().toLowerCase();
    // explicit label[for]
    const labels = Array.from(root2.querySelectorAll('label'));
    for (const lbl of labels) {
      if (lbl.textContent.trim().toLowerCase() === wanted) {
        const forId = lbl.getAttribute('for');
        if (forId) {
          const t = document.getElementById(forId);
          if (t) return t;
        }
        const inner = lbl.querySelector('input, select, textarea, [contenteditable="true"]');
        if (inner) return inner;
      }
    }
    // aria-label fallback
    const byAria = root2.querySelector(`[aria-label="${CSS_ESCAPE(labelText)}"]`);
    if (byAria) return byAria;
    return null;
  }

  function resolveElement(candidates, scope) {
    const root2 = scope || document;
    for (const c of candidates || []) {
      try {
        if (c.type === 'css') {
          const el = root2.querySelector(c.value);
          if (el) return el;
        } else if (c.type === 'label') {
          const el = matchByLabel(c.value, root2);
          if (el) return el;
        }
      } catch (_) {
        // Bad selector -> skip to next candidate.
      }
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.hidden) return false;
    let style = null;
    try {
      style = root.getComputedStyle(el);
    } catch (_) {
      style = null;
    }
    if (style && (style.visibility === 'hidden' || style.display === 'none')) return false;
    // Walk ancestors for display:none (covers collapsed dropdown containers).
    let p = el.parentElement;
    while (p) {
      let ps = null;
      try {
        ps = root.getComputedStyle(p);
      } catch (_) {}
      if (ps && (ps.display === 'none' || ps.visibility === 'hidden')) return false;
      p = p.parentElement;
    }
    // Note: we intentionally do not require a non-zero bounding rect. Headless
    // DOMs (jsdom) report zero rects for everything, and real dropdowns are
    // toggled via display/visibility, which we already check above.
    return true;
  }

  root.FAA_DOM = root.FAA_DOM || {};
  Object.assign(root.FAA_DOM, {
    generateCandidateSelectors,
    resolveElement,
    labelTextFor,
    accessibleNameFor,
    isVisible,
    CSS_ESCAPE
  });
})(typeof window !== 'undefined' ? window : globalThis);
