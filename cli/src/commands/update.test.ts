import { chmodSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../cli.js';
import { fakeUpdates, type FakeUpdatesOptions } from '../testing/fake-updates.js';
import { cleanupProjects, LOGGER_PROJECT, makeProject, readFile, writeFile } from '../testing/fixture.js';
import { approve, fakeIo, testContext } from '../testing/harness.js';

afterEach(cleanupProjects);

const PACKAGE = '{ "name": "slopbuckets", "version": "1.0.0" }';

/**
 * A global npm install: the package sits in node_modules of a folder without package.json, at
 * `<prefix>/lib/node_modules/slopbuckets` on POSIX and `<prefix>/node_modules/slopbuckets` on Windows.
 */
function globalInstall(platform: NodeJS.Platform = 'linux', prefixName = 'prefix'): { prefix: string; packageDir: string } {
  const modules = platform === 'win32' ? `${prefixName}/node_modules` : `${prefixName}/lib/node_modules`;
  const dir = makeProject({ [`${modules}/slopbuckets/package.json`]: PACKAGE }, false);
  return { prefix: path.join(dir, prefixName), packageDir: path.join(dir, modules, 'slopbuckets') };
}

/** The prefix as a POSIX shell needs it: in single quotes unless it is plain. The test paths have no single quote. */
function posixQuoted(prefix: string): string {
  return /^[\w/.:@+=,-]+$/.test(prefix) ? prefix : `'${prefix}'`;
}

function setup(options: { cwd?: string; interactive?: boolean; answers?: string[]; env?: Record<string, string> } & FakeUpdatesOptions = {}) {
  const global = globalInstall();
  const updates = fakeUpdates({ packageDir: global.packageDir, ...options });
  const io = fakeIo({ cwd: options.cwd ?? makeProject({}, false), interactive: options.interactive ?? false, answers: options.answers ?? [], env: options.env ?? {} });
  io.updates = updates;
  const command = `npm install -g --prefix ${posixQuoted(global.prefix)} slopbuckets@1.2.0`;
  return { io, updates, prefix: global.prefix, command, argv: ['npm', 'install', '-g', '--prefix', global.prefix, 'slopbuckets@1.2.0'] };
}

describe('buckets update', () => {
  it('--check prints both versions and the install command, and installs nothing', async () => {
    const { io, updates, prefix, command } = setup();
    expect(await main(testContext(), io, ['update', '--check'])).toBe(0);
    expect(io.out).toContain('Installed: slopbuckets 1.0.0\nLatest:    slopbuckets 1.2.0\n');
    expect(io.out).toContain(`This CLI is a global install of npm in the prefix ${prefix}.`);
    expect(io.out).toContain(command);
    expect(updates.runs).toEqual([]);
    expect(io.err).toBe('');
  });

  it('--json prints the versions and the install, and installs nothing', async () => {
    const { io, updates, prefix, command } = setup({ answers: ['y'], interactive: true });
    expect(await main(testContext(), io, ['update', '--json'])).toBe(0);
    expect(JSON.parse(io.out)).toEqual({
      installed: '1.0.0',
      latest: '1.2.0',
      updateAvailable: true,
      install: { scope: 'global', manager: 'npm', command, dir: null, prefix },
    });
    expect(updates.runs).toEqual([]);
  });

  it('without a terminal and without --yes prints the command and installs nothing', async () => {
    const { io, updates, command } = setup();
    expect(await main(testContext(), io, ['update'])).toBe(1);
    expect(io.out).toContain(command);
    expect(io.out).toContain('Nothing installed.');
    expect(updates.runs).toEqual([]);
  });

  it('asks in a terminal and installs after yes', async () => {
    const { io, updates, argv } = setup({ interactive: true, answers: ['y'] });
    expect(await main(testContext(), io, ['update'])).toBe(0);
    expect(io.questions).toEqual(['\nInstall slopbuckets 1.2.0? [y/N] ']);
    expect(updates.runs).toEqual([{ argv, cwd: io.cwd }]);
    expect(io.out).toContain(`Installed slopbuckets 1.2.0 in ${updates.packageDir}.`);
    expect(io.err).toBe('');
    expect(io.out).toContain('`buckets check` stops with exit code 3');
    expect(io.out).toContain('a human runs `buckets refresh`');
  });

  it('targets the prefix of a Windows install, quoted when it has spaces', async () => {
    const global = globalInstall('win32', 'Program Files/nodejs');
    const { io, updates } = setup({ platform: 'win32', packageDir: global.packageDir });
    expect(await main(testContext(), io, ['update', '--yes'])).toBe(0);
    expect(io.out).toContain(`This CLI is a global install of npm in the prefix ${global.prefix}.`);
    expect(io.out).toContain(`  npm install -g --prefix "${global.prefix}" slopbuckets@1.2.0\n`);
    expect(updates.runs).toEqual([{ argv: ['npm', 'install', '-g', '--prefix', global.prefix, 'slopbuckets@1.2.0'], cwd: io.cwd }]);
    expect(io.out).toContain('Installed slopbuckets 1.2.0');
  });

  it('keeps a POSIX prefix with spaces in one argument and quotes it for the shell', async () => {
    const global = globalInstall('linux', 'my prefix');
    const { io, updates } = setup({ packageDir: global.packageDir });
    expect(await main(testContext(), io, ['update', '--yes'])).toBe(0);
    expect(io.out).toContain(`  npm install -g --prefix '${global.prefix}' slopbuckets@1.2.0\n`);
    expect(updates.runs.map((r) => r.argv)).toEqual([['npm', 'install', '-g', '--prefix', global.prefix, 'slopbuckets@1.2.0']]);
  });

  it('does not hand cmd.exe a prefix with a character it would expand', async () => {
    const global = globalInstall('win32', '100%done');
    const { io, updates } = setup({ platform: 'win32', packageDir: global.packageDir });
    expect(await main(testContext(), io, ['update', '--yes'])).toBe(1);
    expect(io.out).toContain('Nothing installed. A path in the command has a %, ! or " character');
    expect(updates.runs).toEqual([]);
  });

  it('says what happened when the package manager exits with 0 but this copy keeps its version', async () => {
    const { io, updates, prefix } = setup({ installsTo: null, outputs: { 'npm prefix -g': '/home/ana/.npm-global' } });
    expect(await main(testContext(), io, ['update', '--yes'])).toBe(1);
    expect(io.err).toContain(`buckets update: npm finished without an error, but ${updates.packageDir} still holds slopbuckets 1.0.0, not 1.2.0.`);
    expect(io.err).toContain(`\`npm prefix -g\` prints /home/ana/.npm-global, but this CLI is under ${prefix}. npm may have installed 1.2.0 there instead.`);
    expect(io.err).toContain('Install slopbuckets 1.2.0 the way you installed this copy');
    expect(updates.queries).toEqual([['npm', 'prefix', '-g']]);
    expect(io.out).not.toContain('Installed slopbuckets 1.2.0');
    expect(readFile(updates.packageDir, 'package.json')).toBe(PACKAGE);
  });

  it('leaves out `npm prefix -g` when it names the prefix of this CLI, and points to Volta when Volta is in use', async () => {
    const global = globalInstall();
    const { io } = setup({ packageDir: global.packageDir, installsTo: null, outputs: { 'npm prefix -g': global.prefix }, env: { VOLTA_HOME: '/home/ana/.volta' } });
    expect(await main(testContext(), io, ['update', '--yes'])).toBe(1);
    expect(io.err).toContain('still holds slopbuckets 1.0.0, not 1.2.0');
    expect(io.err).not.toContain('prints');
    expect(io.err).toContain('Volta manages Node.js on this machine.');
    expect(io.err).toContain('  volta install slopbuckets@1.2.0\n');
    expect(io.err).not.toContain('the way you installed this copy');
  });

  it('asks for sudo when npm cannot write to the prefix', async () => {
    const { io, prefix, command } = setup({ exitCode: 243, errorOutput: 'npm error code EACCES\nnpm error syscall mkdir\n' });
    expect(await main(testContext(), io, ['update', '--yes'])).toBe(1);
    expect(io.err).toContain(`buckets update: npm has no permission to write to ${prefix}, which needs elevated rights. slopbuckets 1.0.0 is still installed. Run the command with sudo:\n\n  sudo ${command}\n`);
  });

  it('asks for an administrator shell on Windows when npm gets EPERM', async () => {
    const global = globalInstall('win32', 'Program Files/nodejs');
    const { io } = setup({ platform: 'win32', packageDir: global.packageDir, exitCode: 1, errorOutput: 'npm error code EPERM\n' });
    expect(await main(testContext(), io, ['update', '--yes'])).toBe(1);
    expect(io.err).toContain(`Run the command from an administrator shell:\n\n  npm install -g --prefix "${global.prefix}" slopbuckets@1.2.0\n`);
    expect(io.err).not.toContain('sudo');
  });

  it('updates a package of Volta with volta install, and says when volta is missing', async () => {
    const dir = makeProject({ '.volta/tools/image/packages/slopbuckets/lib/node_modules/slopbuckets/package.json': PACKAGE }, false);
    const packageDir = path.join(dir, '.volta', 'tools', 'image', 'packages', 'slopbuckets', 'lib', 'node_modules', 'slopbuckets');
    const json = setup({ packageDir });
    expect(await main(testContext(), json.io, ['update', '--json'])).toBe(0);
    expect(JSON.parse(json.io.out).install).toEqual({ scope: 'global', manager: 'volta', command: 'volta install slopbuckets@1.2.0', dir: null, prefix: null });

    const { io, updates } = setup({ packageDir });
    expect(await main(testContext(), io, ['update', '--yes'])).toBe(0);
    expect(io.out).toContain('This CLI is a package that Volta installed');
    expect(updates.runs.map((r) => r.argv)).toEqual([['volta', 'install', 'slopbuckets@1.2.0']]);
    expect(io.out).toContain('Installed slopbuckets 1.2.0');

    const missing = setup({ packageDir, exitCode: 127 });
    expect(await main(testContext(), missing.io, ['update', '1.0.5', '--yes'])).toBe(1);
    expect(missing.io.err).toContain('Volta installed this CLI, so Volta has to update it, but `volta` is not on PATH.');
    expect(missing.io.err).toContain('  volta install slopbuckets@1.0.5\n');
  });

  it('warns when the shell runs another copy of slopbuckets from PATH', async () => {
    const platform = process.platform;
    const global = globalInstall(platform);
    const exe = platform === 'win32' ? 'buckets.cmd' : 'buckets';
    const shim = '@echo off\r\n"%~dp0\\..\\dist\\index.js" %*\r\n';
    const other = makeProject({ 'package.json': '{ "name": "slopbuckets", "version": "1.1.0" }', 'dist/index.js': '', [`bin/${exe}`]: shim }, false);
    const mine = path.join(global.packageDir, 'bin');
    makeExecutable(path.join(other, 'bin', exe));
    const env = { PATH: path.join(other, 'bin'), PATHEXT: '.CMD' };
    const { io } = setup({ platform, packageDir: global.packageDir, env });
    expect(await main(testContext(), io, ['update', '--yes'])).toBe(0);
    expect(io.out).toContain('Installed slopbuckets 1.2.0');
    expect(io.err).toContain(`Warning: the shell runs ${path.join(other, 'bin', exe)}, which is slopbuckets 1.1.0 in ${other}, not the copy this command updated.`);

    // A `buckets` on PATH that belongs to the updated package is the same copy.
    const same = setup({ platform, packageDir: global.packageDir, env: { PATH: mine, PATHEXT: '.CMD' } });
    writeBin(mine, exe, shim);
    expect(await main(testContext(), same.io, ['update', '1.0.5', '--yes'])).toBe(0);
    expect(same.io.err).toBe('');
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
    const { io, updates, prefix } = setup({ cwd: project });
    expect(await main(testContext(), io, ['update', 'v1.0.5', '--yes'])).toBe(0);
    expect(updates.requests).toContain('https://registry.npmjs.org/slopbuckets/1.0.5');
    expect(updates.runs.map((r) => r.argv)).toEqual([['npm', 'install', '-g', '--prefix', prefix, 'slopbuckets@1.0.5']]);
    expect(io.out).toContain('already names 1.0.5, so `buckets check` runs as before');
  });

  it('runs a project install in the project folder', async () => {
    const dir = makeProject(
      { 'package.json': '{ "devDependencies": { "slopbuckets": "1.0.0" } }', 'pnpm-lock.yaml': '', 'node_modules/slopbuckets/package.json': PACKAGE, 'src/a.ts': '' },
      false,
    );
    const { io, updates } = setup({ cwd: path.join(dir, 'src'), packageDir: path.join(dir, 'node_modules', 'slopbuckets') });
    expect(await main(testContext(), io, ['update', '--yes'])).toBe(0);
    expect(io.out).toContain(`This CLI is in the devDependencies of ${dir}, installed with pnpm. To install slopbuckets 1.2.0, run in that folder:`);
    expect(updates.runs).toEqual([{ argv: ['pnpm', 'add', '--save-dev', '--save-exact', 'slopbuckets@1.2.0'], cwd: dir }]);
    expect(io.out).toContain(`Installed slopbuckets 1.2.0 in ${path.join(dir, 'node_modules', 'slopbuckets')}.`);
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

  it('with --json, prints a registry it cannot reach as a JSON error on stdout', async () => {
    const { io } = setup({ offline: true });
    expect(await main(testContext(), io, ['update', '--check', '--json'])).toBe(1);
    const parsed = JSON.parse(io.out) as { error: string };
    expect(Object.keys(parsed)).toEqual(['error']);
    expect(parsed.error).toContain('cannot reach https://registry.npmjs.org');
    expect(io.err).toBe('');
  });

  it('prints the install command without backticks in plain output, so it can be copied', async () => {
    const { io, command } = setup();
    expect(await main(testContext(), io, ['update', '--check'])).toBe(0);
    expect(io.out).toContain(`:\n\n  ${command}\n`);
    expect(io.out).not.toContain('`npm install');
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

function makeExecutable(file: string): void {
  if (process.platform !== 'win32') chmodSync(file, 0o755);
}

function writeBin(dir: string, name: string, content: string): void {
  writeFile(dir, name, content);
  makeExecutable(path.join(dir, name));
}
