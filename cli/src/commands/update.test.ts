import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../cli.js';
import { fakeUpdates, type FakeUpdatesOptions } from '../testing/fake-updates.js';
import { cleanupProjects, LOGGER_PROJECT, makeProject } from '../testing/fixture.js';
import { approve, fakeIo, testContext } from '../testing/harness.js';

afterEach(cleanupProjects);

/** A global npm install: the package sits in node_modules of a folder without package.json. */
function globalInstall(): string {
  const dir = makeProject({ 'lib/node_modules/slopbuckets/package.json': '{ "name": "slopbuckets" }' }, false);
  return path.join(dir, 'lib', 'node_modules', 'slopbuckets');
}

function setup(options: { cwd?: string; interactive?: boolean; answers?: string[]; env?: Record<string, string> } & FakeUpdatesOptions = {}) {
  const updates = fakeUpdates({ packageDir: globalInstall(), ...options });
  const io = fakeIo({ cwd: options.cwd ?? makeProject({}, false), interactive: options.interactive ?? false, answers: options.answers ?? [], env: options.env ?? {} });
  io.updates = updates;
  return { io, updates };
}

describe('buckets update', () => {
  it('--check prints both versions and the install command, and installs nothing', async () => {
    const { io, updates } = setup();
    expect(await main(testContext(), io, ['update', '--check'])).toBe(0);
    expect(io.out).toContain('Installed: slopbuckets 1.0.0\nLatest:    slopbuckets 1.2.0\n');
    expect(io.out).toContain('This CLI is a global install of npm.');
    expect(io.out).toContain('npm install -g slopbuckets@1.2.0');
    expect(updates.runs).toEqual([]);
    expect(io.err).toBe('');
  });

  it('--json prints the versions and the install, and installs nothing', async () => {
    const { io, updates } = setup({ answers: ['y'], interactive: true });
    expect(await main(testContext(), io, ['update', '--json'])).toBe(0);
    expect(JSON.parse(io.out)).toEqual({
      installed: '1.0.0',
      latest: '1.2.0',
      updateAvailable: true,
      install: { scope: 'global', manager: 'npm', command: 'npm install -g slopbuckets@1.2.0', dir: null },
    });
    expect(updates.runs).toEqual([]);
  });

  it('without a terminal and without --yes prints the command and installs nothing', async () => {
    const { io, updates } = setup();
    expect(await main(testContext(), io, ['update'])).toBe(1);
    expect(io.out).toContain('npm install -g slopbuckets@1.2.0');
    expect(io.out).toContain('Nothing installed.');
    expect(updates.runs).toEqual([]);
  });

  it('asks in a terminal and installs after yes', async () => {
    const { io, updates } = setup({ interactive: true, answers: ['y'] });
    expect(await main(testContext(), io, ['update'])).toBe(0);
    expect(io.questions).toEqual(['\nInstall slopbuckets 1.2.0? [y/N] ']);
    expect(updates.runs).toEqual([{ command: 'npm install -g slopbuckets@1.2.0', cwd: io.cwd }]);
    expect(io.out).toContain('Installed slopbuckets 1.2.0.');
    expect(io.out).toContain('`buckets check` stops with exit code 3');
    expect(io.out).toContain('a human runs `buckets refresh`');
  });

  it('installs nothing when the human says no', async () => {
    const { io, updates } = setup({ interactive: true, answers: ['n'] });
    expect(await main(testContext(), io, ['update'])).toBe(1);
    expect(updates.runs).toEqual([]);
    expect(io.out).toContain('Nothing installed. slopbuckets 1.0.0 stays.');
  });

  it('--yes installs without asking, also without a terminal', async () => {
    const { io, updates } = setup();
    expect(await main(testContext(), io, ['update', '--yes'])).toBe(0);
    expect(io.questions).toEqual([]);
    expect(updates.runs).toHaveLength(1);
  });

  it('installs a given version, such as the one a lock asks for, and says when the lock already names it', async () => {
    const project = makeProject(LOGGER_PROJECT);
    await approve(project, { ...testContext(), cliVersion: '1.0.5' });
    const { io, updates } = setup({ cwd: project });
    expect(await main(testContext(), io, ['update', 'v1.0.5', '--yes'])).toBe(0);
    expect(updates.requests).toContain('https://registry.npmjs.org/slopbuckets/1.0.5');
    expect(updates.runs.map((r) => r.command)).toEqual(['npm install -g slopbuckets@1.0.5']);
    expect(io.out).toContain('already names 1.0.5, so `buckets check` runs as before');
  });

  it('runs a project install in the project folder', async () => {
    const dir = makeProject(
      { 'package.json': '{ "devDependencies": { "slopbuckets": "1.0.0" } }', 'pnpm-lock.yaml': '', 'node_modules/slopbuckets/package.json': '{}', 'src/a.ts': '' },
      false,
    );
    const { io, updates } = setup({ cwd: path.join(dir, 'src'), packageDir: path.join(dir, 'node_modules', 'slopbuckets') });
    expect(await main(testContext(), io, ['update', '--yes'])).toBe(0);
    expect(io.out).toContain(`This CLI is in the devDependencies of ${dir}, installed with pnpm. To install slopbuckets 1.2.0, run in that folder:`);
    expect(updates.runs).toEqual([{ command: 'pnpm add --save-dev --save-exact slopbuckets@1.2.0', cwd: dir }]);
  });

  it('has nothing to do when the latest version is installed', async () => {
    const { io, updates } = setup({ versions: { latest: '1.0.0' } });
    expect(await main(testContext(), io, ['update', '--yes'])).toBe(0);
    expect(io.out).toContain('slopbuckets 1.0.0 is already installed. Nothing to do.');
    expect(updates.runs).toEqual([]);
  });

  it('reports a version the registry does not have, a registry it cannot reach and a failed install', async () => {
    const missing = setup();
    expect(await main(testContext(), missing.io, ['update', '9.9.9'])).toBe(1);
    expect(missing.io.err).toContain('has no slopbuckets 9.9.9');

    const offline = setup({ offline: true });
    expect(await main(testContext(), offline.io, ['update'])).toBe(1);
    expect(offline.io.err).toContain('cannot reach https://registry.npmjs.org');

    const failed = setup({ exitCode: 7 });
    expect(await main(testContext(), failed.io, ['update', '--yes'])).toBe(1);
    expect(failed.io.err).toContain('the install command failed with exit code 7. slopbuckets 1.0.0 is still installed.');
  });

  it('cannot update a CLI it cannot place, and rejects bad arguments', async () => {
    const checkout = setup({ packageDir: '/home/ana/src/slopbuckets/cli' });
    expect(await main(testContext(), checkout.io, ['update', '--yes'])).toBe(1);
    expect(checkout.io.out).toContain('Cannot tell how this CLI was installed');
    expect(checkout.updates.runs).toEqual([]);

    const bad = setup();
    expect(await main(testContext(), bad.io, ['update', 'latest'])).toBe(1);
    expect(bad.io.err).toContain('"latest" is not a version');
    expect(await main(testContext(), bad.io, ['update', '--force'])).toBe(1);
    expect(bad.io.err).toContain('Usage: buckets update');
    expect(bad.updates.requests).toEqual([]);
  });
});

describe('the update notice', () => {
  const NOTICE = 'slopbuckets 1.2.0 is available (installed 1.0.0). Run `buckets update`.\n';

  it('comes first, on stderr, and leaves stdout and the exit code alone', async () => {
    const { io } = setup();
    const order: string[] = [];
    const out = io.stdout;
    const err = io.stderr;
    io.stdout = (text) => (order.push('stdout'), out(text));
    io.stderr = (text) => (order.push('stderr'), err(text));
    expect(await main(testContext(), io, ['--version'])).toBe(0);
    expect(io.err).toBe(NOTICE);
    expect(io.out).toBe('buckets 1.0.0\nadapter ts 1.0.0 (protocol 1)\n');
    expect(order).toEqual(['stderr', 'stdout']);
  });

  it('keeps check --json valid and adds the update field', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const { io } = setup({ cwd: dir });
    expect(await main(testContext(), io, ['check', '--json'])).toBe(2);
    expect(io.err).toBe(NOTICE);
    expect(JSON.parse(io.out)).toMatchObject({ exitCode: 2, update: { installed: '1.0.0', latest: '1.2.0', message: NOTICE.trimEnd() } });
  });

  it('is not in hooks, check --file, update, typos, CI, or when the latest version is installed', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const quiet = async (args: string[], options: Parameters<typeof setup>[0] = {}) => {
      const { io, updates } = setup({ cwd: dir, ...options });
      await main(testContext(), io, args);
      expect(io.err).not.toContain('is available');
      return { io, updates };
    };
    expect((await quiet(['hook', 'stop'])).updates.requests).toEqual([]);
    const file = await quiet(['check', '--json', '--file', 'root/_/main.ts']);
    expect(file.updates.requests).toEqual([]);
    expect(() => JSON.parse(file.io.out)).not.toThrow();
    expect(JSON.parse(file.io.out)).not.toHaveProperty('update');
    await quiet(['check', '--file=root/_/main.ts']);
    await quiet(['update', '--check']);
    expect((await quiet(['chek'])).updates.requests).toEqual([]);
    expect((await quiet(['check'], { env: { CI: 'true' } })).updates.requests).toEqual([]);
    expect((await quiet(['check'], { env: { SLOPBUCKETS_NO_UPDATE_CHECK: '1' } })).updates.requests).toEqual([]);
    const current = await quiet(['check', '--json'], { versions: { latest: '1.0.0' } });
    expect(JSON.parse(current.io.out)).not.toHaveProperty('update');
  });

  it('comes from the cache without the network while the cache is fresh', async () => {
    const cacheDir = makeProject({}, false);
    const first = setup({ cacheDir });
    await main(testContext(), first.io, ['--version']);
    const second = setup({ cacheDir, offline: true });
    await main(testContext(), second.io, ['--version']);
    expect(second.io.err).toBe(NOTICE);
    expect(second.updates.requests).toEqual([]);
  });
});
