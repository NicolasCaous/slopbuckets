// The server of `buckets inspect`: the page, its bundle, GET /snapshot.json and GET /events, a Server-Sent Events
// stream that sends `event: snapshot` with the whole new snapshot after each change (see ../page/main.ts). One
// recursive watcher on the project folder recomputes the snapshot after a quiet period, and passes the engine the
// paths it reported, so the engine reads only those. Inspect has no endpoint that changes anything.
import { statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { RuleEngine, SnapshotV2 } from '../../contract/index.js';
import { PAGE_CSS, PAGE_SCRIPT, pageHtml, type PageAssets } from './page.js';
import { EventHub, startWebServer, type WebResponse, type WebServer } from './server.js';

export const INSPECT_IDLE_MINUTES = 30;

/** Folders whose changes never matter: git, dependencies, and `.buckets/`, where the check writes its cache. */
const SKIPPED = new Set(['.git', 'node_modules', '.buckets']);
/** A full snapshot follows known changes after this long, in case the watcher missed one. */
const FULL_SNAPSHOT_MS = 5000;
/** More changed paths than this between two snapshots go to the engine as "list everything". */
const PENDING_MAX = 1000;

export interface InspectAppOptions {
  engine: RuleEngine;
  root: string;
  /** False keeps only the root project. */
  recursive?: boolean;
  assets: PageAssets;
  /** The first snapshot, when the caller already has it. */
  snapshot?: SnapshotV2;
  /** Shuts down after this long without requests while no page is connected. Default 30 minutes. */
  idleTimeoutMs?: number;
  debounceMs?: number;
  /** How long after known changes the full snapshot follows. Default FULL_SNAPSHOT_MS. */
  fullSnapshotMs?: number;
  /** False turns the watcher off. */
  watch?: boolean;
  /** A snapshot that failed. The pages keep the last good one. */
  onError?: (error: unknown) => void;
}

export interface InspectApp {
  server: WebServer;
  snapshot(): SnapshotV2;
  /** True when files are watched. */
  watching: boolean;
  /** Recomputes the snapshot now and resolves once it is sent. */
  refresh(): Promise<void>;
  close(): Promise<void>;
}

function isFolder(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** The folder name the page and the exports show for the root project. A drive root has no name, so it shows whole. */
export const rootName = (root: string): string => path.basename(root) || root;

export function keepRoot(snapshot: SnapshotV2): SnapshotV2 {
  return { ...snapshot, projects: snapshot.projects.slice(0, 1) };
}

/**
 * True when new content at `rel` (relative to the root, `/` separators) cannot change the snapshot: a skipped folder,
 * or a file that the `ignore` of its project matches. The last matching glob wins, so `!` takes files back.
 */
export function irrelevant(snapshot: SnapshotV2, rel: string): boolean {
  if (rel.split('/').some((segment) => SKIPPED.has(segment))) return true;
  // path.matchesGlob arrived in Node 22.5 and 20.17. Without it every change counts.
  if (typeof path.matchesGlob !== 'function') return false;
  // The deepest nested project that holds the file, else the root project.
  const nested = snapshot.projects.filter((p) => p.path !== '.' && rel.startsWith(`${p.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  const project = nested ?? snapshot.projects[0];
  const inner = nested ? rel.slice(nested.path.length + 1) : rel;
  let ignored = false;
  for (const { glob } of project?.ignore ?? []) {
    const negated = glob.startsWith('!');
    if (path.matchesGlob(inner, negated ? glob.slice(1) : glob)) ignored = !negated;
  }
  return ignored;
}

export async function startInspectApp(options: InspectAppOptions): Promise<InspectApp> {
  const { engine, root } = options;
  const shape = (s: SnapshotV2): SnapshotV2 => (options.recursive === false ? keepRoot(s) : s);
  let snapshot = shape(options.snapshot ?? (await engine.snapshot(root)));
  // Serialized once per snapshot: every request and stream gets the same string.
  let body = JSON.stringify(snapshot);
  const hub = new EventHub();
  let running: Promise<void> | null = null;
  let again = false;
  let closed = false;
  // The paths the watcher reported since the last snapshot, relative to root, or null when it could not name them.
  // The engine reads only these paths, so a full snapshot follows every burst of known changes within
  // FULL_SNAPSHOT_MS: an event the watcher missed leaves the page wrong for at most that long.
  let pending: Set<string> | null = new Set();
  let fullTimer: NodeJS.Timeout | undefined;

  async function recompute(): Promise<void> {
    const changed = pending;
    pending = new Set();
    let next: SnapshotV2;
    try {
      next = shape(await engine.snapshot(root, changed === null ? undefined : { changed: [...changed] }));
    } catch (error) {
      pending = null;
      options.onError?.(error);
      return;
    }
    if (changed !== null && fullTimer === undefined && !closed) {
      fullTimer = setTimeout(() => {
        fullTimer = undefined;
        pending = null;
        void refresh();
      }, options.fullSnapshotMs ?? FULL_SNAPSHOT_MS);
      fullTimer.unref();
    }
    const nextBody = JSON.stringify(next);
    if (closed || nextBody === body) return;
    snapshot = next;
    body = nextBody;
    hub.broadcast('snapshot', body);
  }

  /** One snapshot at a time. Changes during a run join into one more run after it. */
  function refresh(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await recompute();
        } while (again && !closed);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  const page = pageHtml(options.assets, undefined, rootName(root));
  const respond = (contentType: string, content: string) => (): WebResponse => ({ status: 200, headers: { 'content-type': contentType }, body: content });
  // An open page keeps the server up: the server does not shut down while an event stream is open.
  const server = await startWebServer({
    idleTimeoutMs: options.idleTimeoutMs ?? INSPECT_IDLE_MINUTES * 60_000,
    routes: {
      '/': respond('text/html; charset=utf-8', page),
      [`/${PAGE_SCRIPT}`]: respond('text/javascript; charset=utf-8', options.assets.script),
      ...(options.assets.css !== null ? { [`/${PAGE_CSS}`]: respond('text/css; charset=utf-8', options.assets.css) } : {}),
      '/snapshot.json': () => ({ status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body }),
      '/events': hub.handler(),
    },
  });

  let debounce: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | null = null;
  if (options.watch !== false) {
    try {
      watcher = watch(root, { recursive: true, persistent: false }, (event, filename) => {
        const rel = filename === null ? null : String(filename).replace(/\\/g, '/');
        if (rel !== null && rel.split('/').some((segment) => SKIPPED.has(segment))) return;
        // Windows reports a folder as changed when a file in it changes, and reports that file too. A folder that
        // appears or goes is a rename event, and the engine lists every file for it.
        if (event === 'change' && rel !== null && isFolder(path.join(root, rel))) return;
        if (rel === null || (pending !== null && pending.size >= PENDING_MAX)) pending = null;
        else pending?.add(rel);
        // A new content of a file the ignore globs match goes to the engine with the next snapshot, but triggers none.
        // A file that appears or goes is a rename event, and triggers one even when ignored: it changes the counts
        // of the ignore globs and can turn an import into one of an ignored file.
        if (event === 'change' && rel !== null && irrelevant(snapshot, rel)) return;
        clearTimeout(debounce);
        // Short, because a live update has 200 ms to reach the page. A burst of changes longer than this still ends
        // in at most two snapshots, since refresh() joins the changes that arrive during a run into one more run.
        debounce = setTimeout(() => void refresh(), options.debounceMs ?? 25);
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      // The platform cannot watch folders recursively. The page still works, without live updates.
      watcher = null;
    }
  }

  const stop = (): void => {
    closed = true;
    clearTimeout(debounce);
    clearTimeout(fullTimer);
    watcher?.close();
  };
  void server.closed.then(stop);

  return {
    server,
    snapshot: () => snapshot,
    watching: watcher !== null,
    refresh: () => {
      pending = null;
      return refresh();
    },
    async close() {
      stop();
      await server.close();
    },
  };
}
