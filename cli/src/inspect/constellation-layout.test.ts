import { describe, expect, it } from 'vitest';
import { layoutConstellation, outsideKey, type ConstellationLayout, type LayoutLink, type LayoutProject } from './constellation-layout.js';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A small seeded random generator, so a failing graph can be rebuilt. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A repo with nested projects, links between them, links to outside origins and parallel links. */
function graph(size: number, seed: number): { projects: LayoutProject[]; links: LayoutLink[] } {
  const rnd = random(seed);
  const pick = <T>(list: T[]): T => list[Math.floor(rnd() * list.length)]!;
  const projects: LayoutProject[] = [{ path: '.', parent: null }];
  for (let i = 1; i < size; i++) {
    const parent = pick(projects);
    const base = parent.path === '.' ? 'root' : `${parent.path}/root`;
    projects.push({ path: `${base}/b${i}/_/p${i}`, parent: parent.path });
  }
  const outside = ['../shared-sdk', '../vendor/ui', '../../tools/lint', '../a-project-with-a-long-folder-name'];
  const links: LayoutLink[] = [];
  const count = Math.max(1, Math.round(size * 1.5));
  for (let i = 0; i < count; i++) {
    const from = pick(projects).path;
    const name = rnd() < 0.2 ? `a-very-long-link-name-${i}` : `l${i}`;
    if (rnd() < 0.35) {
      // The same outside folder, written relative to the consuming project.
      const depth = from === '.' ? 0 : from.split('/').length;
      links.push({ from, to: null, origin: `${'../'.repeat(depth)}${pick(outside)}`, name });
    } else {
      links.push({ from, to: pick(projects).path, origin: 'x', name });
    }
  }
  // Two parallel links between the same pair, and a project used by two consumers.
  if (size > 2) {
    links.push({ from: '.', to: projects[1]!.path, origin: 'x', name: 'twin-a' });
    links.push({ from: '.', to: projects[1]!.path, origin: 'x', name: 'twin-b' });
    links.push({ from: projects[2]!.path, to: projects[1]!.path, origin: 'x', name: 'second-consumer' });
  }
  return { projects, links };
}

function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/** Whether an axis-aligned segment enters the open interior of a rectangle grown by `pad`. */
function segmentHits([x1, y1]: [number, number], [x2, y2]: [number, number], r: Rect, pad = 0): boolean {
  const left = r.x - pad;
  const right = r.x + r.w + pad;
  const top = r.y - pad;
  const bottom = r.y + r.h + pad;
  if (y1 === y2) return y1 > top && y1 < bottom && Math.max(x1, x2) > left && Math.min(x1, x2) < right;
  if (x1 === x2) return x1 > left && x1 < right && Math.max(y1, y2) > top && Math.min(y1, y2) < bottom;
  throw new Error('not an orthogonal segment');
}

function segments(points: [number, number][]): [[number, number], [number, number]][] {
  return points.slice(1).map((p, i) => [points[i]!, p]);
}

function check(layout: ConstellationLayout, links: LayoutLink[]): void {
  const boxes = layout.boxes;
  const key = (l: LayoutLink): string => (l.to !== null ? `p:${l.to}` : outsideKey(l));
  // Boxes never overlap, with room between them.
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!, 8), `${boxes[i]!.key} / ${boxes[j]!.key}`).toBe(false);
  }
  // Everything is inside the drawing.
  for (const b of boxes) {
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.w).toBeLessThanOrEqual(layout.width);
    expect(b.y + b.h).toBeLessThanOrEqual(layout.height);
  }
  for (const e of layout.edges) {
    const l = links[e.index]!;
    const ends = new Set([`p:${l.from}`, key(l)]);
    for (const [a, b] of segments(e.points)) {
      expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
      for (const box of boxes) {
        // Through no box at all, and with clearance from the boxes it does not connect.
        expect(segmentHits(a, b, box), `link ${l.name} through ${box.key}`).toBe(false);
        if (!ends.has(box.key)) expect(segmentHits(a, b, box, 4), `link ${l.name} grazes ${box.key}`).toBe(false);
      }
    }
    // The line starts on the consumer and ends at the publisher.
    const from = boxes.find((b) => b.key === `p:${l.from}`)!;
    const to = boxes.find((b) => b.key === key(l))!;
    expect(e.points[0]![0]).toBe(from.x + from.w);
    const [ex, ey] = e.points[e.points.length - 1]!;
    expect(Math.abs(ex - (to.outside ? to.x : to.x + to.w))).toBeLessThanOrEqual(1);
    expect(ey).toBeGreaterThan(to.y);
    expect(ey).toBeLessThan(to.y + to.h);
    // The label never covers a box, sits on its own line and no other line crosses it.
    for (const box of boxes) expect(overlaps(e.label, box, 4), `label ${l.name} on ${box.key}`).toBe(false);
    expect(e.points[0]![1]).toBeGreaterThan(e.label.y);
    expect(e.points[0]![1]).toBeLessThan(e.label.y + e.label.h);
    for (const other of layout.edges) {
      if (other === e) continue;
      expect(overlaps(e.label, other.label), `labels ${l.name} / ${links[other.index]!.name}`).toBe(false);
      for (const [a, b] of segments(other.points)) expect(segmentHits(a, b, e.label), `link ${links[other.index]!.name} over label ${l.name}`).toBe(false);
    }
  }
  // Parallel links never share a stretch of line.
  const lines = layout.edges.flatMap((e) => segments(e.points).map((s) => ({ e: e.index, s })));
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const p = lines[i]!;
      const q = lines[j]!;
      if (p.e === q.e) continue;
      const [[a1x, a1y], [a2x, a2y]] = p.s;
      const [[b1x, b1y], [b2x, b2y]] = q.s;
      if (a1x === a2x && b1x === b2x && a1x === b1x && a1y !== a2y && b1y !== b2y) {
        expect(Math.max(a1y, a2y) <= Math.min(b1y, b2y) || Math.max(b1y, b2y) <= Math.min(a1y, a2y), `vertical overlap ${links[p.e]!.name} / ${links[q.e]!.name}`).toBe(true);
      }
      if (a1y === a2y && b1y === b2y && a1y === b1y && a1x !== a2x && b1x !== b2x) {
        expect(Math.max(a1x, a2x) <= Math.min(b1x, b2x) || Math.max(b1x, b2x) <= Math.min(a1x, a2x), `horizontal overlap ${links[p.e]!.name} / ${links[q.e]!.name}`).toBe(true);
      }
    }
  }
  // Nesting lines go from a parent to its child without crossing another box.
  for (const n of layout.nests) {
    for (const [a, b] of segments(n.points)) {
      for (const box of boxes) expect(segmentHits(a, b, box), `nesting ${n.child} through ${box.key}`).toBe(false);
    }
  }
}

describe('layoutConstellation', () => {
  it('lays out the owner case: a link from the repo to an outside project passes beside the nested project', () => {
    const projects = [
      { path: '.', parent: null },
      { path: 'root/web/_/widgetkit', parent: '.' },
    ];
    const links = [{ from: '.', to: null, origin: '../shared-sdk', name: 'sdk' }];
    const layout = layoutConstellation(projects, links);
    check(layout, links);
    const kit = layout.boxes.find((b) => b.key === 'p:root/web/_/widgetkit')!;
    const sdk = layout.boxes.find((b) => b.key === 'o:../shared-sdk')!;
    expect(sdk.x).toBeGreaterThan(kit.x + kit.w);
    expect(layout.nests).toHaveLength(1);
  });

  it('puts one box per outside folder, however each consumer writes the path', () => {
    const projects = [
      { path: '.', parent: null },
      { path: 'root/a/_/kit', parent: '.' },
    ];
    const links = [
      { from: '.', to: null, origin: '../shared-sdk', name: 'sdk' },
      { from: 'root/a/_/kit', to: null, origin: '../../../../../shared-sdk', name: 'sdk' },
    ];
    const layout = layoutConstellation(projects, links);
    expect(layout.boxes.filter((b) => b.outside).map((b) => b.key)).toEqual(['o:../shared-sdk']);
    check(layout, links);
  });

  it('cuts long labels and keeps the full name for the title', () => {
    const projects = [{ path: '.', parent: null }];
    const links = [{ from: '.', to: null, origin: '../x', name: 'an-extremely-long-link-name' }];
    const label = layoutConstellation(projects, links).edges[0]!.label;
    expect(label.cut).toBe(true);
    expect(label.text.endsWith('…')).toBe(true);
  });

  it('draws a project alone and a graph without links', () => {
    check(layoutConstellation([{ path: '.', parent: null }], []), []);
    const projects = graph(6, 1).projects;
    const layout = layoutConstellation(projects, []);
    expect(layout.edges).toEqual([]);
    expect(layout.nests).toHaveLength(5);
    check(layout, []);
  });

  for (const [size, seed] of [
    [3, 7],
    [5, 11],
    [10, 23],
    [20, 42],
    [40, 99],
    [60, 1234],
  ] as const) {
    it(`no overlaps on a generated graph of ${size} projects (seed ${seed})`, () => {
      const { projects, links } = graph(size, seed);
      check(layoutConstellation(projects, links), links);
    });
  }
});
