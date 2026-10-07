// A fake registry, clock, cache folder and process runner for the update check and `buckets update`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FetchLike, UpdateDeps } from '../core/update.js';

export interface FakeUpdates extends UpdateDeps {
  /** Every URL the fake fetch was asked for. */
  requests: string[];
  /** Every program and arguments the fake runner ran, with its folder. */
  runs: { argv: string[]; cwd: string }[];
  /** Every query the fake `output` answered, such as `npm prefix -g`. */
  queries: string[][];
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
  platform?: NodeJS.Platform;
  /** Exit code of the install command. */
  exitCode?: number;
  /** What the install command writes on stderr, such as an EACCES error of npm. */
  errorOutput?: string;
  /**
   * The folder whose package.json the install command rewrites with the installed version, as a real install would.
   * Defaults to `packageDir`. Null leaves every package.json alone, like a package manager that installed elsewhere.
   */
  installsTo?: string | null;
  /** What `output` prints, by the query joined with spaces, such as `npm prefix -g`. A missing query fails. */
  outputs?: Record<string, string>;
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
    queries: [],
    time: Date.UTC(2026, 9, 6),
    fetch,
    now: () => deps.time,
    cacheDir: options.cacheDir ?? null,
    packageDir: options.packageDir ?? '/nowhere/slopbuckets',
    platform: options.platform ?? 'linux',
    run: async (argv, cwd) => {
      deps.runs.push({ argv, cwd });
      const exitCode = options.exitCode ?? 0;
      const dir = options.installsTo === undefined ? options.packageDir : options.installsTo;
      const version = /^slopbuckets@(.+)$/.exec(argv[argv.length - 1] ?? '')?.[1];
      if (exitCode === 0 && dir != null && version !== undefined && existsSync(path.join(dir, 'package.json'))) {
        const file = path.join(dir, 'package.json');
        writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, 'utf8')) as object), version }));
      }
      return { exitCode, errorOutput: options.errorOutput ?? '' };
    },
    output: async (argv) => {
      deps.queries.push(argv);
      return options.outputs?.[argv.join(' ')] ?? null;
    },
  };
  return deps;
}
