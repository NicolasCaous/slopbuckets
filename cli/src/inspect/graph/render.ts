// SVG markup of a laid out graph, shared by the page (index.ts) and `--export svg` (svg.ts).
import type { SnapshotBucket, SnapshotProject } from '../../contract/browser.js';
import { NODE_HEIGHT, type Layout } from './layout.js';
import { edgeId, edgeName, formatCount, formatNumber, nodeName } from './model.js';

export const escapeXml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A vertical-tangent curve between layers and a straight line through the rows a long edge crosses. */
export function edgePath(points: [number, number][]): string {
  let d = `M${points[0]![0]} ${points[0]![1]}`;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]!;
    const [bx, by] = points[i]!;
    const my = (ay + by) / 2;
    d += ax === bx ? `L${bx} ${by}` : `C${ax} ${my} ${bx} ${my} ${bx} ${by}`;
  }
  return d;
}

/** The end of a node's tooltip: the public files of the bucket. */
const publicTitle = (bucket: SnapshotBucket) =>
  bucket.public.length === 0 ? 'Closed, no public file' : `Public: ${bucket.public.map((p) => p.file).join(', ')}`;

/** Arrowheads. Fixed ids: the page has one graph view, and an exported SVG is its own document. */
export const MARKER_DEFS =
  '<defs>' +
  [
    ['gv-arrow', 'gv-arrow-shape'],
    ['gv-arrow-pending', 'gv-arrow-shape gv-arrow-pending'],
    ['gv-arrow-accent', 'gv-arrow-shape gv-arrow-accent'],
    ['gv-arrow-dim', 'gv-arrow-shape gv-arrow-dim'],
  ]
    .map(([id, cls]) => `<marker id="${id}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path class="${cls}" d="M0 0L10 5L0 10z"/></marker>`)
    .join('') +
  '</defs>';

/**
 * Edges first, then nodes. With `interactive`, every node and edge is a focusable button with an accessible name and
 * a hidden "changed" mark that the view shows with a class.
 */
export function graphMarkup(layout: Layout, project: SnapshotProject, pending: Map<string, number>, interactive: boolean): string {
  const buckets = new Map(project.buckets.map((b) => [b.name, b]));
  const edges = new Map(project.edges.map((e) => [edgeId(e.from, e.to), e]));
  const a11y = (name: string) => (interactive ? ` role="button" tabindex="-1" aria-label="${escapeXml(name)}"` : '');
  let out = '';
  for (const le of layout.edges) {
    const id = edgeId(le.from, le.to);
    const edge = edges.get(id)!;
    const d = edgePath(le.points);
    const title = edge.reason ? `${edgeName(edge)}. Reason: ${edge.reason}` : edgeName(edge);
    const [mx, my] = le.points[Math.floor(le.points.length / 2)]!;
    out +=
      `<g class="gv-edge gv-${edge.state}" data-id="${escapeXml(id)}"${a11y(edgeName(edge))}>` +
      `<title>${escapeXml(title)}</title>` +
      (interactive ? `<path class="gv-hit" d="${d}"/>` : '') +
      `<path class="gv-line" d="${d}"/>` +
      (interactive ? `<circle class="gv-mark" cx="${mx}" cy="${my}" r="4"/>` : '') +
      '</g>';
  }
  for (const ln of layout.nodes) {
    const bucket = buckets.get(ln.id)!;
    const count = pending.get(ln.id) ?? 0;
    const badge = count > 0 ? formatNumber(count) : '';
    const badgeWidth = 12 + badge.length * 7;
    out +=
      `<g class="gv-node" data-id="${escapeXml(ln.id)}" transform="translate(${ln.x} ${ln.y})"${a11y(nodeName(ln.id, bucket.fileCount, count))}>` +
      `<title>${escapeXml(`${ln.id}: ${bucket.purpose}. ${publicTitle(bucket)}`)}</title>` +
      `<rect class="gv-box" width="${ln.width}" height="${NODE_HEIGHT}" rx="6"/>` +
      `<text class="gv-name" x="12" y="19" translate="no">${escapeXml(ln.id)}</text>` +
      `<text class="gv-count" x="12" y="35">${formatCount(bucket.fileCount, 'file', 'files')}</text>` +
      (badge
        ? `<g class="gv-badge" transform="translate(${ln.width - badgeWidth + 6} -9)"><rect width="${badgeWidth}" height="18" rx="9"/>` +
          `<text x="${badgeWidth / 2}" y="13" text-anchor="middle">${badge}</text></g>`
        : '') +
      (interactive ? '<circle class="gv-mark" cx="0" cy="0" r="5"/>' : '') +
      '</g>';
  }
  return out;
}

/**
 * Shared by the page and the export. The selection and pending colors come from the page's --sel and --bad, so the page
 * has one blue and one red; an exported SVG has no page and uses the light values. The page adds the dark theme and the
 * interaction states (index.ts).
 */
export const GRAPH_CSS = `
.gv { --gv-text: #1f2328; --gv-muted: #59636e; --gv-surface: #ffffff; --gv-line: #8c959f;
  --gv-accent: var(--sel, #0b5fd0); --gv-accent-soft: var(--sel-soft, #dce8fb); --gv-pending: var(--bad, #c42525);
  --gv-on-pending: #ffffff; }
.gv text { font: 12px system-ui, -apple-system, "Segoe UI", sans-serif; fill: var(--gv-muted); font-variant-numeric: tabular-nums; }
.gv .gv-name { font: 600 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: var(--gv-text); }
.gv .gv-heading { font-size: 14px; font-weight: 600; fill: var(--gv-text); }
.gv-box { fill: var(--gv-surface); stroke: var(--gv-line); stroke-width: 1; }
.gv-line { fill: none; stroke: var(--gv-line); stroke-width: 1.25; marker-end: url(#gv-arrow); }
.gv-arrow-shape { fill: var(--gv-line); }
.gv-arrow-pending { fill: var(--gv-pending); }
.gv-arrow-accent { fill: var(--gv-accent); }
.gv-unused .gv-line { stroke-dasharray: 6 4; }
.gv-undeclared .gv-line { stroke: var(--gv-pending); stroke-width: 2; stroke-dasharray: 0.1 4; stroke-linecap: round; marker-end: url(#gv-arrow-pending); }
.gv-badge rect { fill: var(--gv-pending); }
.gv .gv-badge text { fill: var(--gv-on-pending); font-size: 11px; font-weight: 600; }
`;
