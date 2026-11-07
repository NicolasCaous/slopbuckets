// The session state files: atomic writes, broken files, the dirty flag under racing writers, and processes that
// write the same file at the same time.
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { emptySessionState, parseSessionState } from '../contract/session.js';
import { violationKey, type Violation } from '../contract/violation.js';
import { cleanupProjects, makeProject } from '../testing/fixture.js';
import { SAMPLES } from '../testing/samples.js';
import { advance, diffPending, emptyHookState, loadSession, markSessionDirty, resetShown, saveSession, sessionRef } from './session.js';

afterEach(cleanupProjects);

describe('session files', () => {
  it('saves and loads one file per session and subagent under .buckets/sessions', () => {
    const root = makeProject({});
    const main = sessionRef(root, 's1');
    const sub = sessionRef(root, 's1', 'a1');
    expect(main.file).toBe(path.join(root, '.buckets', 'sessions', 's1.json'));
    expect(sub.file).toBe(path.join(root, '.buckets', 'sessions', 's1-a1.json'));
    const state = { ...emptyHookState(), pending: [SAMPLES['import-private']], shown: ['k'], dirty: true };
    saveSession(main, state);
    expect(loadSession(main)).toEqual(state);
    expect(loadSession(sub)).toEqual(emptyHookState());
    expect(readdirSync(path.join(root, '.buckets', 'sessions'))).toEqual(['s1.json']);
  });

  it('has no file without a session id or with an unsafe one', () => {
    const root = makeProject({});
    expect(sessionRef(root, null).file).toBeNull();
    expect(sessionRef(root, '../up').file).toBeNull();
    expect(sessionRef(root, 's1', 'a/b').file).toBeNull();
    saveSession(sessionRef(root, null), { ...emptyHookState(), dirty: true });
    expect(loadSession(sessionRef(root, null))).toEqual(emptyHookState());
  });

  it('reads a broken file as an empty state', () => {
    const root = makeProject({});
    const ref = sessionRef(root, 's1');
    mkdirSync(path.dirname(ref.file!), { recursive: true });
    for (const text of ['not json', '[]', '{"version":0}', '']) {
      writeFileSync(ref.file!, text);
      expect(loadSession(ref)).toEqual(emptyHookState());
    }
  });

  it('writes nothing through a .buckets or .buckets/sessions that is a junction', () => {
    for (const link of ['.buckets', '.buckets/sessions']) {
      const root = makeProject({});
      const outside = makeProject({}, false);
      mkdirSync(path.dirname(path.join(root, link)), { recursive: true });
      symlinkSync(outside, path.join(root, link), 'junction');
      expect(saveSession(sessionRef(root, 's1'), { ...emptyHookState(), dirty: true })).toBe(false);
      expect(readdirSync(outside)).toEqual([]);
    }
  });

  it('keeps a dirty flag on disk that a racing writer did not see, unless the stop clears it', () => {
    const root = makeProject({});
    const ref = sessionRef(root, 's1');
    const stale = loadSession(ref);
    saveSession(ref, { ...stale, dirty: true });
    saveSession(ref, { ...stale, shown: ['k'] });
    expect(loadSession(ref)).toMatchObject({ dirty: true, shown: ['k'] });
    saveSession(ref, { ...stale, dirty: false }, { clearDirty: true });
    expect(loadSession(ref).dirty).toBe(false);
  });

  it('markSessionDirty sets dirty and clears the stop block', () => {
    const root = makeProject({});
    const ref = sessionRef(root, 's1');
    saveSession(ref, { ...emptyHookState(), stopBlocked: true }, { clearDirty: true });
    markSessionDirty(ref);
    expect(loadSession(ref)).toMatchObject({ dirty: true, stopBlocked: false });
  });

  it('stays a whole file while several processes write it at once', async () => {
    const root = makeProject({});
    const ref = sessionRef(root, 's1');
    // Bundle the module so plain node processes can run it.
    const bundle = path.join(root, 'session.mjs');
    buildSync({ entryPoints: [fileURLToPath(new URL('./session.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
    const script = `
      const { saveSession, loadSession } = await import(${JSON.stringify(new URL(`file:///${bundle.replace(/\\/g, '/')}`).href)});
      const ref = ${JSON.stringify(ref)};
      for (let i = 0; i < 40; i++) {
        const s = loadSession(ref);
        saveSession(ref, { ...s, shown: [String(process.pid), String(i)], dirty: i % 2 === 0 });
      }`;
    const run = () =>
      new Promise<number | null>((resolve) => spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' }).on('exit', resolve));
    expect(await Promise.all(Array.from({ length: 6 }, run))).toEqual([0, 0, 0, 0, 0, 0]);
    const text = readFileSync(ref.file!, 'utf8');
    expect(parseSessionState(JSON.parse(text)).shown).toHaveLength(2);
    expect(readdirSync(path.dirname(ref.file!))).toEqual(['s1.json']);
  });

  it('saves every write of a burst of 50 hook processes on one session', async () => {
    // A burst of parallel tool calls: each process loads the state and saves it once, as one pre-edit hook does. On
    // Windows a rename onto a file another process is renaming fails with EPERM; every save must still land.
    const root = makeProject({});
    const ref = sessionRef(root, 's1');
    saveSession(ref, emptyHookState(), { clearDirty: true });
    const bundle = path.join(root, 'session.mjs');
    buildSync({ entryPoints: [fileURLToPath(new URL('./session.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
    const script = `
      const { saveSession, loadSession } = await import(${JSON.stringify(new URL(`file:///${bundle.replace(/\\/g, '/')}`).href)});
      const ref = ${JSON.stringify(ref)};
      const s = loadSession(ref);
      process.exitCode = saveSession(ref, { ...s, shown: [String(process.pid)], dirty: process.argv[1] === '0' }) ? 0 : 1;`;
    const run = (i: number) =>
      new Promise<number | null>((resolve) => spawn(process.execPath, ['--input-type=module', '-e', script, String(i)], { stdio: 'ignore' }).on('exit', resolve));
    // Process 0 sets dirty and lands first. A save that read the file before that rename can still drop the flag (the
    // ponytail note in saveSession): under a loaded machine that happened when process 0 ran inside the burst. The
    // saves of the burst start after it, so none of them may drop it.
    expect(await run(0)).toBe(0);
    const codes = await Promise.all(Array.from({ length: 49 }, (_, i) => run(i + 1)));
    expect(codes.filter((c) => c !== 0)).toEqual([]);
    const state = parseSessionState(JSON.parse(readFileSync(ref.file!, 'utf8')));
    expect(state.shown).toHaveLength(1);
    expect(state.dirty).toBe(true);
    expect(readdirSync(path.dirname(ref.file!))).toEqual(['s1.json']);
  }, 60_000);
});

const a = SAMPLES['import-private'];
const b = SAMPLES['file-unowned'];
const c = SAMPLES['import-dynamic'];

describe('diffPending', () => {
  it('splits into fresh, old and resolved by key', () => {
    const moved = { ...a, line: 40 };
    expect(diffPending([a, b], [moved, c], [violationKey(a)])).toEqual({ fresh: [c], old: [moved], resolved: [b] });
  });
});

describe('advance', () => {
  it('shows a violation in full once, then as old, and a resolved one once', () => {
    let state = emptySessionState();
    const step = (current: Violation[]) => {
      const { diff, next } = advance(state, current);
      state = next;
      return diff;
    };
    expect(step([a])).toEqual({ fresh: [a], old: [], resolved: [] });
    expect(step([a, b])).toEqual({ fresh: [b], old: [a], resolved: [] });
    expect(step([b])).toEqual({ fresh: [], old: [b], resolved: [a] });
    expect(step([b])).toEqual({ fresh: [], old: [b], resolved: [] });
    // A violation that comes back after it resolved is new again.
    expect(step([a, b])).toEqual({ fresh: [a], old: [b], resolved: [] });
    expect(state.shown).toEqual([violationKey(a), violationKey(b)]);
  });

  it('keeps dirty and stopBlocked', () => {
    const { next } = advance({ ...emptySessionState(), dirty: true, stopBlocked: true }, [a]);
    expect(next.dirty).toBe(true);
    expect(next.stopBlocked).toBe(true);
  });
});

describe('resetShown', () => {
  it('makes every pending violation fresh again', () => {
    const { next } = advance(emptySessionState(), [a, b]);
    expect(advance(resetShown(next), [a, b]).diff).toEqual({ fresh: [a, b], old: [], resolved: [] });
  });
});
