// The exports of `buckets inspect`: the map of a project as SVG and the bucket graph of every project as Mermaid, which
// the command (`--export`) and the page's download links both call, so a file from either is the same, and the whole
// page as one HTML file (export-html.ts), which only the command writes.
import { diskCache, type CacheStore } from '../core/cache.js';
import { defaultState, mapData } from '../web/inspect-page.js';
import { mermaidGraph, type MermaidGraph } from './export-mermaid.js';
import { MAP_FONT, renderMapSvg, type MapSvg } from './map-svg.js';
import type { InspectSnapshot, ProjectSnapshot } from './snapshot.js';

export const EXPORT_FORMATS = ['svg', 'mermaid', 'html'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/** The exports the live page also offers as downloads. */
export type DownloadFormat = Exclude<ExportFormat, 'html'>;

export const EXPORT_TYPES: Record<DownloadFormat, string> = {
  svg: 'image/svg+xml; charset=utf-8',
  mermaid: 'text/vnd.mermaid; charset=utf-8',
};

function projectOf(snapshot: InspectSnapshot, path: string): ProjectSnapshot {
  return snapshot.projects.find((p) => p.path === path) ?? snapshot.projects[0]!;
}

/** A file name from the project name: letters, digits, dots, dashes and underscores only. */
export function exportFileName(snapshot: InspectSnapshot, format: DownloadFormat, project = '.'): string {
  const name = projectOf(snapshot, format === 'svg' ? project : '.').name.replace(/^@/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'project';
  return format === 'svg' ? `${name}-map.svg` : `${name}-buckets.mmd`;
}

/** The map of one project as a standalone SVG file. */
export function exportSvg(snapshot: InspectSnapshot, project = '.'): MapSvg {
  const target = projectOf(snapshot, project);
  if (target.buckets.length === 0) {
    const text = target.environment ? `The check could not run on ${target.name} (${target.environment.code}), so there is no map.` : `${target.name} has no buckets to draw.`;
    const width = Math.max(480, text.length * 8 + 48);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="96" viewBox="0 0 ${width} 96" font-family="${MAP_FONT}" role="img"><title>${escape(text)}</title><rect width="${width}" height="96" rx="12" fill="#010603"/><text x="24" y="54" fill="#ff6e61" font-size="13">${escape(text)}</text></svg>\n`;
    return { svg, width, height: 96, cols: 0, rows: 0 };
  }
  const data = mapData(snapshot, { ...defaultState(), project: target.path }, 0, 'full');
  const counts = `${target.buckets.length === 1 ? '1 bucket' : `${target.buckets.length} buckets`}, ${target.contracts.length === 1 ? '1 contract' : `${target.contracts.length} contracts`}, ${target.violations.length === 1 ? '1 violation' : `${target.violations.length} violations`}`;
  return renderMapSvg(data, { caption: `slopbuckets map of ${target.name}: ${counts}`, title: `Map of the buckets of ${target.name}: ${counts}` });
}

export function exportMermaid(snapshot: InspectSnapshot): MermaidGraph {
  return mermaidGraph(snapshot);
}

/** The text of an export. */
export function exportText(snapshot: InspectSnapshot, format: DownloadFormat, project = '.'): string {
  return format === 'svg' ? exportSvg(snapshot, project).svg : exportMermaid(snapshot).text;
}

/** The disk cache of the check, read but never written, so an export leaves the project as it was. */
export function readOnlyCache(cacheDir: string): CacheStore {
  const disk = diskCache(cacheDir);
  return { read: (projectDir) => disk.read(projectDir), write: () => undefined };
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
