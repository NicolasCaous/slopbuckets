// The server side of `buckets inspect`: the pages, the snapshot as JSON, and a Server-Sent Events stream that tells
// open pages when the project changed. A watcher per project reruns the check (with the analysis cache) after a
// quiet period and compares the snapshots for the event feed. Inspect is read only: it has no endpoint that changes
// anything, and the only thing it writes is the analysis cache of the check in `.buckets/cache/`.
import path from 'node:path';
import { CACHE_DIR } from '../core/cache.js';
import { resolveOrigin } from '../core/links.js';
import type { Context } from '../core/types.js';
import { snapshotDiff, staleViews } from '../inspect/diff.js';
import { feedEvent, fileEvents, snapshotEvents, type FeedEvent } from '../inspect/events.js';
import { EXPORT_TYPES, exportFileName, exportMermaid, exportSvg, type DownloadFormat } from '../inspect/export.js';
import { codeExports, type CodeExport } from '../inspect/impact.js';
import { buildSnapshot, type InspectSnapshot } from '../inspect/snapshot.js';
import { approvalDiff, lockView, systemGit, timelineCache, type GitRunner, type Timeline } from '../inspect/timeline.js';
import { watchProjects, type ProjectWatcher } from '../inspect/watch.js';
import { plural } from '../output/text.js';
import { INSPECT_CSS, INSPECT_JS } from './assets/inspect.js';
import { navItems, parseState, renderFeed, renderInspectPage, statusLabel, VIEWS, type PageInput } from './inspect-page.js';
import { renderNav, sharedAssetRoutes } from './layout.js';
import { asset, EventHub, htmlPage, json, startWebServer, type WebServer } from './server.js';

export const INSPECT_IDLE_MINUTES = 30;
const FEED_SIZE = 120;
/** Rendered pages kept for the current snapshot, so a reload or a live update of an open page renders nothing twice. */
const PAGE_CACHE_SIZE = 48;

export interface InspectAppOptions {
  ctx: Context;
  projectDir: string;
  /** The first snapshot, when the command already built it. */
  snapshot?: InspectSnapshot;
  /** Shuts down after this long without requests while no page is connected. Default 30 minutes. */
  idleTimeoutMs?: number;
  /** False turns the watcher off. `polling` forces polling. */
  watch?: boolean | 'polling';
  debounceMs?: number;
  pollMs?: number;
  /** For tests: a fixed port and token. */
  port?: number;
  token?: string;
  /** How git runs, for the timeline. Tests pass a fake. */
  git?: GitRunner;
}

export interface InspectApp {
  server: WebServer;
  /** The snapshot the pages show now. */
  snapshot(): InspectSnapshot;
  /** Increases with every new snapshot. */
  version(): number;
  feed(): FeedEvent[];
  /** Reruns the check now, as if `paths` changed, and resolves once the new snapshot is published. */
  refresh(paths?: string[]): Promise<void>;
  /** How files are watched. */
  watchMode(): 'native' | 'polling' | 'off';
  /** The approvals of every project, read from git and kept while nothing changes. */
  timeline(): Promise<Timeline>;
  close(): Promise<void>;
}

/** Folders to watch: every project, and the origin folders of links that live outside every project. */
export function watchDirs(snapshot: InspectSnapshot): string[] {
  const dirs = snapshot.projects.map((p) => p.dir);
  const inside = (abs: string) => dirs.some((d) => {
    const rel = path.relative(d, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  const extra = new Set<string>();
  for (const project of snapshot.projects) {
    for (const link of project.links) {
      const origin = resolveOrigin(project.dir, link.origin);
      if (!inside(origin)) extra.add(origin);
    }
  }
  // A folder inside another watched folder still gets its own watcher: one per project, as the feed is per project.
  return [...new Set([...dirs, ...extra])];
}

function projectLabelOf(input: PageInput): string {
  const project = input.snapshot.projects.find((p) => p.path === input.state.project) ?? input.snapshot.projects[0]!;
  return project.path === '.' ? project.name : `${project.name} (${project.path})`;
}

export async function startInspectApp(options: InspectAppOptions): Promise<InspectApp> {
  const { ctx, projectDir } = options;
  const cacheDir = path.join(projectDir, CACHE_DIR);
  let snapshot = options.snapshot ?? (await buildSnapshot(ctx, projectDir, { cacheDir }));
  let version = 1;
  let feed: FeedEvent[] = [];
  const hub = new EventHub();
  let watcher: ProjectWatcher | null = null;
  let running: Promise<void> | null = null;
  let again: string[] | null = null;
  let closed = false;
  const timelines = timelineCache(options.git ?? systemGit());
  const timeline = (): Promise<Timeline> => timelines.get(snapshot);
  const pageCache: { generation: string; pages: Map<string, string> } = { generation: '', pages: new Map() };
  let exportsMemo: { version: number; project: string; list: CodeExport[] } | null = null;
  const exportsOf = (project: string): CodeExport[] => {
    if (exportsMemo !== null && exportsMemo.version === version && exportsMemo.project === project) return exportsMemo.list;
    const target = snapshot.projects.find((p) => p.path === project);
    const list = target ? codeExports(target) : [];
    exportsMemo = { version, project, list };
    return list;
  };
  const download = (format: DownloadFormat, project: string) => () => {
    const text = format === 'svg' ? exportSvg(snapshot, project).svg : exportMermaid(snapshot).text;
    return { status: 200, headers: { 'content-type': EXPORT_TYPES[format], 'content-disposition': `attachment; filename="${exportFileName(snapshot, format, project)}"` }, body: text };
  };

  const push = (events: FeedEvent[]): void => {
    if (events.length === 0) return;
    feed = [...[...events].reverse(), ...feed].slice(0, FEED_SIZE);
  };

  async function rerun(paths: string[]): Promise<void> {
    const at = new Date();
    const before = snapshot;
    let next: InspectSnapshot;
    try {
      next = await buildSnapshot(ctx, projectDir, { cacheDir, now: at });
    } catch (error) {
      const events = [feedEvent('error', '.', `The check failed: ${error instanceof Error ? error.message : String(error)}`, at)];
      push(events);
      hub.broadcast('update', { version, events, exitCode: snapshot.exitCode, summary: snapshot.summary, stale: [] });
      return;
    }
    if (closed) return;
    const events = [...fileEvents(before, paths, at), ...snapshotEvents(before, next, at)];
    // A compact diff, not the snapshot: the ids that changed, and the pages they make stale. A page that is not stale
    // fetches only the feed.
    const diff = snapshotDiff(before, next);
    const stale = staleViews(diff, VIEWS, next.projects.map((p) => p.path));
    snapshot = next;
    version++;
    push(events);
    watcher?.update(watchDirs(snapshot));
    hub.broadcast('update', { version, events, exitCode: snapshot.exitCode, summary: snapshot.summary, diff, stale });
  }

  /** Runs one check at a time. Changes that arrive during a run are joined into one more run after it. */
  function schedule(paths: string[]): Promise<void> {
    if (running) {
      again = [...(again ?? []), ...paths];
      return running;
    }
    running = (async () => {
      try {
        await rerun(paths);
        while (again !== null && !closed) {
          const next = again;
          again = null;
          await rerun(next);
        }
      } finally {
        running = null;
      }
    })();
    return running;
  }

  const server = await startWebServer({
    idleTimeoutMs: options.idleTimeoutMs ?? INSPECT_IDLE_MINUTES * 60_000,
    // Every request is a small GET, so a client that holds one open is dropped quickly. Event streams are responses,
    // which these limits do not cover.
    requestTimeoutMs: 30_000,
    headersTimeoutMs: 10_000,
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.token !== undefined ? { token: options.token } : {}),
    routes: [
      ...sharedAssetRoutes(),
      { method: 'GET', path: '/assets/inspect.css', handler: asset(INSPECT_CSS, 'text/css; charset=utf-8') },
      { method: 'GET', path: '/assets/inspect.js', handler: asset(INSPECT_JS, 'text/javascript; charset=utf-8') },
      {
        method: 'GET',
        path: '/',
        handler: async (req) => {
          const shown = snapshot;
          const shownVersion = version;
          const part = req.url.searchParams.get('part');
          // A page depends on the snapshot, the feed and the watch mode; a new one of these empties the cache.
          const generation = `${shownVersion}|${feed[0]?.id ?? ''}|${mode()}`;
          if (pageCache.generation !== generation) {
            pageCache.generation = generation;
            pageCache.pages.clear();
          }
          const key = `${part ?? ''}|${req.url.search}`;
          const hit = pageCache.pages.get(key);
          if (hit !== undefined) {
            pageCache.pages.delete(key);
            pageCache.pages.set(key, hit);
            return part === 'feed' ? { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: hit } : htmlPage(hit);
          }
          const state = parseState(req.url, shown);
          const extra = {
            ...(state.view === 'timeline' ? { timeline: await timeline() } : {}),
            ...(state.view === 'impact' && state.sim === 'path' ? { exports: exportsOf(state.project) } : {}),
          };
          const input: PageInput = { token: server.token, snapshot: shown, feed, version: shownVersion, state, watch: mode(), ...extra };
          // `part=feed`: only what changes when the snapshot did not, for a page whose content is still current.
          const body =
            part === 'feed'
              ? `${JSON.stringify({ version: shownVersion, feed: renderFeed(input).value, nav: renderNav(navItems(shown, state), projectLabelOf(input)).value, status: statusLabel(shown) })}
`
              : renderInspectPage(input);
          pageCache.pages.set(key, body);
          if (pageCache.pages.size > PAGE_CACHE_SIZE) pageCache.pages.delete(pageCache.pages.keys().next().value!);
          return part === 'feed' ? { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body } : htmlPage(body);
        },
      },
      { method: 'GET', path: '/api/snapshot', handler: () => json(snapshot) },
      {
        method: 'GET',
        path: '/api/timeline',
        handler: async () => {
          const data = await timeline();
          return json({
            tracks: data.tracks.map((track) => ({
              ...track,
              points: track.points.map((point, index) => {
                const { lock, ...rest } = point;
                const project = snapshot.projects.find((p) => p.path === track.project);
                return { ...rest, counts: lock ? lockView(lock, project?.config?.root).counts : null, changes: approvalDiff(project, track, index)?.changes ?? [] };
              }),
            })),
          });
        },
      },
      { method: 'GET', path: '/export/map.svg', handler: (req) => download('svg', req.url.searchParams.get('project') ?? '.')() },
      { method: 'GET', path: '/export/buckets.mmd', handler: download('mermaid', '.') },
      { method: 'GET', path: '/api/events', handler: hub.handler(() => ({ event: 'hello', data: { version } })) },
    ],
  });

  // While a page is connected the server stays up: an open event stream does not count as activity by itself.
  const idleMs = options.idleTimeoutMs ?? INSPECT_IDLE_MINUTES * 60_000;
  const keepAlive = setInterval(
    () => {
      if (hub.size > 0) server.touch();
    },
    Math.max(50, Math.min(15_000, Math.floor(idleMs / 3))),
  );
  keepAlive.unref();

  const mode = (): 'native' | 'polling' | 'off' => (watcher === null ? 'off' : watcher.mode);

  if (options.watch !== false) {
    watcher = watchProjects({
      dirs: watchDirs(snapshot),
      onChange: (paths) => void schedule(paths),
      debounceMs: options.debounceMs ?? 300,
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
      polling: options.watch === 'polling',
    });
  }
  push([
    feedEvent(
      'start',
      '.',
      watcher === null
        ? `Inspecting ${plural(snapshot.projects.length, 'project')}. Not watching files.`
        : `Inspecting ${plural(snapshot.projects.length, 'project')}. Watching ${watcher.mode === 'native' ? 'for file changes' : 'by polling every second'}.`,
      new Date(),
    ),
  ]);

  void server.closed.then(() => {
    closed = true;
    clearInterval(keepAlive);
    watcher?.close();
    hub.closeAll();
  });

  return {
    server,
    snapshot: () => snapshot,
    version: () => version,
    feed: () => feed,
    refresh: (paths = []) => schedule(paths),
    watchMode: mode,
    timeline,
    async close() {
      closed = true;
      clearInterval(keepAlive);
      watcher?.close();
      hub.closeAll();
      await server.close();
    },
  };
}
