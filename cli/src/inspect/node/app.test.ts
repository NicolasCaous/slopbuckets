import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SnapshotV2 } from '../../contract/snapshot.js';
import { createFakeEngine } from '../../testing/fake-engine.js';
import { makeProject } from '../../testing/fixture.js';
import { httpRequest } from '../../testing/http.js';
import { irrelevant, startInspectApp, type InspectApp, type InspectAppOptions } from './app.js';

const fixtures = fileURLToPath(new URL('../../../../examples/fixtures/snapshots/', import.meta.url));
const load = (name: string): SnapshotV2 => JSON.parse(readFileSync(path.join(fixtures, `${name}.json`), 'utf8')) as SnapshotV2;
const assets = { script: 'window.stub = 1;', css: null };

/** An engine whose snapshot is whatever `current` holds when it is called. */
function engineOf(first: SnapshotV2) {
  const state = { current: first, calls: 0 };
  const engine = { ...createFakeEngine(), snapshot: async () => (state.calls++, state.current) };
  return { engine, state };
}

const apps: InspectApp[] = [];
afterEach(() => vi.useRealTimers());
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function start(options: Partial<InspectAppOptions> & { root: string; engine: InspectAppOptions['engine'] }): Promise<InspectApp> {
  const app = await startInspectApp({ assets, watch: false, ...options });
  apps.push(app);
  return app;
}

/** Opens /events and resolves with each `snapshot` event's data, through `next()`. */
function openEvents(port: number) {
  const queue: string[] = [];
  const waiters: ((data: string) => void)[] = [];
  let buffer = '';
  let response: IncomingMessage | undefined;
  const req = request({ host: '127.0.0.1', port, path: '/events', headers: { host: `127.0.0.1:${port}` }, agent: false }, (res) => {
    response = res;
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event !== 'snapshot' || data === undefined) continue;
        const waiter = waiters.shift();
        if (waiter) waiter(data);
        else queue.push(data);
      }
    });
  });
  req.end();
  const opened = new Promise<void>((resolve) => req.once('response', () => resolve()));
  return {
    opened,
    next: () => new Promise<string>((resolve) => (queue.length > 0 ? resolve(queue.shift()!) : waiters.push(resolve))),
    status: () => response?.statusCode,
    close: () => req.destroy(),
  };
}

describe('startInspectApp', () => {
  it('serves the page, the bundle and the snapshot', async () => {
    const small = load('small');
    const app = await start({ root: makeProject({}), engine: engineOf(small).engine });
    const page = await httpRequest(app.server.port);
    expect(page.status).toBe(200);
    expect(page.body).toContain('<script src="/inspect-page.js"></script>');
    const script = await httpRequest(app.server.port, { path: '/inspect-page.js' });
    expect(script.headers['content-type']).toContain('text/javascript');
    expect(script.body).toBe(assets.script);
    const snap = await httpRequest(app.server.port, { path: '/snapshot.json' });
    expect(snap.headers['content-type']).toContain('application/json');
    expect(JSON.parse(snap.body)).toEqual(small);
    expect((await httpRequest(app.server.port, { path: '/inspect-page.css' })).status).toBe(404);
  });

  it('keeps the Host, Origin and method checks of the server', async () => {
    const app = await start({ root: makeProject({}), engine: engineOf(load('small')).engine });
    const port = app.server.port;
    expect((await httpRequest(port, { path: '/snapshot.json', headers: { host: `evil.example:${port}` } })).status).toBe(403);
    expect((await httpRequest(port, { path: '/snapshot.json', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await httpRequest(port, { path: '/snapshot.json', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' } })).status).toBe(403);
    expect((await httpRequest(port, { method: 'POST', path: '/snapshot.json', headers: { origin: `http://127.0.0.1:${port}` } })).status).toBe(403);
  });

  it('keeps only the root project without recursion', async () => {
    const app = await start({ root: makeProject({}), engine: engineOf(load('small')).engine, recursive: false });
    const snap = JSON.parse((await httpRequest(app.server.port, { path: '/snapshot.json' })).body) as SnapshotV2;
    expect(snap.projects.map((p) => p.path)).toEqual(['.']);
  });

  it('sends the new snapshot on /events after a file changes', async () => {
    const root = makeProject({ 'src/a.ts': 'export {};\n' });
    const small = load('small');
    const { engine, state } = engineOf(small);
    const app = await start({ root, engine, watch: true, debounceMs: 50 });
    expect(app.watching).toBe(true);
    const events = openEvents(app.server.port);
    await events.opened;
    const changed = structuredClone(small);
    changed.projects[0]!.buckets[0]!.purpose = 'Changed while the page was open';
    state.current = changed;
    writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
    expect(JSON.parse(await events.next())).toEqual(changed);
    expect(JSON.parse((await httpRequest(app.server.port, { path: '/snapshot.json' })).body)).toEqual(changed);
    events.close();
  });

  it('passes the changed paths to the engine, and a full snapshot follows', async () => {
    const root = makeProject({ 'src/a.ts': 'export {};\n' });
    const small = load('small');
    const calls: (readonly string[] | undefined)[] = [];
    let wake = () => {};
    const engine = {
      ...createFakeEngine(),
      snapshot: async (_root: string, options?: { changed?: readonly string[] }) => {
        calls.push(options?.changed);
        wake();
        return small;
      },
    };
    const until = (test: () => boolean) => new Promise<void>((resolve) => (wake = () => test() && resolve()));
    const app = await start({ root, engine, watch: true, debounceMs: 30, fullSnapshotMs: 300 });
    expect(calls).toEqual([undefined]);
    const known = until(() => calls.at(-1)?.includes('src/a.ts') === true);
    writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
    await known;
    await until(() => calls.at(-1) === undefined);
    // An explicit refresh lists every file too.
    const count = calls.length;
    await app.refresh();
    expect(calls.slice(count)).toEqual([undefined]);
  });

  it('updates when an ignored file appears or goes, but not when only its content changes', async () => {
    const root = makeProject({ 'scripts/build.ts': 'export {};\n' });
    const small = load('small');
    expect(irrelevant(small, 'scripts/build.ts')).toBe(true);
    const calls: (readonly string[] | undefined)[] = [];
    let wake = () => {};
    const engine = {
      ...createFakeEngine(),
      snapshot: async (_root: string, options?: { changed?: readonly string[] }) => {
        calls.push(options?.changed);
        wake();
        return small;
      },
    };
    const next = () => new Promise<void>((resolve) => (wake = resolve));
    await start({ root, engine, watch: true, debounceMs: 30 });
    expect(calls).toHaveLength(1);
    // The new content of an ignored file triggers no snapshot of its own: the next one is the one of the new file.
    let snapshot = next();
    writeFileSync(path.join(root, 'scripts/build.ts'), 'export const b = 1;\n');
    writeFileSync(path.join(root, 'scripts/new.ts'), 'export {};\n');
    await snapshot;
    expect(calls).toHaveLength(2);
    expect(calls.at(-1)).toContain('scripts/new.ts');
    snapshot = next();
    rmSync(path.join(root, 'scripts/new.ts'));
    await snapshot;
    expect(calls.at(-1)).toContain('scripts/new.ts');
  });

  it('sends nothing when the snapshot did not change', async () => {
    const small = load('small');
    const { engine, state } = engineOf(small);
    const app = await start({ root: makeProject({}), engine });
    const events = openEvents(app.server.port);
    await events.opened;
    await app.refresh();
    expect(state.calls).toBe(2);
    state.current = structuredClone(small);
    state.current.projects[0]!.buckets[0]!.purpose = 'New';
    await app.refresh();
    // The first event is the second refresh: the first one found the same snapshot.
    expect(JSON.parse(await events.next()).projects[0].buckets[0].purpose).toBe('New');
    events.close();
  });

  it('keeps the last snapshot when the engine fails', async () => {
    const small = load('small');
    const errors: unknown[] = [];
    let fail = false;
    const engine = { ...createFakeEngine(), snapshot: async () => { if (fail) throw new Error('boom'); return small; } };
    const app = await start({ root: makeProject({}), engine, onError: (e) => errors.push(e) });
    fail = true;
    await app.refresh();
    expect(errors).toHaveLength(1);
    expect(app.snapshot()).toBe(small);
  });

  it('shuts down after the idle time, but not while a page is connected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const app = await start({ root: makeProject({}), engine: engineOf(load('small')).engine, idleTimeoutMs: 300 });
    const events = openEvents(app.server.port);
    await events.opened;
    let closed = false;
    void app.server.closed.then(() => (closed = true));
    vi.advanceTimersByTime(700);
    expect(closed).toBe(false);
    events.close();
    // With fake timers, every check of waitFor moves the clock on, so the idle time after the close passes.
    await vi.waitFor(() => expect(closed).toBe(true));
  });
});

// The time budget of a live update is the inspect-live-change-50k scenario of scripts/bench.mjs.
describe('the large snapshot', () => {
  it('reaches the event stream and GET /snapshot.json whole', async () => {
    const large = load('large');
    const { engine, state } = engineOf(large);
    const app = await start({ root: makeProject({}), engine });
    const events = openEvents(app.server.port);
    await events.opened;
    state.current = structuredClone(large);
    state.current.projects[0]!.buckets[0]!.purpose = 'Changed';
    await app.refresh();
    const data = await events.next();
    const res = await httpRequest(app.server.port, { path: '/snapshot.json' });
    expect(res.body.length).toBe(data.length);
    expect(JSON.parse(data).projects[0].buckets[0].purpose).toBe('Changed');
    events.close();
  });
});

describe('irrelevant', () => {
  it('skips git, dependencies, the cache and the ignore globs of the right project', () => {
    const small = load('small');
    small.projects[0]!.ignore.push({ glob: '!scripts/keep.ts', count: 1 });
    small.projects[1]!.ignore = [{ glob: 'dist/**', count: 1 }];
    expect(irrelevant(small, 'node_modules/x/index.js')).toBe(true);
    expect(irrelevant(small, '.buckets/cache/a.json')).toBe(true);
    expect(irrelevant(small, '.git/index')).toBe(true);
    expect(irrelevant(small, 'scripts/build.ts')).toBe(true);
    expect(irrelevant(small, 'scripts/keep.ts')).toBe(false);
    expect(irrelevant(small, 'src/app/main.ts')).toBe(false);
    expect(irrelevant(small, 'packages/sdk/dist/index.js')).toBe(true);
    expect(irrelevant(small, 'dist/index.js')).toBe(false);
    expect(irrelevant(small, 'packages/sdk/test/a.ts')).toBe(false);
  });
});
