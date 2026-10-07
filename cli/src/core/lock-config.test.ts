// Lock version 4: the config stored as an object, older locks that store its hash, and what a review shows of a
// config change in the text of `buckets refresh`, the review model of `buckets refresh --web` and the native dialog.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatLockDiff } from '../output/text.js';
import { cleanupProjects, LOGGER_PROJECT, makeProject, writeFile } from '../testing/fixture.js';
import { approve, checkProject, testContext } from '../testing/harness.js';
import { buildReview, evaluateLockState } from '../web/lock-review.js';
import { dialogItems, dialogRequest } from '../web/refresh-app.js';
import { configHash, DEFAULT_CONFIG, type ResolvedConfig } from './config.js';
import { diffLocks, LOCK_VERSION, parseLockText, readLock, serializeLock } from './lock.js';
import { configDiff, lockConfig, lockConfigHash } from './lock-config.js';
import type { Lock } from './types.js';

afterEach(cleanupProjects);

const ACCESS = { default: 'allow', deny: ['root/billing/** -> root/zz*'] };

function lockWith(config: Lock['config'], lockVersion: Lock['lockVersion'] = 4): Lock {
  return { lockVersion, cli: '1.0.0', adapter: { name: 'ts', version: '1.0.0' }, config, buckets: ['root'], dmz: {} };
}

const withAccess = (access: ResolvedConfig['access'], extra: Partial<ResolvedConfig> = {}): ResolvedConfig => lockConfig({ ...DEFAULT_CONFIG, ...extra, ...(access ? { access } : {}) });

describe('lock version 4', () => {
  it('stores the resolved config with sorted keys and reads it back unchanged', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'buckets.config.json': JSON.stringify({ maxDepth: 3, root: 'root', access: ACCESS }) });
    const lock = await approve(dir);
    expect(LOCK_VERSION).toBe(4);
    expect(lock.lockVersion).toBe(4);
    expect(lock.config).toEqual({ access: { allow: [], default: 'allow', deny: ['root/billing/** -> root/zz*'] }, adapter: 'ts', alias: '@root', maxDepth: 3, root: 'root' });
    const read = readLock(dir);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.lock).toEqual(lock);
    expect(serializeLock(read.lock)).toBe(serializeLock(lock));
    expect(Object.keys(read.lock.config as object)).toEqual(['access', 'adapter', 'alias', 'maxDepth', 'root']);
    expect((await checkProject(dir)).report).toEqual({ exitCode: 0, violations: [], lockChanges: [] });
  });

  it('finds no lock difference when two access lines swap places', async () => {
    const access = (allow: string[]) => JSON.stringify({ root: 'root', access: { default: 'allow', allow, deny: ['root/billing/** -> root/zz*'] } });
    const dir = makeProject({ ...LOGGER_PROJECT, 'buckets.config.json': access(['root/a -> root/log', 'root/b -> root/log']) });
    await approve(dir);
    writeFile(dir, 'buckets.config.json', access(['root/b -> root/log', 'root/a -> root/log']));
    expect((await checkProject(dir)).report.lockChanges).toEqual([]);
  });

  it('keeps a config without access out of the hash, so the hash of version 3 locks stays valid', () => {
    expect(lockConfigHash(lockConfig(DEFAULT_CONFIG))).toBe(configHash(DEFAULT_CONFIG));
    expect(Object.keys(lockConfig(DEFAULT_CONFIG))).not.toContain('access');
  });

  it.each([
    ['a hash string', 'sha256:c', 'config is malformed'],
    ['no config', undefined, 'config is missing'],
    ['an access object without default', { ...DEFAULT_CONFIG, access: { allow: [], deny: [] } }, 'config.access is malformed'],
    ['an access list that is not an array', { ...DEFAULT_CONFIG, access: { default: 'deny', allow: 'x', deny: [] } }, 'config.access is malformed'],
  ])('refuses a version 4 lock with %s as config', (_name, config, reason) => {
    expect(parseLockText(JSON.stringify({ ...lockWith(DEFAULT_CONFIG), config }))).toEqual({ kind: 'invalid', reason });
  });

  it('refuses a version 3 lock whose config is not a hash string', () => {
    expect(parseLockText(JSON.stringify(lockWith(DEFAULT_CONFIG, 3)))).toEqual({ kind: 'invalid', reason: 'config is missing' });
  });
});

describe('reading locks of version 3', () => {
  async function approvedAsVersion3(dir: string): Promise<void> {
    const lock = await approve(dir);
    writeFileSync(path.join(dir, 'buckets.lock.json'), serializeLock({ ...lock, lockVersion: 3, config: lockConfigHash(lock.config) }));
  }

  it('reports no difference when the config did not change', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approvedAsVersion3(dir);
    const result = await checkProject(dir);
    expect(result.previousLock?.lockVersion).toBe(3);
    expect(result.report).toEqual({ exitCode: 0, violations: [], lockChanges: [] });
  });

  it('reports one config-changed when the config changed, and says the old values are unknown', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approvedAsVersion3(dir);
    writeFile(dir, 'buckets.config.json', JSON.stringify({ root: 'root', maxDepth: 3, access: ACCESS }));
    const { report } = await checkProject(dir);
    expect(report.exitCode).toBe(2);
    expect(report.lockChanges.map((c) => c.kind)).toEqual(['config-changed']);
    expect(report.lockChanges[0]!.message).toContain('stored only a hash of the config, so the old values are unknown');
  });

  it('shows the current config in the text diff, the review and the dialog', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approvedAsVersion3(dir);
    writeFile(dir, 'buckets.config.json', JSON.stringify({ root: 'root', maxDepth: 3, access: ACCESS }));
    const state = await evaluateLockState(testContext(), dir);
    if (state.kind !== 'review') throw new Error(`expected a review, got ${state.kind}`);
    expect(state.review.config).toMatchObject({ changed: true, recorded: false, changes: [], current: { maxDepth: 3, access: { default: 'allow' } } });
    const text = formatLockDiff(state.previous, state.lock, state.changes);
    expect(text).toContain('~ config changed');
    expect(text).toContain('The approved lock (version 3) stored only a hash of buckets.config.json, so the old values are unknown. Approving records these values:');
    expect(text).toMatch(/\n {6}maxDepth +3\n/);
    expect(text).toMatch(/\n {6}access\.deny +root\/billing\/\*\* -> root\/zz\*\n/);
    const items = dialogItems(state.review);
    expect(items).toContain('~ buckets.config.json changed, its old values were not recorded. Approving records:');
    expect(items).toContain('config access.deny: root/billing/** -> root/zz*');
  });
});

describe('config changes between locks of version 4', () => {
  const before = withAccess({ default: 'deny', allow: ['** -> root/log', 'root/api/** -> root/billing/**'], deny: [] });
  const after = withAccess({ default: 'deny', allow: ['** -> root/log', 'root/web/** -> root/billing/**'], deny: ['root/billing/payments/** -> root/sql/**'] }, { maxDepth: 3 });

  it('finds no change for the same config', () => {
    expect(configDiff(before, lockConfig(before))).toBeNull();
    expect(diffLocks(lockWith(before), lockWith(lockConfig(before)))).toEqual([]);
  });

  it('lists each access line added or removed with its list, and other keys with the old and new value', () => {
    expect(configDiff(before, after)).toEqual({
      recorded: true,
      changes: [
        { kind: 'access-line', sign: '-', list: 'allow', line: 'root/api/** -> root/billing/**' },
        { kind: 'access-line', sign: '+', list: 'allow', line: 'root/web/** -> root/billing/**' },
        { kind: 'access-line', sign: '+', list: 'deny', line: 'root/billing/payments/** -> root/sql/**' },
        { kind: 'value', key: 'maxDepth', before: '2', after: '3' },
      ],
    });
    const changes = diffLocks(lockWith(before), lockWith(after));
    expect(changes.map((c) => c.kind)).toEqual(['config-changed']);
    expect(changes[0]!.message).toBe(
      'buckets.config.json changed since the lock was approved: removed the "access.allow" line "root/api/** -> root/billing/**"; added the "access.allow" line "root/web/** -> root/billing/**"; added the "access.deny" line "root/billing/payments/** -> root/sql/**"; changed "maxDepth" from 2 to 3. A human must review this and run `buckets refresh`.',
    );
  });

  it('reports a default change, and access added or removed as a whole with its lines', () => {
    const allow = withAccess({ default: 'allow', allow: [], deny: before.access!.allow });
    expect(configDiff(before, allow)!.changes[0]).toEqual({ kind: 'access-default', before: 'deny', after: 'allow' });
    const none = withAccess(undefined);
    expect(configDiff(none, before)!.changes).toEqual([
      { kind: 'access', sign: '+', default: 'deny' },
      { kind: 'access-line', sign: '+', list: 'allow', line: '** -> root/log' },
      { kind: 'access-line', sign: '+', list: 'allow', line: 'root/api/** -> root/billing/**' },
    ]);
    expect(configDiff(before, none)!.changes.map((c) => `${c.kind} ${'sign' in c ? c.sign : ''}`)).toEqual(['access -', 'access-line -', 'access-line -']);
  });

  it('prints one indented line per change under "config changed" in the text diff, and counts the change once', () => {
    const previous = lockWith(before);
    const next = lockWith(after);
    const text = formatLockDiff(previous, next, diffLocks(previous, next));
    expect(text.split('\n')).toEqual([
      '~ config changed          buckets.config.json',
      '    - access.allow  root/api/** -> root/billing/**',
      '    + access.allow  root/web/** -> root/billing/**',
      '    + access.deny   root/billing/payments/** -> root/sql/**',
      '    ~ maxDepth      2 to 3',
      '',
    ]);
  });

  it('fills the review model and the dialog lines with the changes', () => {
    const previous = lockWith(before);
    const next = lockWith(after);
    const review = buildReview({ projectDir: '.', previous, next, changes: diffLocks(previous, next), config: DEFAULT_CONFIG, lockText: '{}' });
    expect(review.config).toEqual({ changed: true, current: after, recorded: true, changes: configDiff(before, after)!.changes });
    expect(review.counts).toMatchObject({ changed: 1, total: 1 });
    expect(dialogItems(review)).toEqual([
      '~ buckets.config.json changed',
      '- config access.allow: root/api/** -> root/billing/**',
      '+ config access.allow: root/web/** -> root/billing/**',
      '+ config access.deny: root/billing/payments/** -> root/sql/**',
      '~ config maxDepth: 2 to 3',
    ]);
  });

  it('shows a long access line in full in the dialog, wrapped onto more lines', () => {
    const long = 'root/billing/payments/providers/stripe/webhooks/** -> root/infrastructure/database/postgres/migrations/**';
    const previous = lockWith(before);
    const next = lockWith(withAccess({ default: 'deny', allow: ['** -> root/log', 'root/api/** -> root/billing/**', long], deny: [] }));
    const review = buildReview({ projectDir: '.', previous, next, changes: diffLocks(previous, next), config: DEFAULT_CONFIG, lockText: '{}' });
    const row = `+ config access.allow: ${long}`;
    expect(row.length).toBeGreaterThan(100);
    const item = dialogItems(review)[1]!;
    expect(item.split('\n')).toEqual(['+ config access.allow: root/billing/payments/providers/stripe/webhooks/** ->', 'root/infrastructure/database/postgres/migrations/**']);
    expect(item.replace('\n', ' ')).toBe(row);
    expect(dialogRequest(review).message).toContain('  + config access.allow: root/billing/payments/providers/stripe/webhooks/** ->\n      root/infrastructure/database/postgres/migrations/**\n');
  });
});
