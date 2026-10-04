// The layout of the bucket map, shared by the page script (assets/inspect.ts), which draws it on a canvas, and by the
// SVG export and the timeline (inspect/map-svg.ts), which run the same code on the server. It is plain ES2020 in a
// String.raw template, like the page script, so it must not contain backticks or dollar-brace pairs. It defines
// functions and constants only and touches no browser API, so the server can evaluate it with `new Function`.
export const MAP_CORE_JS = String.raw`
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  const PAL = {
    phos: '#3dff74', hi: '#b8ffcc', text: '#b4f5c6', dim: '#6cbf86', faint: '#2f7a48',
    line: '#2b8a4c', amber: '#ffc04d', red: '#ff6e61', cyan: '#8ef9ff', ink: '#021a0a', bar: '#06200e'
  };
  /* the timeline colors a past approval by what changed: added, changed, removed or the same as the approval before */
  const SIT = { ok: PAL.phos, lock: PAL.amber, violation: PAL.red, added: PAL.phos, changed: PAL.amber, removed: PAL.red, same: PAL.dim };
  const SLOP = '~*%&#{}()<>;=+?!$^:./|';
  const FONT = '"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, "DejaVu Sans Mono", Menlo, monospace';

  function hash(a, b) {
    let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function strHash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h | 0;
  }

  class Grid {
    constructor(cols, rows) {
      this.cols = cols; this.rows = rows;
      const n = cols * rows;
      this.ch = new Array(n).fill('');
      this.fg = new Array(n).fill('');
      this.bg = new Array(n).fill('');
      this.al = new Float32Array(n);
      this.mk = new Uint8Array(n);
      this.st = new Uint8Array(n);
    }
    idx(x, y) { return (x < 0 || y < 0 || x >= this.cols || y >= this.rows) ? -1 : y * this.cols + x; }
    put(x, y, c, fg, al, bg) {
      const i = this.idx(x, y);
      if (i < 0) return;
      this.ch[i] = c; this.fg[i] = fg; this.al[i] = al === undefined ? 1 : al; this.mk[i] = 0; this.bg[i] = bg || '';
    }
    text(x, y, s, fg, al, bg, maxX) {
      for (let k = 0; k < s.length; k++) {
        if (maxX !== undefined && x + k > maxX) break;
        if (s[k] === ' ' && !bg) { const i = this.idx(x + k, y); if (i >= 0) { this.ch[i] = ''; this.mk[i] = 0; this.bg[i] = ''; } }
        else this.put(x + k, y, s[k], fg, al, bg);
      }
    }
    fillBg(x0, y0, x1, y1, bg, al) {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = this.idx(x, y);
        if (i >= 0) { this.bg[i] = bg; if (!this.ch[i] && !this.mk[i]) this.al[i] = al; }
      }
    }
    link(a, b, st, fg, al) {
      const [x0, y0] = a, [x1, y1] = b;
      let ba, bb;
      if (x1 > x0) { ba = 2; bb = 8; } else if (x1 < x0) { ba = 8; bb = 2; } else if (y1 > y0) { ba = 4; bb = 1; } else { ba = 1; bb = 4; }
      const mark = (i, bit) => { if (i < 0 || this.ch[i]) return; this.mk[i] |= bit; this.st[i] = st; this.fg[i] = fg; this.al[i] = al; };
      mark(this.idx(x0, y0), ba);
      mark(this.idx(x1, y1), bb);
    }
    frame(R, st, fg, al) {
      const [x0, y0, x1, y1] = R;
      for (let x = x0; x <= x1; x++) for (const y of [y0, y1]) { const i = this.idx(x, y); if (i >= 0) { this.mk[i] = 0; this.ch[i] = ''; } }
      for (let y = y0; y <= y1; y++) for (const x of [x0, x1]) { const i = this.idx(x, y); if (i >= 0) { this.mk[i] = 0; this.ch[i] = ''; } }
      for (let x = x0; x < x1; x++) { this.link([x, y0], [x + 1, y0], st, fg, al); this.link([x, y1], [x + 1, y1], st, fg, al); }
      for (let y = y0; y < y1; y++) { this.link([x0, y], [x0, y + 1], st, fg, al); this.link([x1, y], [x1, y + 1], st, fg, al); }
    }
    hline(x0, x1, y, st, fg, al) { for (let x = x0; x < x1; x++) this.link([x, y], [x + 1, y], st, fg, al); }
  }

  /* ---- layout in cells ---- */

  const GAP = 1;
  const CELLS_PER_FILE = 6;

  /* text inside a box: only what the server asks for (the label of a map rebuilt from a lock, the count of buckets a
     cut map leaves out). Files show in the size of the box; the numbers are in the tooltip and the side panel */
  function codeLines(b) {
    return (b.code ? [{ text: b.code, tone: 'dim' }] : []).concat(b.lines || []);
  }
  /* buckets that use this one and buckets it depends on, for the tooltip */
  function insOf(b) { return b.ins !== undefined ? b.ins : b.dependents.length; }
  function outsOf(b) { return b.outs !== undefined ? b.outs : b.dependsOn.length; }
  function fileRows(b, w) { return b.files > 0 ? clamp(Math.ceil(Math.min(b.files * CELLS_PER_FILE, 900) / Math.max(1, w)), 1, 30) : 1; }
  function natProject(p) { return clamp(Math.max(p.name.length, 9) + 8, 20, 34); }
  function natCode(b, maxW) {
    const cells = Math.min(b.files * CELLS_PER_FILE, 900);
    let w = Math.max(0, Math.max.apply(null, codeLines(b).map((l) => l.text.length + 1).concat([0])), Math.ceil(Math.sqrt(cells * 3)) + 2);
    if (b.projects.length) {
      const row = b.projects.reduce((n, p) => n + natProject(p), 0) + GAP * (b.projects.length - 1);
      w = Math.max(w, row);
    }
    return clamp(w, 12, maxW);
  }
  function titleOf(b) { return b.name + '/'; }
  /* one compact badge: a cross for violations, a ring for orphan contracts, a tilde for lock differences */
  function badgeOf(b) {
    const parts = [];
    const orphans = b.orphans || 0;
    if (b.violations - orphans > 0) parts.push('✗' + (b.violations - orphans));
    if (orphans > 0) parts.push('○' + orphans);
    if (b.lockChanges) parts.push('~' + b.lockChanges);
    return parts.length ? ' ' + parts.join(' ') + ' ' : '';
  }
  function natBucket(b, maxW, tree) {
    const title = titleOf(b).length + badgeOf(b).length + 6;
    const inner = maxW - 4;
    const items = [natCode(b, inner)].concat(b.children.map((c) => natBucket(tree.get(c), inner, tree)));
    const row = items.reduce((n, w) => n + w, 0) + GAP * (items.length - 1);
    const dmz = b.children.length ? ('dmz/ ' + b.contracts + ' contracts').length + 6 : 0;
    const w = row + 4 <= maxW ? Math.max(title, row + 4, dmz) : maxW;
    return clamp(w, 16, maxW);
  }

  /* shelf packing: items with natural widths into rows of width W, each row stretched to fill W */
  function shelves(nats, W) {
    const rows = [];
    let cur = [], used = 0;
    nats.forEach((w, i) => {
      const need = cur.length ? used + GAP + w : w;
      if (cur.length && need > W) { rows.push(cur); cur = []; used = 0; }
      used = cur.length ? used + GAP + w : w;
      cur.push(i);
    });
    if (cur.length) rows.push(cur);
    return rows.map((row) => {
      const sum = row.reduce((n, i) => n + nats[i], 0);
      const extra = W - sum - GAP * (row.length - 1);
      const widths = row.map((i) => nats[i] + Math.floor((extra * nats[i]) / sum));
      const fix = W - widths.reduce((n, w) => n + w, 0) - GAP * (row.length - 1);
      widths[widths.length - 1] += fix;
      return { items: row, widths };
    });
  }

  function layoutMap(data, cols) {
    const tree = new Map(data.buckets.map((b) => [b.path, b]));
    const boxes = [];
    const codes = new Map();
    const strips = new Map();
    const projects = [];
    function placeProject(p, x, y, w) {
      const R = { kind: 'project', p, x, y, w, h: 5 };
      projects.push(R);
      return 5;
    }
    function placeCode(b, x, y, w) {
      const lines = codeLines(b);
      /* the files make the box bigger: wider in natCode, taller here */
      const fill = fileRows(b, w);
      let h = Math.max(1, lines.length + fill);
      if (b.projects.length) {
        const rows = shelves(b.projects.map(natProject), w);
        let yy = y + lines.length;
        rows.forEach((row) => {
          let xx = x;
          row.items.forEach((i, k) => { placeProject(b.projects[i], xx, yy, row.widths[k]); xx += row.widths[k] + GAP; });
          yy += 5 + GAP;
        });
        h = yy - y - GAP;
      }
      const R = { kind: 'code', b, x, y, w, h, lines };
      codes.set(b.path, R);
      return h;
    }
    function placeBucket(b, x, y, w) {
      const R = { kind: 'bucket', b, x, y, w, h: 0 };
      boxes.push(R);
      const iw = w - 4;
      const kinds = [{ kind: 'code' }].concat(b.children.map((c) => ({ kind: 'bucket', b: tree.get(c) })));
      const nats = kinds.map((k) => (k.kind === 'code' ? natCode(b, iw) : natBucket(k.b, iw, tree)));
      let cursor = y + 1;
      shelves(nats, iw).forEach((row, r) => {
        if (r > 0) cursor += 1;
        let xx = x + 2;
        let rowH = 0;
        const placed = [];
        row.items.forEach((i, k) => {
          const width = row.widths[k];
          const h = kinds[i].kind === 'code' ? placeCode(b, xx, cursor, width) : placeBucket(kinds[i].b, xx, cursor, width);
          placed.push(kinds[i].kind === 'code' ? codes.get(b.path) : boxes.find((bx) => bx.b === kinds[i].b));
          rowH = Math.max(rowH, h);
          xx += width + GAP;
        });
        placed.forEach((P) => { P.h = rowH; });
        cursor += rowH;
      });
      if (b.children.length) {
        strips.set(b.path, { x: x + 2, y: cursor, w: iw, h: 1, b });
        cursor += 1;
      }
      R.h = cursor - y + 1;
      return R.h;
    }
    const root = data.buckets[0];
    const rows = root ? placeBucket(root, 0, 0, cols) : 1;
    return { cols, rows, boxes, codes, strips, projects, tree };
  }

  /* ---- treemap: every bucket at once, area by file count (a bucket's own files plus everything below it) ---- */

  /* squarified treemap of weighted items in a rectangle of cells; a cell is twice as tall as wide, so the shapes are
     computed in square units and rounded back to cells */
  function squarify(items, x, y, w, h) {
    const total = items.reduce((n, it) => n + it.weight, 0);
    if (total <= 0 || w <= 0 || h <= 0) return [];
    const scale = (w * h * 2) / total;
    const list = items.map((it) => ({ item: it, a: it.weight * scale })).sort((p, q) => q.a - p.a);
    const out = [];
    let rx = 0, ry = 0, rw = w, rh = h * 2;
    const worst = (row, side) => {
      const sum = row.reduce((n, r) => n + r.a, 0);
      let m = 0;
      for (const r of row) m = Math.max(m, (side * side * r.a) / (sum * sum), (sum * sum) / (side * side * r.a));
      return m;
    };
    const flush = (row) => {
      const sum = row.reduce((n, r) => n + r.a, 0);
      if (rw >= rh) {
        const sw = sum / rh;
        let yy = ry;
        for (const r of row) { const hh = r.a / sw; out.push({ item: r.item, fx: rx, fy: yy, fw: sw, fh: hh }); yy += hh; }
        rx += sw; rw -= sw;
      } else {
        const sh = sum / rw;
        let xx = rx;
        for (const r of row) { const ww = r.a / sh; out.push({ item: r.item, fx: xx, fy: ry, fw: ww, fh: sh }); xx += ww; }
        ry += sh; rh -= sh;
      }
    };
    let row = [];
    for (const r of list) {
      const side = Math.min(rw, rh);
      if (!row.length || worst(row.concat([r]), side) <= worst(row, side)) row.push(r);
      else { flush(row); row = [r]; }
    }
    if (row.length) flush(row);
    return out.map((o) => {
      const x0 = Math.round(x + o.fx), x1 = Math.round(x + o.fx + o.fw);
      const y0 = Math.round(y + o.fy / 2), y1 = Math.round(y + (o.fy + o.fh) / 2);
      return { item: o.item, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    });
  }

  function layoutTreemap(data, cols, minRows) {
    const tree = new Map(data.buckets.map((b) => [b.path, b]));
    const weights = new Map();
    const weightOf = (b) => {
      if (weights.has(b.path)) return weights.get(b.path);
      let n = Math.max(1, b.files);
      for (const c of b.children) { const k = tree.get(c); if (k) n += weightOf(k); }
      weights.set(b.path, n);
      return n;
    };
    const below = (b) => b.children.reduce((n, c) => { const k = tree.get(c); return k ? n + 1 + below(k) : n; }, 0);
    const boxes = [];
    const root = data.buckets[0];
    /* about 16 cells per file, so a bucket of a few files still has room for its name */
    const rows = root ? Math.max(clamp(Math.ceil((weightOf(root) * 16) / cols) + 6, 18, 900), minRows || 0) : 1;
    function place(b, x, y, w, h) {
      const R = { kind: 'bucket', b, x, y, w, h, hidden: 0 };
      boxes.push(R);
      const kids = b.children.map((c) => tree.get(c)).filter(Boolean);
      if (!kids.length) return;
      const ix = x + 1, iy = y + 1, iw = w - 2, ih = h - 2;
      if (iw < 4 || ih < 1) { R.hidden = below(b); return; }
      const items = [{ own: true, weight: Math.max(1, b.files) }].concat(kids.map((k) => ({ b: k, weight: weightOf(k) })));
      for (const r of squarify(items, ix, iy, iw, ih)) {
        if (r.item.own) continue;
        /* one column between neighbours, so two frames never touch */
        const gap = r.x + r.w < ix + iw ? 1 : 0;
        if (r.w - gap >= 3 && r.h >= 2) place(r.item.b, r.x, r.y, r.w - gap, r.h);
        else R.hidden += 1 + below(r.item.b);
      }
    }
    if (root) place(root, 0, 0, cols, rows);
    return { cols, rows, boxes, codes: new Map(), strips: new Map(), projects: [], tree, treemap: true };
  }

  /* the layout the data asks for: nested boxes (the whole tree or one level) or the treemap */
  function layoutFor(data, cols) {
    return data.mode === 'treemap' ? layoutTreemap(data, cols) : layoutMap(data, cols);
  }

  /* ---- drawing the grid ---- */

  function drawMap(L, data, ui) {
    if (L.treemap) return drawTreemap(L, data, ui);
    const g = new Grid(L.cols, L.rows);
    const selected = data.selected;
    /* one single frame per bucket in the color of its situation; the selected one is thick and lit */
    for (const R of L.boxes) {
      const b = R.b;
      const isSel = b.path === selected;
      const isHover = ui.hover && ui.hover.kind === 'bucket' && ui.hover.b === b;
      const color = isSel ? PAL.hi : SIT[b.situation];
      g.frame([R.x, R.y, R.x + R.w - 1, R.y + R.h - 1], isSel ? 3 : 1, color, isSel || isHover ? 1 : 0.8);
      const badge = badgeOf(b);
      const title = ' ' + titleOf(b) + ' ';
      const fits = badge && R.x + 2 + title.length + badge.length < R.x + R.w - 1;
      const maxX = R.x + R.w - 2 - (fits ? badge.length : 0);
      if (isSel) g.text(R.x + 2, R.y, title, PAL.ink, 1, PAL.hi, maxX);
      else g.text(R.x + 2, R.y, title, isHover ? PAL.hi : color, 1, '', maxX);
      /* where the whole name is drawn, for the labels of the selection */
      R.nameAt = R.x + 1 + title.length <= maxX ? { x: R.x + 2, y: R.y, len: title.length, bare: false } : null;
      if (fits) g.text(R.x + R.w - 2 - badge.length, R.y, badge, PAL.ink, 1, SIT[b.situation]);
      if (isSel) g.fillBg(R.x + 1, R.y + 1, R.x + R.w - 2, R.y + R.h - 2, PAL.bar, 0.55);
    }
    /* the bucket's own code is one quiet line of text, plus the summary lines the server adds to a collapsed box */
    const codeColor = (data.codeTone && PAL[data.codeTone]) || PAL.dim;
    for (const R of L.codes.values()) {
      R.lines.forEach((line, i) => {
        if (i >= R.h) return;
        const tone = i === 0 && R.b.code ? codeColor : PAL[line.tone] || PAL.text;
        g.text(R.x, R.y + i, line.text.slice(0, Math.max(0, R.w)), tone, i === 0 ? 0.9 : 1);
      });
    }
    /* the dmz/ summary: dim when its contracts are fine, in the problem color when one is not */
    for (const R of L.strips.values()) {
      const b = R.b;
      const quiet = b.dmz === 'ok' || b.dmz === 'same';
      const tone = quiet ? PAL.dim : SIT[b.dmz];
      const label = 'dmz/ ' + b.contracts + (b.contracts === 1 ? ' contract, ' : ' contracts, ') + b.symbols + (b.symbols === 1 ? ' symbol' : ' symbols');
      g.text(R.x, R.y, label.length < R.w ? label : 'dmz/', tone, quiet ? 0.85 : 1, '', R.x + R.w - 1);
    }
    for (const R of L.projects) {
      const p = R.p;
      const isHover = ui.hover && ui.hover.kind === 'project' && ui.hover.p === p;
      g.frame([R.x, R.y, R.x + R.w - 1, R.y + R.h - 1], 1, PAL.cyan, isHover ? 1 : 0.85);
      g.text(R.x + 2, R.y, ' project ', PAL.ink, 1, PAL.cyan, R.x + R.w - 2);
      g.put(R.x + 2, R.y + 1, '●', SIT[p.situation], 1);
      g.text(R.x + 4, R.y + 1, p.name, isHover ? PAL.hi : PAL.text, 1, '', R.x + R.w - 2);
      g.text(R.x + 2, R.y + 2, p.buckets + (p.buckets === 1 ? ' bucket' : ' buckets'), PAL.dim, 1, '', R.x + R.w - 2);
      g.text(R.x + 2, R.y + 3, 'enter >', isHover ? PAL.amber : PAL.dim, 1, '', R.x + R.w - 2);
    }
    return g;
  }

  /* the treemap: frames in the situation color, a light tint for leaves, a name only where it fits */
  function drawTreemap(L, data, ui) {
    const g = new Grid(L.cols, L.rows);
    for (const R of L.boxes) {
      const b = R.b;
      const isSel = b.path === data.selected;
      const isHover = ui.hover && ui.hover.kind === 'bucket' && ui.hover.b === b;
      const tone = SIT[b.situation];
      const leaf = !b.children.length || R.hidden > 0;
      if (isSel || isHover) g.fillBg(R.x + 1, R.y + 1, R.x + R.w - 2, R.y + R.h - 2, PAL.bar, isSel ? 0.8 : 0.5);
      g.frame([R.x, R.y, R.x + R.w - 1, R.y + R.h - 1], isSel ? 3 : 1, isSel ? PAL.hi : tone, isSel || isHover ? 1 : 0.7);
      const title = titleOf(b);
      const badge = badgeOf(b).trim();
      const ink = isSel ? PAL.ink : isHover ? PAL.hi : tone;
      let next = R.y + 1;
      R.nameAt = null;
      if (R.w >= title.length + 4) {
        R.nameAt = { x: R.x + 1, y: R.y, len: title.length + 2, bare: false };
        /* the name sits on the top wall, like the nested map */
        g.text(R.x + 1, R.y, ' ' + title + ' ', ink, 1, isSel ? PAL.hi : '', R.x + R.w - 2);
        if (badge && R.w >= title.length + badge.length + 7) g.text(R.x + R.w - badge.length - 4, R.y, ' ' + badge + ' ', PAL.ink, 1, tone);
      } else if (leaf && R.w >= title.length + 1 && R.h >= 3) {
        /* a small leaf has its name inside, without the slash when that is what makes it fit */
        g.text(R.x + 1, R.y + 1, title, ink, 1, isSel ? PAL.hi : '', R.x + R.w - 2);
        if (R.w >= title.length + 2) R.nameAt = { x: R.x + 1, y: R.y + 1, len: title.length, bare: true };
        next = R.y + 2;
        if (badge && R.w >= badge.length + 2 && R.h >= 4) { g.text(R.x + 1, next, badge, PAL.ink, 1, tone); next++; }
      } else if (leaf && R.w >= b.name.length + 2 && R.h >= 3) {
        g.text(R.x + 1, R.y + 1, b.name, ink, 1, isSel ? PAL.hi : '', R.x + R.w - 2);
        R.nameAt = { x: R.x + 1, y: R.y + 1, len: b.name.length, bare: true };
        next = R.y + 2;
      }
      if (R.hidden > 0 && next < R.y + R.h - 1 && R.w >= 10) { g.text(R.x + 1, next, '+' + R.hidden + ' inside', PAL.dim, 1, '', R.x + R.w - 2); next++; }
    }
    return g;
  }

  /* ---- the lines of one cell: what the marks of the grid look like, for any pen with moveTo and lineTo ---- */

  function markWidths(cw) {
    return { thin: Math.max(1.1, cw * 0.15), thick: Math.max(1.8, cw * 0.3) };
  }

  /* style 2 is a double line (bucket walls), 1 a single line, 3 a thick line and 4 a dashed one (the dmz strip) */
  function markPath(pen, m, st, x0, yy0, cw, chh) {
    const off = Math.max(1.3, cw * 0.19);
    const cx = x0 + cw / 2, cy = yy0 + chh / 2;
    if (st === 2) {
      const Lx = x0, Rx = x0 + cw, T = yy0, Bt = yy0 + chh;
      const hz = m & 10, vt = m & 5;
      if (m === 10) { pen.moveTo(Lx, cy - off); pen.lineTo(Rx, cy - off); pen.moveTo(Lx, cy + off); pen.lineTo(Rx, cy + off); }
      else if (m === 5) { pen.moveTo(cx - off, T); pen.lineTo(cx - off, Bt); pen.moveTo(cx + off, T); pen.lineTo(cx + off, Bt); }
      else if (hz && vt && (m === 6 || m === 12 || m === 3 || m === 9)) {
        const sx = m & 2 ? 1 : -1, sy = m & 4 ? 1 : -1;
        const ex = sx > 0 ? Rx : Lx, ey = sy > 0 ? Bt : T;
        pen.moveTo(cx - sx * off, ey); pen.lineTo(cx - sx * off, cy - sy * off); pen.lineTo(ex, cy - sy * off);
        pen.moveTo(cx + sx * off, ey); pen.lineTo(cx + sx * off, cy + sy * off); pen.lineTo(ex, cy + sy * off);
      } else {
        if (m & 1) { pen.moveTo(cx - off, cy); pen.lineTo(cx - off, T); pen.moveTo(cx + off, cy); pen.lineTo(cx + off, T); }
        if (m & 4) { pen.moveTo(cx - off, cy); pen.lineTo(cx - off, Bt); pen.moveTo(cx + off, cy); pen.lineTo(cx + off, Bt); }
        if (m & 2) { pen.moveTo(cx, cy - off); pen.lineTo(Rx, cy - off); pen.moveTo(cx, cy + off); pen.lineTo(Rx, cy + off); }
        if (m & 8) { pen.moveTo(cx, cy - off); pen.lineTo(Lx, cy - off); pen.moveTo(cx, cy + off); pen.lineTo(Lx, cy + off); }
      }
      return;
    }
    if (m & 1) { pen.moveTo(cx, cy); pen.lineTo(cx, yy0); }
    if (m & 2) { pen.moveTo(cx, cy); pen.lineTo(x0 + cw, cy); }
    if (m & 4) { pen.moveTo(cx, cy); pen.lineTo(cx, yy0 + chh); }
    if (m & 8) { pen.moveTo(cx, cy); pen.lineTo(x0, cy); }
  }

  /* ---- routing paths through the gaps (Dijkstra on cells, with a cost for turns, text and walls) ---- */

  function costGrid(g) {
    const c = new Float32Array(g.cols * g.rows);
    for (let i = 0; i < c.length; i++) c[i] = g.ch[i] ? 24 : g.mk[i] ? 7 : 1;
    return c;
  }
  function anchorCells(R, cols, rows) {
    const out = [];
    const x0 = R.x, y0 = R.y, x1 = R.x + R.w - 1, y1 = R.y + R.h - 1;
    if (R.h <= 2 || R.w <= 2) {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y]);
    } else {
      for (let x = x0 + 1; x < x1; x++) { out.push([x, y0]); out.push([x, y1]); }
      for (let y = y0 + 1; y < y1; y++) { out.push([x0, y]); out.push([x1, y]); }
    }
    return out.filter(([x, y]) => x >= 0 && y >= 0 && x < cols && y < rows);
  }
  function route(cost, cols, rows, from, to) {
    const N = cols * rows;
    const dist = new Float32Array(N * 4).fill(Infinity);
    const prev = new Int32Array(N * 4).fill(-1);
    const goal = new Uint8Array(N);
    for (const [x, y] of to) goal[y * cols + x] = 1;
    const heap = [];
    const push = (d, s) => {
      heap.push([d, s]);
      let i = heap.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
        }
      }
      return top;
    };
    const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
    for (const [x, y] of from) for (let d = 0; d < 4; d++) { const s = (y * cols + x) * 4 + d; dist[s] = 0; push(0, s); }
    let end = -1;
    let guard = 0;
    while (heap.length && guard++ < 400000) {
      const [d, s] = pop();
      if (d > dist[s]) continue;
      const cell = s >> 2, dir = s & 3;
      if (goal[cell] && d > 0) { end = s; break; }
      const x = cell % cols, y = (cell / cols) | 0;
      for (let nd = 0; nd < 4; nd++) {
        if (nd === (dir + 2) % 4) continue;
        const nx = x + DX[nd], ny = y + DY[nd];
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const nc = ny * cols + nx;
        const step = cost[nc] + (nd === dir ? 0 : 3);
        const ns = nc * 4 + nd;
        if (d + step < dist[ns]) { dist[ns] = d + step; prev[ns] = s; push(d + step, ns); }
      }
    }
    if (end < 0) return null;
    const cells = [];
    for (let s = end; s >= 0; s = prev[s]) cells.unshift([(s >> 2) % cols, ((s >> 2) / cols) | 0]);
    return cells.filter((c, i) => i === 0 || c[0] !== cells[i - 1][0] || c[1] !== cells[i - 1][1]);
  }

  function anchorOf(L, bucket) {
    const code = L.codes.get(bucket);
    if (code) return code;
    return boxOf(L, bucket);
  }
  /* the box of a bucket, or of the deepest bucket that holds it when it has no box of its own (a collapsed box on
     the one-level map, a box too small for the treemap) */
  function boxOf(L, bucket) {
    let best = null;
    for (const R of L.boxes) {
      const p = R.b.path;
      if ((p === bucket || bucket.startsWith(p + '/')) && (!best || p.length > best.b.path.length)) best = R;
    }
    return best;
  }

  function overlays(L, g, data) {
    const cost = costGrid(g);
    const out = { cycles: [], orphans: [], forbidden: [], deps: [], skipped: 0 };
    const link = (a, b) => (a && b && a !== b ? route(cost, L.cols, L.rows, anchorCells(a, L.cols, L.rows), anchorCells(b, L.cols, L.rows)) : null);
    for (const c of data.overlays.cycles) {
      const segs = [];
      for (let i = 0; i + 1 < c.buckets.length; i++) {
        const seg = link(anchorOf(L, c.buckets[i]), anchorOf(L, c.buckets[i + 1]));
        if (seg) segs.push(seg);
      }
      if (segs.length) out.cycles.push({ id: c.id, segs, all: [].concat.apply([], segs) });
      if (segs.length + 1 < c.buckets.length) out.skipped++;
    }
    for (const o of data.overlays.orphans) {
      const stops = [];
      if (o.origin) stops.push(anchorOf(L, o.origin));
      for (const owner of o.owners) { const s = L.strips.get(owner); if (s) stops.push(s); }
      if (o.consumer) stops.push(anchorOf(L, o.consumer));
      const segs = [];
      for (let i = 0; i + 1 < stops.length; i++) { const seg = link(stops[i], stops[i + 1]); if (seg) segs.push(seg); }
      out.orphans.push({ id: o.id, symbol: o.symbol, segs, tip: stops[stops.length - 1] || null });
    }
    for (const f of data.overlays.forbidden) {
      const from = anchorOf(L, f.from), to = anchorOf(L, f.to);
      const seg = link(from, to);
      if (!seg) { out.skipped++; continue; }
      /* the cross goes where the line goes through the wall of a bucket it may not reach through */
      let cross = null;
      const fromBox = L.boxes.find((R) => R.b.path === f.from);
      for (const [x, y] of seg) {
        const wall = L.boxes.find((R) => R !== fromBox && R.b.path !== f.to && (x === R.x || x === R.x + R.w - 1 || y === R.y || y === R.y + R.h - 1) && x >= R.x && x < R.x + R.w && y >= R.y && y < R.y + R.h);
        if (wall) { cross = [x, y]; break; }
      }
      if (!cross && fromBox) cross = seg.find(([x, y]) => x === fromBox.x || x === fromBox.x + fromBox.w - 1 || y === fromBox.y || y === fromBox.y + fromBox.h - 1) || null;
      out.forbidden.push({ id: f.id, seg, cross: cross || seg[Math.floor(seg.length / 2)] });
    }
    if (data.showDeps && data.selected && !data.highlight) {
      const sel = data.buckets.find((b) => b.path === data.selected);
      if (sel) {
        sel.dependsOn.slice(0, 10).forEach((t) => { const seg = link(anchorOf(L, sel.path), anchorOf(L, t)); if (seg) out.deps.push({ seg, out: true }); });
        sel.dependents.slice(0, 10).forEach((t) => { const seg = link(anchorOf(L, t), anchorOf(L, sel.path)); if (seg) out.deps.push({ seg, out: false }); });
      }
    }
    return out;
  }
`;
