// `buckets refresh --web` with nested projects: one page, one section and one Approve per project.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, LOGGER_PROJECT, makeProject, readFile, writeFile } from '../testing/fixture.js';
import { approve, fakeIo, testContext } from '../testing/harness.js';
import { httpRequest, pagePost } from '../testing/http.js';
import type { ConfirmDialog, DialogAnswer, DialogRequest } from '../web/dialog.js';
import { confirmationCode, evaluateTree } from '../web/lock-review.js';
import { finalOutcome } from '../web/refresh-app.js';
import { renderMultiReviewPage } from '../web/refresh-page.js';
import type { WebServer } from '../web/server.js';
import { refreshCommand } from './refresh.js';

afterEach(cleanupProjects);

const NESTED = 'root/billing/_/engine';

function fakeDialog() {
  const calls: DialogRequest[] = [];
  const pending: ((answer: DialogAnswer) => void)[] = [];
  const dialog: ConfirmDialog = {
    name: 'fake',
    confirm: (request, signal) =>
      new Promise((resolve) => {
        calls.push(request);
        pending.push(resolve);
        signal?.addEventListener('abort', () => resolve(null), { once: true });
      }),
  };
  return { dialog, calls, answer: (a: DialogAnswer) => pending.shift()!(a) };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Both projects have one change each: a new bucket. */
async function changedTree(): Promise<string> {
  const dir = makeProject({
    ...LOGGER_PROJECT,
    [`${NESTED}/buckets.config.json`]: '{ "root": "root", "alias": "@engine" }\n',
    [`${NESTED}/package.json`]: '{ "name": "engine" }\n',
    [`${NESTED}/root/_/run.ts`]: 'export const run = 1;\n',
  });
  await approve(dir);
  await approve(path.join(dir, NESTED));
  writeFile(dir, 'root/mail/_/m.ts', 'export const m = 1;\n');
  writeFile(dir, `${NESTED}/root/jobs/_/j.ts`, 'export const j = 1;\n');
  return dir;
}

async function startWeb(dir: string, dialog: ConfirmDialog) {
  const io = fakeIo({ cwd: dir });
  let listening!: (server: WebServer) => void;
  const ready = new Promise<WebServer>((resolve) => {
    listening = resolve;
  });
  const code = refreshCommand(testContext(), io, ['--web'], { detectDialog: () => ({ ok: true, dialog }), onListening: listening });
  const server = await Promise.race([
    ready,
    code.then((c) => {
      throw new Error(`exited with ${c}: ${io.err}`);
    }),
  ]);
  return { io, server, code };
}

function buttons(page: string): { project: string; hash: string }[] {
  return [...page.matchAll(/data-project="([^"]+)" data-hash="([^"]+)"/g)].map((m) => ({ project: m[1]!, hash: m[2]! }));
}

describe('refresh --web with nested projects', () => {
  it('prints a section per project and serves one Approve per project', async () => {
    const dir = await changedTree();
    const fake = fakeDialog();
    const { io, server, code } = await startWeb(dir, fake.dialog);
    expect(io.out).toContain('== Project .');
    expect(io.out).toContain(`== Project ${NESTED}`);
    expect(io.out).toContain(`since the last approved ${NESTED}/buckets.lock.json`);
    expect(io.out).toContain('one section per project (2 projects)');
    const page = await httpRequest(server.port);
    expect(page.body).toContain('Approve contract changes in 2 projects');
    expect(buttons(page.body).map((b) => b.project)).toEqual(['.', NESTED]);
    expect(page.body).not.toMatch(/id="approve"/);
    await pagePost(server, '/api/cancel');
    expect(await code).toBe(1);
  });

  it('approves each project on its own dialog and writes only that lock, then exits 0', async () => {
    const dir = await changedTree();
    const topBefore = readFile(dir, 'buckets.lock.json');
    const nestedBefore = readFile(dir, `${NESTED}/buckets.lock.json`);
    const fake = fakeDialog();
    const { server, code } = await startWeb(dir, fake.dialog);
    const [top, nested] = buttons((await httpRequest(server.port)).body);

    const first = pagePost(server, '/api/approve', { hash: nested!.hash, project: nested!.project });
    await until(() => fake.calls.length === 1, 'the first dialog');
    expect(fake.calls[0]!.message).toContain(`Nested project: ${NESTED}`);
    expect(fake.calls[0]!.message).toContain('Approve 1 contract change in the project "engine"?');
    expect(fake.calls[0]!.message).toContain('+ bucket root/jobs');
    // The code of the top project does not approve the nested one.
    fake.answer(confirmationCode(top!.hash));
    expect(JSON.parse((await first).body)).toMatchObject({ status: 'wrong-code', project: NESTED });
    expect(readFile(dir, `${NESTED}/buckets.lock.json`)).toBe(nestedBefore);
    const retry = pagePost(server, '/api/approve', { hash: nested!.hash, project: nested!.project });
    await until(() => fake.calls.length === 2, 'the second dialog for the nested project');
    fake.answer(confirmationCode(nested!.hash));
    expect(JSON.parse((await retry).body)).toMatchObject({ status: 'project-approved', project: NESTED });
    expect(readFile(dir, `${NESTED}/buckets.lock.json`)).not.toBe(nestedBefore);
    expect(readFile(dir, 'buckets.lock.json')).toBe(topBefore);

    // The approved project cannot be approved again, and the page shows it as approved.
    expect(JSON.parse((await pagePost(server, '/api/approve', { hash: nested!.hash, project: NESTED })).body)).toMatchObject({ status: 'stale' });
    expect((await httpRequest(server.port)).body).toContain('Approved. Its buckets.lock.json is written.');

    const second = pagePost(server, '/api/approve', { hash: top!.hash, project: '.' });
    await until(() => fake.calls.length === 3, 'the dialog of the top project');
    fake.answer(confirmationCode(top!.hash));
    expect(JSON.parse((await second).body)).toMatchObject({ status: 'approved' });
    expect(await code).toBe(0);
    expect(readFile(dir, 'buckets.lock.json')).not.toBe(topBefore);
  });

  it('ends as partial with exit 1 when one project is approved and the other is rejected', async () => {
    const dir = await changedTree();
    const fake = fakeDialog();
    const { io, server, code } = await startWeb(dir, fake.dialog);
    const [top, nested] = buttons((await httpRequest(server.port)).body);
    const a = pagePost(server, '/api/approve', { hash: top!.hash, project: '.' });
    await until(() => fake.calls.length === 1, 'dialog');
    fake.answer(null);
    expect(JSON.parse((await a).body)).toMatchObject({ status: 'project-rejected' });
    const b = pagePost(server, '/api/approve', { hash: nested!.hash, project: NESTED });
    await until(() => fake.calls.length === 2, 'dialog');
    fake.answer(confirmationCode(nested!.hash));
    expect(JSON.parse((await b).body)).toMatchObject({ status: 'partial' });
    expect(await code).toBe(1);
    expect(io.err).toContain('Only some projects were approved');
  });

  it('refuses an approval without a project, a stale hash, and keeps one dialog at a time', async () => {
    const dir = await changedTree();
    const fake = fakeDialog();
    const { server, code } = await startWeb(dir, fake.dialog);
    const [top, nested] = buttons((await httpRequest(server.port)).body);
    expect(JSON.parse((await pagePost(server, '/api/approve', { hash: top!.hash })).body)).toMatchObject({ status: 'stale' });
    expect(JSON.parse((await pagePost(server, '/api/approve', { hash: top!.hash, project: NESTED })).body)).toMatchObject({ status: 'stale' });
    const open = pagePost(server, '/api/approve', { hash: top!.hash, project: '.' });
    await until(() => fake.calls.length === 1, 'dialog');
    expect(JSON.parse((await pagePost(server, '/api/approve', { hash: nested!.hash, project: NESTED })).body)).toMatchObject({ status: 'busy' });
    // The nested project changes while the first dialog is open; its old hash is refused later.
    writeFile(dir, `${NESTED}/root/more/_/x.ts`, 'export const x = 1;\n');
    fake.answer(confirmationCode(top!.hash));
    expect(JSON.parse((await open).body)).toMatchObject({ status: 'project-approved' });
    expect(JSON.parse((await pagePost(server, '/api/approve', { hash: nested!.hash, project: NESTED })).body)).toMatchObject({ status: 'stale' });
    expect(fake.calls).toHaveLength(1);
    expect(JSON.parse((await pagePost(server, '/api/cancel')).body)).toMatchObject({ status: 'cancelled' });
    expect(await code).toBe(1);
  });

  it('refuses to start while a nested project breaks a rule', async () => {
    const dir = await changedTree();
    writeFile(dir, `${NESTED}/root/_/run.ts`, "import x from './x';\n");
    const io = fakeIo({ cwd: dir });
    const code = await refreshCommand(testContext(), io, ['--web'], { detectDialog: () => ({ ok: true, dialog: fakeDialog().dialog }) });
    expect(code).toBe(1);
    expect(io.err).toContain(`== Project ${NESTED}`);
    expect(io.err).toContain('in every project');
  });
});

describe('multi-project page', () => {
  it('renders a section per project with unique ids and a labelled Approve button', async () => {
    const dir = await changedTree();
    const tree = await evaluateTree(testContext(), dir);
    const page = renderMultiReviewPage({ token: 't', projectName: 'fixture' }, tree.map((p) => ({ path: p.path, dir: p.dir, state: p.state })));
    const ids = [...page.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(page).toContain(`Approve <span translate="no">${NESTED}</span>`);
    expect(page).toContain('Approve <span translate="no">the main project</span>');
    expect(page).toMatch(/<h2 id="p1-title">/);
    expect(page).toMatch(/<h3 id="p1-buckets-title">Buckets<\/h3>/);
    expect(page).toContain('aria-live="polite"');
  });

  it('computes the final outcome from the decisions', () => {
    expect(finalOutcome(['approved', 'current'])).toBe('approved');
    expect(finalOutcome(['current'])).toBe('current');
    expect(finalOutcome(['approved', 'rejected'])).toBe('partial');
    expect(finalOutcome(['rejected', 'current'])).toBe('rejected');
  });
});
