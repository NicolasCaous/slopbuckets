import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serializeLock } from '../core/lock.js';
import type { Lock } from '../core/types.js';
import { cleanupProjects, makeProject, removeFile, TMP_ROOT, writeFile } from '../testing/fixture.js';
import type { InspectSnapshot } from './snapshot.js';
import { approvalDiff, approvalMapData, lockView, readTrack, systemGit, timelineCache, trackKey, WORKING, type GitError, type GitRunner, type TimelineTrack } from './timeline.js';

afterEach(cleanupProjects);

const HAS_GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Git that never looks above the temporary folder, so the repository of this checkout does not count. */
const git = systemGit({ ...process.env, GIT_CEILING_DIRECTORIES: TMP_ROOT.replace(/[\\/]$/, '') });

function lock(buckets: string[], dmz: Record<string, string[]>, extra: Partial<Lock> = {}): Lock {
  const out: Lock = { lockVersion: 2, cli: '1.0.0', adapter: { name: 'fake', version: '1.0.0' }, config: 'sha256:c', buckets, dmz: {} };
  for (const [file, symbols] of Object.entries(dmz)) out.dmz[file] = { text: `sha256:${file}`, symbols: Object.fromEntries(symbols.map((s) => [s, `sha256:${s}`])) };
  return { ...out, ...extra };
}

const V1 = lock(['root', 'root/log', 'root/billing'], { 'root/dmz/log/billing.ts': ['logger'] });
const V2 = lock(['root', 'root/log', 'root/billing', 'root/billing/invoices', 'root/billing/payments'], {
  'root/dmz/log/billing.ts': ['logger'],
  'root/billing/dmz/.parent/invoices.ts': ['logger'],
  'root/billing/dmz/invoices/payments.ts': ['total'],
});
const V3 = lock(['root', 'root/log', 'root/billing', 'root/billing/invoices'], {
  'root/dmz/log/billing.ts': ['logger', 'level'],
  'root/billing/dmz/.parent/invoices.ts': ['logger'],
}, { links: { 'root/log/_/links/kit': { name: 'kit', origin: '../kit/root/dmz/ui/.external.ts', mode: 'copy', hash: 'sha256:k' } }, projects: ['root/log/_/engine'] });

function run(dir: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd: dir,
    stdio: 'ignore',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: TMP_ROOT.replace(/[\\/]$/, ''), GIT_AUTHOR_NAME: 'Ana Lima', GIT_AUTHOR_EMAIL: 'ana@example.com', GIT_COMMITTER_NAME: 'Ana Lima', GIT_COMMITTER_EMAIL: 'ana@example.com' },
  });
}

function commit(dir: string, message: string, date: string): void {
  run(dir, 'add', '-A');
  run(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '--date', date, '-m', message);
}

function repo(): string {
  const dir = makeProject({ 'buckets.config.json': '{ "root": "root" }\n' }, false);
  run(dir, 'init', '-q');
  return dir;
}

const project = (dir: string) => ({ path: '.', name: 'fixture', dir });

describe.skipIf(!HAS_GIT)('reading the approvals from git', () => {
  it('lists every commit that changed the lock, oldest first, with date, author, subject and that version of the lock', async () => {
    const dir = repo();
    writeFile(dir, 'buckets.lock.json', serializeLock(V1));
    commit(dir, 'Approve log and billing', '2026-09-01T10:00:00Z');
    writeFile(dir, 'notes.txt', 'not a lock change\n');
    commit(dir, 'Unrelated commit', '2026-09-02T10:00:00Z');
    writeFile(dir, 'buckets.lock.json', serializeLock(V2));
    commit(dir, 'Approve invoices and payments', '2026-09-03T10:00:00Z');
    const track = await readTrack(project(dir), git);
    expect(track.status).toBe('ok');
    expect(track.truncated).toBe(false);
    expect(track.points.map((p) => [p.subject, p.author, p.date.slice(0, 10), p.state, p.file])).toEqual([
      ['Approve log and billing', 'Ana Lima', '2026-09-01', 'ok', 'buckets.lock.json'],
      ['Approve invoices and payments', 'Ana Lima', '2026-09-03', 'ok', 'buckets.lock.json'],
    ]);
    expect(track.points[0]!.lock).toEqual(V1);
    expect(track.points[1]!.lock).toEqual(V2);
    expect(track.points[1]!.short).toHaveLength(7);
  });

  it('adds the lock on disk when it differs from the last commit, and marks a commit that deleted the lock', async () => {
    const dir = repo();
    writeFile(dir, 'buckets.lock.json', serializeLock(V1));
    commit(dir, 'First', '2026-09-01T10:00:00Z');
    removeFile(dir, 'buckets.lock.json');
    commit(dir, 'Delete the lock', '2026-09-02T10:00:00Z');
    writeFile(dir, 'buckets.lock.json', serializeLock(V2));
    commit(dir, 'Approve again', '2026-09-03T10:00:00Z');
    writeFile(dir, 'buckets.lock.json', serializeLock(V3));
    const track = await readTrack(project(dir), git);
    expect(track.points.map((p) => [p.subject, p.state])).toEqual([
      ['First', 'ok'],
      ['Delete the lock', 'deleted'],
      ['Approve again', 'ok'],
      ['Approved on disk, not committed yet', 'ok'],
    ]);
    expect(track.points[3]!.id).toBe(WORKING);
    expect(track.points[3]!.lock).toEqual(V3);
  });

  it('explains an empty track: no commits, a lock never committed, no lock, not a repository', async () => {
    const empty = repo();
    expect(await readTrack(project(empty), git)).toMatchObject({ status: 'no-commits', points: [] });
    writeFile(empty, 'other.txt', 'x\n');
    commit(empty, 'Something else', '2026-09-01T10:00:00Z');
    expect(await readTrack(project(empty), git)).toMatchObject({ status: 'no-lock' });
    writeFile(empty, 'buckets.lock.json', serializeLock(V1));
    const untracked = await readTrack(project(empty), git);
    expect(untracked.status).toBe('untracked');
    expect(untracked.message).toContain('not committed');
    const plain = makeProject({ 'buckets.lock.json': serializeLock(V1) }, false);
    expect(await readTrack(project(plain), git)).toMatchObject({ status: 'not-repo', message: expect.stringContaining('not in a git repository') });
  });

  it('reads a track again only when HEAD or the lock on disk changes', async () => {
    const dir = repo();
    writeFile(dir, 'buckets.lock.json', serializeLock(V1));
    commit(dir, 'First', '2026-09-01T10:00:00Z');
    const calls: string[] = [];
    const counting: GitRunner = (args, cwd) => {
      calls.push(args[0]!);
      return git(args, cwd);
    };
    const cache = timelineCache(counting);
    const snapshot = { projects: [{ path: '.', name: 'fixture', dir }] } as unknown as InspectSnapshot;
    expect((await cache.get(snapshot)).tracks[0]!.points).toHaveLength(1);
    const first = calls.filter((c) => c === 'log').length;
    await cache.get(snapshot);
    expect(calls.filter((c) => c === 'log').length).toBe(first);
    writeFile(dir, 'buckets.lock.json', serializeLock(V2));
    commit(dir, 'Second', '2026-09-02T10:00:00Z');
    expect((await cache.get(snapshot)).tracks[0]!.points).toHaveLength(2);
    expect(calls.filter((c) => c === 'log').length).toBe(first + 1);
  });

  it('finds the lock of a nested project in the same repository', async () => {
    const dir = repo();
    writeFile(dir, 'root/log/_/engine/buckets.lock.json', serializeLock(V1));
    commit(dir, 'Engine approval', '2026-09-01T10:00:00Z');
    const track = await readTrack({ path: 'root/log/_/engine', name: 'engine', dir: path.join(dir, 'root/log/_/engine') }, git);
    expect(track.points.map((p) => [p.subject, p.file])).toEqual([['Engine approval', 'root/log/_/engine/buckets.lock.json']]);
  });
});

describe('git that cannot help', () => {
  it('reports a missing git, a shallow clone and other git errors without throwing', async () => {
    const dir = makeProject({ 'buckets.lock.json': serializeLock(V1) }, false);
    const missing: GitRunner = () => Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) as GitError);
    expect(await readTrack(project(dir), missing)).toMatchObject({ status: 'no-git', points: [], message: expect.stringContaining('Git is not installed') });
    const shallow: GitRunner = (args) => Promise.resolve(args[0] === 'rev-parse' && args[1] === '--show-toplevel' ? `${dir}\ntrue\n` : 'abc\n');
    expect(await readTrack(project(dir), shallow)).toMatchObject({ status: 'shallow', message: expect.stringContaining('git fetch --unshallow') });
    const dubious: GitRunner = () => Promise.reject(Object.assign(new Error('failed'), { code: 128, stderr: "fatal: detected dubious ownership in repository at 'x'\n" }) as GitError);
    expect(await readTrack(project(dir), dubious)).toMatchObject({ status: 'error', message: expect.stringContaining('dubious ownership') });
    expect((await trackKey(dir, missing)).key).toMatch(/^no-git\|/);
  });
});

describe('a version of the lock as a contract graph', () => {
  it('rebuilds the bucket tree, the contracts with provider and consumer, links and nested projects', () => {
    const view = lockView(V3, 'root');
    expect(view.root).toBe('root');
    expect(view.buckets.map((b) => [b.path, b.level, b.parent, b.children])).toEqual([
      ['root', 0, null, ['root/billing', 'root/log']],
      ['root/billing', 1, 'root', ['root/billing/invoices']],
      ['root/billing/invoices', 2, 'root/billing', []],
      ['root/log', 1, 'root', []],
    ]);
    expect(view.contracts).toEqual([
      { file: 'root/billing/dmz/.parent/invoices.ts', owner: 'root/billing', provider: '.parent', consumer: 'invoices', providerBucket: null, consumerBucket: 'root/billing/invoices', symbols: ['logger'] },
      { file: 'root/dmz/log/billing.ts', owner: 'root', provider: 'log', consumer: 'billing', providerBucket: 'root/log', consumerBucket: 'root/billing', symbols: ['level', 'logger'] },
    ]);
    expect(view.links).toEqual([{ path: 'root/log/_/links/kit', name: 'kit', origin: '../kit/root/dmz/ui/.external.ts', mode: 'copy', bucket: 'root/log' }]);
    expect(view.counts).toEqual({ buckets: 4, contracts: 2, symbols: 3, links: 1, projects: 1 });
    expect(lockView(lock(['src/app', 'src/app/a'], {})).root).toBe('src/app');
  });

  const track: TimelineTrack = {
    project: '.',
    name: 'fixture',
    status: 'ok',
    truncated: false,
    repo: null,
    points: [V1, V2, V3].map((l, i) => ({ id: `c${i}`, short: `c${i}`, date: `2026-09-0${i + 1}T10:00:00Z`, author: 'Ana', subject: `step ${i}`, file: 'buckets.lock.json', state: 'ok' as const, lock: l })),
  };

  it('diffs each approval against the one before with diffLocks and the review rows of refresh --web', () => {
    const first = approvalDiff(undefined, track, 0)!;
    expect(first.previous).toBeNull();
    expect(first.review.fresh).toBe(true);
    const last = approvalDiff(undefined, track, 2)!;
    expect(last.previous!.id).toBe('c1');
    expect(last.changes.map((c) => `${c.kind} ${c.path}${c.symbol ? ` ${c.symbol}` : ''}`)).toEqual([
      'bucket-removed root/billing/payments',
      'project-added root/log/_/engine',
      'dmz-removed root/billing/dmz/invoices/payments.ts',
      'symbol-added root/dmz/log/billing.ts level',
      'link-added root/log/_/links/kit',
    ]);
    expect(last.review.counts).toMatchObject({ added: 3, removed: 2 });
    expect(last.review.dmz.every((row) => row.source === undefined)).toBe(true);
  });

  it('colors the map of an approval by what changed and draws the changed contracts', () => {
    const snapshot = { projects: [] } as unknown as InspectSnapshot;
    const map = approvalMapData(undefined, snapshot, track, 2)!;
    const tone = Object.fromEntries(map.data.buckets.map((b) => [b.path, b.situation]));
    expect(tone).toEqual({ root: 'changed', 'root/billing': 'changed', 'root/billing/invoices': 'changed', 'root/billing/payments': 'removed', 'root/log': 'changed' });
    expect(map.data.buckets.find((b) => b.path === 'root/log')!.projects).toEqual([expect.objectContaining({ path: 'root/log/_/engine', situation: 'added' })]);
    expect(map.edges.map((e) => [e.tone, e.label])).toEqual([
      ['changed', 'log/billing'],
      ['removed', 'invoices/payments'],
    ]);
    const fresh = approvalMapData(undefined, snapshot, track, 0)!;
    expect(new Set(fresh.data.buckets.map((b) => b.situation))).toEqual(new Set(['added']));
    expect(fresh.edges).toEqual([]);
  });
});
