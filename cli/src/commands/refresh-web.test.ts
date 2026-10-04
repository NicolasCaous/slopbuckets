import { request } from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLock } from '../core/lock.js';
import { cleanupProjects, fileExists, LOGGER_PROJECT, makeProject, readFile, writeFile } from '../testing/fixture.js';
import { approve, fakeIo, testContext } from '../testing/harness.js';
import { httpRequest, pagePost } from '../testing/http.js';
import type { ConfirmDialog, DialogAnswer, DialogRequest } from '../web/dialog.js';
import { confirmationCode } from '../web/lock-review.js';
import type { WebServer } from '../web/server.js';
import { refreshCommand } from './refresh.js';

afterEach(cleanupProjects);

function fakeDialog() {
  const calls: DialogRequest[] = [];
  const pending: ((answer: DialogAnswer) => void)[] = [];
  let beforeAnswer: (() => void) | undefined;
  const dialog: ConfirmDialog = {
    name: 'fake',
    confirm: (request, signal) =>
      new Promise((resolve) => {
        calls.push(request);
        pending.push(resolve);
        signal?.addEventListener('abort', () => resolve(null), { once: true });
      }),
  };
  return {
    dialog,
    calls,
    /** Answers the oldest open dialog with the typed text, or null for Cancel. */
    answer(answer: DialogAnswer) {
      beforeAnswer?.();
      pending.shift()!(answer);
    },
    onAnswer(fn: () => void) {
      beforeAnswer = fn;
    },
  };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function startWeb(dir: string, dialog: ConfirmDialog, options: { idleTimeoutMs?: number; maxLifetimeMs?: number; requestTimeoutMs?: number } = {}) {
  const io = fakeIo({ cwd: dir, interactive: false });
  let listening!: (server: WebServer) => void;
  const ready = new Promise<WebServer>((resolve) => {
    listening = resolve;
  });
  const code = refreshCommand(testContext(), io, ['--web'], { detectDialog: () => ({ ok: true, dialog }), onListening: listening, ...options });
  const server = await Promise.race([
    ready,
    code.then((c) => {
      throw new Error(`refresh --web exited with ${c} before listening: ${io.err}`);
    }),
  ]);
  return { io, server, code };
}

async function pageHash(server: WebServer): Promise<string> {
  const page = await httpRequest(server.port);
  expect(page.status).toBe(200);
  const hash = /data-hash="([^"]+)"/.exec(page.body)?.[1];
  if (hash === undefined) throw new Error(`no hash in page:\n${page.body}`);
  return hash;
}

/** The hash and the confirmation code the page shows. */
async function pageReview(server: WebServer): Promise<{ hash: string; code: string; body: string }> {
  const page = await httpRequest(server.port);
  const hash = /data-hash="([^"]+)"/.exec(page.body)?.[1];
  const code = /data-code="([^"]+)"/.exec(page.body)?.[1];
  if (hash === undefined || code === undefined) throw new Error(`no hash or code in page:\n${page.body}`);
  expect(code).toBe(confirmationCode(hash));
  return { hash, code, body: page.body };
}

/** A project with an approved lock and one contract change: the signature of logger. */
async function changedProject(): Promise<string> {
  const dir = makeProject(LOGGER_PROJECT);
  await approve(dir);
  writeFile(dir, 'root/log/_/logger.ts', 'export function logger(message: string, level: number): void {}\n');
  return dir;
}

describe('buckets refresh --web, before the server starts', () => {
  it('refuses on a machine without a GUI and says to use the terminal', async () => {
    const dir = await changedProject();
    const io = fakeIo({ cwd: dir });
    const reason = 'This is an SSH session, so a confirmation window would not reach the human at this machine. Ask the human to run `buckets refresh` in a terminal instead.';
    const code = await refreshCommand(testContext(), io, ['--web'], { detectDialog: () => ({ ok: false, reason }) });
    expect(code).toBe(1);
    expect(io.err).toContain('cannot ask for approval on this machine');
    expect(io.err).toContain('SSH session');
    expect(io.out).toBe('');
  });

  it('refuses while a rule is broken, without a server or a dialog', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/_/main.ts': "import x from './x';\n" });
    const fake = fakeDialog();
    const io = fakeIo({ cwd: dir });
    let listened = false;
    const code = await refreshCommand(testContext(), io, ['--web'], { detectDialog: () => ({ ok: true, dialog: fake.dialog }), onListening: () => (listened = true) });
    expect(code).toBe(1);
    expect(io.err).toContain('import-relative');
    expect(io.err).toContain('Nothing to approve yet');
    expect(listened).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it('says so and exits 0 when there is nothing to approve', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    const io = fakeIo({ cwd: dir });
    const code = await refreshCommand(testContext(), io, ['--web'], { detectDialog: () => ({ ok: true, dialog: fakeDialog().dialog }) });
    expect(code).toBe(0);
    expect(io.out).toContain('already matches the project. Nothing to approve.');
  });

  it('rejects other options', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    for (const args of [['--webx'], ['--web', '--yes'], ['--WEB']]) {
      const io = fakeIo({ cwd: dir });
      expect(await refreshCommand(testContext(), io, args)).toBe(1);
      expect(io.err).toContain('unknown option');
    }
  });
});

describe('buckets refresh --web, the approve flow', () => {
  it('prints the diff and the URL alone on the last line, without needing a TTY', async () => {
    const dir = await changedProject();
    const fake = fakeDialog();
    const { io, server, code } = await startWeb(dir, fake.dialog);
    const lines = io.out.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toBe(server.url);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(io.out).toContain('2 changes since the last approved buckets.lock.json (2 changed)');
    expect(io.out).toContain('~ signature changed');
    await pagePost(server, '/api/cancel');
    expect(await code).toBe(1);
  });

  it('writes the lock only after the dialog confirms, then shuts down with 0', async () => {
    const dir = await changedProject();
    const before = readFile(dir, 'buckets.lock.json');
    const fake = fakeDialog();
    const { io, server, code } = await startWeb(dir, fake.dialog);
    const { hash, code: typed } = await pageReview(server);

    const reply = pagePost(server, '/api/approve', { hash });
    await until(() => fake.calls.length === 1, 'the dialog');
    expect(readFile(dir, 'buckets.lock.json')).toBe(before);
    const folder = path.basename(dir);
    expect(fake.calls[0]!.message).toContain(`Approve 2 contract changes in the project "${folder}" (package.json name "fixture")?`);
    expect(fake.calls[0]!.message).toContain(`Folder: ${dir}`);
    // The dialog asks for the code but never shows it.
    expect(fake.calls[0]!.message).toContain('type the 6-character confirmation code shown on the review page');
    expect(fake.calls[0]!.message).not.toContain(typed);
    // Lower case and spaces are accepted.
    fake.answer(` ${typed.slice(0, 3).toLowerCase()} ${typed.slice(3)} `);

    const res = await reply;
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'approved' });
    expect(await code).toBe(0);
    expect(io.out).toContain('Wrote buckets.lock.json');
    expect(readFile(dir, 'buckets.lock.json')).not.toBe(before);
    const lock = readLock(dir);
    expect(lock.kind).toBe('ok');
    await expect(httpRequest(server.port)).rejects.toThrow();
  });

  it('writes nothing when the human cancels in the dialog, and exits 1', async () => {
    const dir = await changedProject();
    const before = readFile(dir, 'buckets.lock.json');
    const fake = fakeDialog();
    const { io, server, code } = await startWeb(dir, fake.dialog);
    const reply = pagePost(server, '/api/approve', { hash: await pageHash(server) });
    await until(() => fake.calls.length === 1, 'the dialog');
    fake.answer(null);
    expect(JSON.parse((await reply).body)).toMatchObject({ status: 'rejected' });
    expect(await code).toBe(1);
    expect(io.err).toContain('Not approved');
    expect(readFile(dir, 'buckets.lock.json')).toBe(before);
  });

  it('writes nothing when the human clicks Cancel on the page, and exits 1', async () => {
    const dir = await changedProject();
    const before = readFile(dir, 'buckets.lock.json');
    const fake = fakeDialog();
    const { io, server, code } = await startWeb(dir, fake.dialog);
    const res = await pagePost(server, '/api/cancel');
    expect(JSON.parse(res.body)).toMatchObject({ status: 'cancelled' });
    expect(await code).toBe(1);
    expect(io.err).toContain('Cancelled in the browser');
    expect(fake.calls).toEqual([]);
    expect(readFile(dir, 'buckets.lock.json')).toBe(before);
  });

  it('closes an open dialog when the page cancels', async () => {
    const dir = await changedProject();
    const before = readFile(dir, 'buckets.lock.json');
    const fake = fakeDialog();
    const { server, code } = await startWeb(dir, fake.dialog);
    const reply = pagePost(server, '/api/approve', { hash: await pageHash(server) });
    await until(() => fake.calls.length === 1, 'the dialog');
    expect(JSON.parse((await pagePost(server, '/api/cancel')).body)).toMatchObject({ status: 'cancelled' });
    expect(JSON.parse((await reply).body)).toMatchObject({ status: 'closed' });
    expect(await code).toBe(1);
    expect(readFile(dir, 'buckets.lock.json')).toBe(before);
  });

  it('refuses when the project changed between render and approve, without opening the dialog', async () => {
    const dir = await changedProject();
    const before = readFile(dir, 'buckets.lock.json');
    const fake = fakeDialog();
    const { server, code } = await startWeb(dir, fake.dialog);
    const hash = await pageHash(server);
    writeFile(dir, 'root/mail/_/m.ts', 'export const m = 1;\n');

    const res = await pagePost(server, '/api/approve', { hash });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'stale' });
    expect(fake.calls).toEqual([]);
    expect(readFile(dir, 'buckets.lock.json')).toBe(before);

    // A reload shows the new diff, and approving that one works.
    const fresh = await httpRequest(server.port);
    expect(fresh.body).toContain('root/mail');
    const newHash = /data-hash="([^"]+)"/.exec(fresh.body)![1]!;
    expect(newHash).not.toBe(hash);
    const reply = pagePost(server, '/api/approve', { hash: newHash });
    await until(() => fake.calls.length === 1, 'the dialog');
    fake.answer(confirmationCode(newHash));
    expect(JSON.parse((await reply).body)).toMatchObject({ status: 'approved' });
    expect(await code).toBe(0);
    const lock = readLock(dir);
    expect(lock.kind === 'ok' && lock.lock.buckets).toContain('root/mail');
  });

  it('refuses when the project changes while the dialog is open', async () => {
    const dir = await changedProject();
    const before = readFile(dir, 'buckets.lock.json');
    const fake = fakeDialog();
    const { server, code } = await startWeb(dir, fake.dialog);
    const shown = await pageReview(server);
    const reply = pagePost(server, '/api/approve', { hash: shown.hash });
    await until(() => fake.calls.length === 1, 'the dialog');
    fake.onAnswer(() => writeFile(dir, 'root/log/_/logger.ts', 'export function logger(message: number): void {}\n'));
    fake.answer(shown.code);
    const res = await reply;
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'stale' });
    expect(readFile(dir, 'buckets.lock.json')).toBe(before);
    await pagePost(server, '/api/cancel');
    expect(await code).toBe(1);
  });

  it('still finishes when the tab closes while the dialog is open', async () => {
    const dir = await changedProject();
    const before = readFile(dir, 'buckets.lock.json');
    const fake = fakeDialog();
    const { server, code } = await startWeb(dir, fake.dialog);
    const hash = await pageHash(server);
    const req = request({
      host: '127.0.0.1',
      port: server.port,
      method: 'POST',
      path: '/api/approve',
      agent: false,
      headers: { host: `127.0.0.1:${server.port}`, origin: `http://127.0.0.1:${server.port}`, 'content-type': 'application/json', 'x-buckets-token': server.token },
    });
    req.on('error', () => {});
    req.end(JSON.stringify({ hash }));
    await until(() => fake.calls.length === 1, 'the dialog');
    req.destroy();
    await new Promise((r) => setTimeout(r, 30));
    fake.answer(confirmationCode(hash));
    expect(await code).toBe(0);
    expect(readFile(dir, 'buckets.lock.json')).not.toBe(before);
  });

  it('refuses a hash the page never showed', async () => {
    const dir = await changedProject();
    const fake = fakeDialog();
    const { server, code } = await startWeb(dir, fake.dialog);
    for (const body of [{ hash: 'f'.repeat(64) }, {}, { hash: 7 }]) {
      const res = await pagePost(server, '/api/approve', body);
      expect(JSON.parse(res.body)).toMatchObject({ status: 'stale' });
    }
    expect(fake.calls).toEqual([]);
    await pagePost(server, '/api/cancel');
    expect(await code).toBe(1);
  });

  it('opens one dialog for concurrent clicks and ignores the others', async () => {
    const dir = await changedProject();
    const fake = fakeDialog();
    const { server, code } = await startWeb(dir, fake.dialog);
    const hash = await pageHash(server);
    const replies = [pagePost(server, '/api/approve', { hash }), pagePost(server, '/api/approve', { hash }), pagePost(server, '/api/approve', { hash })];
    await until(() => fake.calls.length === 1, 'the dialog');
    // The two extra clicks come back as busy while the first dialog is still open.
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.calls).toHaveLength(1);
    fake.answer(confirmationCode(hash));
    const bodies = (await Promise.all(replies)).map((r) => JSON.parse(r.body).status as string).sort();
    expect(bodies).toEqual(['approved', 'busy', 'busy']);
    expect(fake.calls).toHaveLength(1);
    expect(await code).toBe(0);
  });

  it('ignores approve and cancel without the token or from another origin', async () => {
    const dir = await changedProject();
    const fake = fakeDialog();
    const { server, code } = await startWeb(dir, fake.dialog);
    const hash = await pageHash(server);
    expect((await pagePost(server, '/api/approve', { hash }, { 'x-buckets-token': 'guess' })).status).toBe(403);
    expect((await pagePost(server, '/api/cancel', {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect(fake.calls).toEqual([]);
    await pagePost(server, '/api/cancel');
    expect(await code).toBe(1);
  });

  it('times out after the idle period with exit 1 and writes nothing', async () => {
    const dir = await changedProject();
    const before = readFile(dir, 'buckets.lock.json');
    const { io, code } = await startWeb(dir, fakeDialog().dialog, { idleTimeoutMs: 100 });
    expect(await code).toBe(1);
    expect(io.err).toContain('No decision in time (30 minutes without activity on the page, or 2 hours in all)');
    expect(readFile(dir, 'buckets.lock.json')).toBe(before);
  });

  it('times out after the maximum lifetime even while the page keeps polling', async () => {
    const dir = await changedProject();
    const before = readFile(dir, 'buckets.lock.json');
    const { io, server, code } = await startWeb(dir, fakeDialog().dialog, { maxLifetimeMs: 300 });
    const { hash } = await pageReview(server);
    let finished = false;
    void code.then(() => (finished = true));
    while (!finished) {
      await pagePost(server, '/api/state', { projects: { '.': hash } }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(await code).toBe(1);
    expect(io.err).toContain('No decision in time');
    expect(readFile(dir, 'buckets.lock.json')).toBe(before);
  });

  it('resets the idle timer only for requests that carry the token', async () => {
    const dir = await changedProject();
    const { server, code } = await startWeb(dir, fakeDialog().dialog, { idleTimeoutMs: 400 });
    const { hash } = await pageReview(server);
    const start = Date.now();
    // Plain GET requests, which anyone with the link can send, do not keep the server alive.
    let gone = false;
    void code.then(() => (gone = true));
    while (!gone && Date.now() - start < 3000) {
      await httpRequest(server.port).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(gone).toBe(true);
    expect(await code).toBe(1);

    // The page's own polls do.
    const second = await startWeb(await changedProject(), fakeDialog().dialog, { idleTimeoutMs: 300 });
    const shown = await pageReview(second.server);
    for (let i = 0; i < 10; i++) {
      expect((await pagePost(second.server, '/api/state', { projects: { '.': shown.hash } })).status).toBe(200);
      await new Promise((r) => setTimeout(r, 100));
    }
    await pagePost(second.server, '/api/cancel');
    expect(await second.code).toBe(1);
    void hash;
  });

  it('creates the first lock when there is none', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const fake = fakeDialog();
    const { io, server, code } = await startWeb(dir, fake.dialog);
    expect(io.out).toContain('No buckets.lock.json yet');
    const page = await pageReview(server);
    expect(page.body).toContain('Approve the first lock');
    const reply = pagePost(server, '/api/approve', { hash: page.hash });
    await until(() => fake.calls.length === 1, 'the dialog');
    expect(fake.calls[0]!.message).toContain(`Approve the first lock of the project "${path.basename(dir)}" (package.json name "fixture"), with 5 buckets and 2 DMZ files?`);
    fake.answer(page.code);
    expect(JSON.parse((await reply).body)).toMatchObject({ status: 'approved' });
    expect(await code).toBe(0);
    expect(fileExists(dir, 'buckets.lock.json')).toBe(true);
  });

  it('ends with 0 when the page poll finds the lock already approved elsewhere, and a GET changes nothing', async () => {
    const dir = await changedProject();
    const { server, code } = await startWeb(dir, fakeDialog().dialog);
    const { hash } = await pageReview(server);
    await approve(dir);
    let ended = false;
    void code.then(() => (ended = true));
    const page = await httpRequest(server.port);
    expect(page.body).toContain('Nothing to approve');
    // GET only reads: the session is still open until the page's token-authenticated poll.
    await new Promise((r) => setTimeout(r, 50));
    expect(ended).toBe(false);
    const poll = await pagePost(server, '/api/state', { projects: { '.': hash } });
    expect(JSON.parse(poll.body)).toMatchObject({ status: 'current' });
    expect(await code).toBe(0);
  });
});

describe('buckets refresh --web, the confirmation code', () => {
  it('refuses a wrong code without a decision, and the right code still approves', async () => {
    const dir = await changedProject();
    const before = readFile(dir, 'buckets.lock.json');
    const fake = fakeDialog();
    const { server, code } = await startWeb(dir, fake.dialog);
    const shown = await pageReview(server);
    for (const typed of ['', 'AAAAAA', `${shown.code}X`]) {
      const reply = pagePost(server, '/api/approve', { hash: shown.hash });
      await until(() => fake.calls.length === 1, 'the dialog');
      fake.calls.length = 0;
      fake.answer(typed);
      const res = await reply;
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({ status: 'wrong-code' });
      expect(readFile(dir, 'buckets.lock.json')).toBe(before);
    }
    const reply = pagePost(server, '/api/approve', { hash: shown.hash });
    await until(() => fake.calls.length === 1, 'the dialog');
    fake.answer(shown.code);
    expect(JSON.parse((await reply).body)).toMatchObject({ status: 'approved' });
    expect(await code).toBe(0);
  });

  it('refuses when the agent changes the project and approves the new hash, because the human types the old code', async () => {
    const dir = await changedProject();
    const before = readFile(dir, 'buckets.lock.json');
    const fake = fakeDialog();
    const { server, code } = await startWeb(dir, fake.dialog);
    // The human loads the page and sees this code.
    const human = await pageReview(server);
    // The agent changes the project, fetches the page again and approves the new state with its hash.
    writeFile(dir, 'root/mail/_/m.ts', 'export const m = 1;\n');
    const agent = await pageReview(server);
    expect(agent.code).not.toBe(human.code);
    const reply = pagePost(server, '/api/approve', { hash: agent.hash });
    await until(() => fake.calls.length === 1, 'the dialog');
    // The dialog lists the new state, but the human types the code from the page they read.
    expect(fake.calls[0]!.message).toContain('+ bucket root/mail');
    fake.answer(human.code);
    const res = await reply;
    expect(JSON.parse(res.body)).toMatchObject({ status: 'wrong-code' });
    expect(readFile(dir, 'buckets.lock.json')).toBe(before);
    await pagePost(server, '/api/cancel');
    expect(await code).toBe(1);
  });

  it('reports a changed state to the page poll instead of changing the page', async () => {
    const dir = await changedProject();
    const { server, code } = await startWeb(dir, fakeDialog().dialog);
    const shown = await pageReview(server);
    expect(JSON.parse((await pagePost(server, '/api/state', { projects: { '.': shown.hash } })).body)).toEqual({ status: 'waiting', changed: [] });
    writeFile(dir, 'root/mail/_/m.ts', 'export const m = 1;\n');
    expect(JSON.parse((await pagePost(server, '/api/state', { projects: { '.': shown.hash } })).body)).toEqual({ status: 'waiting', changed: ['.'] });
    expect(shown.body).toContain('id="stale-banner"');
    await pagePost(server, '/api/cancel');
    expect(await code).toBe(1);
  });

  it('lists the changes in the dialog with sanitized names, and never the code', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'package.json': JSON.stringify({ name: `ok‮\nApprove now​${'x'.repeat(100)}` }) });
    await approve(dir);
    for (let i = 0; i < 10; i++) writeFile(dir, `root/b${i}/_/m.ts`, 'export const m = 1;\n');
    const fake = fakeDialog();
    const { server, code } = await startWeb(dir, fake.dialog);
    const shown = await pageReview(server);
    const reply = pagePost(server, '/api/approve', { hash: shown.hash });
    await until(() => fake.calls.length === 1, 'the dialog');
    const message = fake.calls[0]!.message;
    expect(message).toContain('Approve 10 contract changes in the project');
    expect(message).toMatch(/package\.json name "ok Approve now x+\.\.\."/);
    expect(message).not.toMatch(/[‮​]/);
    expect(message).toContain('  + bucket root/b0');
    expect(message).toContain('  and 2 more, listed on the review page');
    expect(message).not.toContain(shown.code);
    const name = /package\.json name "([^"]*)"/.exec(message)![1]!;
    expect([...name].length).toBeLessThanOrEqual(60);
    fake.answer(null);
    await reply;
    expect(await code).toBe(1);
  });

  it('reads the approve body before taking the one-dialog lock, so a held-open request blocks nothing', async () => {
    const dir = await changedProject();
    const fake = fakeDialog();
    const { server, code } = await startWeb(dir, fake.dialog, { requestTimeoutMs: 500 });
    const shown = await pageReview(server);
    const held = request({
      host: '127.0.0.1',
      port: server.port,
      method: 'POST',
      path: '/api/approve',
      agent: false,
      headers: { host: `127.0.0.1:${server.port}`, origin: `http://127.0.0.1:${server.port}`, 'content-type': 'application/json', 'content-length': '1000', 'x-buckets-token': server.token },
    });
    let closedByServer = false;
    held.on('error', () => (closedByServer = true));
    held.on('response', () => (closedByServer = true));
    held.write('{"hash":');
    await new Promise((r) => setTimeout(r, 50));
    const reply = pagePost(server, '/api/approve', { hash: shown.hash });
    await until(() => fake.calls.length === 1, 'the dialog');
    fake.answer(shown.code);
    expect(JSON.parse((await reply).body)).toMatchObject({ status: 'approved' });
    expect(await code).toBe(0);
    await until(() => closedByServer, 'the held request to be closed');
    held.destroy();
  });
});
