import { describe, expect, it } from 'vitest';
import { formatLockDiff } from '../output/text.js';
import { dialogItems } from '../web/refresh-app.js';
import { buildReview } from '../web/lock-review.js';
import { renderReviewPage } from '../web/refresh-page.js';
import { DEFAULT_CONFIG } from './config.js';
import { diffLocks, isSupportedLockVersion, parseLockText } from './lock.js';
import type { Lock, LockLink } from './types.js';

const BASE: Lock = { lockVersion: 3, cli: '1', adapter: { name: 'ts', version: '1' }, config: 'c', buckets: ['root'], dmz: {} };
const LINK: LockLink = { name: 'api', origin: '../api', mode: 'copy', alias: '@root-api23456', symbols: { 'dmz/server/.external.ts': { handle: 'sha256:a', Router: 'sha256:r' } } };
const P = 'root/web/_/links/api';

function kinds(previous: Lock, current: Lock): string[] {
  return diffLocks(previous, current).map((c) => `${c.kind} ${c.path}${c.symbol !== undefined ? ` ${c.symbol}` : ''}`);
}

describe('lock sections for nested projects and links', () => {
  it('accepts versions 1 to 4', () => {
    expect([0, 1, 2, 3, 4, 1.5].map(isSupportedLockVersion)).toEqual([false, true, true, true, true, false]);
  });

  it('treats missing sections as empty', () => {
    const old: Lock = { ...BASE, lockVersion: 1 };
    expect(kinds(old, { ...BASE, projects: ['root/_/sub'], links: { [P]: LINK } })).toEqual(['project-added root/_/sub', `link-added ${P}`]);
    expect(kinds({ ...BASE, projects: ['root/_/sub'], links: { [P]: LINK } }, old)).toEqual(['project-removed root/_/sub', `link-removed ${P}`]);
  });

  it('reports a changed origin, mode or alias as one link-changed without a symbol', () => {
    const before = { ...BASE, links: { [P]: LINK } };
    for (const change of [{ origin: '../other' }, { mode: 'link' as const }, { alias: '@root-other234' }]) {
      expect(kinds(before, { ...BASE, links: { [P]: { ...LINK, ...change } } })).toEqual([`link-changed ${P}`]);
    }
  });

  it('reports each published symbol that changed, appeared or went away', () => {
    const before = { ...BASE, links: { [P]: LINK } };
    const after = { ...BASE, links: { [P]: { ...LINK, symbols: { 'dmz/server/.external.ts': { handle: 'sha256:b', Extra: 'sha256:e' } } } } };
    const changes = diffLocks(before, after);
    expect(changes.map((c) => `${c.kind} ${c.symbol}`)).toEqual(['link-changed Extra', 'link-changed Router', 'link-changed handle']);
    expect(changes.find((c) => c.symbol === 'handle')!.message).toContain('The signature of `handle`');
    expect(changes.find((c) => c.symbol === 'Router')!.message).toContain('no longer publishes `Router`');
    expect(changes.find((c) => c.symbol === 'Extra')!.message).toContain('now publishes `Extra`');
  });

  it('reports nothing when only the internals of the origin changed', () => {
    const before = { ...BASE, links: { [P]: LINK } };
    expect(kinds(before, { ...BASE, links: { [P]: structuredClone(LINK) } })).toEqual([]);
  });

  it('skips the symbols of a link that is missing on disk', () => {
    const before = { ...BASE, links: { [P]: LINK } };
    const { symbols: _symbols, ...missing } = LINK;
    expect(kinds(before, { ...BASE, links: { [P]: missing } })).toEqual([]);
  });

  it('reads a version 2 lock with the old link fields and the external hash', () => {
    const text = JSON.stringify({
      lockVersion: 2,
      cli: '1',
      adapter: { name: 'ts', version: '1' },
      config: 'c',
      buckets: ['root'],
      dmz: { 'root/dmz/api/.external.ts': { text: 't', symbols: {}, external: 'sha256:1' } },
      links: { [P]: { name: 'api', origin: '../api/root/dmz/server/.external.ts', mode: 'copy', hash: 'sha256:a' } },
    });
    const read = parseLockText(text);
    expect(read.kind).toBe('ok');
    const old = (read as { lock: Lock }).lock;
    const now: Lock = { ...BASE, dmz: { 'root/dmz/api/.external.ts': { text: 't', symbols: {} } }, links: { [P]: { ...LINK, origin: '../api' } } };
    // The external hash is ignored; the link asks for approval of its new shape, once per difference.
    expect(kinds(old, now)).toEqual([`link-changed ${P}`, `link-changed ${P} Router`, `link-changed ${P} handle`]);
  });

  it('lists nested projects and links in the diff of a first lock', () => {
    const text = formatLockDiff(null, { ...BASE, projects: ['root/_/sub'], links: { [P]: LINK } }, []);
    expect(text).toContain('1 nested project:\n    root/_/sub');
    expect(text).toContain(`1 link:\n    ${P}  (copy of ../api, alias @root-api23456, 2 published symbols)`);
  });

  it('shows each published symbol of a link in the refresh review, the page and the dialog', () => {
    const before = { ...BASE, links: { [P]: LINK } };
    const after = { ...BASE, links: { [P]: { ...LINK, symbols: { 'dmz/server/.external.ts': { handle: 'sha256:b', Extra: 'sha256:e' } } } } };
    const review = buildReview({ projectDir: '.', previous: before, next: after, changes: diffLocks(before, after), config: DEFAULT_CONFIG, lockText: '{}' });
    expect(review.links).toEqual([
      {
        sign: '~',
        path: P,
        label: 'published symbols changed',
        detail: 'copy of the project ../api, imported as @root-api23456',
        symbols: [
          { sign: '+', name: 'Extra', file: 'dmz/server/.external.ts' },
          { sign: '-', name: 'Router', file: 'dmz/server/.external.ts' },
          { sign: '~', name: 'handle', file: 'dmz/server/.external.ts' },
        ],
      },
    ]);
    expect(review.counts).toMatchObject({ added: 1, removed: 1, changed: 1 });
    expect(dialogItems(review)).toContain(`~ published symbols changed ${P}: +Extra, -Router, ~handle`);
    const fresh = buildReview({ projectDir: '.', previous: null, next: before, changes: [], config: DEFAULT_CONFIG, lockText: null });
    expect(fresh.links[0]!.symbols!.map((s) => `${s.sign}${s.name}`)).toEqual(['+Router', '+handle']);
    const page = renderReviewPage({ token: 'tok', projectName: 'fixture' }, review);
    expect(page).toContain('aria-label="Published symbols"');
    expect(page).toContain('signature changed in <code translate="no">dmz/server/.external.ts</code>');
  });
});
