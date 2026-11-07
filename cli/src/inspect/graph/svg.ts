// `buckets inspect --export svg`: every project's layered graph in one standalone SVG, stacked top to bottom.
import type { SnapshotV2 } from '../../contract/browser.js';
import { computeLayout } from './layout.js';
import { GRAPH_CSS, MARKER_DEFS, escapeXml, graphMarkup } from './render.js';
import { layoutInput, pendingCounts } from './model.js';

const MARGIN = 24;
const LEGEND = 'Solid line: declared and imported. Dashed: declared, not imported. Red dotted: imported, not declared.';

/** `rootName` is the heading of the root project; the command passes its folder name. */
export function renderGraphSvg(snapshot: SnapshotV2, rootName = 'root project'): string {
  let y = MARGIN;
  let width = 720;
  let body = `<text class="gv-legend" x="${MARGIN}" y="${y + 12}">${LEGEND}</text>`;
  y += 36;
  for (const project of snapshot.projects) {
    const heading = `Project ${project.path === '.' ? rootName : project.path}`;
    body += `<text class="gv-heading" x="${MARGIN}" y="${y + 14}">${escapeXml(heading)}</text>`;
    y += 32;
    if (project.environment !== null || project.buckets.length === 0) {
      const note = project.environment !== null ? 'This project could not be checked.' : 'No buckets.';
      body += `<text x="${MARGIN}" y="${y + 12}">${note}</text>`;
      y += 40;
      continue;
    }
    const layout = computeLayout(layoutInput(project, null));
    // The badges stick out 9px above the top row.
    body += `<g transform="translate(${MARGIN} ${y + 9})">${graphMarkup(layout, project, pendingCounts(project), false)}</g>`;
    y += layout.height + 9 + 40;
    width = Math.max(width, layout.width + 2 * MARGIN);
  }
  const height = y - 40 + MARGIN;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="gv" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<style>${GRAPH_CSS}</style>${MARKER_DEFS}` +
    `<rect width="100%" height="100%" fill="#ffffff"/>${body}</svg>\n`
  );
}
