// The timeline of approvals: the git history of each project's buckets.lock.json, one track per project. Every
// commit that changed a lock is an approval, because only a human approval writes the lock. For each approval the
// page rebuilds a light view of the contract graph from that version of the lock (buckets, DMZ files, symbols,
// links and nested projects; the lock has no source code) and the difference from the approval before it.
//
// Git runs through execFile, never a shell, with read-only commands: rev-parse, log and show. It is optional: without
// git, outside a repository, in a shallow clone or with a lock that was never committed, a track says why it is empty.
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedConfig } from '../core/config.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import { EXTERNAL, PARENT, SELF } from '../core/dmz-path.js';
import { diffLocks, own, parseLockText } from '../core/lock.js';
import { codeBucket, LOCK_FILE, parentPath, toPosix } from '../core/paths.js';
import type { Lock, LockChange } from '../core/types.js';
import { buildReview, type LockReview } from '../web/lock-review.js';
import type { MapBucketData, MapData, MapEdge, MapTone } from './map-svg.js';
import type { InspectSnapshot, ProjectSnapshot } from './snapshot.js';

/** At most this many approvals per project, the newest ones. */
export const MAX_APPROVALS = 200;
/** `at` of the point that stands for a lock changed on disk but not committed. */
export const WORKING = 'working';

export type TrackStatus = 'ok' | 'no-git' | 'not-repo' | 'shallow' | 'no-commits' | 'untracked' | 'no-lock' | 'error';

export interface TimelinePoint {
  /** The commit, or `working` for the lock on disk when it differs from the last commit. */
  id: string;
  short: string;
  /** ISO date of the author. */
  date: string;
  author: string;
  subject: string;
  /** The lock's path at that commit, relative to the repository. */
  file: string;
  /** `deleted` when the commit removed the lock, `invalid` when that version cannot be read. */
  state: 'ok' | 'invalid' | 'deleted';
  problem?: string;
  lock: Lock | null;
}

export interface TimelineTrack {
  project: string;
  name: string;
  status: TrackStatus;
  /** Why the track is empty, for every status but `ok`. */
  message?: string;
  /** Oldest first. */
  points: TimelinePoint[];
  /** True when the history has more than MAX_APPROVALS approvals and the oldest are left out. */
  truncated: boolean;
  /** Absolute folder of the repository, when there is one. */
  repo: string | null;
}

export interface Timeline {
  tracks: TimelineTrack[];
}

/** Runs git with arguments, in a folder. Rejects with an error that has `code` (ENOENT when git is missing) and `stderr`. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export interface GitError extends Error {
  code?: string | number;
  stderr?: string;
}

/** The real git: execFile without a shell, no pager, no prompt, no optional lock files, no fsmonitor hook. */
export function systemGit(env: NodeJS.ProcessEnv = process.env): GitRunner {
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', ...args],
        {
          cwd,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          timeout: 30_000,
          windowsHide: true,
          env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
        },
        (error, stdout, stderr) => {
          if (error) {
            const out = error as GitError;
            out.stderr = String(stderr ?? '');
            reject(out);
          } else resolve(String(stdout));
        },
      );
    });
}

function firstLine(text: string | undefined): string {
  return (text ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export interface TrackKey {
  /** Identifies the state the track was read from: the repository, its HEAD and the lock file on disk. */
  key: string;
  repo: string | null;
  head: string | null;
  shallow: boolean;
  status: TrackStatus | null;
  message?: string;
}

/** The cheap part of reading a track: where the repository is and what HEAD is. Used as the cache key. */
export async function trackKey(dir: string, git: GitRunner): Promise<TrackKey> {
  let lockStat = 'none';
  try {
    const s = statSync(path.join(dir, LOCK_FILE));
    lockStat = `${s.size}:${s.mtimeMs}`;
  } catch {
    // No lock on disk.
  }
  let top: string;
  let shallow: boolean;
  try {
    const out = (await git(['rev-parse', '--show-toplevel', '--is-shallow-repository'], dir)).split(/\r?\n/);
    top = path.resolve(out[0]!.trim());
    shallow = out[1]?.trim() === 'true';
  } catch (error) {
    const e = error as GitError;
    if (e.code === 'ENOENT') return { key: `no-git|${lockStat}`, repo: null, head: null, shallow: false, status: 'no-git', message: 'Git is not installed or not on the PATH, so there is no history of the lock to show.' };
    const why = firstLine(e.stderr);
    if (/not a git repository/i.test(why)) return { key: `not-repo|${lockStat}`, repo: null, head: null, shallow: false, status: 'not-repo', message: 'The project is not in a git repository, so there is no history of the lock to show.' };
    return { key: `error|${why}|${lockStat}`, repo: null, head: null, shallow: false, status: 'error', message: `Git could not read the repository: ${why || 'unknown error'}.` };
  }
  let head: string | null = null;
  try {
    head = (await git(['rev-parse', '--verify', '-q', 'HEAD'], dir)).trim() || null;
  } catch {
    head = null;
  }
  const base = { repo: top, head, shallow };
  if (shallow) return { ...base, key: `shallow|${top}|${head}|${lockStat}`, status: 'shallow', message: 'This is a shallow clone, so the history of the lock is cut short. Run `git fetch --unshallow` to see every approval.' };
  if (head === null) return { ...base, key: `empty|${top}|${lockStat}`, status: 'no-commits', message: 'The repository has no commits yet, so no approval was recorded.' };
  return { ...base, key: `ok|${top}|${head}|${lockStat}`, status: null };
}

/** Reads the approvals of one project from git. */
export async function readTrack(project: { path: string; name: string; dir: string }, git: GitRunner, known?: TrackKey): Promise<TimelineTrack> {
  const key = known ?? (await trackKey(project.dir, git));
  const empty = (status: TrackStatus, message: string): TimelineTrack => ({ project: project.path, name: project.name, status, message, points: [], truncated: false, repo: key.repo });
  if (key.status !== null) return empty(key.status, key.message ?? '');
  const repo = key.repo!;
  const lockAbs = path.join(project.dir, LOCK_FILE);
  const rel = toPosix(path.relative(repo, lockAbs));
  let onDisk: string | null = null;
  try {
    onDisk = readFileSync(lockAbs, 'utf8');
  } catch {
    onDisk = null;
  }
  let log: string;
  try {
    log = await git(['log', '--follow', `-n${MAX_APPROVALS + 1}`, '--format=%x1e%H%x1f%aI%x1f%an%x1f%s', '--name-only', '--', rel], repo);
  } catch (error) {
    return empty('error', `Git could not read the history of ${rel}: ${firstLine((error as GitError).stderr) || (error as Error).message}.`);
  }
  const records = log
    .split('\x1e')
    .map((r) => r.trim())
    .filter((r) => r !== '')
    .map((record) => {
      const [head, ...names] = record.split(/\r?\n/).filter((l) => l.trim() !== '');
      const [id, date, author, subject] = head!.split('\x1f') as [string, string, string, string];
      return { id, date, author: author ?? '', subject: subject ?? '', file: names[0]?.trim() || rel };
    });
  if (records.length === 0) {
    return onDisk === null
      ? empty('no-lock', 'The project has no buckets.lock.json yet, so nothing was approved.')
      : empty('untracked', `${rel} is not committed, so git has no approvals to show. Commit the lock after each approval to build the timeline.`);
  }
  const truncated = records.length > MAX_APPROVALS;
  const kept = records.slice(0, MAX_APPROVALS).reverse();
  const texts = await pool(kept, 6, async (r) => {
    try {
      return await git(['show', `${r.id}:${r.file}`], repo);
    } catch {
      return null;
    }
  });
  const points: TimelinePoint[] = kept.map((r, i) => {
    const text = texts[i];
    const base = { id: r.id, short: r.id.slice(0, 7), date: r.date, author: r.author, subject: r.subject, file: r.file };
    if (text === null || text === undefined) return { ...base, state: 'deleted', lock: null };
    const read = parseLockText(text);
    return read.kind === 'ok' ? { ...base, state: 'ok', lock: read.lock } : { ...base, state: 'invalid', problem: read.kind === 'invalid' ? read.reason : 'unreadable', lock: null };
  });
  // The lock on disk, when it differs from the newest commit: approved but not committed yet.
  const newest = texts[texts.length - 1];
  if (onDisk !== null && (newest === null || newest === undefined || normalize(newest) !== normalize(onDisk))) {
    const read = parseLockText(onDisk);
    let date = new Date().toISOString();
    try {
      date = statSync(lockAbs).mtime.toISOString();
    } catch {
      // Keep now.
    }
    points.push({
      id: WORKING,
      short: 'working',
      date,
      author: '',
      subject: 'Approved on disk, not committed yet',
      file: rel,
      ...(read.kind === 'ok' ? { state: 'ok' as const, lock: read.lock } : { state: 'invalid' as const, problem: read.kind === 'invalid' ? read.reason : 'unreadable', lock: null }),
    });
  }
  return { project: project.path, name: project.name, status: 'ok', points, truncated, repo };
}

/** Reads the tracks of every project of a snapshot. */
export async function readTimeline(snapshot: InspectSnapshot, git: GitRunner = systemGit()): Promise<Timeline> {
  const tracks = await Promise.all(snapshot.projects.map((p) => readTrack({ path: p.path, name: p.name, dir: p.dir }, git)));
  return { tracks };
}

/**
 * Keeps tracks between requests: a track is read again only when its key changes, which happens after a commit, a
 * checkout or a change of the lock on disk.
 */
export function timelineCache(git: GitRunner = systemGit()): { get(snapshot: InspectSnapshot): Promise<Timeline> } {
  const tracks = new Map<string, { key: string; track: Promise<TimelineTrack> }>();
  return {
    async get(snapshot) {
      const out = await Promise.all(
        snapshot.projects.map(async (p) => {
          const key = await trackKey(p.dir, git);
          const cached = tracks.get(p.dir);
          if (cached && cached.key === key.key) {
            const track = await cached.track;
            return { ...track, project: p.path, name: p.name };
          }
          const track = readTrack({ path: p.path, name: p.name, dir: p.dir }, git, key);
          tracks.set(p.dir, { key: key.key, track });
          track.catch(() => tracks.delete(p.dir));
          return track;
        }),
      );
      return { tracks: out };
    },
  };
}

// ---- the contract graph of one version of a lock ----

export interface LockViewContract {
  file: string;
  owner: string;
  provider: string;
  consumer: string;
  providerBucket: string | null;
  consumerBucket: string | null;
  symbols: string[];
}

export interface LockView {
  root: string;
  buckets: { path: string; name: string; level: number; parent: string | null; children: string[] }[];
  contracts: LockViewContract[];
  links: { path: string; name: string; origin: string; mode: 'link' | 'copy'; bucket: string | null }[];
  projects: string[];
  counts: { buckets: number; contracts: number; symbols: number; links: number; projects: number };
}

const DMZ_FILE = /^(.*)\/dmz\/([^/]+)\/([^/]+)\.[^./]+$/;

function nameBucket(owner: string, name: string): string | null {
  if (name === SELF) return owner;
  if (name === PARENT || name === EXTERNAL) return null;
  return `${owner}/${name}`;
}

/** The root bucket of a set of bucket paths: `preferred` when the set has it, or else the shortest path. */
function rootOf(paths: string[], preferred?: string): string {
  if (preferred !== undefined && paths.includes(preferred)) return preferred;
  return [...paths].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))[0] ?? preferred ?? 'root';
}

/** Buckets as a tree, from a list of paths, in tree order. */
function bucketTree(paths: string[], root: string): LockView['buckets'] {
  const set = new Set(paths);
  const parentOf = (p: string): string | null => {
    if (p === root) return null;
    let up = parentPath(p);
    while (up !== '' && !set.has(up)) up = parentPath(up);
    return up === '' ? (set.has(root) ? root : null) : up;
  };
  const children = new Map<string, string[]>();
  for (const p of paths) {
    const parent = parentOf(p);
    if (parent === null) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(p);
  }
  const out: LockView['buckets'] = [];
  const visit = (p: string, level: number): void => {
    const kids = (children.get(p) ?? []).sort();
    out.push({ path: p, name: p === root ? root : p.slice(p.lastIndexOf('/') + 1), level, parent: parentOf(p), children: kids });
    for (const k of kids) visit(k, level + 1);
  };
  if (set.has(root)) visit(root, 0);
  for (const p of [...paths].sort()) if (!out.some((b) => b.path === p)) visit(p, p.split('/').length - root.split('/').length);
  return out;
}

/** The contract graph that one version of a lock records. */
export function lockView(lock: Lock, root?: string): LockView {
  const buckets = [...lock.buckets].sort();
  const r = rootOf(buckets, root);
  const contracts: LockViewContract[] = [];
  for (const file of Object.keys(lock.dmz).sort()) {
    const m = DMZ_FILE.exec(file);
    if (!m) continue;
    const [, owner, provider, consumer] = m as unknown as [string, string, string, string];
    contracts.push({
      file,
      owner,
      provider,
      consumer,
      providerBucket: nameBucket(owner, provider),
      consumerBucket: nameBucket(owner, consumer),
      symbols: Object.keys(own(lock.dmz, file)!.symbols).sort(),
    });
  }
  const links = Object.keys(lock.links ?? {})
    .sort()
    .map((p) => {
      const entry = own(lock.links!, p)!;
      return { path: p, name: entry.name, origin: entry.origin, mode: entry.mode, bucket: codeBucket(r, p) };
    });
  const projects = [...(lock.projects ?? [])].sort();
  return {
    root: r,
    buckets: bucketTree(buckets, r),
    contracts,
    links,
    projects,
    counts: {
      buckets: buckets.length,
      contracts: contracts.length,
      symbols: contracts.reduce((n, c) => n + c.symbols.length, 0),
      links: links.length,
      projects: projects.length,
    },
  };
}

export interface ApprovalDiff {
  /** The approval before, or null for the first one. */
  previous: TimelinePoint | null;
  changes: LockChange[];
  review: LockReview;
}

/** What an approval changed since the approval before it, with the same diff and review rows as `refresh --web`. */
export function approvalDiff(project: ProjectSnapshot | undefined, track: TimelineTrack, index: number): ApprovalDiff | null {
  const point = track.points[index];
  if (!point || point.lock === null) return null;
  let previous: TimelinePoint | null = null;
  for (let i = index - 1; i >= 0; i--) {
    if (track.points[i]!.lock !== null) {
      previous = track.points[i]!;
      break;
    }
  }
  const before = previous?.lock ?? null;
  const changes = before ? diffLocks(before, point.lock) : [];
  const config: ResolvedConfig = project?.config ? { adapter: project.config.adapter, root: project.config.root, alias: project.config.alias } : DEFAULT_CONFIG;
  const review = buildReview({
    projectDir: project?.dir ?? '.',
    previous: before,
    next: point.lock,
    changes,
    config,
    lockText: null,
    path: track.project,
    sources: false,
  });
  return { previous, changes, review };
}

const CHANGE_KINDS_OF_FILE = new Set(['dmz-added', 'dmz-removed', 'dmz-changed', 'symbol-added', 'symbol-removed', 'signature-changed']);

/**
 * The map of one approval: the buckets of that lock and of the approval before it, colored by what changed, with the
 * contracts that were added, changed or removed drawn as lines.
 */
export function approvalMapData(project: ProjectSnapshot | undefined, snapshot: InspectSnapshot, track: TimelineTrack, index: number): { data: MapData; edges: MapEdge[]; view: LockView } | null {
  const diff = approvalDiff(project, track, index);
  const point = track.points[index];
  if (!diff || !point?.lock) return null;
  const root = project?.config?.root;
  const now = lockView(point.lock, root);
  const before = diff.previous?.lock ? lockView(diff.previous.lock, root) : null;
  const fresh = before === null;
  const added = new Set(diff.changes.filter((c) => c.kind === 'bucket-added').map((c) => c.path));
  const removed = new Set(diff.changes.filter((c) => c.kind === 'bucket-removed').map((c) => c.path));
  const paths = [...new Set([...now.buckets.map((b) => b.path), ...removed])];
  const tree = bucketTree(paths, now.root);
  const contracts = new Map<string, { contract: LockViewContract; tone: MapTone }>();
  for (const c of now.contracts) contracts.set(c.file, { contract: c, tone: fresh ? 'added' : 'same' });
  for (const change of diff.changes) {
    if (!CHANGE_KINDS_OF_FILE.has(change.kind)) continue;
    if (change.kind === 'dmz-removed') {
      const old = before?.contracts.find((c) => c.file === change.path);
      if (old) contracts.set(old.file, { contract: old, tone: 'removed' });
      continue;
    }
    const entry = contracts.get(change.path);
    if (entry) entry.tone = change.kind === 'dmz-added' ? 'added' : entry.tone === 'added' ? 'added' : 'changed';
  }
  const linkChanged = new Set(diff.changes.filter((c) => c.kind.startsWith('link-')).map((c) => codeBucket(now.root, c.path)));
  const projectsChanged = new Map(diff.changes.filter((c) => c.kind === 'project-added' || c.kind === 'project-removed').map((c) => [c.path, c.kind === 'project-added' ? ('added' as const) : ('removed' as const)]));
  const allProjects = [...new Set([...now.projects, ...(before?.projects ?? [])])];
  const touches = (bucket: string): number =>
    [...contracts.values()].filter(({ contract: c, tone }) => tone !== 'same' && (c.owner === bucket || c.providerBucket === bucket || c.consumerBucket === bucket)).length +
    (linkChanged.has(bucket) ? 1 : 0) +
    allProjects.filter((p) => projectsChanged.has(p) && codeBucket(now.root, p) === bucket).length;
  const buckets: MapBucketData[] = tree.map((b) => {
    const situation: MapTone = fresh || added.has(b.path) ? 'added' : removed.has(b.path) ? 'removed' : touches(b.path) > 0 ? 'changed' : 'same';
    const owned = [...contracts.values()].filter(({ contract: c, tone }) => c.owner === b.path && tone !== 'removed');
    const offered = [...contracts.values()].filter(({ contract: c, tone }) => c.providerBucket === b.path && tone !== 'removed').reduce((n, { contract: c }) => n + c.symbols.length, 0);
    const ownedTones = [...contracts.values()].filter(({ contract: c }) => c.owner === b.path).map((x) => x.tone);
    const dmz: MapTone = ownedTones.includes('removed') || ownedTones.includes('changed') ? 'changed' : ownedTones.includes('added') && !fresh ? 'added' : situation === 'removed' ? 'removed' : 'same';
    const nested = allProjects
      .filter((p) => codeBucket(now.root, p) === b.path)
      .map((p) => {
        const abs = snapshot.projects.find((x) => x.path === (track.project === '.' ? p : `${track.project}/${p}`));
        return { path: p, name: abs?.name ?? p.slice(p.lastIndexOf('/') + 1), situation: (projectsChanged.get(p) ?? (fresh ? 'added' : 'same')) as MapTone, status: 'ok', buckets: abs?.buckets.length ?? 0 };
      });
    return {
      path: b.path,
      name: b.name,
      level: b.level,
      parent: b.parent,
      children: b.children,
      files: Math.max(1, offered),
      code: offered === 0 ? '_/' : `_/ offers ${offered === 1 ? '1 symbol' : `${offered} symbols`}`,
      situation,
      violations: 0,
      lockChanges: situation === 'changed' ? touches(b.path) : 0,
      contracts: owned.length,
      symbols: owned.reduce((n, { contract: c }) => n + c.symbols.length, 0),
      dmz,
      projects: nested,
      dependsOn: [],
      dependents: [],
    };
  });
  const edges: MapEdge[] = [];
  if (!fresh) {
    for (const { contract: c, tone } of contracts.values()) {
      if (tone === 'same') continue;
      const from = c.providerBucket !== null ? { bucket: c.providerBucket } : { strip: c.owner };
      const to = c.consumerBucket !== null ? { bucket: c.consumerBucket } : { strip: c.owner };
      edges.push({ from, to, tone, dashed: tone === 'removed', label: `${c.provider}/${c.consumer}` });
      if (edges.length >= 24) break;
    }
  }
  const data: MapData = {
    project: track.project,
    name: track.name,
    root: now.root,
    situation: 'same',
    codeTone: 'line',
    selected: null,
    highlight: null,
    buckets,
    overlays: { cycles: [], orphans: [], forbidden: [] },
  };
  return { data, edges, view: now };
}
