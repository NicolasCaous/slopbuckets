// The matrix, pending and files views of the center area. The graph view lives in ../graph.
import { renderAdvice, violationKey, violationLocation, type Advice, type SnapshotEdge, type Violation } from '../../contract/browser.js';
import { html, raw, type SafeHtml } from './html.js';
import { code, fmt, link, plural, tag, VirtualList, type Ctx } from './dom.js';
import {
  CANVAS_ABOVE,
  cellText,
  cellTitle,
  edgeId,
  flattenTree,
  groupViolations,
  matrixCells,
  OWNER_FILTERS,
  ownerCounts,
  ownerLabel,
  violationTarget,
  type MatrixCell,
  type OwnerFilter,
  type TreeRow,
} from './model.js';
import { DEFAULT_OPTIONS, type ViewOptions } from './url.js';

export interface CenterView {
  /** Called after every state change with the same data; updates what depends on the selection. */
  update(ctx: Ctx): void;
  destroy?(): void;
}

/**
 * The list options. The shell reads them from the query string and writes them back with ctx.saveOptions; the
 * collapsed folders of the file tree stay in memory.
 */
export const viewOptions: ViewOptions & { collapsed: Set<string> } = { ...DEFAULT_OPTIONS, collapsed: new Set() };

const empty = (text: string) => html`<p class="empty">${text}</p>`;

export function locationText(v: Violation): string {
  const loc = violationLocation(v);
  const file = v.project === '.' ? loc.file : `${v.project}/${loc.file}`;
  return loc.line === undefined ? file : `${file}:${loc.line}`;
}

/** The accessible name starts with the visible label, so a voice command that says the label finds the button. */
export const copyButton = (text: string, label = 'Copy') =>
  html`<button type="button" class="copy" data-copy="${text}" aria-label="${label} ${text}">${label}</button>`;

// Matrix

export function matrixView(el: HTMLElement, ctx: Ctx): CenterView {
  const { order } = ctx.index;
  if (order.length === 0) {
    el.innerHTML = empty('No buckets yet, so there is no matrix. Add buckets to buckets.config.json.').value;
    return { update() {} };
  }
  const cells = matrixCells(ctx.index);
  if (order.length <= CANVAS_ABOVE) return matrixTable(el, ctx, cells);
  return viewOptions.table ? edgeTable(el, ctx) : matrixCanvas(el, ctx, cells);
}

const STATE_CLASS = { used: 'used', unused: 'unused', undeclared: 'undeclared' };
const STATE_TEXT = { used: 'declared', unused: 'declared, never imported', undeclared: 'undeclared' };

/** The buckets whose row and column the matrix bands: the selected bucket, or both ends of the selected edge. */
const bandNames = (c: Ctx): string[] => {
  const s = c.state.selection;
  return s.kind === 'bucket' ? [s.name] : s.kind === 'edge' ? [s.from, s.to] : [];
};

function matrixTable(el: HTMLElement, ctx: Ctx, cells: MatrixCell[]): CenterView {
  const { order } = ctx.index;
  const n = order.length;
  const grid: (MatrixCell | undefined)[] = new Array(n * n);
  for (const c of cells) grid[c.row * n + c.col] = c;
  const out: string[] = [
    html`<p class="hint">Rows import columns. Each cell shows the number of imports; <span class="unused-key">0</span> is declared but never imported; red with ! is imported without a declaration.</p>`.value,
    '<div class="matrix-wrap"><table class="matrix"><caption class="sr">Dependency matrix in layer order: each row imports the columns</caption><thead><tr><td></td>',
  ];
  for (const name of order) out.push(html`<th scope="col"><a href="${ctx.href({ kind: 'bucket', name })}" class="vert mono" translate="no" title="${name}">${name}</a></th>`.value);
  out.push('</tr></thead><tbody>');
  for (let r = 0; r < n; r++) {
    const name = order[r]!;
    out.push(html`<tr><th scope="row"><a href="${ctx.href({ kind: 'bucket', name })}" class="mono trunc" translate="no" title="${name}">${name}</a></th>`.value);
    for (let c = 0; c < n; c++) {
      const cell = grid[r * n + c];
      if (cell === undefined) {
        out.push(r === c ? '<td class="diag"></td>' : '<td></td>');
        continue;
      }
      const e = cell.edge;
      const id = edgeId(e.from, e.to);
      out.push(
        html`<td class="${STATE_CLASS[e.state]}${ctx.changed.has(id) ? ' changed' : ''}"><a href="${ctx.href({ kind: 'edge', from: e.from, to: e.to })}" data-id="${id}" title="${cellTitle(e)}">${cellText(e)}${e.state === 'undeclared' ? '!' : ''}</a></td>`.value,
      );
    }
    out.push('</tr>');
  }
  out.push('</tbody></table></div>');
  el.innerHTML = out.join('');
  const rows = [...el.querySelectorAll('tbody tr')];
  const heads = [...el.querySelectorAll('thead th')];
  let marked: Element[] = [];
  let banded: Element[] = [];
  let shown = '';
  const mark = (c: Ctx) => {
    for (const m of marked) m.removeAttribute('aria-current');
    for (const m of banded) m.classList.remove('band');
    const s = c.state.selection;
    const names = bandNames(c);
    const cell = s.kind === 'edge' ? `[data-id="${CSS.escape(edgeId(s.from, s.to))}"]` : '';
    const selector = [...(cell ? [cell] : []), ...names.map((name) => `th a[title="${CSS.escape(name)}"]`)].join(',');
    marked = selector === '' ? [] : [...el.querySelectorAll(selector)];
    for (const m of marked) m.setAttribute('aria-current', 'true');
    // The row and the column of each bucket, like the canvas matrix.
    banded = [];
    for (const name of names) {
      const i = order.indexOf(name);
      if (i === -1) continue;
      banded.push(...rows[i]!.children, heads[i]!);
      for (const tr of rows) banded.push(tr.children[i + 1]!);
    }
    for (const b of banded) b.classList.add('band');
    // Scroll only when the selection changes, so a live update does not undo the reader's scrolling. For a bucket,
    // the last match is its row header.
    const key = JSON.stringify(s);
    if (key === shown) return;
    shown = key;
    (cell ? el.querySelector(cell) : marked[marked.length - 1])?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  mark(ctx);
  return { update: mark };
}

const CANVAS_FONT = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const COLOR_NAMES = ['--bg', '--fg', '--muted', '--line', '--soft', '--sel', '--sel-soft', '--bad', '--bad-soft'] as const;
type Colors = Record<(typeof COLOR_NAMES)[number], string>;
/** The side of a canvas cell, in CSS pixels. */
const CELL = 16;

/** Where the canvas matrix puts things: the bucket order, the header sizes and the cells by `row * n + col`. */
interface Layout {
  order: string[];
  n: number;
  left: number;
  top: number;
  grid: Map<number, MatrixCell>;
}

/** The scroll offset, the size and the visible rows `r0..r1` and columns `c0..c1` (end excluded) of one frame. */
interface Frame {
  sx: number;
  sy: number;
  w: number;
  h: number;
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

/** The headers are as deep as the longest name needs, up to a limit; fillText cuts longer names. */
function matrixLayout(order: string[], cells: MatrixCell[]): Layout {
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = CANVAS_FONT;
  let longest = 0;
  for (const name of order) longest = Math.max(longest, measure.measureText(name).width);
  const n = order.length;
  const grid = new Map<number, MatrixCell>();
  for (const c of cells) grid.set(c.row * n + c.col, c);
  return { order, n, left: Math.min(150, Math.ceil(longest) + 16), top: Math.min(120, Math.ceil(longest) + 12), grid };
}

function visibleFrame(scroller: HTMLElement, { n, left, top }: Layout): Frame {
  const w = scroller.clientWidth;
  const h = scroller.clientHeight;
  const sx = scroller.scrollLeft;
  const sy = scroller.scrollTop;
  return {
    sx,
    sy,
    w,
    h,
    c0: Math.floor(sx / CELL),
    c1: Math.min(n, Math.ceil((sx + w - left) / CELL)),
    r0: Math.floor(sy / CELL),
    r1: Math.min(n, Math.ceil((sy + h - top) / CELL)),
  };
}

/** Sizes the canvas to the frame at the device pixel ratio and returns its context, scaled to CSS pixels. */
function sizeCanvas(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

/** One filled cell: the state background or border, the import count, and the selection or change outline. */
function drawCell(g: CanvasRenderingContext2D, x: number, y: number, cell: MatrixCell, colors: Colors, ctx: Ctx): void {
  const e = cell.edge;
  const s = ctx.state.selection;
  const isSel = s.kind === 'edge' && s.from === e.from && s.to === e.to;
  if (e.state === 'undeclared') {
    g.fillStyle = colors['--bad-soft'];
    g.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
  }
  if (e.state === 'unused') {
    g.strokeStyle = colors['--muted'];
    g.setLineDash([2, 2]);
    g.strokeRect(x + 1.5, y + 1.5, CELL - 3, CELL - 3);
    g.setLineDash([]);
  }
  g.fillStyle = e.state === 'undeclared' ? colors['--bad'] : e.state === 'unused' ? colors['--muted'] : colors['--fg'];
  g.fillText(e.imports.length > 99 ? '99+' : cellText(e), x + CELL / 2, y + CELL / 2 + 1, CELL - 2);
  if (isSel || ctx.changed.has(edgeId(e.from, e.to))) {
    g.strokeStyle = isSel ? colors['--sel'] : colors['--fg'];
    g.lineWidth = 2;
    g.strokeRect(x + 1, y + 1, CELL - 2, CELL - 2);
    g.lineWidth = 1;
  }
}

/** The background, the bands of the selected buckets, the diagonal and the visible cells. */
function drawCells(g: CanvasRenderingContext2D, layout: Layout, f: Frame, colors: Colors, ctx: Ctx, marked: Set<string>): void {
  const { order, n, left, top, grid } = layout;
  g.fillStyle = colors['--bg'];
  g.fillRect(0, 0, f.w, f.h);
  g.font = CANVAS_FONT;
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.fillStyle = colors['--sel-soft'];
  for (let c = f.c0; c < f.c1; c++) if (marked.has(order[c]!)) g.fillRect(left + c * CELL - f.sx, top, CELL, f.h - top);
  for (let r = f.r0; r < f.r1; r++) {
    const y = top + r * CELL - f.sy;
    if (marked.has(order[r]!)) {
      g.fillStyle = colors['--sel-soft'];
      g.fillRect(left, y, f.w - left, CELL);
    }
    for (let c = f.c0; c < f.c1; c++) {
      const x = left + c * CELL - f.sx;
      if (r === c) {
        g.fillStyle = colors['--soft'];
        g.fillRect(x, y, CELL, CELL);
      }
      const cell = grid.get(r * n + c);
      if (cell !== undefined) drawCell(g, x, y, cell, colors, ctx);
    }
  }
}

function drawGridLines(g: CanvasRenderingContext2D, { left, top }: Layout, f: Frame, colors: Colors): void {
  g.strokeStyle = colors['--line'];
  g.beginPath();
  for (let c = f.c0; c <= f.c1; c++) {
    const x = left + c * CELL - f.sx + 0.5;
    g.moveTo(x, top);
    g.lineTo(x, f.h);
  }
  for (let r = f.r0; r <= f.r1; r++) {
    const y = top + r * CELL - f.sy + 0.5;
    g.moveTo(left, y);
    g.lineTo(f.w, y);
  }
  g.stroke();
}

/** The fixed row and column headers, drawn last so the cells scroll under them. */
function drawHeaders(g: CanvasRenderingContext2D, { order, left, top }: Layout, f: Frame, colors: Colors, marked: Set<string>): void {
  const { '--bg': bg, '--fg': fg, '--sel': sel } = colors;
  g.fillStyle = bg;
  g.fillRect(0, 0, f.w, top);
  g.fillRect(0, 0, left, f.h);
  g.textAlign = 'right';
  for (let r = f.r0; r < f.r1; r++) {
    g.fillStyle = marked.has(order[r]!) ? sel : fg;
    g.fillText(order[r]!, left - 6, top + r * CELL - f.sy + CELL / 2 + 1, left - 10);
  }
  g.textAlign = 'left';
  for (let c = f.c0; c < f.c1; c++) {
    g.save();
    g.translate(left + c * CELL - f.sx + CELL / 2 + 1, top - 6);
    g.rotate(-Math.PI / 2);
    g.fillStyle = marked.has(order[c]!) ? sel : fg;
    g.fillText(order[c]!, 0, 0, top - 10);
    g.restore();
  }
  g.fillStyle = bg;
  g.fillRect(0, 0, left, top);
}

/** The cell or the header bucket under the mouse. */
function hitMatrix(e: MouseEvent, scroller: HTMLElement, { order, n, left, top, grid }: Layout): { cell?: MatrixCell; bucket?: string } {
  const box = scroller.getBoundingClientRect();
  const x = e.clientX - box.left;
  const y = e.clientY - box.top;
  const c = Math.floor((x - left + scroller.scrollLeft) / CELL);
  const r = Math.floor((y - top + scroller.scrollTop) / CELL);
  if (x < left && y >= top && r >= 0 && r < n) return { bucket: order[r] };
  if (y < top && x >= left && c >= 0 && c < n) return { bucket: order[c] };
  if (x >= left && y >= top && r < n && c < n) return { cell: grid.get(r * n + c) };
  return {};
}

/** Scrolls the least needed to show the selected bucket's row and column, or the selected cell. */
function revealSelection(scroller: HTMLElement, { order, left, top }: Layout, c: Ctx): void {
  const s = c.state.selection;
  const [row, col] = s.kind === 'bucket' ? [s.name, s.name] : s.kind === 'edge' ? [s.from, s.to] : [];
  const r = order.indexOf(row ?? '');
  const k = order.indexOf(col ?? '');
  if (r === -1 || k === -1) return;
  const into = (i: number, start: number, room: number) => (i * CELL < start || (i + 1) * CELL > start + room ? Math.max(0, i * CELL - (room - CELL) / 2) : start);
  scroller.scrollTop = into(r, scroller.scrollTop, scroller.clientHeight - top);
  scroller.scrollLeft = into(k, scroller.scrollLeft, scroller.clientWidth - left);
}

function matrixCanvas(el: HTMLElement, ctx: Ctx, cells: MatrixCell[]): CenterView {
  const layout = matrixLayout(ctx.index.order, cells);
  const { n, left, top } = layout;
  el.innerHTML = html`<div class="toolbar"><span class="hint">${fmt(n)} buckets, drawn on a canvas. Rows import columns; click a cell to open the dependency or a name to open the bucket.</span><button type="button" id="matrix-alt">Show as table</button></div>
    <div class="canvas-box"><canvas aria-hidden="true"></canvas><div class="canvas-scroll" tabindex="0" role="region" aria-label="Dependency matrix; use Show as table for a keyboard and screen reader version"><div class="spacer" style="width:${left + n * CELL}px;height:${top + n * CELL}px"></div></div></div>`.value;
  const canvas = el.querySelector('canvas')!;
  const scroller = el.querySelector<HTMLElement>('.canvas-scroll')!;
  let current = ctx;
  el.querySelector('#matrix-alt')!.addEventListener('click', () => {
    viewOptions.table = true;
    current.saveOptions();
    current.go({});
  });
  let frame = 0;
  // Computed colors are read once per color scheme, not on every frame.
  let colors: Colors | null = null;
  const palette = (): Colors => {
    if (colors) return colors;
    const css = getComputedStyle(el);
    colors = Object.fromEntries(COLOR_NAMES.map((name) => [name, css.getPropertyValue(name).trim()])) as Colors;
    return colors;
  };
  const draw = () => {
    frame = 0;
    const f = visibleFrame(scroller, layout);
    const g = sizeCanvas(canvas, f.w, f.h);
    const marked = new Set(bandNames(current));
    drawCells(g, layout, f, palette(), current, marked);
    drawGridLines(g, layout, f, palette());
    drawHeaders(g, layout, f, palette(), marked);
  };
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(draw);
  };
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => {
    colors = null;
    schedule();
  };
  scheme.addEventListener('change', onScheme);
  scroller.addEventListener('scroll', schedule, { passive: true });
  scroller.addEventListener('mousemove', (e) => {
    const { cell, bucket } = hitMatrix(e, scroller, layout);
    scroller.title = cell ? cellTitle(cell.edge) : (bucket ?? '');
    scroller.style.cursor = cell || bucket ? 'pointer' : 'default';
  });
  scroller.addEventListener('click', (e) => {
    const { cell, bucket } = hitMatrix(e, scroller, layout);
    if (cell) current.go({ selection: { kind: 'edge', from: cell.edge.from, to: cell.edge.to }, pair: null });
    else if (bucket) current.go({ selection: { kind: 'bucket', name: bucket }, pair: null });
  });
  const resize = new ResizeObserver(schedule);
  resize.observe(scroller);
  let shown = JSON.stringify(ctx.state.selection);
  revealSelection(scroller, layout, ctx);
  draw();
  return {
    update(c) {
      current = c;
      // Only a new selection scrolls, so a live update does not undo the reader's scrolling.
      const key = JSON.stringify(c.state.selection);
      if (key !== shown) {
        shown = key;
        revealSelection(scroller, layout, c);
      }
      schedule();
    },
    destroy() {
      resize.disconnect();
      scheme.removeEventListener('change', onScheme);
      cancelAnimationFrame(frame);
    },
  };
}

const EDGE_ROW = 28;

/** The keyboard and screen reader alternative to the canvas matrix: one virtualized row per dependency. */
function edgeTable(el: HTMLElement, ctx: Ctx): CenterView {
  const edges = ctx.index.project.edges;
  let current = ctx;
  el.innerHTML = html`<div class="toolbar"><span class="hint">${plural(edges.length, 'dependency', 'dependencies')}. Each row opens its dependency.</span><button type="button" id="matrix-alt">Show as matrix</button></div>
    <div class="erow ehead" aria-hidden="true"><span>From</span><span>To</span><span>State</span><span class="num">Imports</span></div>
    <div id="edge-list" class="fill"></div>`.value;
  const list = new VirtualList(el.querySelector('#edge-list')!, EDGE_ROW, (i) => edgeRow(edges[i]!, current), 'Dependencies between buckets');
  list.setCount(edges.length);
  el.querySelector('#matrix-alt')!.addEventListener('click', () => {
    viewOptions.table = false;
    current.saveOptions();
    current.go({});
  });
  /** Scrolls to the selected dependency, or to the first dependency of the selected bucket. */
  const reveal = (c: Ctx) => {
    const s = c.state.selection;
    const i =
      s.kind === 'edge' ? edges.findIndex((e) => e.from === s.from && e.to === s.to) : s.kind === 'bucket' ? edges.findIndex((e) => e.from === s.name || e.to === s.name) : -1;
    if (i === -1) return;
    list.setActive(i);
    list.scrollTo(i, true);
  };
  let shown = JSON.stringify(ctx.state.selection);
  reveal(ctx);
  return {
    update(c) {
      current = c;
      list.refresh();
      const key = JSON.stringify(c.state.selection);
      if (key !== shown) {
        shown = key;
        reveal(c);
      }
    },
  };
}

function edgeRow(e: SnapshotEdge, ctx: Ctx): SafeHtml {
  const s = ctx.state.selection;
  const id = edgeId(e.from, e.to);
  const current = s.kind === 'edge' && s.from === e.from && s.to === e.to;
  const band = s.kind === 'bucket' && (s.name === e.from || s.name === e.to);
  const cls = `erow ${STATE_CLASS[e.state]}${band ? ' band' : ''}${ctx.changed.has(id) ? ' changed' : ''}`;
  return html`<a href="${ctx.href({ kind: 'edge', from: e.from, to: e.to })}" class="${cls}"${current ? html` aria-current="true"` : ''}>${code(e.from)}<span class="sr">${e.state === 'undeclared' ? ' imports ' : ' depends on '}</span>${code(e.to)}<span>${STATE_TEXT[e.state]}</span><span class="num">${fmt(e.imports.length)}<span class="sr"> imports</span></span></a>`;
}

// Pending

export function pendingView(el: HTMLElement, ctx: Ctx): CenterView {
  const list = ctx.index.project.violations;
  const advice = ctx.index.project.advice;
  if (list.length === 0 && advice.length === 0) {
    el.innerHTML = empty('Nothing pending. buckets check finds no problem in this project.').value;
    return { update() {} };
  }
  el.innerHTML = html`<div class="toolbar">
      <label>Group by <select id="pending-by" name="pending-by"><option value="rule">rule</option><option value="bucket">bucket</option></select></label>
      <label class="sr" for="pending-filter">Filter pending items</label>
      <input id="pending-filter" name="pending-filter" type="search" autocomplete="off" spellcheck="false" placeholder="Filter pending…" value="${viewOptions.pending}">
      <span id="pending-count" class="hint" aria-live="polite"></span>
    </div><div class="scroll pending" id="pending-list"></div>`.value;
  const by = el.querySelector<HTMLSelectElement>('#pending-by')!;
  by.value = viewOptions.by;
  const filter = el.querySelector<HTMLInputElement>('#pending-filter')!;
  const out = el.querySelector<HTMLElement>('#pending-list')!;
  const count = el.querySelector<HTMLElement>('#pending-count')!;
  const paint = () => {
    const groups = groupViolations(list, viewOptions.by, viewOptions.pending, ctx.text);
    const f = viewOptions.pending.trim().toLowerCase();
    const notes = advice.filter((a) => f === '' || renderAdvice(a).toLowerCase().includes(f));
    const shown = new Set(groups.flatMap((g) => g.items)).size;
    const items = shown === list.length ? plural(list.length, 'item') : `${fmt(shown)} of ${plural(list.length, 'item')}`;
    const notesText = advice.length === 0 ? '' : notes.length === advice.length ? `, ${plural(advice.length, 'note')} of advice` : `, ${fmt(notes.length)} of ${plural(advice.length, 'note')} of advice`;
    count.textContent = items + notesText;
    if (groups.length === 0 && notes.length === 0) {
      out.innerHTML = empty('No pending item matches the filter.').value;
      return;
    }
    const byRule = viewOptions.by === 'rule';
    out.innerHTML =
      groups
        .map((g) => {
          const title = byRule ? code(g.key) : g.key === '' ? 'No bucket' : link(ctx.href({ kind: 'bucket', name: g.key }), code(g.key));
          // The heading names the rule, so items grouped by rule leave it out.
          return html`<section><h3>${title} <span class="count">${fmt(g.items.length)}</span></h3>${g.items.map((v) => pendingItem(v, ctx, !byRule))}</section>`.value;
        })
        .join('') +
      (notes.length === 0
        ? ''
        : html`<section class="advice"><h3>Advice <span class="count">${fmt(notes.length)}</span></h3>
            <p class="muted">Not blocking. Advice never fails the check or blocks the turn.</p>
            ${notes.map((a) => adviceItem(a, ctx))}</section>`.value);
  };
  by.addEventListener('change', () => {
    viewOptions.by = by.value as 'rule' | 'bucket';
    ctx.saveOptions();
    paint();
  });
  filter.addEventListener('input', () => {
    viewOptions.pending = filter.value;
    ctx.saveOptions();
    paint();
  });
  paint();
  return { update() {} };
}

/**
 * One pending item: the rule (unless a heading names it), a link to the dependency or bucket it concerns, the copy
 * button and the full message. The file:line inside the message links to the file; when the message lacks it, the
 * head shows it.
 */
export function pendingItem(v: Violation, ctx: Ctx, showRule = true): SafeHtml {
  const loc = violationLocation(v);
  const at = loc.line === undefined ? loc.file : `${loc.file}:${loc.line}`;
  const isNew = ctx.changed.has(violationKey(v));
  const text = ctx.text(v);
  const fileHref = v.project === ctx.index.project.path && ctx.owner(loc.file) !== undefined ? ctx.href({ kind: 'file', path: loc.file }) : null;
  const cut = text.indexOf(at);
  const target = violationTarget(ctx.index, v);
  const targetLink = target === null ? '' : link(ctx.href(target), code(target.kind === 'edge' ? `${target.from} -> ${target.to}` : target.kind === 'bucket' ? target.name : ''), 'target');
  const where = cut !== -1 ? '' : fileHref ? link(fileHref, code(at, 'loc')) : code(at, 'loc');
  const message = cut === -1 || fileHref === null ? text : html`${text.slice(0, cut)}${link(fileHref, at)}${text.slice(cut + at.length)}`;
  return html`<article class="item${isNew ? ' changed' : ''}">
    <div class="item-head">${showRule ? code(v.rule, 'rule') : ''} ${targetLink} ${where} ${copyButton(locationText(v), 'Copy file:line')} ${isNew ? tag('new') : ''}</div>
    <pre class="msg mono" translate="no">${message}</pre>
  </article>`;
}

/** One note of advice: a link to the bucket it is about, when it names one, and the text that buckets check prints. */
function adviceItem(a: Advice, ctx: Ctx): SafeHtml {
  const bucket = a.at[0] === 'buckets' && typeof a.at[1] === 'string' && ctx.index.buckets.has(a.at[1]) ? a.at[1] : null;
  return html`<article class="item note-item">
    <div class="item-head">${code(a.advice, 'rule')} ${bucket === null ? '' : link(ctx.href({ kind: 'bucket', name: bucket }), code(bucket), 'target')}</div>
    <pre class="msg mono" translate="no">${renderAdvice(a)}</pre>
  </article>`;
}

// Files

const ROW = 26;

export function filesView(el: HTMLElement, ctx: Ctx): CenterView {
  if (ctx.index.project.files.length === 0) {
    el.innerHTML = empty('No files. The project folder has no file that buckets check reads.').value;
    return { update() {} };
  }
  const labels: Record<OwnerFilter, string> = { all: 'all', bucket: 'in a bucket', ignored: 'ignored', unowned: 'no bucket', overlap: 'two buckets' };
  const counts = ownerCounts(ctx.index.project);
  el.innerHTML = html`<div class="toolbar">
      <label>Owner <select id="owner-filter" name="owner-filter">${OWNER_FILTERS.map((f) => html`<option value="${f}">${labels[f]} (${fmt(counts[f])})</option>`)}</select></label>
      <label class="sr" for="file-filter">Filter paths</label>
      <input id="file-filter" name="file-filter" type="search" autocomplete="off" spellcheck="false" placeholder="Filter paths…" value="${viewOptions.path}">
      <span id="file-count" class="hint" aria-live="polite"></span>
    </div><div class="tree-head" aria-hidden="true"><span>Path</span><span>Owner</span></div><div id="file-list" class="fill"></div><p id="file-empty" class="empty" hidden>No file matches the filters.</p>`.value;
  const owner = el.querySelector<HTMLSelectElement>('#owner-filter')!;
  owner.value = viewOptions.owner;
  const text = el.querySelector<HTMLInputElement>('#file-filter')!;
  const count = el.querySelector<HTMLElement>('#file-count')!;
  const none = el.querySelector<HTMLElement>('#file-empty')!;
  const tree = ctx.tree();
  let current = ctx;
  let rows: TreeRow[] = [];
  const list = new VirtualList(el.querySelector('#file-list')!, ROW, (i) => fileRow(rows[i]!, current), 'Project files');
  const rebuild = () => {
    rows = flattenTree(tree, viewOptions.collapsed, viewOptions.owner, viewOptions.path);
    const files = rows.reduce((n, r) => n + (r.depth === 0 ? r.count : 0), 0);
    count.textContent = plural(files, 'file');
    none.hidden = rows.length > 0;
    list.setCount(rows.length);
  };
  owner.addEventListener('change', () => {
    viewOptions.owner = owner.value as OwnerFilter;
    current.saveOptions();
    rebuild();
  });
  text.addEventListener('input', () => {
    viewOptions.path = text.value;
    current.saveOptions();
    rebuild();
  });
  list.el.addEventListener('click', (e) => {
    const dir = (e.target as HTMLElement).closest<HTMLElement>('[data-dir]')?.dataset.dir;
    if (dir === undefined) return;
    if (viewOptions.collapsed.has(dir)) viewOptions.collapsed.delete(dir);
    else viewOptions.collapsed.add(dir);
    rebuild();
  });
  rebuild();
  const reveal = (c: Ctx) => {
    const s = c.state.selection;
    if (s.kind !== 'file') return;
    const i = rows.findIndex((r) => r.path === s.path);
    if (i === -1) return;
    list.setActive(i);
    list.scrollTo(i, true);
  };
  reveal(ctx);
  let shown = JSON.stringify(ctx.state.selection);
  return {
    update(c) {
      current = c;
      list.refresh();
      // Only a new selection scrolls, so a live update does not undo the reader's scrolling.
      const key = JSON.stringify(c.state.selection);
      if (key !== shown) {
        shown = key;
        reveal(c);
      }
    },
  };
}

function fileRow(r: TreeRow, ctx: Ctx): SafeHtml {
  const pad = raw(`style="padding-left:${0.5 + r.depth * 1.1}rem"`);
  if (r.owner === null) {
    return html`<div class="tree-row" ${pad}><button type="button" class="dir" data-dir="${r.path}" aria-expanded="${String(!r.collapsed)}"><span aria-hidden="true">${r.collapsed ? '▸' : '▾'}</span> ${code(`${r.name}/`)}</button><span class="num">${fmt(r.count)}</span></div>`;
  }
  const s = ctx.state.selection;
  const current = s.kind === 'file' && s.path === r.path;
  const o = r.owner;
  const ownerCell = o.state === 'bucket' ? code(o.bucket) : html`<span class="state-${o.state}" title="${o.state === 'overlap' ? o.buckets.join(', ') : ''}">${ownerLabel(o)}</span>`;
  return html`<div class="tree-row" ${pad}>${link(ctx.href({ kind: 'file', path: r.path }), code(r.name), 'file', current)}<span class="owner"><span class="sr">owner </span>${ownerCell}</span></div>`;
}
