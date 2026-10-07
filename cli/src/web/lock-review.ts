// The difference between buckets.lock.json and the current state, as data for a page. `buckets refresh --web`
// renders it for approval; `buckets inspect` can reuse it to highlight what differs from the lock.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { memoryCache, type CacheStore } from '../core/cache.js';
import { runCheck } from '../core/check.js';
import type { ResolvedConfig } from '../core/config.js';
import { sha256 } from '../core/hash.js';
import { diffLocks, isSupportedLockVersion, own, serializeLock } from '../core/lock.js';
import { configDiff, type ConfigChange } from '../core/lock-config.js';
import { LOCK_FILE } from '../core/paths.js';
import { discoverProjects } from '../core/recursive.js';
import type { OrphanChain } from '../core/rules/orphans.js';
import type { CheckReport, Context, Lock, LockChange } from '../core/types.js';

export type Sign = '+' | '-' | '~';

export interface VersionRow {
  label: string;
  before: string;
  after: string;
}

export interface SymbolRow {
  sign: Sign;
  name: string;
}

export interface DmzFileRow {
  path: string;
  status: 'created' | 'deleted' | 'edited' | 'symbols';
  /** Symbol changes. In a created file every symbol is added. */
  symbols: SymbolRow[];
  /** The current text of a created or edited file. The lock keeps only hashes, so a deleted file has none. */
  source?: string;
}

/** A nested project or a link that approving adds, removes or changes. */
export interface ItemRow {
  sign: Sign;
  path: string;
  label: string;
  /** More about the change, such as the origin and mode of a link. */
  detail?: string;
  /** For a link: its published symbols that approving adds, removes or changes, with the `.external` file of each. */
  symbols?: (SymbolRow & { file: string })[];
}

export interface LockReview {
  /**
   * `path` is relative to the project where `buckets refresh --web` started, `.` for that project. `name` is the
   * package.json name or the folder name; `folder` is always the folder name, which an agent cannot change as
   * easily, so the native dialog shows it first.
   */
  project: { name: string; folder: string; dir: string; path: string };
  /** True when there is no lock yet, so approving creates it. */
  fresh: boolean;
  versions: VersionRow[];
  config: {
    changed: boolean;
    /** The config approving records. */
    current: ResolvedConfig;
    /**
     * False when the approved lock (version 1 to 3) stored only a hash of the config, so the old values are unknown:
     * `changes` is empty and a page shows `current` instead.
     */
    recorded: boolean;
    /** What changed in the config, each access line on its own. Empty when nothing changed or `recorded` is false. */
    changes: ConfigChange[];
  };
  buckets: { added: string[]; removed: string[] };
  dmz: DmzFileRow[];
  /** Nested projects added or removed. */
  projects: ItemRow[];
  /** Links added, removed or changed. */
  links: ItemRow[];
  /** True when the lock differs only in formatting, for example after a hand edit that kept the values. */
  formatOnly: boolean;
  /** With `formatOnly`, the lock format versions when the new lock moves to another one, such as 3 to 4. */
  formatVersions?: { before: number; after: number };
  counts: { added: number; removed: number; changed: number; total: number };
  /**
   * Identifies the lock file on disk and the state being approved. The page sends it back on approve, and the
   * server refuses when the hash of the state at that moment differs.
   */
  hash: string;
  /** The confirmation code of this state, derived from `hash`. The human types it in the native dialog. */
  code: string;
}

/** Letters and digits that cannot be mistaken for each other: no 0/O, 1/I/L, 2/Z, 5/S, 6/G, 8/B, U/V. */
export const CODE_ALPHABET = 'ACDEFHJKMNPRTWXY3479';
export const CODE_LENGTH = 6;

/**
 * The confirmation code of a review hash: 6 characters from CODE_ALPHABET, taken from the hash bytes. The page
 * shows it and the native dialog asks the human to type it, so the dialog approves only the state the human saw.
 */
export function confirmationCode(hash: string): string {
  const hex = hash.replace(/^sha256:/, '');
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[parseInt(hex.slice(i * 4, i * 4 + 4) || '0', 16) % CODE_ALPHABET.length];
  return code;
}

/** What the human typed, as a code: upper case, without spaces and dashes. */
export function normalizeTypedCode(typed: string): string {
  return typed.toUpperCase().replace(/[\s-]+/g, '');
}

export type ReviewState =
  | { kind: 'environment'; report: CheckReport }
  | { kind: 'violations'; report: CheckReport; chains: OrphanChain[] }
  | { kind: 'current' }
  | { kind: 'review'; review: LockReview; lock: Lock; previous: Lock | null; changes: LockChange[] };

const MAX_SOURCE_CHARS = 20_000;

export function projectName(projectDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8')) as { name?: unknown };
    if (typeof pkg.name === 'string' && pkg.name.trim() !== '') return pkg.name.trim();
  } catch {
    // No package.json or not JSON: use the folder name.
  }
  return path.basename(projectDir);
}

function readLockText(projectDir: string): string | null {
  const file = path.join(projectDir, LOCK_FILE);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** Hash of the lock file bytes and of the lock that approving would write. */
export function reviewHash(lockText: string | null, next: Lock): string {
  return sha256(JSON.stringify({ lock: lockText, next: serializeLock(next) }));
}

function readSource(projectDir: string, file: string): string | undefined {
  try {
    const text = readFileSync(path.join(projectDir, file), 'utf8').replace(/\r\n?/g, '\n');
    return text.length > MAX_SOURCE_CHARS ? `${text.slice(0, MAX_SOURCE_CHARS)}\n...` : text;
  } catch {
    return undefined;
  }
}

export function buildReview(options: {
  projectDir: string;
  previous: Lock | null;
  next: Lock;
  changes: LockChange[];
  config: ResolvedConfig;
  lockText: string | null;
  /** Relative to the project where the review started. Defaults to `.`. */
  path?: string;
  /** False leaves out the current text of created and edited files, for a review of two past locks. Default true. */
  sources?: boolean;
}): LockReview {
  const { projectDir, previous, next, changes } = options;
  const versions: VersionRow[] = [];
  const buckets = { added: [] as string[], removed: [] as string[] };
  const projects: ItemRow[] = [];
  const links: ItemRow[] = [];
  const linkDetail = (lock: Lock, p: string): string | undefined => {
    const link = own(lock.links ?? {}, p);
    return link ? `${link.mode === 'link' ? 'link' : 'copy'} of the project ${link.origin}${link.alias !== undefined ? `, imported as ${link.alias}` : ''}` : undefined;
  };
  /** Every published symbol of a link in `lock`, all with `sign`. */
  const allSymbols = (lock: Lock, p: string, sign: Sign): (SymbolRow & { file: string })[] => {
    const out: (SymbolRow & { file: string })[] = [];
    for (const [f, names] of Object.entries(own(lock.links ?? {}, p)?.symbols ?? {})) for (const name of Object.keys(names)) out.push({ sign, name, file: f });
    return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };
  const linkItem = (sign: Sign, p: string, label: string, detail: string | undefined, symbols: (SymbolRow & { file: string })[]): ItemRow => {
    const row = item(sign, p, label, detail);
    if (symbols.length > 0) row.symbols = symbols;
    return row;
  };
  /** The published file of a link-changed symbol, read from the lock that holds it. */
  const symbolFile = (p: string, name: string): string => {
    for (const lock of [next, previous]) {
      for (const [f, names] of Object.entries(own(lock?.links ?? {}, p)?.symbols ?? {})) if (Object.hasOwn(names, name)) return f;
    }
    return '';
  };
  const item = (sign: Sign, p: string, label: string, detail?: string): ItemRow => (detail !== undefined ? { sign, path: p, label, detail } : { sign, path: p, label });
  const files = new Map<string, DmzFileRow>();
  const counts = { added: 0, removed: 0, changed: 0, total: 0 };
  const file = (p: string, status: DmzFileRow['status']): DmzFileRow => {
    let row = files.get(p);
    if (!row) {
      row = { path: p, status, symbols: [] };
      files.set(p, row);
    }
    return row;
  };

  if (previous === null) {
    buckets.added.push(...next.buckets);
    counts.added += next.buckets.length;
    for (const p of Object.keys(next.dmz).sort()) {
      const row = file(p, 'created');
      row.symbols = Object.keys(next.dmz[p]!.symbols).sort().map((name) => ({ sign: '+' as const, name }));
      counts.added++;
    }
    for (const p of next.projects ?? []) projects.push(item('+', p, 'nested project'));
    for (const p of Object.keys(next.links ?? {}).sort()) links.push(linkItem('+', p, 'link', linkDetail(next, p), allSymbols(next, p, '+')));
    counts.added += projects.length + links.length;
  } else {
    if (previous.cli !== next.cli) versions.push({ label: 'CLI version', before: previous.cli, after: next.cli });
    if (previous.adapter.name !== next.adapter.name || previous.adapter.version !== next.adapter.version) {
      versions.push({ label: 'Adapter version', before: `${previous.adapter.name} ${previous.adapter.version}`, after: `${next.adapter.name} ${next.adapter.version}` });
    }
    if (previous.adapter.toolchain !== next.adapter.toolchain) {
      versions.push({ label: 'Toolchain', before: previous.adapter.toolchain ?? 'unknown', after: next.adapter.toolchain ?? 'unknown' });
    }
    counts.changed += versions.length;
    for (const change of changes) {
      switch (change.kind) {
        case 'bucket-added':
          buckets.added.push(change.path);
          counts.added++;
          break;
        case 'bucket-removed':
          buckets.removed.push(change.path);
          counts.removed++;
          break;
        case 'config-changed':
          counts.changed++;
          break;
        case 'dmz-added': {
          const row = file(change.path, 'created');
          const entry = own(next.dmz, change.path);
          row.symbols = Object.keys(entry?.symbols ?? {}).sort().map((name) => ({ sign: '+' as const, name }));
          counts.added++;
          break;
        }
        case 'dmz-removed': {
          const row = file(change.path, 'deleted');
          const entry = own(previous.dmz, change.path);
          row.symbols = Object.keys(entry?.symbols ?? {}).sort().map((name) => ({ sign: '-' as const, name }));
          counts.removed++;
          break;
        }
        case 'dmz-changed':
          file(change.path, 'edited').status = 'edited';
          counts.changed++;
          break;
        case 'symbol-added':
        case 'symbol-removed':
        case 'signature-changed': {
          const sign: Sign = change.kind === 'symbol-added' ? '+' : change.kind === 'symbol-removed' ? '-' : '~';
          file(change.path, 'symbols').symbols.push({ sign, name: change.symbol ?? '' });
          if (sign === '+') counts.added++;
          else if (sign === '-') counts.removed++;
          else counts.changed++;
          break;
        }
        case 'project-added':
        case 'project-removed': {
          const sign: Sign = change.kind === 'project-added' ? '+' : '-';
          projects.push(item(sign, change.path, sign === '+' ? 'nested project added' : 'nested project removed'));
          if (sign === '+') counts.added++;
          else counts.removed++;
          break;
        }
        case 'link-added':
          links.push(linkItem('+', change.path, 'link added', linkDetail(next, change.path), allSymbols(next, change.path, '+')));
          counts.added++;
          break;
        case 'link-removed':
          links.push(linkItem('-', change.path, 'link removed', linkDetail(previous, change.path), allSymbols(previous, change.path, '-')));
          counts.removed++;
          break;
        case 'link-changed': {
          if (change.symbol === undefined) {
            links.push(item('~', change.path, 'link changed', change.message.replace(/^Link \S+ changed since the lock was approved: /, '').replace(/\. A human must.*$/, '')));
            counts.changed++;
            break;
          }
          // One row per link, with every published symbol that changed.
          let row = links.find((r) => r.path === change.path && r.label === 'published symbols changed');
          if (row === undefined) {
            row = item('~', change.path, 'published symbols changed', linkDetail(next, change.path));
            links.push(row);
          }
          const was = Object.values(own(previous.links ?? {}, change.path)?.symbols ?? {}).some((names) => Object.hasOwn(names, change.symbol!));
          const is = Object.values(own(next.links ?? {}, change.path)?.symbols ?? {}).some((names) => Object.hasOwn(names, change.symbol!));
          const sign: Sign = was && is ? '~' : is ? '+' : '-';
          (row.symbols ??= []).push({ sign, name: change.symbol, file: symbolFile(change.path, change.symbol) });
          if (sign === '+') counts.added++;
          else if (sign === '-') counts.removed++;
          else counts.changed++;
          break;
        }
        case 'link-drift':
        case 'lock-missing':
          break;
      }
    }
  }

  const dmz = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const row of dmz) {
    if (row.status !== 'deleted' && options.sources !== false) {
      const source = readSource(projectDir, row.path);
      if (source !== undefined) row.source = source;
    }
  }
  counts.total = counts.added + counts.removed + counts.changed;
  const formatOnly = previous !== null && counts.total === 0;
  if (formatOnly) {
    counts.changed = 1;
    counts.total = 1;
  }
  const hash = reviewHash(options.lockText, next);
  const config = previous !== null && changes.some((c) => c.kind === 'config-changed') ? configDiff(previous.config, next.config) : null;
  return {
    project: { name: projectName(projectDir), folder: path.basename(path.resolve(projectDir)), dir: projectDir, path: options.path ?? '.' },
    fresh: previous === null,
    versions,
    config: {
      changed: config !== null,
      current: typeof next.config === 'string' ? options.config : next.config,
      recorded: config?.recorded ?? true,
      changes: config?.changes ?? [],
    },
    buckets,
    dmz,
    projects,
    links,
    formatOnly,
    ...(formatOnly && previous.lockVersion !== next.lockVersion ? { formatVersions: { before: previous.lockVersion, after: next.lockVersion } } : {}),
    counts,
    hash,
    code: confirmationCode(hash),
  };
}

export interface ProjectState {
  /** Relative to the project where the review started, `.` for that project. */
  path: string;
  dir: string;
  state: ReviewState;
}

/** The state of the project and of every project nested in it, in tree order. */
export async function evaluateTree(ctx: Context, projectDir: string): Promise<ProjectState[]> {
  const out: ProjectState[] = [];
  for (const project of discoverProjects(ctx, projectDir)) out.push({ ...project, state: await evaluateLockState(ctx, project.dir, project.path) });
  return out;
}

/**
 * Keeps evaluations between requests of a long-lived server. `cache` holds the adapter's answers (keyed on the
 * project files, see core/cache.ts); `reviews` holds the last review of each project, reused while the lock text,
 * the analyzed state and the lock that approving would write are all unchanged.
 */
export interface EvaluationCache {
  cache: CacheStore;
  reviews: Map<string, { key: string; state: ReviewState }>;
}

export function evaluationCache(): EvaluationCache {
  return { cache: memoryCache(), reviews: new Map() };
}

/** Runs the full check like `buckets refresh` does and describes what approving would change. */
export async function evaluateLockState(ctx: Context, projectDir: string, projectPath = '.', memo?: EvaluationCache): Promise<ReviewState> {
  const lockText = readLockText(projectDir);
  const result = await runCheck(ctx, projectDir, { ignoreVersions: true, ...(memo ? { cache: memo.cache } : {}) });
  const { report } = result;
  if (report.environment) return { kind: 'environment', report };
  if (report.violations.length > 0 || !result.lock || !result.config) {
    return { kind: 'violations', report: { ...report, lockChanges: [] }, chains: result.orphanChains };
  }
  const next = result.lock;
  const previous = result.previousLock && isSupportedLockVersion(result.previousLock.lockVersion) ? result.previousLock : null;
  // The hash uses the lock text read before the check. If the lock changes during the check, the next
  // evaluation reads a different text, so an approval of this review is refused as stale.
  if (previous && serializeLock(previous) === serializeLock(next)) return { kind: 'current' };
  const key = result.stateKey !== undefined ? sha256(JSON.stringify({ lock: lockText, state: result.stateKey, next: serializeLock(next), path: projectPath })) : undefined;
  const known = key !== undefined ? memo?.reviews.get(projectDir) : undefined;
  if (known !== undefined && known.key === key) return known.state;
  const changes = previous ? diffLocks(previous, next) : [];
  const review = buildReview({ projectDir, previous, next, changes, config: result.config, lockText, path: projectPath });
  const state: ReviewState = { kind: 'review', review, lock: next, previous, changes };
  if (key !== undefined) memo?.reviews.set(projectDir, { key, state });
  return state;
}
