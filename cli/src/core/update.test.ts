import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeUpdates } from '../testing/fake-updates.js';
import { cleanupProjects, fileExists, makeProject, readFile, writeFile } from '../testing/fixture.js';
import {
  checkForUpdate,
  compareVersions,
  detectInstall,
  fetchVersion,
  installCommand,
  isVersion,
  registryUrl,
  UPDATE_CACHE_MS,
  updateCacheDir,
  updateCheckEnabled,
  type FetchLike,
} from './update.js';

afterEach(cleanupProjects);

const CLI_PACKAGE = { 'package.json': '{ "name": "slopbuckets", "version": "1.0.0" }\n' };

/** A folder tree with the CLI package at `cli` (relative to the tree) and the other files. */
function tree(cli: string, files: Record<string, string> = {}): { dir: string; packageDir: string } {
  const all: Record<string, string> = { ...files };
  for (const [name, content] of Object.entries(CLI_PACKAGE)) all[`${cli}/${name}`] = content;
  const dir = makeProject(all, false);
  return { dir, packageDir: path.join(dir, cli) };
}

describe('compareVersions', () => {
  it.each([
    ['1.2.0', '1.1.9', 1],
    ['1.1.0', '1.1.0', 0],
    ['1.10.0', '1.9.0', 1],
    ['2.0.0', '10.0.0', -1],
    ['1.1.0-beta.1', '1.1.0', -1],
    ['1.1.0-beta.2', '1.1.0-beta.10', -1],
    ['1.1.0-beta', '1.1.0-alpha', 1],
    ['1.1.0-1', '1.1.0-alpha', -1],
    ['1.1.0+build.5', '1.1.0', 0],
  ])('%s against %s', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });

  it('accepts only full versions', () => {
    expect(isVersion('1.2.3')).toBe(true);
    expect(isVersion('1.2.3-rc.1')).toBe(true);
    expect(isVersion('1.2')).toBe(false);
    expect(isVersion('latest')).toBe(false);
    expect(isVersion('1.2.3; rm -rf /')).toBe(false);
  });
});

describe('registryUrl and updateCacheDir', () => {
  it('reads npm_config_registry and drops the trailing slash', () => {
    expect(registryUrl({})).toBe('https://registry.npmjs.org');
    expect(registryUrl({ npm_config_registry: 'https://npm.example.com/repo/' })).toBe('https://npm.example.com/repo');
    expect(registryUrl({ NPM_CONFIG_REGISTRY: 'https://upper.example.com' })).toBe('https://upper.example.com');
    expect(registryUrl({ npm_config_registry: '  ' })).toBe('https://registry.npmjs.org');
  });

  it('uses LOCALAPPDATA on Windows and the XDG cache folder elsewhere', () => {
    expect(updateCacheDir({ LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local' }, 'win32', 'C:\\Users\\ana')).toBe('C:\\Users\\ana\\AppData\\Local\\slopbuckets');
    expect(updateCacheDir({}, 'win32', 'C:\\Users\\ana')).toBe('C:\\Users\\ana\\AppData\\Local\\slopbuckets');
    expect(updateCacheDir({ XDG_CACHE_HOME: '/var/cache/ana' }, 'linux', '/home/ana')).toBe('/var/cache/ana/slopbuckets');
    expect(updateCacheDir({ XDG_CACHE_HOME: 'relative' }, 'linux', '/home/ana')).toBe('/home/ana/.cache/slopbuckets');
    expect(updateCacheDir({}, 'darwin', '/Users/ana')).toBe('/Users/ana/.cache/slopbuckets');
    expect(updateCacheDir({}, 'linux', '')).toBeNull();
  });

  it('is off with CI or SLOPBUCKETS_NO_UPDATE_CHECK=1', () => {
    expect(updateCheckEnabled({})).toBe(true);
    expect(updateCheckEnabled({ CI: 'true' })).toBe(false);
    expect(updateCheckEnabled({ SLOPBUCKETS_NO_UPDATE_CHECK: '1' })).toBe(false);
    expect(updateCheckEnabled({ SLOPBUCKETS_NO_UPDATE_CHECK: '0' })).toBe(true);
  });
});

describe('fetchVersion', () => {
  it('asks the registry for the dist-tag and reads the version', async () => {
    const deps = fakeUpdates();
    expect(await fetchVersion(deps.fetch, 'https://r.example', 'latest', 1000)).toBe('1.2.0');
    expect(deps.requests).toEqual(['https://r.example/slopbuckets/latest']);
  });

  it('names a missing version, an HTTP error and a bad answer', async () => {
    await expect(fetchVersion(fakeUpdates().fetch, 'https://r.example', '9.9.9', 1000)).rejects.toThrow('https://r.example has no slopbuckets 9.9.9');
    const failing: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await expect(fetchVersion(failing, 'https://r.example', 'latest', 1000)).rejects.toThrow('HTTP 503');
    const garbage: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ version: '$(evil)' }) });
    await expect(fetchVersion(garbage, 'https://r.example', 'latest', 1000)).rejects.toThrow('no valid version');
  });

  it('gives up after the timeout', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason as Error));
      });
    await expect(fetchVersion(hanging, 'https://r.example', 'latest', 20)).rejects.toThrow('did not answer within 0.02 seconds');
  });
});

describe('checkForUpdate', () => {
  it('reads the registry once a day and keeps the answer in the cache folder', async () => {
    const cacheDir = makeProject({}, false);
    const deps = fakeUpdates({ cacheDir });
    const first = await checkForUpdate(deps, {}, '1.0.0');
    expect(first).toEqual({ installed: '1.0.0', latest: '1.2.0', message: 'slopbuckets 1.2.0 is available (installed 1.0.0). Run `buckets update`.' });
    expect(fileExists(cacheDir, 'update-check.json')).toBe(true);
    expect(JSON.parse(readFile(cacheDir, 'update-check.json'))).toEqual({ registry: 'https://registry.npmjs.org', checkedAt: deps.time, latest: '1.2.0' });

    deps.time += UPDATE_CACHE_MS - 1;
    expect(await checkForUpdate(deps, {}, '1.0.0')).toEqual(first);
    expect(deps.requests).toHaveLength(1);

    deps.time += 1;
    await checkForUpdate(deps, {}, '1.0.0');
    expect(deps.requests).toHaveLength(2);
  });

  it('asks again for another registry or when the clock moved back', async () => {
    const cacheDir = makeProject({}, false);
    const deps = fakeUpdates({ cacheDir });
    await checkForUpdate(deps, {}, '1.0.0');
    await checkForUpdate(deps, { npm_config_registry: 'https://mirror.example' }, '1.0.0');
    expect(deps.requests).toEqual(['https://registry.npmjs.org/slopbuckets/latest', 'https://mirror.example/slopbuckets/latest']);
    deps.time -= 1000;
    await checkForUpdate(deps, { npm_config_registry: 'https://mirror.example' }, '1.0.0');
    expect(deps.requests).toHaveLength(3);
  });

  it('says nothing when the installed version is the latest or newer', async () => {
    expect(await checkForUpdate(fakeUpdates(), {}, '1.2.0')).toBeNull();
    expect(await checkForUpdate(fakeUpdates(), {}, '1.3.0-beta.1')).toBeNull();
  });

  it('touches nothing when it is off', async () => {
    const deps = fakeUpdates();
    expect(await checkForUpdate(deps, { CI: '1' }, '1.0.0')).toBeNull();
    expect(await checkForUpdate(deps, { SLOPBUCKETS_NO_UPDATE_CHECK: '1' }, '1.0.0')).toBeNull();
    expect(deps.requests).toEqual([]);
  });

  it('fails silently offline, keeps the last answer and waits a day before it asks again', async () => {
    const cacheDir = makeProject({}, false);
    const offline = fakeUpdates({ cacheDir, offline: true });
    expect(await checkForUpdate(offline, {}, '1.0.0')).toBeNull();
    expect(await checkForUpdate(offline, {}, '1.0.0')).toBeNull();
    expect(offline.requests).toHaveLength(1);

    writeFile(cacheDir, 'update-check.json', JSON.stringify({ registry: 'https://registry.npmjs.org', checkedAt: offline.time - UPDATE_CACHE_MS, latest: '1.1.0' }));
    expect((await checkForUpdate(offline, {}, '1.0.0'))?.latest).toBe('1.1.0');
    expect(JSON.parse(readFile(cacheDir, 'update-check.json')).latest).toBe('1.1.0');
  });

  it('ignores a broken cache file and a cache folder it cannot write', async () => {
    const cacheDir = makeProject({ 'update-check.json': 'not json' }, false);
    expect((await checkForUpdate(fakeUpdates({ cacheDir }), {}, '1.0.0'))?.latest).toBe('1.2.0');
    const file = makeProject({ blocker: 'a file, not a folder' }, false);
    expect((await checkForUpdate(fakeUpdates({ cacheDir: path.join(file, 'blocker') }), {}, '1.0.0'))?.latest).toBe('1.2.0');
  });
});

describe('detectInstall', () => {
  it('finds a global npm install under a folder without package.json', () => {
    const { packageDir } = tree('lib/node_modules/slopbuckets');
    expect(detectInstall(packageDir, '/')).toEqual({ scope: 'global', manager: 'npm', dir: null, dev: false });
  });

  it('finds the global folders of pnpm, yarn and bun by name', () => {
    expect(detectInstall('/home/ana/.local/share/pnpm/global/5/node_modules/.pnpm/slopbuckets@1.0.0/node_modules/slopbuckets', '/')).toMatchObject({ scope: 'global', manager: 'pnpm' });
    expect(detectInstall('C:\\Users\\ana\\AppData\\Local\\pnpm\\global\\5\\node_modules\\slopbuckets', 'C:\\')).toMatchObject({ scope: 'global', manager: 'pnpm' });
    expect(detectInstall('/home/ana/.config/yarn/global/node_modules/slopbuckets', '/')).toMatchObject({ scope: 'global', manager: 'yarn' });
    expect(detectInstall('C:\\Users\\ana\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\slopbuckets', 'C:\\')).toMatchObject({ scope: 'global', manager: 'yarn' });
    expect(detectInstall('/home/ana/.bun/install/global/node_modules/slopbuckets', '/')).toMatchObject({ scope: 'global', manager: 'bun' });
  });

  it('finds a project dependency and its package manager from the lockfile', () => {
    for (const [lockfile, manager] of [['package-lock.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']] as const) {
      const { dir, packageDir } = tree('node_modules/slopbuckets', { 'package.json': '{ "devDependencies": { "slopbuckets": "1.0.0" } }', [lockfile]: '' });
      expect(detectInstall(packageDir, dir)).toEqual({ scope: 'local', manager, dir, dev: true });
    }
  });

  it('knows pnpm from its store folder, and a runtime dependency', () => {
    const { dir, packageDir } = tree('node_modules/.pnpm/slopbuckets@1.0.0/node_modules/slopbuckets', { 'package.json': '{ "dependencies": { "slopbuckets": "1.0.0" } }' });
    expect(detectInstall(packageDir, dir)).toEqual({ scope: 'local', manager: 'pnpm', dir, dev: false });
  });

  it('falls back to the packageManager field, then npm', () => {
    const yarn = tree('node_modules/slopbuckets', { 'package.json': '{ "packageManager": "yarn@4.1.0" }' });
    expect(detectInstall(yarn.packageDir, yarn.dir).manager).toBe('yarn');
    const plain = tree('node_modules/slopbuckets', { 'package.json': '{}' });
    expect(detectInstall(plain.packageDir, plain.dir).manager).toBe('npm');
  });

  it('runs the install in the workspace member that lists slopbuckets', () => {
    const { dir, packageDir } = tree('node_modules/slopbuckets', {
      'package.json': '{ "workspaces": ["packages/*"] }',
      'package-lock.json': '',
      'packages/app/package.json': '{ "dependencies": { "slopbuckets": "1.0.0" } }',
      'packages/app/src/index.ts': '',
    });
    const member = path.join(dir, 'packages', 'app');
    expect(detectInstall(packageDir, path.join(member, 'src'))).toEqual({ scope: 'local', manager: 'npm', dir: member, dev: false });
    expect(detectInstall(packageDir, path.dirname(dir))).toMatchObject({ dir });
  });

  it('cannot update a temporary copy or a checkout', () => {
    expect(detectInstall('/home/ana/.npm/_npx/1a2b3c/node_modules/slopbuckets', '/')).toMatchObject({ scope: 'unknown', manager: null });
    expect(detectInstall('/tmp/bunx-1000-slopbuckets@latest/node_modules/slopbuckets', '/')).toMatchObject({ scope: 'unknown' });
    expect(detectInstall('/home/ana/src/slopbuckets/cli', '/').reason).toContain('not inside a node_modules folder');
  });
});

describe('installCommand', () => {
  it('builds the command of each manager', () => {
    const global = (manager: 'npm' | 'pnpm' | 'yarn' | 'bun') => installCommand({ scope: 'global', manager, dir: null, dev: false }, '1.2.0');
    expect(global('npm')).toBe('npm install -g slopbuckets@1.2.0');
    expect(global('pnpm')).toBe('pnpm add -g slopbuckets@1.2.0');
    expect(global('yarn')).toBe('yarn global add slopbuckets@1.2.0');
    expect(global('bun')).toBe('bun add -g slopbuckets@1.2.0');
    const local = (manager: 'npm' | 'pnpm' | 'yarn' | 'bun', dev: boolean) => installCommand({ scope: 'local', manager, dir: '/p', dev }, '1.2.0');
    expect(local('npm', true)).toBe('npm install --save-dev --save-exact slopbuckets@1.2.0');
    expect(local('npm', false)).toBe('npm install --save-exact slopbuckets@1.2.0');
    expect(local('pnpm', true)).toBe('pnpm add --save-dev --save-exact slopbuckets@1.2.0');
    expect(local('yarn', true)).toBe('yarn add --dev --exact slopbuckets@1.2.0');
    expect(local('bun', false)).toBe('bun add --exact slopbuckets@1.2.0');
    expect(installCommand({ scope: 'unknown', manager: null, dir: null, dev: false }, '1.2.0')).toBeNull();
  });

  it('refuses anything but a version, because the command goes through a shell', () => {
    expect(() => installCommand({ scope: 'global', manager: 'npm', dir: null, dev: false }, '1.2.0 && evil')).toThrow('not a version');
  });
});
