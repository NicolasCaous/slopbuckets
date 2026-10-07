// A fake registry, clock, cache folder and process runner for the update check and `buckets update`.
import type { FetchLike, UpdateDeps } from '../core/update.js';

export interface FakeUpdates extends UpdateDeps {
  /** Every URL the fake fetch was asked for. */
  requests: string[];
  /** Every command the fake runner ran, with its folder. */
  runs: { command: string; cwd: string }[];
  /** The current time; tests move it forward. */
  time: number;
}

export interface FakeUpdatesOptions {
  /** Versions by dist-tag or exact version. A missing one answers 404. */
  versions?: Record<string, string>;
  /** Makes every request fail like a network error. */
  offline?: boolean;
  cacheDir?: string | null;
  packageDir?: string;
  /** Exit code of the install command. */
  exitCode?: number;
}

export function fakeUpdates(options: FakeUpdatesOptions = {}): FakeUpdates {
  const versions = options.versions ?? { latest: '1.2.0', '1.2.0': '1.2.0', '1.0.5': '1.0.5' };
  const fetch: FetchLike = async (url) => {
    deps.requests.push(url);
    if (options.offline) throw new TypeError('fetch failed');
    const tag = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
    const version = versions[tag];
    if (version === undefined) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    return { ok: true, status: 200, json: async () => ({ name: 'slopbuckets', version }) };
  };
  const deps: FakeUpdates = {
    requests: [],
    runs: [],
    time: Date.UTC(2026, 9, 6),
    fetch,
    now: () => deps.time,
    cacheDir: options.cacheDir ?? null,
    packageDir: options.packageDir ?? '/nowhere/slopbuckets',
    run: async (command, cwd) => {
      deps.runs.push({ command, cwd });
      return options.exitCode ?? 0;
    },
  };
  return deps;
}
