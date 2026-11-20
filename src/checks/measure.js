// Runs INSIDE the page (page.evaluate). Must stay self-contained: no require, no outer variables.
// measure({ id, opts }) -> { status: 'pass' | 'fail' | 'na', detail }
//   pass = checked and fine, fail = checked and wrong, na = could not be tested here (element not on this page/theme).
// Selectors come from the app's storefront source (real-app/search-n-filter/dev-extensions/search-result).
function measure(arg) {
  const id = arg.id;
  const T = Object.assign({ alignPx: 3, contrastMin: 3, widthDiffPct: 10, searchGapPx: 12 }, arg.opts || {});
  const q = (s, r) => Array.from((r || document).querySelectorAll(s));
  const rect = (e) => e.getBoundingClientRect();
  const vis = (e) => {
    if (!e) return false;
    const r = rect(e);
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
  };
  const onScreen = (e) => { const r = rect(e); return r.right > 1 && r.left < innerWidth - 1 && r.bottom > 0 && r.top < innerHeight * 4; };
  const cy = (e) => { const r = rect(e); return (r.top + r.bottom) / 2; };
  const cx = (e) => { const r = rect(e); return (r.left + r.right) / 2; };
  const root = (arg.scope && document.querySelector(arg.scope)) || document.querySelector('#fdt-container');
  const R = (status, detail) => ({ status, detail: detail || '' });
  const fdt = (s) => q(s, root || document).filter((e) => vis(e) && onScreen(e));

  // colour helpers for contrast
  const parse = (c) => { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const bgOf = (e) => { let n = e; while (n) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.05) return c; n = n.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

  // find the icon (svg) belonging to an input
  const iconOf = (inp) => {
    let host = inp.parentElement;
    for (let i = 0; i < 3 && host; i++, host = host.parentElement) {
      const s = q('svg, img', host).find((x) => !inp.contains(x) && rect(x).width > 0);
      if (s) return s;
    }
    return null;
  };

  switch (id) {
    case 'P-01': {
      const panel = document.getElementById('fdt-popup-theme-detect');
      if (!panel || getComputedStyle(panel).display === 'none') return R('na', 'Compatibility panel is not showing (theme already chosen).');
      const x = q('button, [role=button], [class*=close i], [aria-label*=close i]', panel).find((e) => /close|×|✕|x/i.test((e.getAttribute('aria-label') || '') + (e.innerText || '') + String(e.className)) || e.querySelector('svg'));
      if (!x || !vis(x)) return R('fail', 'Close (X) button is not visible on the panel.');
      const r = rect(x), p = rect(panel);
      const title = q('h1,h2,h3,strong,p', panel).find((e) => /compatib/i.test(e.innerText || ''));
      const probs = [];
      if (r.width > 48 || r.height > 48) probs.push(`X is too big (${Math.round(r.width)}x${Math.round(r.height)}px)`);
      if (r.width < 12 || r.height < 12) probs.push(`X is too small (${Math.round(r.width)}x${Math.round(r.height)}px)`);
      if (r.right > p.right + 1 || r.left < p.left - 1 || r.top < p.top - 1) probs.push('X sits outside the panel');
      if (title && Math.abs(cy(title) - cy(x)) > Math.max(T.alignPx * 4, 14)) probs.push(`X is ${Math.round(Math.abs(cy(title) - cy(x)))}px off the title line`);
      const svg = x.querySelector('svg');
      if (svg && (Math.abs(cx(svg) - cx(x)) > 3 || Math.abs(cy(svg) - cy(x)) > 3)) probs.push('X icon is off-centre in its box');
      return probs.length ? R('fail', probs.join('; ')) : R('pass');
    }

    case 'V-01': {
      const inputs = fdt('input[type=text], input[type=search], input:not([type])').filter((i) => i.placeholder);
      if (!inputs.length) return R('na', 'No search input with a placeholder found.');
      const probs = [];
      const c = document.createElement('canvas').getContext('2d');
      inputs.forEach((inp) => {
        const name = (inp.placeholder || '').slice(0, 30);
        const cs = getComputedStyle(inp);
        const ir = rect(inp);
        const textStart = ir.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
        const textEnd = ir.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
        const icon = iconOf(inp);
        if (!icon) { probs.push(`"${name}": no magnifier icon`); }
        else {
          const sr = rect(icon);
          const leftSide = cx(icon) < cx(inp);
          if (sr.width < 8 || sr.height < 8) probs.push(`"${name}": icon is tiny (${Math.round(sr.width)}px)`);
          if (leftSide && sr.right > textStart - 2 && sr.right > ir.left) probs.push(`"${name}": icon touches or overlaps the text (gap ${Math.round(textStart - sr.right)}px)`);
          // cropped: an ancestor with overflow hidden cuts the icon
          let a = icon.parentElement;
          for (let i = 0; i < 4 && a; i++, a = a.parentElement) {
            const o = getComputedStyle(a);
            if (/(hidden|clip)/.test(o.overflowX)) { const ar = rect(a); if (sr.left < ar.left - 0.5 || sr.right > ar.right + 0.5) { probs.push(`"${name}": icon is cropped on the ${sr.left < ar.left - 0.5 ? 'left' : 'right'}`); break; } }
          }
        }
        c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const w = c.measureText(inp.placeholder).width;
        if (w > textEnd - textStart + 1) probs.push(`"${name}": placeholder is cut (${Math.round(w)}px of text in ${Math.round(textEnd - textStart)}px)`);
      });
      return probs.length ? R('fail', probs.join('; ')) : R('pass', `${inputs.length} search box(es) checked`);
    }

    case 'V-02': {
      const items = fdt('.fdt-option-item-count');
      if (!items.length) return R('na', 'No value counts on screen (count display may be off).');
      const probs = [];
      items.slice(0, 60).forEach((cnt) => {
        const row = cnt.closest('filter-option-item, filter-group-item, label, li') || cnt.parentElement;
        const label = row && q('.search-filters__filter-option-item-label', row).find(vis);
        if (!label) return;
        const d = Math.abs(cy(cnt) - cy(label));
        const wrapped = rect(cnt).top > rect(label).bottom - 1;
        if (wrapped) probs.push(`"${(label.innerText || '').trim().slice(0, 20)}": count is on the next line`);
        else if (d > T.alignPx) probs.push(`"${(label.innerText || '').trim().slice(0, 20)}": count is ${Math.round(d)}px ${cy(cnt) < cy(label) ? 'above' : 'below'} the value`);
      });
      return probs.length ? R('fail', `${probs.length} of ${items.length} counts misaligned. ${probs.slice(0, 3).join('; ')}`) : R('pass', `${items.length} counts aligned`);
    }

    case 'V-03': {
      // the caller hovers a value first, then asks for this check
      const item = q('[data-tc-hover="1"]')[0];
      if (!item) return R('na', 'No value was hovered.');
      const cnt = q('.fdt-option-item-count', item).find(vis);
      if (!cnt) return R('na', 'Hovered value has no count.');
      const fg = parse(getComputedStyle(cnt).color);
      const bg = bgOf(cnt);
      const ratio = contrast(fg, bg);
      return ratio < T.contrastMin ? R('fail', `Count colour ${getComputedStyle(cnt).color} on ${`rgb(${bg.r},${bg.g},${bg.b})`} on hover: contrast ${ratio.toFixed(1)}:1 (needs ${T.contrastMin}:1)`) : R('pass', `contrast ${ratio.toFixed(1)}:1`);
    }

    case 'V-05': {
      // markup: li.fdt-group-value__parent-item > label > filter-group-item (checkbox + name) + button.fdt-group-value__toggle (svg caret)
      const toggles = q('.fdt-group-value__toggle').filter((e) => vis(e) && onScreen(e));
      const inDom = q('.fdt-group-value__toggle').length;
      if (!toggles.length) return R('na', inDom ? 'Merged groups exist but their filter box is collapsed, so they could not be measured.' : 'No merged value groups on this collection.');
      const probs = [];
      toggles.slice(0, 20).forEach((tg) => {
        const row = tg.closest('li') || tg.parentElement;
        const name = String(row.innerText || '').trim().split(/[\r\n]/)[0].slice(0, 20);
        const tr = rect(tg);
        const svg = q('svg', tg).find((e) => rect(e).width > 0);
        if (!svg || rect(svg).width < 4) probs.push('"' + name + '": the arrow icon does not show');
        else if (contrast(parse(getComputedStyle(svg).color) || { r: 0, g: 0, b: 0 }, bgOf(tg)) < 1.5) probs.push('"' + name + '": the arrow is the same colour as its button, so it cannot be seen');
        if (tr.width > 48 || tr.height > 48) probs.push('"' + name + '": the arrow button is oversized (' + Math.round(tr.width) + 'x' + Math.round(tr.height) + 'px)');
        const label = q('.search-filters__filter-option-item-label', row).find(vis);
        const box = q('input[type=checkbox]', row)[0];
        if (label && Math.abs(cy(tg) - cy(label)) > Math.max(T.alignPx * 2, 8)) probs.push('"' + name + '": the arrow is not on the same line as the name (wrapped)');
        if (label && box && rect(box).width > 0 && Math.abs(cy(box) - cy(label)) > Math.max(T.alignPx * 2, 8)) probs.push('"' + name + '": the checkbox is not on the same line as the name');
      });
      return probs.length ? R('fail', Array.from(new Set(probs)).slice(0, 4).join('; ')) : R('pass', toggles.length + ' group(s) checked');
    }

    case 'V-06': {
      // the caller scrolls down first
      const ours = q('fdt-scroll-to-top').find(vis);
      const probs = [];
      if (!ours) probs.push("Findter's scroll-to-top button is not visible after scrolling");
      else {
        const r = rect(ours);
        const btn = q('.search-filters__scroll-to-top-btn', ours)[0] || ours;
        const inner = q('svg, img', ours).find((e) => { const b2 = rect(e); return b2.width > 3 && b2.height > 3; });
        if (!inner) probs.push('Findter button shows only the circle, with no arrow inside');
        else if (inner.tagName.toLowerCase() === 'svg') {
          const cs = getComputedStyle(inner);
          const path = inner.querySelector('path');
          const ink = parse(path ? getComputedStyle(path).fill : cs.color) || parse(cs.color);
          if (ink && contrast(ink, bgOf(btn)) < 1.5) probs.push('the arrow is the same colour as the circle, so it cannot be seen');
        }
        if (r.width < 20) probs.push('Findter button is tiny (' + Math.round(r.width) + 'px)');
      }
      // the theme's own button counts only when it is on screen right now (a footer link below the fold does not)
      const theirs = q('[class*="scroll-to-top" i], [class*="back-to-top" i], [class*="scroll-top" i], [class*="backtotop" i], [id*="back-to-top" i], [id*="scroll-to-top" i], [aria-label*="back to top" i], [aria-label*="scroll to top" i]').filter((e) => {
        if (e.closest('fdt-scroll-to-top') || !vis(e)) return false;
        const r2 = rect(e);
        return r2.top >= 0 && r2.bottom <= innerHeight && r2.left >= 0 && r2.right <= innerWidth;
      });
      if (ours && theirs.length) probs.push("the theme's own scroll-to-top button shows at the same time");
      return probs.length ? R('fail', probs.join('; ')) : R('pass');
    }

    case 'V-07': {
      const inputs = fdt('filter-option-item input[type=checkbox]');
      if (!inputs.length) return R('na', 'No checklist values on screen.');
      const probs = [];
      inputs.slice(0, 40).forEach((inp) => {
        const row = inp.closest('filter-option-item') || inp.parentElement;
        const label = q('.search-filters__filter-option-item-label', row).find(vis);
        if (!label) return;
        // the visible box is often the label's ::before, or the input itself
        const pseudo = getComputedStyle(label, '::before');
        let w = parseFloat(pseudo.width), h = parseFloat(pseudo.height);
        if (!(w > 0 && h > 0) || pseudo.content === 'none') { const r = rect(inp); w = r.width; h = r.height; }
        if (w > 0 && h > 0 && Math.abs(w - h) > 1.5) probs.push(`"${(label.innerText || '').trim().slice(0, 20)}": checkbox is ${Math.round(w)}x${Math.round(h)}px (not square)`);
        const cnt = q('.fdt-option-item-count', row).find(vis);
        if (cnt && Math.abs(cy(cnt) - cy(label)) > T.alignPx) probs.push(`"${(label.innerText || '').trim().slice(0, 20)}": count is off the name's line`);
        const r2 = rect(inp);
        if (r2.width > 0 && Math.abs(cy(inp) - cy(label)) > Math.max(T.alignPx * 2, 8) && rect(inp).width > 6) probs.push(`"${(label.innerText || '').trim().slice(0, 20)}": checkbox is off the name's line`);
      });
      return probs.length ? R('fail', `${probs.length} problem(s). ${probs.slice(0, 3).join('; ')}`) : R('pass', `${inputs.length} checkbox(es) checked`);
    }

    case 'V-08': {
      const wrap = fdt('.search-filters__sorting')[0];
      if (!wrap) return R('na', 'No sort control on screen.');
      const label = q('.search-filters__sort-label', wrap).find(vis);
      const btn = q('.search-filters__sort-button', wrap).find(vis);
      const probs = [];
      if (!label || !(label.innerText || '').trim()) probs.push("'Sort by' label is missing");
      if (!btn) probs.push('sort dropdown is missing');
      if (label && btn) {
        const d = Math.abs(cy(label) - cy(btn));
        if (d > T.alignPx) probs.push(`Sort label is ${Math.round(d)}px off the dropdown line`);
      }
      const toolbar = wrap.parentElement;
      const filterBy = toolbar && q('.search-filters__open-wrapper, [class*=filter-toggle i]', toolbar).find(vis);
      if (filterBy && btn && Math.abs(cy(filterBy) - cy(btn)) > Math.max(T.alignPx * 3, 12)) probs.push('Filter by and Sort by are not on one line');
      // overlap between the sort control and a neighbour in the toolbar
      if (btn && toolbar) {
        const br = rect(btn);
        q(':scope > *', toolbar).filter((e) => vis(e) && !e.contains(btn) && !btn.contains(e) && e !== wrap && !wrap.contains(e)).forEach((e) => {
          const r = rect(e);
          const ox = Math.min(r.right, br.right) - Math.max(r.left, br.left), oy = Math.min(r.bottom, br.bottom) - Math.max(r.top, br.top);
          if (ox > 4 && oy > 4) probs.push(`sort dropdown overlaps another toolbar element (${Math.round(ox)}x${Math.round(oy)}px)`);
        });
      }
      return probs.length ? R('fail', probs.join('; ')) : R('pass');
    }

    case 'V-12': {
      // every Findter icon on screen: the dropdown arrows, the magnifier, the X, the scroll arrow...
      const icons = q('#fdt-container svg, fdt-scroll-to-top svg, fdt-search-suggestion-widget svg, svg.fdt-icon').filter((e) => e.tagName.toLowerCase() === 'svg' && vis(e));
      const uniq = Array.from(new Set(icons));
      if (!uniq.length) return R('na', 'No Findter icon is on screen to measure.');
      const probs = [];
      let min = 1e9, max = 0;
      uniq.forEach((svg, i) => {
        const r = rect(svg);
        min = Math.min(min, Math.min(r.width, r.height)); max = Math.max(max, Math.max(r.width, r.height));
        const name = (svg.getAttribute('aria-label') || (svg.closest('button, a') && (svg.closest('button, a').getAttribute('aria-label') || '')) || 'icon ' + (i + 1)).slice(0, 24);
        if (Math.max(r.width, r.height) > 40) probs.push('"' + name + '" is enlarged (' + Math.round(r.width) + 'x' + Math.round(r.height) + 'px, it should be 6 to 40px)');
        else if (Math.max(r.width, r.height) < 6) probs.push('"' + name + '" is almost invisible (' + Math.round(r.width) + 'x' + Math.round(r.height) + 'px)'); // a small chevron such as 8x5 is normal
        else if (Math.max(r.width, r.height) / Math.min(r.width, r.height) > 3) probs.push('"' + name + '" is stretched (' + Math.round(r.width) + 'x' + Math.round(r.height) + 'px)');
        if (!svg.querySelector('path, circle, line, polyline, polygon, rect, ellipse, use')) probs.push('"' + name + '" is empty (the icon has no shape)');
        const cs = getComputedStyle(svg);
        if (cs.fill === 'none' && cs.stroke === 'none' && !svg.querySelector('[fill]:not([fill=none]), [stroke]:not([stroke=none])')) probs.push('"' + name + '" has no fill and no line, so it cannot be seen');
      });
      return probs.length ? R('fail', Array.from(new Set(probs)).slice(0, 4).join('; ')) : R('pass', uniq.length + ' Findter icon(s) measured: all between ' + Math.round(min) + ' and ' + Math.round(max) + 'px, none stretched or empty.');
    }

    case 'V-09':
    case 'M-04': {
      // the caller clicked "Choose options" on a card and marked the card
      const card = q('[data-tc-card="1"]')[0];
      if (!card) return R('na', "No product card with 'Choose options' on this collection.");
      const cr = rect(card);
      const probs = [];
      const btns = q('button, a.button, [role=button]', card).filter(vis);
      btns.forEach((b) => { const r = rect(b); if (r.right > cr.right + 2 || r.left < cr.left - 2) probs.push(`"${(b.innerText || '').trim().slice(0, 18)}" button spills ${Math.round(Math.max(r.right - cr.right, cr.left - r.left))}px outside the card`); });
      // A real option is a button the shopper presses: a pill or a swatch, which has its own border or background.
      // A caption line such as "Size: 10" or "Title: Sample Selling Plans" has neither, and is not measured.
      const boxed = (e) => {
        const cs = getComputedStyle(e);
        const bw = ['Top', 'Right', 'Bottom', 'Left'].reduce((m, side) => Math.max(m, parseFloat(cs['border' + side + 'Width']) || 0), 0);
        const bg = cs.backgroundColor;
        const hasBg = !!bg && bg !== 'transparent' && !/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)/.test(bg);
        return (bw >= 1 && cs.borderStyle !== 'none') || hasBg || cs.backgroundImage !== 'none';
      };
      const action = /add to cart|view full|view details?|quick|close|choose options/i;
      let cand = q('[class*="variant" i] label, [class*="option" i] label, [class*="variant" i] button, [class*="option" i] button, [class*="swatch" i], [class*="option-value" i], [role=radio]', card)
        .filter((e) => vis(e) && (e.innerText || '').trim() && (e.innerText || '').trim().length <= 30 && !action.test((e.innerText || '').trim()) && rect(e).width <= 220 && rect(e).height <= 90 && boxed(e));
      cand = cand.filter((e) => !cand.some((o) => o !== e && e.contains(o))); // the inner-most box only
      const opts = cand;
      opts.slice(0, 12).forEach((o) => {
        // where does the text really sit in its box? (the computed text-align is "left"/"start" almost everywhere by default)
        const rg = document.createRange();
        rg.selectNodeContents(o);
        const tr = rg.getBoundingClientRect(), or = rect(o);
        if (!(tr.width > 0 && or.width > 0)) return;
        const dx = Math.abs((tr.left + tr.right) / 2 - (or.left + or.right) / 2), dy = Math.abs((tr.top + tr.bottom) / 2 - (or.top + or.bottom) / 2);
        const label = (o.innerText || '').trim().slice(0, 12);
        if (or.width > tr.width + 12 && dx > T.alignPx + 2) probs.push(`option "${label}": the text is ${Math.round(dx)}px off-centre sideways (aligned ${(tr.left + tr.right) / 2 < (or.left + or.right) / 2 ? 'left' : 'right'})`);
        else if (or.height > tr.height + 12 && dy > T.alignPx + 2) probs.push(`option "${label}": the text is ${Math.round(dy)}px off-centre vertically (aligned ${(tr.top + tr.bottom) / 2 < (or.top + or.bottom) / 2 ? 'top' : 'bottom'})`);
      });
      const panel = q('[class*="choose" i], [class*="variant" i], [class*="quick-add" i]', card).find((e) => vis(e) && rect(e).height > 40);
      if (panel && Number(getComputedStyle(panel).opacity) < 0.9) probs.push('options panel is see-through (opacity ' + getComputedStyle(panel).opacity + ')');
      return probs.length ? R('fail', Array.from(new Set(probs)).slice(0, 4).join('; ')) : R('pass');
    }

    case 'V-11': {
      const chips = fdt('.search-filters__filter-active-tag-item');
      if (!chips.length) return R('na', 'No selected-value chip on screen.');
      const probs = [];
      chips.slice(0, 6).forEach((ch) => {
        const parts = q('.search-filters__filter-active-tag-item-label, .search-filters__filter-active-tag-item-content, svg', ch).filter(vis);
        const ys = parts.map(cy);
        if (ys.length > 1 && Math.max.apply(null, ys) - Math.min.apply(null, ys) > T.alignPx + 1) probs.push(`chip "${(ch.innerText || '').trim().slice(0, 24)}": parts are ${Math.round(Math.max.apply(null, ys) - Math.min.apply(null, ys))}px apart vertically`);
        if (!q('svg, button, [class*=remove i], [class*=close i]', ch).some(vis)) probs.push(`chip "${(ch.innerText || '').trim().slice(0, 24)}": no X icon`);
        const r = rect(ch);
        const content = q('.search-filters__filter-active-tag-item-content', ch).find(vis);
        if (content && Math.abs(cy(content) - (r.top + r.bottom) / 2) > T.alignPx + 1) probs.push(`chip "${(ch.innerText || '').trim().slice(0, 24)}": text is off the chip's centre`);
      });
      return probs.length ? R('fail', probs.join('; ')) : R('pass');
    }

    case 'O-01': {
      const b = q('.search-filters__open-wrapper').find(vis);
      if (!b) return R('fail', "'Filter by' button is not visible.");
      const icon = q('svg, img', b).find((e) => rect(e).width > 3);
      const txt = q('span, p, div', b).find((e) => e.children.length === 0 && (e.innerText || '').trim());
      const probs = [];
      if (!icon) probs.push('icon is missing');
      if (icon && txt && Math.abs(cy(icon) - cy(txt)) > T.alignPx + 1) probs.push(`icon is ${Math.round(Math.abs(cy(icon) - cy(txt)))}px off the text`);
      return probs.length ? R('fail', probs.join('; ')) : R('pass');
    }

    case 'O-02':
    case 'M-02': {
      const opts = q('filter-option, fdt-filter-option').filter((e) => { const r = rect(e); return r.width > 0 && r.height > 0 && r.left >= -5 && r.right <= innerWidth + 5; });
      return opts.length ? R('pass', `${opts.length} filter group(s) visible in the drawer`) : R('fail', 'Drawer did not open or shows no filter options.');
    }

    case 'O-03': {
      // drawer must be open
      const scope = q('filter-option, fdt-filter-option').find((e) => vis(e) && onScreen(e));
      if (!scope) return R('na', 'Drawer is not open.');
      const xs = q('.search-filters__close, [class*="close" i], [aria-label*="close" i]').filter((e) => vis(e) && onScreen(e) && !e.closest('.search-filters__filter-active-tag-item') && !e.closest('#fdt-popup-theme-detect') && rect(e).width <= 150 && rect(e).height <= 150);
      const x = xs.find((e) => e.querySelector('svg, img') || e.tagName === 'BUTTON') || xs[0];
      if (!x) return R('fail', 'Drawer close (X) button is not visible.');
      const r = rect(x);
      const probs = [];
      if (r.width > 80 || r.height > 80) probs.push(`X box is too big (${Math.round(r.width)}x${Math.round(r.height)}px)`);
      if (r.width < 16 || r.height < 16) probs.push(`X box is too small (${Math.round(r.width)}x${Math.round(r.height)}px)`);
      const ic = q('svg, img', x)[0] || (x.matches('svg') ? x : null);
      if (!ic || rect(ic).width < 4) probs.push('X icon does not show inside its box');
      else {
        const dx = Math.abs(cx(ic) - cx(x)), dy = Math.abs(cy(ic) - cy(x));
        if (dx > 3 || dy > 3) probs.push(`X icon is off-centre in its box (${Math.round(dx)}px, ${Math.round(dy)}px)`);
        if (rect(ic).width > r.width + 2) probs.push('X icon is bigger than its box');
      }
      if (r.right > innerWidth + 1 || r.top < -1) probs.push('X button is partly off-screen');
      return probs.length ? R('fail', probs.join('; ')) : R('pass');
    }

    case 'O-04':
    case 'M-03': {
      const vals = q('.fdt-range-value').filter((e) => vis(e) && onScreen(e));
      if (!vals.length) return R('na', 'No price From/To fields on screen (drawer closed or no price filter).');
      const probs = [];
      vals.forEach((v) => {
        q('input', v).forEach((i) => { if (i.scrollWidth > i.clientWidth + 1) probs.push(`price field is cut: "${i.value}" does not fit`); });
        q('label, span, p', v).forEach((l) => {
          if (!vis(l) || l.children.length) return;
          if (l.scrollWidth > l.clientWidth + 1 && /(hidden|clip)/.test(getComputedStyle(l).overflowX)) probs.push(`label "${(l.innerText || '').trim().slice(0, 12)}" is cut`);
          const near = q('input', v)[0];
          if (near) { const a = rect(l), b = rect(near); const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); if (ox > 1 && oy > 1) probs.push(`label "${(l.innerText || '').trim().slice(0, 12)}" overlaps its field`); }
        });
      });
      const texts = vals.map((v) => (v.innerText || '').toLowerCase()).join(' ');
      if (!/from/.test(texts) || !/to/.test(texts)) probs.push("'From' / 'To' text is not shown");
      return probs.length ? R('fail', Array.from(new Set(probs)).slice(0, 4).join('; ')) : R('pass');
    }

    case 'M-01': {
      const ours = q('.search-filters__open-wrapper').find(vis);
      if (!ours) return R('fail', "Findter's 'Filter and sort' button is not visible on mobile.");
      const theme = q('details[id*="filter" i] summary, [class*="facets" i] button, [class*="mobile-facets" i], [class*="filter-button" i]').filter((e) => vis(e) && !e.closest('#fdt-container'));
      return theme.length ? R('fail', "the theme's own Filter/Sort control is shown next to Findter's") : R('pass');
    }

    case 'M-02b': {
      // sort option text alignment inside the open mobile drawer
      const labels = q('.search-filters__sort-option-item-label').filter(vis);
      if (!labels.length) return R('na', 'Sort options are not on screen.');
      const bad = labels.filter((l) => { const li = l.closest('li') || l.parentElement; return rect(l).left - rect(li).left > rect(li).width * 0.35; });
      return bad.length ? R('fail', `${bad.length} sort option(s) are aligned to the right, leaving a gap on the left`) : R('pass');
    }

    case 'G-01': {
      const probs = [];
      if (!root || !vis(root)) return R('fail', 'Findter container (#fdt-container) is not on the page.');
      const cards = q('.search-filters__product-item').filter(vis);
      if (!cards.length) probs.push(/nothing matches/i.test(document.body.innerText) ? 'collection has no products to show (no data), check the collection' : 'no product cards are visible');
      const noImg = cards.filter((c) => !c.querySelector('img')).length;
      if (cards.length && noImg === cards.length) probs.push('no card has an image');
      const broken = q('.search-filters__product-item img').filter((i) => vis(i) && i.complete && i.naturalWidth === 0).length;
      if (broken) probs.push(`${broken} broken image(s)`);
      if (cards.length && !cards.some((c) => /\d/.test(c.innerText))) probs.push('no card shows a price');
      return probs.length ? R('fail', probs.join('; ')) : R('pass', `${cards.length} card(s) shown`);
    }

    case 'G-02':
      return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 ? R('fail', `page scrolls sideways (${document.documentElement.scrollWidth}px wide in a ${document.documentElement.clientWidth}px window)`) : R('pass');

    default:
      return R('na', 'No measurement for ' + id);
  }
}

// Search suggestion measurement (desktop + mobile), run after the caller typed the keyword.
function measureSuggestion(arg) {
  const T = Object.assign({ widthDiffPct: 10, searchGapPx: 12 }, arg.opts || {});
  const q = (s, r) => Array.from((r || document).querySelectorAll(s));
  const rect = (e) => e.getBoundingClientRect();
  const vis = (e) => { if (!e) return false; const r = rect(e); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0; };
  // The <fdt-search-suggestion-widget> tag itself has no size of its own: what the shopper sees is its panel inside.
  const widgetTag = q('fdt-search-suggestion-widget')[0] || null;
  const widget = q('fdt-search-suggestion-overview').find(vis) || q('fdt-search-suggestion-widget').find((w) => vis(w) || q('*', w).some((c) => vis(c) && rect(c).height > 20 && rect(c).width > 60)) || null;
  const hiddenCopy = !!widgetTag && !widget && !!widgetTag.closest('form') && !vis(widgetTag.closest('form'));
  const themeBoxes = q('[class*="predictive" i], [class*="suggestion" i], [id*="predictive" i], [id*="suggestion" i], [class*="search-results" i]').filter((e) => vis(e) && !e.closest('fdt-search-suggestion-widget') && !e.querySelector('fdt-search-suggestion-widget') && rect(e).height > 60 && q('a[href*="/products/"]', e).some(vis));
  const themeInput = q('input[type=search], input[name=q]').find((e) => vis(e) && !e.closest('fdt-search-suggestion-widget') && !e.closest('#fdt-container'));
  const embedLoaded = !!document.querySelector('fdt-search-suggestion-widget, script[src*="fdt-search-suggestion"], link[href*="fdt-search-suggestion"], script[src*="fdt-suggestion"]');
  const out = { embedLoaded: embedLoaded, widgetInPage: !!widgetTag, hiddenCopy: hiddenCopy, widget: !!widget, watermark: false, themeBoxes: themeBoxes.length, themeInput: !!themeInput, themeInputValue: themeInput ? themeInput.value : '', widgetWidth: 0, inputWidth: 0, gap: null, covered: false, backArrow: false, searchInputs: 0 };
  if (widget) {
    const scope = widget.closest('fdt-search-suggestion') || widget;
    out.watermark = /powered by\s*findter/i.test(widget.innerText || '') || q('fdt-watermark, [class*="watermark" i], [class*="powered" i]', scope).some((e) => vis(e) && /powered by\s*findter/i.test(e.innerText || ''));
    const wr = rect(widget);
    out.widgetWidth = Math.round(wr.width);
    const cx = Math.round((wr.left + wr.right) / 2), cyy = Math.round(wr.top + Math.min(40, wr.height / 2));
    const hit = document.elementFromPoint(cx, cyy);
    out.covered = !!hit && !widget.contains(hit) && hit !== widget;
    if (themeInput) {
      const ir = rect(themeInput);
      out.inputWidth = Math.round(ir.width);
      out.gap = Math.round(wr.top - ir.bottom);
      out.widthDiffPct = Math.round(Math.abs(wr.width - ir.width) / ir.width * 100);
      out.shiftPx = Math.round(Math.abs((wr.left + wr.right) / 2 - (ir.left + ir.right) / 2));
    }
    // Findter's back arrow is the close button of its panel, drawn as an arrow, on the left of the search bar
    out.backArrow = q('.search-filters__search-suggestion-close-button, [class*="suggestion" i][class*="close" i], [class*="suggestion" i][class*="back" i]', widget.closest('form') || widget.parentElement || document).some((e) => vis(e) && !!e.querySelector('svg'));
  }
  // search bars the shopper can see on screen: not the filter boxes of the collection ("Search in this collection", "Search filter value")
  out.searchInputs = q('input[type=search], input[name=q], input[placeholder*="search" i]').filter((e) => vis(e) && !e.closest('#fdt-container') && rect(e).bottom > 0 && rect(e).top < window.innerHeight).length;
  return out;
}

module.exports = { measure, measureSuggestion };
