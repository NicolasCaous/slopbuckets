// The bucket map as SVG, for `buckets inspect --export svg`, the download button of the page and the timeline. It runs
// the same layout and router as the page's canvas (web/assets/map-core.ts), evaluated once on the server, and turns
// the character grid into SVG: walls as paths, letters as text, violations as routed lines. The SVG uses only
// presentation attributes (no style element, no external font), so it renders the same as a file and inside a page
// with a strict Content Security Policy.
import { MAP_CORE_JS } from '../web/assets/map-core.js';

/** A situation the map can color: the three of the live map and the four of a timeline approval. */
export type MapTone = 'ok' | 'lock' | 'violation' | 'added' | 'changed' | 'removed' | 'same';

export interface MapBucketData {
  path: string;
  name: string;
  level: number;
  parent: string | null;
  children: string[];
  files: number;
  /** Replaces the `_/ N files` label of the code box, for a map rebuilt from a lock that has no file counts. */
  code?: string;
  situation: MapTone;
  violations: number;
  lockChanges: number;
  contracts: number;
  symbols: number;
  /** The tone of the bucket's `dmz/` strip. */
  dmz: MapTone;
  projects: { path: string; name: string; situation: MapTone; status: string; buckets: number }[];
  dependsOn: string[];
  dependents: string[];
  href?: string;
  /** Orphan contracts among `violations`, shown with their own mark in the badge. */
  orphans?: number;
  /** Summary lines drawn under the `_/` label, such as the counts of a collapsed box. */
  lines?: { text: string; tone?: 'dim' | 'text' | 'cyan' | 'amber' | 'red' }[];
  /** For a collapsed box: how many buckets are below it. Its `children` is then empty. */
  inside?: number;
  /** Buckets that use this one and buckets it depends on, for the tooltip. Default: the list lengths. */
  ins?: number;
  outs?: number;
  /** Contract files where the bucket is the consumer and the provider, for the tooltip. */
  cin?: number;
  cout?: number;
}

/** How the map lays buckets out: every bucket nested, one level of a large project, or a treemap of all of them. */
export type MapMode = 'full' | 'level' | 'treemap';

export interface MapData {
  version?: number;
  project: string;
  name: string;
  root: string;
  situation: MapTone;
  /** The color of the code boxes: amber on the live map, `line` on maps where amber means a change. */
  codeTone?: 'line' | 'dim';
  selected: string | null;
  highlight: string | null;
  /** Default `full`. */
  mode?: MapMode;
  /** Draws the dependency lines of the selected bucket. Off by default. */
  showDeps?: boolean;
  buckets: MapBucketData[];
  overlays: {
    cycles: { id: string; buckets: string[] }[];
    orphans: { id: string; symbol: string; origin: string | null; owners: string[]; consumer: string | null }[];
    forbidden: { id: string; from: string | null; to: string | null; file: string }[];
  };
  projectHref?: { path: string; href: string }[];
}

/** An end of an extra line: a bucket (its code box) or the `dmz/` strip of a bucket. */
export type MapAnchor = { bucket: string } | { strip: string };

/** A line routed between two buckets, such as a contract the timeline shows as added or removed. */
export interface MapEdge {
  from: MapAnchor;
  to: MapAnchor;
  tone: MapTone;
  /** Short text drawn next to the end of the line. */
  label?: string;
  dashed?: boolean;
}

export interface MapSvgOptions {
  /** Grid width in cells. Default 150. */
  cols?: number;
  /** Cell width in pixels; a cell is twice as tall. Default 8. */
  cw?: number;
  /** A complete file with the XML namespace, a title, a header line and a legend. Default true. */
  standalone?: boolean;
  /** Prefix of the ids inside the SVG, so two maps on one page do not collide. */
  idPrefix?: string;
  /** Text of the header line of a standalone file. */
  caption?: string;
  /** Accessible title. */
  title?: string;
  /** Extra routed lines, drawn under the violation overlays. */
  edges?: MapEdge[];
  /** Draws cycles, orphan chains and forbidden imports. Default true. */
  overlays?: boolean;
  /** Adds `class` attributes to walls and titles drawn in a tone color, so a page can animate them. */
  toneClasses?: Partial<Record<MapTone, string>>;
  /** Legend entries of a standalone file. Default: the live map legend. */
  legend?: { label: string; tone: MapTone | 'project' | 'cycle' | 'orphan' | 'forbidden' }[];
}

export interface MapSvg {
  svg: string;
  width: number;
  height: number;
  cols: number;
  rows: number;
}

// ---- the shared core, evaluated once ----

interface Rect {
  kind: 'bucket' | 'code' | 'project';
  x: number;
  y: number;
  w: number;
  h: number;
  b?: MapBucketData;
}

interface Layout {
  cols: number;
  rows: number;
  boxes: Rect[];
  codes: Map<string, Rect>;
  strips: Map<string, Rect>;
  projects: Rect[];
}

interface Grid {
  cols: number;
  rows: number;
  ch: string[];
  fg: string[];
  bg: string[];
  al: Float32Array;
  mk: Uint8Array;
  st: Uint8Array;
  idx(x: number, y: number): number;
}

type Cell = [number, number];

interface Pen {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
}

export interface MapCore {
  PAL: Record<'phos' | 'hi' | 'text' | 'dim' | 'faint' | 'line' | 'amber' | 'red' | 'cyan' | 'ink' | 'bar', string>;
  SIT: Record<MapTone, string>;
  layoutMap(data: MapData, cols: number): Layout;
  layoutFor(data: MapData, cols: number): Layout;
  drawMap(layout: Layout, data: MapData, ui: { hover: null }): Grid;
  overlays(
    layout: Layout,
    grid: Grid,
    data: MapData,
  ): {
    cycles: { id: string; segs: Cell[][]; all: Cell[] }[];
    orphans: { id: string; symbol: string; segs: Cell[][] }[];
    forbidden: { id: string; seg: Cell[]; cross: Cell }[];
  };
  costGrid(grid: Grid): Float32Array;
  anchorCells(rect: Rect, cols: number, rows: number): Cell[];
  route(cost: Float32Array, cols: number, rows: number, from: Cell[], to: Cell[]): Cell[] | null;
  anchorOf(layout: Layout, bucket: string): Rect | null;
  markPath(pen: Pen, m: number, st: number, x0: number, y0: number, cw: number, chh: number): void;
  markWidths(cw: number): { thin: number; thick: number };
}

let core: MapCore | null = null;
let compiled: (() => MapCore) | null = null;

/** The statement that ends the map core source when it runs as a function: what it hands to the code that runs it. */
export const MAP_CORE_RETURN = 'return { PAL, SIT, layoutMap, layoutFor, drawMap, overlays, costGrid, anchorCells, route, anchorOf, markPath, markWidths };';

/**
 * The map core compiled ahead of time, for the browser script of `inspect --export html`: the page of that file
 * forbids evaluating text, so the bundle carries the same source as code (web/static-bundle.ts) and hands it over here.
 */
export function useCompiledMapCore(factory: () => MapCore): void {
  compiled = factory;
  core = null;
}

/** The map layout of the page script, evaluated on the server. The source is a constant of this package. */
export function mapCore(): MapCore {
  if (core === null) {
    const factory = compiled ?? (new Function(`'use strict';\n${MAP_CORE_JS}\n${MAP_CORE_RETURN}`) as () => MapCore);
    core = factory();
  }
  return core;
}

// ---- SVG pieces ----

/** Text for XML content and attributes: escaped, without the control characters XML 1.0 forbids. */
function xml(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function n(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function opacity(alpha: number): string {
  return alpha >= 0.995 ? '' : ` opacity="${n(alpha)}"`;
}

class PathPen implements Pen {
  d = '';
  moveTo(x: number, y: number): void {
    this.d += `M${n(x)} ${n(y)}`;
  }
  lineTo(x: number, y: number): void {
    this.d += `L${n(x)} ${n(y)}`;
  }
}

export const MAP_FONT = 'ui-monospace, Menlo, Consolas, &#34;DejaVu Sans Mono&#34;, monospace';
const BACKGROUND = '#010603';

/** Renders a map as SVG with the page's layout. */
export function renderMapSvg(data: MapData, options: MapSvgOptions = {}): MapSvg {
  const C = mapCore();
  const { PAL, SIT } = C;
  const cols = Math.max(24, Math.floor(options.cols ?? 150));
  const cw = options.cw ?? 8;
  const chh = Math.round(cw * 2);
  const standalone = options.standalone ?? true;
  const id = (name: string) => `${options.idPrefix ?? 'sb'}-${name}`;
  const toneClass = new Map<string, string>();
  for (const [tone, cls] of Object.entries(options.toneClasses ?? {})) if (cls) toneClass.set(SIT[tone as MapTone], cls);
  const classFor = (color: string): string => {
    const cls = toneClass.get(color);
    return cls ? ` class="${cls}"` : '';
  };

  const layout = C.layoutFor(data, cols);
  const grid = C.drawMap(layout, data, { hover: null });
  const width = cols * cw;
  const mapHeight = layout.rows * chh;
  const top = standalone ? chh * 3 : 0;
  const bottom = standalone ? chh * 3 : 0;
  const height = top + mapHeight + bottom;
  const fs = cw / 0.6;
  const out: string[] = [];

  // Cell backgrounds, merged along each row.
  const backs: string[] = [];
  for (let y = 0; y < grid.rows; y++) {
    let x = 0;
    while (x < grid.cols) {
      const i = y * grid.cols + x;
      const bg = grid.bg[i]!;
      if (!bg) {
        x++;
        continue;
      }
      const al = grid.al[i] || 1;
      let end = x + 1;
      while (end < grid.cols && grid.bg[y * grid.cols + end] === bg && (grid.al[y * grid.cols + end] || 1) === al) end++;
      backs.push(`<rect x="${n(x * cw)}" y="${n(y * chh)}" width="${n((end - x) * cw + 0.5)}" height="${n(chh + 0.5)}" fill="${bg}"${opacity(al)}${classFor(bg)}/>`);
      x = end;
    }
  }

  // Walls and strips: one path per style, color and opacity.
  const widths = C.markWidths(cw);
  const marks = new Map<string, { st: number; fg: string; al: number; pen: PathPen }>();
  for (let i = 0; i < grid.mk.length; i++) {
    const m = grid.mk[i]!;
    if (!m) continue;
    const st = grid.st[i]!;
    const fg = grid.fg[i]!;
    const al = Math.round(grid.al[i]! * 100) / 100;
    const key = `${st}|${fg}|${al}`;
    let entry = marks.get(key);
    if (!entry) {
      entry = { st, fg, al, pen: new PathPen() };
      marks.set(key, entry);
    }
    C.markPath(entry.pen, m, st, (i % grid.cols) * cw, Math.floor(i / grid.cols) * chh, cw, chh);
  }
  const walls = [...marks.values()].map((e) => {
    const dash = e.st === 4 ? ` stroke-dasharray="${n(cw * 0.32)} ${n(cw * 0.32)}"` : '';
    const cls = e.st === 2 || e.st === 4 ? classFor(e.fg) : '';
    return `<path d="${e.pen.d}" fill="none" stroke="${e.fg}" stroke-width="${n(e.st === 3 ? widths.thick : widths.thin)}" stroke-linecap="square"${dash}${opacity(e.al)}${cls}/>`;
  });

  // Letters: runs of the same color along each row, one x per glyph. Dots and crosses are shapes, as on the canvas.
  const texts: string[] = [];
  const shapes: string[] = [];
  for (let y = 0; y < grid.rows; y++) {
    let run: { fg: string; al: number; xs: number[]; chars: string } | null = null;
    const flush = () => {
      if (run === null) return;
      const cls = run.al >= 0.995 ? classFor(run.fg) : '';
      texts.push(`<text x="${run.xs.map(n).join(' ')}" y="${n(y * chh + chh / 2 + chh * 0.03)}" fill="${run.fg}"${opacity(run.al)}${cls}>${xml(run.chars)}</text>`);
      run = null;
    };
    for (let x = 0; x < grid.cols; x++) {
      const i = y * grid.cols + x;
      const c = grid.ch[i]!;
      if (!c || c === ' ') {
        flush();
        continue;
      }
      const fg = grid.fg[i]!;
      const al = Math.round(grid.al[i]! * 100) / 100;
      const cx = x * cw + cw / 2;
      const cy = y * chh + chh / 2;
      if (c === '●' || c === '·' || c === '✗') {
        flush();
        if (c === '●') shapes.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(cw * 0.36)}" fill="${fg}"${opacity(al)}${classFor(fg)}/>`);
        else if (c === '·') shapes.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(Math.max(1, cw * 0.14))}" fill="${fg}"${opacity(al)}/>`);
        else shapes.push(cross(x * cw, cy, cw, fg, al));
        continue;
      }
      if (run !== null && (run.fg !== fg || run.al !== al)) flush();
      if (run === null) run = { fg, al, xs: [], chars: '' };
      run.xs.push(cx);
      run.chars += c;
    }
    flush();
  }

  // Extra lines and violations, routed through the gaps like on the page.
  const cost = C.costGrid(grid);
  const anchor = (a: MapAnchor): Rect | null => ('bucket' in a ? C.anchorOf(layout, a.bucket) : (layout.strips.get(a.strip) ?? null));
  const link = (a: Rect | null, b: Rect | null): Cell[] | null =>
    a && b ? C.route(cost, layout.cols, layout.rows, C.anchorCells(a, layout.cols, layout.rows), C.anchorCells(b, layout.cols, layout.rows)) : null;
  const pt = (c: Cell): [number, number] => [c[0] * cw + cw / 2, c[1] * chh + chh / 2];
  const poly = (cells: Cell[]): string => cells.map((c, i) => `${i === 0 ? 'M' : 'L'}${n(pt(c)[0])} ${n(pt(c)[1])}`).join('');
  const arrow = (cells: Cell[], color: string, cls = ''): string => {
    if (cells.length < 2) return '';
    const a = pt(cells[cells.length - 2]!);
    const b = pt(cells[cells.length - 1]!);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const s = Math.max(5, cw * 0.75);
    const p = [
      [b[0] + Math.cos(ang) * s * 0.4, b[1] + Math.sin(ang) * s * 0.4],
      [b[0] - Math.cos(ang - 0.5) * s, b[1] - Math.sin(ang - 0.5) * s],
      [b[0] - Math.cos(ang + 0.5) * s, b[1] - Math.sin(ang + 0.5) * s],
    ];
    return `<path d="M${p.map((q) => `${n(q[0]!)} ${n(q[1]!)}`).join('L')}z" fill="${color}"${cls}/>`;
  };
  const label = (cell: Cell | undefined, text: string, color: string, cls = ''): string => {
    if (!cell) return '';
    const lfs = Math.max(10, cw / 0.66);
    const w = text.length * lfs * 0.6 + 8;
    const span = Math.ceil(w / cw);
    const spots: Cell[] = [[1, 0], [-span - 1, 0], [1, 1], [1, -1], [-span - 1, 1], [-span - 1, -1], [-Math.floor(span / 2), 1], [-Math.floor(span / 2), -1]];
    let best: { x0: number; y: number; score: number } | null = null;
    for (const [dx, dy] of spots) {
      const x0 = cell[0] + dx;
      const y = cell[1] + dy;
      if (x0 < 0 || x0 + span >= grid.cols || y < 0 || y >= grid.rows) continue;
      let score = 0;
      for (let x = x0; x < x0 + span; x++) {
        const i = grid.idx(x, y);
        if (grid.ch[i]) score += 3;
        else if (grid.mk[i]) score += 1;
      }
      if (!best || score < best.score) best = { x0, y, score };
    }
    const spot = best ?? { x0: Math.max(0, Math.min(grid.cols - span - 1, cell[0] + 1)), y: cell[1] };
    const x = spot.x0 * cw + 1;
    const cy = spot.y * chh + chh / 2;
    return `<g${cls}><rect x="${n(x - 1)}" y="${n(cy - chh * 0.48)}" width="${n(w)}" height="${n(chh * 0.96)}" fill="${BACKGROUND}" fill-opacity="0.94" stroke="${color}" stroke-width="1"/><text x="${n(x + 3)}" y="${n(cy + 1)}" fill="${color}" font-weight="600" font-size="${n(lfs)}" text-anchor="start">${xml(text)}</text></g>`;
  };

  const lines: string[] = [];
  for (const edge of options.edges ?? []) {
    const seg = link(anchor(edge.from), anchor(edge.to));
    if (!seg) continue;
    const color = SIT[edge.tone];
    const cls = toneClass.get(color) ? ` class="${toneClass.get(color)} map-edge"` : ' class="map-edge"';
    const dash = edge.dashed ? ` stroke-dasharray="${n(cw * 0.55)} ${n(cw * 0.4)}"` : '';
    lines.push(`<g${cls}><path d="${poly(seg)}"${edge.dashed ? '' : ' pathLength="100"'} fill="none" stroke="${color}" stroke-width="${n(Math.max(1.4, cw * 0.2))}" stroke-linejoin="round" stroke-linecap="round"${dash}/>${arrow(seg, color)}</g>`);
    if (edge.label) lines.push(label(seg[seg.length - 1], edge.label, color, cls));
  }
  if (options.overlays ?? true) {
    const ov = C.overlays(layout, grid, data);
    for (const o of ov.orphans) {
      for (const seg of o.segs) lines.push(`<path d="${poly(seg)}" fill="none" stroke="${PAL.dim}" stroke-width="${n(Math.max(1.4, cw * 0.18))}" stroke-dasharray="1 ${n(cw * 0.55)}" stroke-linecap="round" opacity="0.8"/>`);
      const last = o.segs[o.segs.length - 1];
      if (last) lines.push(label(last[last.length - 1], `orphan ${o.symbol}`, PAL.dim));
    }
    for (const f of ov.forbidden) {
      lines.push(`<path d="${poly(f.seg)}" fill="none" stroke="${PAL.red}" stroke-width="${n(Math.max(1.6, cw * 0.22))}" stroke-dasharray="${n(cw * 0.55)} ${n(cw * 0.4)}" stroke-linecap="round"/>${arrow(f.seg, PAL.red)}`);
      const p = pt(f.cross);
      lines.push(`<rect x="${n(p[0] - cw * 0.7)}" y="${n(p[1] - chh * 0.45)}" width="${n(cw * 1.4)}" height="${n(chh * 0.9)}" fill="${BACKGROUND}"/>${cross(p[0] - cw / 2, p[1], cw, PAL.red, 1)}`);
      lines.push(label(f.cross, 'import-forbidden', PAL.red));
    }
    for (const c of ov.cycles) {
      for (const seg of c.segs) lines.push(`<path d="${poly(seg)}" fill="none" stroke="${PAL.red}" stroke-width="${n(Math.max(2, cw * 0.3))}" stroke-linejoin="round" stroke-linecap="round"/>${arrow(seg, PAL.red)}`);
      lines.push(label(c.segs[0]?.[0], 'cycle', PAL.red));
    }
  }

  const glow = id('glow');
  out.push(`<rect x="0" y="0" width="${n(width)}" height="${n(height)}" rx="${n(cw * 1.5)}" fill="${BACKGROUND}"/>`);
  if (standalone) {
    out.push(
      `<text x="${n(cw * 2)}" y="${n(chh * 1.5)}" fill="${PAL.phos}" font-weight="600">${xml(options.caption ?? `map of ${data.name}`)}</text>`,
      `<path d="M${n(cw * 2)} ${n(chh * 2.4)}H${n(width - cw * 2)}" stroke="${PAL.line}" stroke-width="1" stroke-dasharray="2 4"/>`,
    );
  }
  out.push(`<g transform="translate(0 ${n(top)})">`);
  if (backs.length > 0) out.push(`<g>${backs.join('')}</g>`);
  out.push(`<g filter="url(#${glow})">${walls.join('')}</g>`);
  out.push(`<g font-size="${n(fs)}" text-anchor="middle" dominant-baseline="central">${texts.join('')}</g>`);
  out.push(`<g>${shapes.join('')}</g>`);
  if (lines.length > 0) out.push(`<g font-family="${MAP_FONT}" dominant-baseline="central">${lines.join('')}</g>`);
  out.push('</g>');
  if (standalone) out.push(legend(options.legend ?? DEFAULT_LEGEND, SIT, PAL, cw, chh, top + mapHeight + chh, width));

  const defs = `<defs><filter id="${glow}" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="${n(cw * 0.25)}" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;
  const title = options.title ?? `Map of the ${data.buckets.length === 1 ? '1 bucket' : `${data.buckets.length} buckets`} of ${data.name}`;
  const head = standalone
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}" font-family="${MAP_FONT}" role="img" aria-labelledby="${id('title')}">`
    : `<svg class="map-svg" viewBox="0 0 ${n(width)} ${n(height)}" width="${n(width)}" height="${n(height)}" font-family="${MAP_FONT}" role="img" aria-labelledby="${id('title')}">`;
  const svg = `${head}<title id="${id('title')}">${xml(title)}</title>${defs}${out.join('')}</svg>${standalone ? '\n' : ''}`;
  return { svg, width, height, cols: layout.cols, rows: layout.rows };
}

function cross(x0: number, cy: number, cw: number, color: string, alpha: number): string {
  const w = Math.max(1.8, cw * 0.3);
  return `<path d="M${n(x0 + cw * 0.12)} ${n(cy - cw * 0.5)}L${n(x0 + cw * 0.88)} ${n(cy + cw * 0.5)}M${n(x0 + cw * 0.88)} ${n(cy - cw * 0.5)}L${n(x0 + cw * 0.12)} ${n(cy + cw * 0.5)}" stroke="${color}" stroke-width="${n(w)}"${opacity(alpha)}/>`;
}

const DEFAULT_LEGEND: NonNullable<MapSvgOptions['legend']> = [
  { label: 'ok', tone: 'ok' },
  { label: 'differs from the lock', tone: 'lock' },
  { label: 'violation', tone: 'violation' },
  { label: 'nested project', tone: 'project' },
  { label: 'cycle', tone: 'cycle' },
  { label: 'orphan chain', tone: 'orphan' },
  { label: 'forbidden import', tone: 'forbidden' },
];

function legend(items: NonNullable<MapSvgOptions['legend']>, SIT: Record<MapTone, string>, PAL: MapCore['PAL'], cw: number, chh: number, y: number, width: number): string {
  const parts: string[] = [];
  let x = cw * 2;
  for (const item of items) {
    const w = item.label.length * cw + cw * 6;
    if (x + w > width) break;
    const color = item.tone === 'project' ? PAL.cyan : item.tone === 'cycle' || item.tone === 'forbidden' ? PAL.red : item.tone === 'orphan' ? PAL.dim : SIT[item.tone];
    const cy = y + chh / 2;
    if (item.tone === 'cycle') parts.push(`<path d="M${n(x)} ${n(cy)}h${n(cw * 3)}" stroke="${color}" stroke-width="3"/>`);
    else if (item.tone === 'orphan') parts.push(`<path d="M${n(x)} ${n(cy)}h${n(cw * 3)}" stroke="${color}" stroke-width="2" stroke-dasharray="1 3" stroke-linecap="round"/>`);
    else if (item.tone === 'forbidden') parts.push(`<path d="M${n(x)} ${n(cy)}h${n(cw * 3)}" stroke="${color}" stroke-width="2" stroke-dasharray="4 3"/>`);
    else parts.push(`<rect x="${n(x)}" y="${n(cy - 5)}" width="${n(cw * 3)}" height="10" fill="none" stroke="${color}" stroke-width="2"/>`);
    parts.push(`<text x="${n(x + cw * 4)}" y="${n(cy)}" fill="${PAL.dim}" dominant-baseline="central" font-size="12">${xml(item.label)}</text>`);
    x += w;
  }
  return `<g>${parts.join('')}</g>`;
}
