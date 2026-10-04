// The pages of `buckets inspect --export html`: one HTML file with the snapshot in it and no server behind it. The
// state of a page lives in the URL hash (`#view=matrix&bucket=root/core`) where the live page has the query, and every
// page comes from the same renderers as the live pages. The CLI renders the first page into the file with this module,
// and the page script renders every page after it with the same module bundled for the browser
// (inspect-static-entry.ts), so the file and the live page cannot drift apart.
import type { FeedEvent } from '../inspect/events.js';
import { exportFileName, exportMermaid, exportSvg } from '../inspect/export.js';
import type { CodeExport } from '../inspect/impact.js';
import type { InspectSnapshot } from '../inspect/snapshot.js';
import type { Timeline } from '../inspect/timeline.js';
import type { Lock } from '../core/types.js';
import { escapeHtml, raw } from './html.js';
import { inspectPageOptions, parseState, type PageInput, type StaticInfo } from './inspect-page.js';
import { renderNav, type PageOptions } from './layout.js';

/** The id of the `<script type="application/json">` that holds the data of the file. */
export const STATIC_DATA_ID = 'buckets-static';

/** Everything the file shows, read once by the CLI when it exports. */
export interface StaticData {
  snapshot: InspectSnapshot;
  /** The approvals from git, read at export time, or null when there is no history to show. */
  timeline: Timeline | null;
  /** Exports of the `_/` files of each project, for the path simulation, packed by `packExports`. */
  exports: Record<string, PackedExports>;
  feed: FeedEvent[];
  info: StaticInfo;
}

/**
 * The data as the file holds it. Consecutive approvals of a project mostly hold the same lock, so each point after the
 * first keeps only what changed: a bucket list or a DMZ entry equal to the one of the approval before becomes 0.
 */
export type StaticFileData = Omit<StaticData, 'timeline'> & { timeline: Timeline | null };

type DmzEntry = Lock['dmz'][string];

export function packStaticData(data: StaticData): StaticFileData {
  if (data.timeline === null) return data;
  const tracks = data.timeline.tracks.map((track) => {
    let before: Lock | null = null;
    const points = track.points.map((point) => {
      const lock = point.lock;
      const prev = before;
      if (lock !== null) before = lock;
      if (lock === null || prev === null) return point;
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      const dmz: Record<string, DmzEntry | 0> = {};
      for (const [file, entry] of Object.entries(lock.dmz)) dmz[file] = prev.dmz[file] !== undefined && same(prev.dmz[file], entry) ? 0 : entry;
      const packed = { ...lock, buckets: same(prev.buckets, lock.buckets) ? 0 : lock.buckets, dmz };
      return { ...point, lock: packed as unknown as Lock };
    });
    return { ...track, points };
  });
  return { ...data, timeline: { tracks } };
}

export function unpackStaticData(file: StaticFileData): StaticData {
  if (file.timeline === null) return file;
  const tracks = file.timeline.tracks.map((track) => {
    let before: Lock | null = null;
    const points = track.points.map((point) => {
      const packed = point.lock as unknown as (Omit<Lock, 'buckets' | 'dmz'> & { buckets: string[] | 0; dmz: Record<string, DmzEntry | 0> }) | null;
      if (packed === null) return point;
      const prev: Lock | null = before;
      const dmz: Lock['dmz'] = {};
      for (const [name, entry] of Object.entries(packed.dmz)) dmz[name] = entry === 0 ? prev!.dmz[name]! : entry;
      const lock: Lock = { ...packed, buckets: packed.buckets === 0 ? prev!.buckets : packed.buckets, dmz };
      before = lock;
      return { ...point, lock };
    });
    return { ...track, points };
  });
  return { ...file, timeline: { tracks } };
}

/** Export names by file. A type-only export is written `type Name`. */
export type PackedExports = Record<string, string[]>;

export function packExports(list: CodeExport[]): PackedExports {
  const out: PackedExports = {};
  for (const e of list) (out[e.file] ??= []).push(e.typeOnly ? `type ${e.name}` : e.name);
  return out;
}

export function unpackExports(packed: PackedExports): CodeExport[] {
  const out: CodeExport[] = [];
  for (const [file, names] of Object.entries(packed)) {
    // A code file is `<bucket>/_/<path>`, and no bucket is called `_`.
    const bucket = file.slice(0, file.indexOf('/_/'));
    for (const name of names) out.push({ bucket, file, name: name.replace(/^type /, ''), typeOnly: name.startsWith('type ') });
  }
  return out;
}

/** A URL of the file as the live page would have it: `#view=matrix` and `/?view=matrix` give `/?view=matrix`, `#` gives `/`. */
export function internalUrl(url: string): string {
  const query = url.startsWith('#') ? url.slice(1).replace(/^\?/, '') : url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  return query === '' ? '/' : `/?${query}`;
}

/** Links of a rendered page as hash links: `href="/?view=matrix"` becomes `href="#view=matrix"`, `href="/"` becomes `href="#"`. */
export function hashLinks(text: string): string {
  return text.replace(/ href="\/(?:\?([^"]*))?"/g, (_m, query: string | undefined) => ` href="#${query ?? ''}"`);
}

/** The input of the live renderers for a URL of the file. */
export function staticInput(data: StaticData, url: string): PageInput {
  const state = parseState(new URL(internalUrl(url), 'http://snapshot.invalid'), data.snapshot);
  return {
    token: '',
    snapshot: data.snapshot,
    feed: data.feed,
    version: 1,
    state,
    watch: 'off',
    static: data.info,
    ...(data.timeline !== null ? { timeline: data.timeline } : {}),
    ...(state.view === 'impact' && state.sim === 'path' ? { exports: unpackExports(data.exports[state.project] ?? {}) } : {}),
  };
}

/** A link of the live page as a hash link: `/?view=matrix` becomes `#view=matrix`, `/` becomes `#`. Other links stay. */
export function hashHref(link: string): string {
  return link === '/' ? '#' : link.startsWith('/?') ? `#${link.slice(2)}` : link;
}

/** The shell options of the live page for a URL of the file, with hash links in the windows and the content. */
export function staticOptions(data: StaticData, url: string): PageOptions {
  const options = inspectPageOptions(staticInput(data, url));
  return {
    ...options,
    nav: options.nav.map((item) => (item.href === undefined ? item : { ...item, href: hashHref(item.href) })),
    main: raw(hashLinks(options.main.value)),
  };
}

/** What the page script swaps in for a URL: the title, the windows of the top bar, the status and the content. */
export function staticDocument(data: StaticData, url: string): string {
  const options = staticOptions(data, url);
  return (
    `<!doctype html><html lang="en"><head><title>${escapeHtml(options.title)}</title></head><body>` +
    `<nav class="tmux-nav">${renderNav(options.nav, options.project).value}</nav>` +
    `<span id="server-status"><span class="label">${escapeHtml(options.status.label)}</span></span>` +
    `<main id="main">\n${options.main.value}\n</main></body></html>`
  );
}

/** A download link of the page (`/export/map.svg?project=…` or `/export/buckets.mmd`) as a file, made in the browser. */
export function staticExport(data: StaticData, link: string): { name: string; type: string; text: string } | null {
  const url = new URL(link, 'http://snapshot.invalid');
  if (url.pathname === '/export/map.svg') {
    const project = url.searchParams.get('project') ?? '.';
    return { name: exportFileName(data.snapshot, 'svg', project), type: 'image/svg+xml', text: exportSvg(data.snapshot, project).svg };
  }
  if (url.pathname === '/export/buckets.mmd') return { name: exportFileName(data.snapshot, 'mermaid'), type: 'text/plain', text: exportMermaid(data.snapshot).text };
  return null;
}
