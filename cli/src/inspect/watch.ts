// File watching for `buckets inspect`: one watcher per project folder, plus the origin folders of links that live
// outside every project. `fs.watch` with `recursive` where the platform supports it, and polling of file sizes and
// times where it does not. Changes are collected and reported together after a quiet period (debounce).
import { watch, type FSWatcher } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** Folder names that never matter for a check, and `.buckets/`, where the check writes its own cache. */
const IGNORED = new Set(['.git', 'node_modules', '.buckets', '.test-tmp']);

export function ignoredPath(rel: string): boolean {
  return rel.split(/[\\/]/).some((segment) => IGNORED.has(segment));
}

export interface WatchOptions {
  dirs: string[];
  /** Called with the absolute paths that changed, once no change came for `debounceMs`. */
  onChange(paths: string[]): void;
  debounceMs?: number;
  pollMs?: number;
  /** Always poll, for tests and for file systems where native events do not arrive. */
  polling?: boolean;
}

export interface ProjectWatcher {
  /** `native` when every folder has a native watcher, `polling` when at least one folder is polled. */
  readonly mode: 'native' | 'polling';
  /** Watches exactly these folders from now on. */
  update(dirs: string[]): void;
  close(): void;
}

type Stamp = Map<string, string>;

/** Size and modification time of every file below `dir`, ignored folders left out. Links are not followed. */
function stamp(dir: string): Stamp {
  const out: Stamp = new Map();
  const visit = (abs: string, depth: number): void => {
    if (depth > 40) return;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) visit(child, depth + 1);
      else {
        try {
          const st = statSync(child);
          out.set(child, `${st.size}:${st.mtimeMs}`);
        } catch {
          // Gone between the listing and the stat.
        }
      }
    }
  };
  visit(dir, 0);
  return out;
}

export function watchProjects(options: WatchOptions): ProjectWatcher {
  const debounceMs = options.debounceMs ?? 300;
  const pollMs = options.pollMs ?? 1000;
  const pending = new Set<string>();
  const natives = new Map<string, FSWatcher>();
  const polled = new Map<string, Stamp>();
  let timer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let closed = false;

  const flush = (): void => {
    timer = undefined;
    if (closed || pending.size === 0) return;
    const paths = [...pending].sort();
    pending.clear();
    options.onChange(paths);
  };
  const note = (abs: string): void => {
    if (closed) return;
    pending.add(abs);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    timer.unref?.();
  };

  const poll = (): void => {
    for (const [dir, before] of polled) {
      const now = stamp(dir);
      for (const [file, value] of now) if (before.get(file) !== value) note(file);
      for (const file of before.keys()) if (!now.has(file)) note(file);
      polled.set(dir, now);
    }
  };
  const ensurePolling = (): void => {
    if (pollTimer || closed) return;
    pollTimer = setInterval(poll, pollMs);
    pollTimer.unref?.();
  };
  const startPolling = (dir: string): void => {
    polled.set(dir, stamp(dir));
    ensurePolling();
  };

  const add = (dir: string): void => {
    if (natives.has(dir) || polled.has(dir)) return;
    if (options.polling) {
      startPolling(dir);
      return;
    }
    try {
      const watcher = watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
        const rel = filename === null ? '' : String(filename);
        if (rel !== '' && ignoredPath(rel)) return;
        note(rel === '' ? dir : path.join(dir, rel));
      });
      watcher.on('error', () => {
        // The folder went away or the platform stopped delivering events: poll it instead.
        watcher.close();
        natives.delete(dir);
        if (!closed) startPolling(dir);
      });
      natives.set(dir, watcher);
    } catch {
      // `recursive` is not supported here (ERR_FEATURE_UNAVAILABLE_ON_PLATFORM), or the folder cannot be watched.
      startPolling(dir);
    }
  };
  const remove = (dir: string): void => {
    natives.get(dir)?.close();
    natives.delete(dir);
    polled.delete(dir);
  };

  for (const dir of options.dirs) add(dir);

  return {
    get mode() {
      return polled.size > 0 ? 'polling' : 'native';
    },
    update(dirs) {
      const wanted = new Set(dirs);
      for (const dir of [...natives.keys(), ...polled.keys()]) if (!wanted.has(dir)) remove(dir);
      for (const dir of wanted) add(dir);
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
      for (const watcher of natives.values()) watcher.close();
      natives.clear();
      polled.clear();
    },
  };
}
