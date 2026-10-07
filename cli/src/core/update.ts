// Updates of the slopbuckets CLI: the latest version on the npm registry, how the running CLI was installed, and the
// command that installs another version. The TypeScript adapter ships inside the CLI package, so updating the CLI
// updates the adapter too.
//
// Every command except `buckets hook`, `buckets check --file` and `buckets update` asks for the latest version at
// most once a day, keeps the answer in the cache folder of the operating system and prints a notice on stderr when a
// newer version exists. `buckets update` always asks the registry. Everything that touches the network, the clock, the
// cache folder or another process comes in through `UpdateDeps`, so the tests never touch any of them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { toPosix } from './paths.js';

export const PACKAGE_NAME = 'slopbuckets';
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
/** How long `buckets check` reuses the latest version it read from the registry. */
export const UPDATE_CACHE_MS = 24 * 60 * 60 * 1000;
/** How long `buckets check` waits for the registry before it gives up without a word. */
export const UPDATE_CHECK_TIMEOUT_MS = 1500;
const CACHE_FILE = 'update-check.json';

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The process boundary of the update check and of `buckets update`. index.ts wires the real ones. */
export interface UpdateDeps {
  fetch: FetchLike;
  /** Milliseconds since the epoch. */
  now(): number;
  /** The cache folder of slopbuckets, or null when the machine has none. */
  cacheDir: string | null;
  /** The folder with the package.json of the running CLI. */
  packageDir: string;
  /** Runs a shell command in `cwd` with the terminal attached, and resolves with its exit code. */
  run(command: string, cwd: string): Promise<number>;
}

/** The update notice, also the `update` field of `buckets check --json`. Present only when a newer version exists. */
export interface UpdateNotice {
  installed: string;
  latest: string;
  message: string;
}

/* ---------- versions ---------- */

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** True for a full semver version such as `1.2.0` or `1.2.0-beta.1`. The install command is built from it. */
export function isVersion(text: string): boolean {
  return VERSION.test(text);
}

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1; // a release is newer than its prereleases
  if (b === undefined) return -1;
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (nx !== null) return -1;
    else if (ny !== null) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Semver order: negative when `a` is older than `b`, 0 when equal, positive when newer. Text that is not a version sorts first. */
export function compareVersions(a: string, b: string): number {
  const x = VERSION.exec(a);
  const y = VERSION.exec(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d;
  }
  return comparePrerelease(x[4], y[4]);
}

/* ---------- registry ---------- */

/** The registry of `npm_config_registry`, the variable npm reads, without a trailing slash. */
export function registryUrl(env: Record<string, string | undefined>): string {
  const configured = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  return (configured !== undefined && configured.trim() !== '' ? configured.trim() : DEFAULT_REGISTRY).replace(/\/+$/, '');
}

/**
 * The version that a dist-tag (such as `latest`) or an exact version resolves to on the registry. Throws with a
 * sentence when the registry does not answer in time, answers with an error, or has no such version.
 */
export async function fetchVersion(fetch: FetchLike, registry: string, tag: string, timeoutMs: number): Promise<string> {
  const url = `${registry}/${PACKAGE_NAME}/${encodeURIComponent(tag)}`;
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new Error(timedOut ? `${registry} did not answer within ${timeoutMs / 1000} seconds` : `cannot reach ${registry} (${error instanceof Error ? error.message : String(error)})`);
  }
  if (response.status === 404) throw new Error(`${registry} has no ${PACKAGE_NAME} ${tag}`);
  if (!response.ok) throw new Error(`${registry} answered with HTTP ${response.status}`);
  const body = (await response.json()) as { version?: unknown } | null;
  const version = body?.version;
  if (typeof version !== 'string' || !isVersion(version)) throw new Error(`${registry} sent no valid version for ${PACKAGE_NAME} ${tag}`);
  return version;
}

/* ---------- cache ---------- */

/** `%LOCALAPPDATA%\slopbuckets` on Windows, `$XDG_CACHE_HOME/slopbuckets` or `~/.cache/slopbuckets` elsewhere. */
export function updateCacheDir(env: Record<string, string | undefined>, platform: NodeJS.Platform, home: string): string | null {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    if (local) return path.win32.join(local, PACKAGE_NAME);
    return home ? path.win32.join(home, 'AppData', 'Local', PACKAGE_NAME) : null;
  }
  const xdg = env.XDG_CACHE_HOME;
  // The XDG spec says to ignore a relative path.
  if (xdg && path.posix.isAbsolute(xdg)) return path.posix.join(xdg, PACKAGE_NAME);
  return home ? path.posix.join(home, '.cache', PACKAGE_NAME) : null;
}

interface CacheEntry {
  registry: string;
  checkedAt: number;
  latest: string | null;
}

function readCache(dir: string): CacheEntry | null {
  try {
    const data = JSON.parse(readFileSync(path.join(dir, CACHE_FILE), 'utf8')) as Partial<CacheEntry>;
    if (typeof data.registry !== 'string' || typeof data.checkedAt !== 'number') return null;
    const latest = typeof data.latest === 'string' && isVersion(data.latest) ? data.latest : null;
    return { registry: data.registry, checkedAt: data.checkedAt, latest };
  } catch {
    return null;
  }
}

/** Records the latest version. A failure to write is ignored: the next check asks the registry again. */
export function writeUpdateCache(dir: string | null, entry: CacheEntry): void {
  if (dir === null) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, CACHE_FILE), `${JSON.stringify(entry)}\n`);
  } catch {
    // A read-only home folder, for example. The check works without the cache.
  }
}

/* ---------- update detection ---------- */

/** False when the CI variable is set or SLOPBUCKETS_NO_UPDATE_CHECK=1. */
export function updateCheckEnabled(env: Record<string, string | undefined>): boolean {
  if (env.CI !== undefined && env.CI !== '') return false;
  const off = env.SLOPBUCKETS_NO_UPDATE_CHECK;
  return off === undefined || off === '' || off === '0';
}

export function updateNotice(installed: string, latest: string): UpdateNotice {
  return {
    installed,
    latest,
    message: `slopbuckets ${latest} is available (installed ${installed}). Run \`buckets update\`.`,
  };
}

/**
 * The update notice, or null when the installed version is the latest, when the check is off, and on
 * any failure. Reads the registry at most once every 24 hours per registry, with a 1500 ms timeout.
 */
export async function checkForUpdate(
  deps: UpdateDeps,
  env: Record<string, string | undefined>,
  installed: string,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
): Promise<UpdateNotice | null> {
  try {
    if (!updateCheckEnabled(env)) return null;
    const registry = registryUrl(env);
    const now = deps.now();
    const cached = deps.cacheDir !== null ? readCache(deps.cacheDir) : null;
    const usable = cached !== null && cached.registry === registry ? cached : null;
    let latest: string | null;
    // A time in the future means the clock moved back, so the entry is not trusted.
    if (usable !== null && usable.checkedAt <= now && now - usable.checkedAt < UPDATE_CACHE_MS) {
      latest = usable.latest;
    } else {
      try {
        latest = await fetchVersion(deps.fetch, registry, 'latest', timeoutMs);
      } catch {
        // Offline or blocked: keep the previous answer, and wait a day before trying again, so an offline machine
        // does not pay the timeout on every check.
        latest = usable?.latest ?? null;
      }
      writeUpdateCache(deps.cacheDir, { registry, checkedAt: now, latest });
    }
    return latest !== null && compareVersions(latest, installed) > 0 ? updateNotice(installed, latest) : null;
  } catch {
    return null;
  }
}

/* ---------- how the CLI is installed ---------- */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface Install {
  /** `global`, a project dependency (`local`), or `unknown` (npx, a checkout of the repository, a folder slopbuckets does not recognize). */
  scope: 'global' | 'local' | 'unknown';
  manager: PackageManager | null;
  /** For `local`, the folder where the install command runs. */
  dir: string | null;
  /** For `local`, true unless the project lists slopbuckets in `dependencies`. */
  dev: boolean;
  /** For `unknown`, why. */
  reason?: string;
}

const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

function readPackageJson(dir: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as unknown;
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function listsCli(pkg: Record<string, unknown> | null, field: string): boolean {
  const deps = pkg?.[field];
  return deps !== null && typeof deps === 'object' && Object.prototype.hasOwnProperty.call(deps, PACKAGE_NAME);
}

function projectManager(dir: string, posixPackageDir: string): PackageManager {
  if (posixPackageDir.includes('/node_modules/.pnpm/')) return 'pnpm';
  for (const [file, manager] of LOCKFILES) if (existsSync(path.join(dir, file))) return manager;
  const field = readPackageJson(dir)?.packageManager;
  if (typeof field === 'string') {
    const name = field.split('@')[0];
    if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name;
  }
  return 'npm';
}

/**
 * How the CLI in `packageDir` was installed, from its path. A package under a `node_modules` folder whose parent
 * has a package.json is a project dependency; the lockfile next to that package.json names the package manager.
 * Under `node_modules` of a folder without a package.json (`/usr/local/lib`, `%APPDATA%\npm`) it is a global npm
 * install. pnpm, yarn and bun keep their global packages in folders of their own, recognized by name.
 */
export function detectInstall(packageDir: string, cwd: string): Install {
  const full = toPosix(path.resolve(packageDir));
  const lower = full.toLowerCase();
  if (lower.includes('/_npx/') || lower.includes('/pnpm/dlx/') || /\/bunx-[^/]*\//.test(lower)) {
    return { scope: 'unknown', manager: null, dir: null, dev: false, reason: `it runs from a temporary copy (${packageDir}), such as the one npx makes, so there is nothing to update. Ask npx for the version you want, such as \`npx slopbuckets@<version>\`` };
  }
  if (lower.includes('/pnpm/global/')) return { scope: 'global', manager: 'pnpm', dir: null, dev: false };
  if (/\/yarn\/(data\/)?global\//.test(lower) || lower.includes('/.yarn-global/')) return { scope: 'global', manager: 'yarn', dir: null, dev: false };
  if (lower.includes('/.bun/install/global/')) return { scope: 'global', manager: 'bun', dir: null, dev: false };

  const at = full.indexOf('/node_modules/');
  if (at < 0) return { scope: 'unknown', manager: null, dir: null, dev: false, reason: `it runs from ${packageDir}, which is not inside a node_modules folder, such as a checkout of the repository` };
  const owner = path.resolve(at === 0 ? '/' : full.slice(0, at));
  if (!existsSync(path.join(owner, 'package.json'))) return { scope: 'global', manager: 'npm', dir: null, dev: false };

  // In a workspace the package sits in the node_modules of the root, but a member may be the one that lists it.
  let dir = owner;
  const relative = path.relative(owner, path.resolve(cwd));
  if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
      const pkg = readPackageJson(current);
      if (listsCli(pkg, 'dependencies') || listsCli(pkg, 'devDependencies')) {
        dir = current;
        break;
      }
      if (current === owner || path.dirname(current) === current) break;
    }
  }
  const pkg = readPackageJson(dir);
  const dev = !listsCli(pkg, 'dependencies') || listsCli(pkg, 'devDependencies');
  return { scope: 'local', manager: projectManager(owner, full), dir, dev };
}

/** The command that installs `version` the way the running CLI was installed, or null when that is unknown. */
export function installCommand(install: Install, version: string): string | null {
  if (!isVersion(version)) throw new Error(`not a version: ${version}`);
  const spec = `${PACKAGE_NAME}@${version}`;
  if (install.scope === 'global') {
    switch (install.manager) {
      case 'pnpm':
        return `pnpm add -g ${spec}`;
      case 'yarn':
        return `yarn global add ${spec}`;
      case 'bun':
        return `bun add -g ${spec}`;
      default:
        return `npm install -g ${spec}`;
    }
  }
  if (install.scope === 'local') {
    // Exact, because the lock of the project names one exact CLI version.
    switch (install.manager) {
      case 'pnpm':
        return `pnpm add ${install.dev ? '--save-dev ' : ''}--save-exact ${spec}`;
      case 'yarn':
        return `yarn add ${install.dev ? '--dev ' : ''}--exact ${spec}`;
      case 'bun':
        return `bun add ${install.dev ? '--dev ' : ''}--exact ${spec}`;
      default:
        return `npm install ${install.dev ? '--save-dev ' : ''}--save-exact ${spec}`;
    }
  }
  return null;
}
