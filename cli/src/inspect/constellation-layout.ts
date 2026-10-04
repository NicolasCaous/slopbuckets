// The layout of the projects constellation on the inspect page. The visible projects form a tree in a left column,
// each nested project indented under its parent with an elbow line on the left. Origins outside the visible projects
// sit in a column on the right. A link leaves the right side of the consuming box, runs to a vertical track of its
// own between the columns and enters the publishing box from the side, so it never crosses a box. Its label sits
// on the first horizontal stretch, in a gutter that no other line crosses.
import path from 'node:path';

export interface LayoutProject {
  path: string;
  parent: string | null;
}

export interface LayoutLink {
  from: string;
  /** The visible project that publishes the link, or null when the origin is outside them. */
  to: string | null;
  /** The origin folder, relative to the consuming project. */
  origin: string;
  name: string;
}

export interface LayoutBox {
  /** `p:<project path>` for a visible project, `o:<origin>` for an origin outside them. */
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  outside: boolean;
  /** Nesting depth for a visible project, 0 for an outside origin. */
  depth: number;
}

export interface LayoutLabel {
  text: string;
  /** The background rectangle; the text starts at `x + LABEL_PAD` on the baseline `baseline`. */
  x: number;
  y: number;
  w: number;
  h: number;
  baseline: number;
  /** True when the text was cut to fit; the full name is in the title and the side panel. */
  cut: boolean;
}

export interface LayoutEdge {
  /** Index in the input links. */
  index: number;
  points: [number, number][];
  /** The SVG path, orthogonal with rounded corners. */
  d: string;
  label: LayoutLabel;
}

export interface LayoutNest {
  parent: string;
  child: string;
  points: [number, number][];
  d: string;
}

export interface ConstellationLayout {
  width: number;
  height: number;
  boxes: LayoutBox[];
  edges: LayoutEdge[];
  nests: LayoutNest[];
}

export const BOX_W = 210;
export const BOX_H = 64;
const INDENT = 40;
const ROW_GAP = 26;
const PAD = 24;
const PORT_GAP = 20;
const TRACK_GAP = 14;
const TRACK_MARGIN = 10;
const CORNER = 6;
const LABEL_CHARS = 18;
const CHAR_W = 7.4;
const LABEL_PAD = 5;
const LABEL_H = 18;
const GUTTER_GAP = 14;
const COLUMN_GAP = 28;

/** The key of the box an outside origin goes to: its folder resolved from the starting project. */
export function outsideKey(link: LayoutLink): string {
  const from = link.from === '.' ? '' : link.from;
  return `o:${path.posix.normalize(path.posix.join(from, link.origin.replace(/\\/g, '/'))).replace(/\/$/, '')}`;
}

function cutLabel(text: string): { text: string; cut: boolean } {
  return text.length > LABEL_CHARS ? { text: `${text.slice(0, LABEL_CHARS - 1)}…`, cut: true } : { text, cut: false };
}

function labelWidth(text: string): number {
  return Math.ceil(text.length * CHAR_W) + 2 * LABEL_PAD;
}

/** An orthogonal polyline as a path with rounded corners. */
export function roundedPath(points: [number, number][]): string {
  const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1]![0] || p[1] !== points[i - 1]![1]);
  let d = `M${pts[0]![0]} ${pts[0]![1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i]!;
    const next = pts[i + 1];
    if (next === undefined) {
      d += ` L${x} ${y}`;
      break;
    }
    const [px, py] = pts[i - 1]!;
    const inLen = Math.abs(x - px) + Math.abs(y - py);
    const outLen = Math.abs(next[0] - x) + Math.abs(next[1] - y);
    const r = Math.min(CORNER, inLen / 2, outLen / 2);
    const ax = x - Math.sign(x - px) * r;
    const ay = y - Math.sign(y - py) * r;
    const bx = x + Math.sign(next[0] - x) * r;
    const by = y + Math.sign(next[1] - y) * r;
    d += ` L${ax} ${ay} Q${x} ${y} ${bx} ${by}`;
  }
  return d;
}

interface Port {
  edge: number;
  role: 'src' | 'dst';
  /** The center of the box at the other end, to order the ports and avoid crossings near the box. */
  other: number;
  y: number;
}

/** Lays out the constellation. Pure, so the tests can check it on generated graphs. */
export function layoutConstellation(projects: LayoutProject[], links: LayoutLink[]): ConstellationLayout {
  // The tree of visible projects, depth first, in the order of the input.
  const known = new Set(projects.map((p) => p.path));
  const children = new Map<string | null, LayoutProject[]>();
  for (const p of projects) {
    const parent = p.parent !== null && known.has(p.parent) && p.parent !== p.path ? p.parent : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(p);
  }
  const order: { project: LayoutProject; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number): void => {
    for (const p of children.get(parent) ?? []) {
      if (seen.has(p.path)) continue;
      seen.add(p.path);
      order.push({ project: p, depth });
      walk(p.path, depth + 1);
    }
  };
  walk(null, 0);
  // A parent cycle leaves projects unreached: show them as roots.
  for (const p of projects) {
    if (!seen.has(p.path)) {
      seen.add(p.path);
      order.push({ project: p, depth: 0 });
      walk(p.path, 1);
    }
  }

  // Which side ports each box needs: every link starts on the right side of its consumer and ends on the right side
  // of a visible publisher or on the left side of an outside origin.
  const targetKey = (l: LayoutLink): string => (l.to !== null && known.has(l.to) ? `p:${l.to}` : outsideKey(l));
  const ports = new Map<string, Port[]>();
  const addPort = (key: string, port: Port): void => {
    if (!ports.has(key)) ports.set(key, []);
    ports.get(key)!.push(port);
  };
  links.forEach((l, i) => {
    addPort(`p:${l.from}`, { edge: i, role: 'src', other: 0, y: 0 });
    addPort(targetKey(l), { edge: i, role: 'dst', other: 0, y: 0 });
  });
  const heightOf = (key: string): number => Math.max(BOX_H, ((ports.get(key)?.length ?? 0) + 1) * PORT_GAP);

  const boxes = new Map<string, LayoutBox>();
  let y = PAD;
  let treeRight = PAD + BOX_W;
  for (const { project, depth } of order) {
    const key = `p:${project.path}`;
    const box: LayoutBox = { key, x: PAD + depth * INDENT, y, w: BOX_W, h: heightOf(key), outside: false, depth };
    boxes.set(key, box);
    y += box.h + ROW_GAP;
    treeRight = Math.max(treeRight, box.x + box.w);
  }
  const treeBottom = y - ROW_GAP;

  // Outside origins: as close as possible to the height of their consumers, in that order, without overlapping.
  const outsideKeys = [...new Set(links.filter((l) => targetKey(l).startsWith('o:')).map(targetKey))];
  const center = (b: LayoutBox): number => b.y + b.h / 2;
  const wanted = new Map<string, number>();
  for (const key of outsideKeys) {
    const from = links.filter((l) => targetKey(l) === key).map((l) => center(boxes.get(`p:${l.from}`)!));
    wanted.set(key, from.reduce((a, b) => a + b, 0) / from.length);
  }
  outsideKeys.sort((a, b) => wanted.get(a)! - wanted.get(b)! || (a < b ? -1 : 1));
  let next = PAD;
  for (const key of outsideKeys) {
    const h = heightOf(key);
    const top = Math.max(next, Math.round(wanted.get(key)! - h / 2));
    boxes.set(key, { key, x: 0, y: top, w: BOX_W, h, outside: true, depth: 0 });
    next = top + h + ROW_GAP;
  }

  // Port heights, ordered by the height of the other end so lines near a box do not cross each other.
  links.forEach((l, i) => {
    const a = boxes.get(`p:${l.from}`)!;
    const b = boxes.get(targetKey(l))!;
    for (const port of ports.get(a.key)!) if (port.edge === i && port.role === 'src') port.other = center(b);
    for (const port of ports.get(b.key)!) if (port.edge === i && port.role === 'dst') port.other = center(a);
  });
  for (const [key, list] of ports) {
    const box = boxes.get(key)!;
    list.sort((p, q) => p.other - q.other || (p.role === q.role ? p.edge - q.edge : p.role === 'src' ? -1 : 1));
    list.forEach((port, j) => {
      port.y = Math.round(box.y + ((j + 1) * box.h) / (list.length + 1));
    });
  }
  const portY = (key: string, edge: number, role: 'src' | 'dst'): number => ports.get(key)!.find((p) => p.edge === edge && p.role === role)!.y;

  // Labels in a gutter right of the tree, on the line that leaves the consumer.
  const labels = links.map((l) => cutLabel(l.name));
  const gutterX = treeRight + GUTTER_GAP;
  const gutterW = links.length === 0 ? 0 : Math.max(...labels.map((t) => labelWidth(t.text))) + GUTTER_GAP;
  const trackX0 = gutterX + gutterW;

  // Vertical tracks: links between visible projects nearest the tree, links to outside origins after them. Two links
  // share a track only when their vertical stretches are apart; the shortest stretches take the inner tracks.
  const spans = links.map((l, i) => {
    const s = portY(`p:${l.from}`, i, 'src');
    const t = portY(targetKey(l), i, 'dst');
    return { i, s, t, lo: Math.min(s, t), hi: Math.max(s, t), outside: targetKey(l).startsWith('o:') };
  });
  const track = new Array<number>(links.length).fill(0);
  let trackCount = 0;
  for (const group of [spans.filter((s) => !s.outside), spans.filter((s) => s.outside)]) {
    const used: { lo: number; hi: number }[][] = [];
    const sorted = [...group].sort((a, b) => a.hi - a.lo - (b.hi - b.lo) || a.lo - b.lo || a.i - b.i);
    for (const span of sorted) {
      let t = used.findIndex((list) => list.every((o) => span.lo > o.hi + TRACK_MARGIN || o.lo > span.hi + TRACK_MARGIN));
      if (t === -1) {
        t = used.length;
        used.push([]);
      }
      used[t]!.push(span);
      track[span.i] = trackCount + t;
    }
    trackCount += used.length;
  }
  const trackX = (i: number): number => trackX0 + track[i]! * TRACK_GAP;
  const outsideX = links.length === 0 ? treeRight : trackX0 + Math.max(0, trackCount - 1) * TRACK_GAP + COLUMN_GAP;
  for (const key of outsideKeys) boxes.get(key)!.x = outsideX;

  const edges: LayoutEdge[] = links.map((l, i) => {
    const a = boxes.get(`p:${l.from}`)!;
    const b = boxes.get(targetKey(l))!;
    const { s, t } = spans[i]!;
    const x = trackX(i);
    const end = b.outside ? b.x - 1 : b.x + b.w + 1;
    const points: [number, number][] = [
      [a.x + a.w, s],
      [x, s],
      [x, t],
      [end, t],
    ];
    const cut = labels[i]!;
    const w = labelWidth(cut.text);
    return {
      index: i,
      points,
      d: roundedPath(points),
      label: { text: cut.text, cut: cut.cut, x: gutterX, y: s - LABEL_H / 2, w, h: LABEL_H, baseline: s + 4 },
    };
  });

  // Nesting: an elbow from under the parent down the left of its children.
  const nests: LayoutNest[] = [];
  for (const { project } of order) {
    const parent = project.parent !== null ? boxes.get(`p:${project.parent}`) : undefined;
    const child = boxes.get(`p:${project.path}`)!;
    if (!parent || parent === child || child.depth !== parent.depth + 1) continue;
    const trunk = parent.x + INDENT / 2;
    const points: [number, number][] = [
      [trunk, parent.y + parent.h],
      [trunk, center(child)],
      [child.x, center(child)],
    ];
    nests.push({ parent: parent.key, child: child.key, points, d: roundedPath(points) });
  }

  const all = [...boxes.values()];
  const width = Math.ceil(Math.max(treeRight, ...all.map((b) => b.x + b.w)) + PAD);
  const height = Math.ceil(Math.max(treeBottom, ...all.map((b) => b.y + b.h)) + PAD);
  return { width, height, boxes: all, edges, nests };
}
