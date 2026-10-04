import { request } from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { cleanupProjects, LOGGER_PROJECT, makeProject, writeFile } from '../testing/fixture.js';
import { approve, testContext } from '../testing/harness.js';
import { httpRequest, pagePost } from '../testing/http.js';
import { serializeLock } from '../core/lock.js';
import type { GitRunner } from '../inspect/timeline.js';
import { startInspectApp, watchDirs, type InspectApp } from './inspect-app.js';

const apps: InspectApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  cleanupProjects();
});

async function start(dir: string, options: Partial<Parameters<typeof startInspectApp>[0]> = {}): Promise<InspectApp> {
  const app = await startInspectApp({ ctx: testContext(), projectDir: dir, watch: false, ...options });
  apps.push(app);
  return app;
}

/** Opens the event stream and collects events until `until` returns true. */
function events(port: number, until: (events: { event: string; data: unknown }[]) => boolean, timeoutMs = 10_000): { done: Promise<{ event: string; data: unknown }[]>; ready: Promise<void> } {
  let ready!: () => void;
  const readyPromise = new Promise<void>((r) => (ready = r));
  const done = new Promise<{ event: string; data: unknown }[]>((resolve, reject) => {
    const got: { event: string; data: unknown }[] = [];
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`timed out with events: ${JSON.stringify(got)}`));
    }, timeoutMs);
    const req = request({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}`, accept: 'text/event-stream' }, agent: false }, (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let at: number;
        while ((at = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event === undefined) continue;
          got.push({ event, data: data === undefined ? null : JSON.parse(data) });
          if (event === 'hello') ready();
          if (until(got)) {
            clearTimeout(timer);
            req.destroy();
            resolve(got);
          }
        }
      });
    });
    req.on('error', () => undefined);
    req.end();
  });
  return { done, ready: readyPromise };
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs)) {
      if (name === '.buckets') continue;
      const child = path.join(abs, name);
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (statSync(child).isDirectory()) visit(child, childRel);
      else out[childRel] = readFileSync(child, 'utf8');
    }
  };
  visit(dir, '');
  return out;
}

describe('buckets inspect server', () => {
  it('serves the page, the snapshot, the assets and the event stream with the security headers', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    const app = await start(dir);
    expect(app.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await httpRequest(app.server.port, { path: '/?view=matrix' });
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toContain('DMZ matrix');
    const snapshot = await httpRequest(app.server.port, { path: '/api/snapshot' });
    expect(JSON.parse(snapshot.body)).toMatchObject({ snapshotVersion: 1, exitCode: 0, projects: [{ path: '.' }] });
    for (const asset of ['/assets/inspect.css', '/assets/inspect.js', '/assets/theme.css', '/assets/app.js']) expect((await httpRequest(app.server.port, { path: asset })).status).toBe(200);
    expect((await httpRequest(app.server.port, { path: '/nope' })).status).toBe(404);
    const stream = events(app.server.port, (got) => got.some((e) => e.event === 'hello'));
    expect((await stream.done)[0]).toEqual({ event: 'hello', data: { version: 1 } });
  });

  it('refuses another Host or Origin, and has no endpoint that changes anything', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const app = await start(dir);
    expect((await httpRequest(app.server.port, { headers: { host: `evil.example:${app.server.port}` } })).status).toBe(403);
    expect((await httpRequest(app.server.port, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await httpRequest(app.server.port, { method: 'POST', path: '/api/snapshot', headers: { origin: `http://127.0.0.1:${app.server.port}` } })).status).toBe(403);
    // Even with the right origin and token, every route is GET only.
    for (const route of ['/', '/api/snapshot', '/api/events']) expect((await pagePost(app.server, route)).status).toBe(405);
    expect((await pagePost(app.server, '/api/approve')).status).toBe(404);
  });

  it('never writes to the project, except the check cache in .buckets/', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    const before = tree(dir);
    const app = await start(dir);
    for (const view of ['map', 'matrix', 'trace', 'projects', 'approvals', 'timeline', 'impact']) await httpRequest(app.server.port, { path: `/?view=${view}` });
    for (const path of ['/?view=impact&sim=bucket&bucket=root%2Flog', '/?view=impact&sim=path&pick=root%2Flog%2F_%2Flogger.ts%3A%3Alogger&to=root%2Fbilling%2Fpayments', '/export/map.svg', '/export/buckets.mmd', '/api/timeline']) {
      expect((await httpRequest(app.server.port, { path })).status).toBe(200);
    }
    await app.refresh([]);
    expect(tree(dir)).toEqual(before);
  });

  it('reruns the check after a file change and pushes an update with the feed events', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    const app = await start(dir, { watch: 'polling', debounceMs: 80, pollMs: 40 });
    expect(app.watchMode()).toBe('polling');
    const stream = events(app.server.port, (got) => got.some((e) => e.event === 'update'));
    await stream.ready;
    writeFile(dir, 'root/billing/payments/_/pay.ts', "import x from './x';\nexport const pay = x;\n");
    const got = await stream.done;
    const update = got.find((e) => e.event === 'update')!.data as { version: number; exitCode: number; events: { kind: string; project: string; text: string }[] };
    expect(update.version).toBe(2);
    expect(update.exitCode).toBe(1);
    expect(update.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'file', project: '.', text: 'root/billing/payments/_/pay.ts changed in bucket root/billing/payments' }),
        expect.objectContaining({ kind: 'violation-added', text: 'Violation appeared: import-relative in root/billing/payments/_/pay.ts:1' }),
      ]),
    );
    expect(app.snapshot().summary.violations).toBe(1);
    const page = await httpRequest(app.server.port);
    expect(page.body).toContain('Violation appeared: import-relative');
    expect(page.body).toContain('data-version="2"');
    // The update carries a compact diff and the pages it makes stale, not the snapshot.
    const diff = (update as unknown as { diff: { same: boolean; projects: Record<string, { violations: string[] }> }; stale: string[] }).diff;
    expect(diff.same).toBe(false);
    expect(diff.projects['.']!.violations).toHaveLength(1);
    expect((update as unknown as { stale: string[] }).stale).toEqual(expect.arrayContaining(['map|.', 'matrix|.']));
  });

  it('serves the feed alone for a page whose content did not change, and renders each page once per snapshot', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    const app = await start(dir);
    const first = await httpRequest(app.server.port, { path: '/?view=matrix' });
    const again = await httpRequest(app.server.port, { path: '/?view=matrix' });
    expect(again.body).toBe(first.body);
    const stream = events(app.server.port, (got) => got.some((e) => e.event === 'update'));
    await stream.ready;
    await app.refresh([path.join(dir, 'root/log/_/logger.ts')]);
    const update = (await stream.done).find((e) => e.event === 'update')!.data as { diff: { same: boolean }; stale: string[] };
    // Nothing the pages show changed: no page is stale, they fetch the feed with the new file event.
    expect(update.diff.same).toBe(true);
    expect(update.stale).toEqual([]);
    const part = await httpRequest(app.server.port, { path: '/?view=matrix&part=feed' });
    expect(part.headers['content-type']).toContain('application/json');
    const body = JSON.parse(part.body) as { version: number; feed: string; nav: string; status: string };
    expect(body.version).toBe(2);
    expect(body.feed).toContain('id="feed"');
    expect(body.feed).toContain('root/log/_/logger.ts changed in bucket root/log');
    expect(body.nav).toContain('aria-current="page"');
    expect(body.status).toBe('live');
  });

  it('joins changes that arrive during a run into one more run', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const app = await start(dir);
    await Promise.all([app.refresh([path.join(dir, 'a')]), app.refresh([path.join(dir, 'b')]), app.refresh([path.join(dir, 'c')])]);
    expect(app.version()).toBe(3);
  });

  it('watches every project folder and the origins of links outside them', () => {
    const snapshot = {
      projects: [
        { dir: '/r', links: [{ origin: 'root/_/x' }, { origin: '../vendor/api' }] },
        { dir: path.join('/r', 'root/_/x'), links: [] },
      ],
    } as unknown as Parameters<typeof watchDirs>[0];
    expect(watchDirs(snapshot)).toEqual(['/r', path.join('/r', 'root/_/x'), path.resolve('/r', '../vendor/api')]);
  });

  it('stays up while a page is connected', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const app = await start(dir, { idleTimeoutMs: 300 });
    let closed = false;
    void app.server.closed.then(() => (closed = true));
    const stream = events(app.server.port, () => false, 2000);
    await stream.ready;
    await new Promise((r) => setTimeout(r, 900));
    expect(closed).toBe(false);
    await expect(stream.done).rejects.toThrow('timed out');
    await new Promise((r) => setTimeout(r, 900));
    expect(closed).toBe(true);
  });

  it('stops after the idle time without a page', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const app = await start(dir, { idleTimeoutMs: 300 });
    let closed = false;
    void app.server.closed.then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 700));
    expect(closed).toBe(true);
  });
});

/** A git with one commit per lock (newest first), so the timeline needs no real repository. */
function fakeGit(dir: string, locks: string[]): GitRunner {
  const id = (n: number) => `c${n}`.padEnd(40, '0');
  return async (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return `${dir}\nfalse\n`;
    if (args[0] === 'rev-parse') return 'c1\n';
    if (args[0] === 'log') {
      return locks.map((_, i) => {
        const n = locks.length - i;
        return `\x1e${id(n)}\x1f2026-09-0${n}T10:00:00+00:00\x1fAna Lima\x1fApproval ${n}\n\nbuckets.lock.json\n`;
      }).join('');
    }
    if (args[0] === 'show') return locks[locks.length - Number(args[1]!.slice(1, 2))]!;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

describe('phase 2 routes', () => {
  it('serves the exports as attachments named after the project', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    const app = await start(dir);
    const svg = await httpRequest(app.server.port, { path: '/export/map.svg' });
    expect(svg.status).toBe(200);
    expect(svg.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
    expect(svg.headers['content-disposition']).toBe('attachment; filename="fixture-map.svg"');
    expect(svg.headers['content-security-policy']).toContain("default-src 'none'");
    expect(svg.body).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    const mmd = await httpRequest(app.server.port, { path: '/export/buckets.mmd' });
    expect(mmd.headers['content-type']).toBe('text/vnd.mermaid; charset=utf-8');
    expect(mmd.headers['content-disposition']).toBe('attachment; filename="fixture-buckets.mmd"');
    expect(mmd.body.startsWith('flowchart TB\n')).toBe(true);
    expect((await pagePost(app.server, '/export/map.svg')).status).toBe(405);
    const page = await httpRequest(app.server.port, { path: '/' });
    expect(page.body).toContain('href="/export/map.svg" download');
    expect(page.body).toContain('href="/export/buckets.mmd" download');
  });

  it('renders the timeline from git, with the approval in the URL, and serves it as JSON', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const second = await approve(dir);
    const first = { ...second, buckets: second.buckets.filter((b) => !b.startsWith('root/billing/')), dmz: {} };
    const app = await start(dir, { git: fakeGit(dir, [serializeLock(second), serializeLock(first)]) });
    const page = await httpRequest(app.server.port, { path: `/?view=timeline&at=${'c1'.padEnd(40, '0')}` });
    expect(page.status).toBe(200);
    expect(page.body).toContain('aria-current="page"><span class="n" aria-hidden="true">5:</span>timeline</a>');
    expect(page.body).toContain('Approval <strong>1</strong> of 2');
    expect(page.body).toContain('<svg class="map-svg"');
    expect(page.body).toContain('id="tl-data"');
    expect(page.body).not.toMatch(/ style="/);
    const latest = await httpRequest(app.server.port, { path: '/?view=timeline' });
    expect(latest.body).toContain('Approval <strong>2</strong> of 2');
    expect(latest.body).toContain('root/billing/invoices');
    const json = JSON.parse((await httpRequest(app.server.port, { path: '/api/timeline' })).body);
    expect(json.tracks[0]).toMatchObject({ project: '.', status: 'ok', points: [{ subject: 'Approval 1', counts: { contracts: 0 } }, { subject: 'Approval 2', author: 'Ana Lima' }] });
    expect(json.tracks[0].points[1].changes.map((c: { kind: string }) => c.kind)).toContain('bucket-added');
    expect(json.tracks[0].points[0]).not.toHaveProperty('lock');
  });

  it('runs the simulations from the URL', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    const app = await start(dir);
    const bucket = await httpRequest(app.server.port, { path: '/?view=impact&sim=bucket&bucket=root%2Flog' });
    expect(bucket.body).toContain('Without <span translate="no">log</span>');
    expect(bucket.body).toContain('root/billing/invoices/_/create-invoice.ts:1');
    const route = await httpRequest(app.server.port, { path: '/?view=impact&sim=path&pick=root%2Flog%2F_%2Flogger.ts%3A%3Alogger&to=root%2Fbilling%2Fpayments' });
    expect(route.body).toContain('export { logger } from &#39;@root/dmz/log/billing&#39;;');
    expect(route.body).toContain('data-copy-id="step-import"');
    expect(route.body).toContain('<option value="root/log/_/logger.ts::logger" selected>logger</option>');
  });
});
