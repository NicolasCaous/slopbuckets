import { chmodSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeUpdates } from '../testing/fake-updates.js';
import { cleanupProjects, fileExists, makeProject, readFile, writeFile } from '../testing/fixture.js';
import {
  binTarget,
  checkForUpdate,
  compareVersions,
  detectInstall,
  fetchVersion,
  findOnPath,
  formatCommand,
  installArgs,
  installCommand,
  installedPackageDir,
  isVersion,
  isVoltaPackage,
  npmGlobalPrefix,
  registryUrl,
  voltaInUse,
  windowsCommandLine,
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
  it('finds a global npm install under a folder without package.json, and its prefix', () => {
    const posix = tree('lib/node_modules/slopbuckets');
    expect(detectInstall(posix.packageDir, '/', { platform: 'linux' })).toEqual({ scope: 'global', manager: 'npm', dir: null, dev: false, prefix: posix.dir });
    const windows = tree('npm/node_modules/slopbuckets');
    expect(detectInstall(windows.packageDir, '/', { platform: 'win32' })).toEqual({ scope: 'global', manager: 'npm', dir: null, dev: false, prefix: path.join(windows.dir, 'npm') });
  });

  it('finds a global install of Volta by VOLTA_HOME, the default folders or the folder names', () => {
    const volta = (packageDir: string, platform: NodeJS.Platform, env: Record<string, string> = {}) => detectInstall(packageDir, '/', { platform, env });
    const expected = { scope: 'global', manager: 'volta', dir: null, dev: false, prefix: null };
    expect(volta('/home/ana/.volta/tools/image/packages/slopbuckets/lib/node_modules/slopbuckets', 'linux', { HOME: '/home/ana' })).toEqual(expected);
    expect(volta('/home/ana/.volta/tools/image/packages/slopbuckets/lib/node_modules/slopbuckets', 'linux')).toEqual(expected);
    expect(volta('/opt/tools/v/tools/image/packages/slopbuckets/lib/node_modules/slopbuckets', 'linux', { VOLTA_HOME: '/opt/tools/v' })).toEqual(expected);
    expect(volta('C:\\Users\\ana\\AppData\\Local\\Volta\\tools\\image\\packages\\slopbuckets\\node_modules\\slopbuckets', 'win32', { LOCALAPPDATA: 'c:\\users\\ana\\appdata\\local' })).toEqual(expected);
    expect(isVoltaPackage('D:\\v\\tools\\image\\packages\\slopbuckets\\node_modules\\slopbuckets', 'win32', { VOLTA_HOME: 'd:\\V' })).toBe(true);
    expect(isVoltaPackage('/opt/tools/v/tools/image/packages/slopbuckets/lib/node_modules/slopbuckets', 'linux', { VOLTA_HOME: '/opt/tools/V' })).toBe(false);
    // The node image of Volta holds the npm that Volta runs, and its global folder is a plain npm prefix.
    expect(volta('/home/ana/.volta/tools/image/node/24.20.0/lib/node_modules/slopbuckets', 'linux', { HOME: '/home/ana' })).toMatchObject({ manager: 'npm', prefix: '/home/ana/.volta/tools/image/node/24.20.0' });
  });

  it('knows when Volta manages Node.js', () => {
    expect(voltaInUse('/usr/lib/node_modules/slopbuckets', { VOLTA_HOME: '/home/ana/.volta' })).toBe(true);
    expect(voltaInUse('/usr/lib/node_modules/slopbuckets', { PATH: '/home/ana/.volta/bin:/usr/bin' })).toBe(true);
    expect(voltaInUse('/usr/lib/node_modules/slopbuckets', { Path: 'C:\\Users\\ana\\AppData\\Local\\Volta\\bin;C:\\Windows' })).toBe(true);
    expect(voltaInUse('/usr/lib/node_modules/slopbuckets', { PATH: '/usr/local/bin:/usr/bin' })).toBe(false);
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
      expect(detectInstall(packageDir, dir)).toEqual({ scope: 'local', manager, dir, dev: true, prefix: null });
    }
  });

  it('knows pnpm from its store folder, and a runtime dependency', () => {
    const { dir, packageDir } = tree('node_modules/.pnpm/slopbuckets@1.0.0/node_modules/slopbuckets', { 'package.json': '{ "dependencies": { "slopbuckets": "1.0.0" } }' });
    expect(detectInstall(packageDir, dir)).toEqual({ scope: 'local', manager: 'pnpm', dir, dev: false, prefix: null });
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
    expect(detectInstall(packageDir, path.join(member, 'src'))).toEqual({ scope: 'local', manager: 'npm', dir: member, dev: false, prefix: null });
    expect(detectInstall(packageDir, path.dirname(dir))).toMatchObject({ dir });
  });

  it('cannot update a temporary copy or a checkout', () => {
    expect(detectInstall('/home/ana/.npm/_npx/1a2b3c/node_modules/slopbuckets', '/')).toMatchObject({ scope: 'unknown', manager: null });
    expect(detectInstall('/tmp/bunx-1000-slopbuckets@latest/node_modules/slopbuckets', '/')).toMatchObject({ scope: 'unknown' });
    expect(detectInstall('/home/ana/src/slopbuckets/cli', '/').reason).toContain('not inside a node_modules folder');
  });
});

describe('npmGlobalPrefix', () => {
  it.each([
    ['/usr/local/lib/node_modules/slopbuckets', 'linux', '/usr/local'],
    ['/usr/lib/node_modules/slopbuckets/', 'linux', '/usr'],
    ['/opt/homebrew/lib/node_modules/slopbuckets', 'darwin', '/opt/homebrew'],
    ['/home/ana/.nvm/versions/node/v24.0.0/lib/node_modules/slopbuckets', 'linux', '/home/ana/.nvm/versions/node/v24.0.0'],
    ['/home/ana/.local/share/mise/installs/node/24.0.0/lib/node_modules/slopbuckets', 'linux', '/home/ana/.local/share/mise/installs/node/24.0.0'],
    ['/home/ana/.asdf/installs/nodejs/24.0.0/lib/node_modules/slopbuckets', 'linux', '/home/ana/.asdf/installs/nodejs/24.0.0'],
    ['/home/ana/.local/share/fnm/node-versions/v24.0.0/installation/lib/node_modules/slopbuckets', 'linux', '/home/ana/.local/share/fnm/node-versions/v24.0.0/installation'],
    ['/home/ana/my tools/lib/node_modules/slopbuckets', 'linux', '/home/ana/my tools'],
    ['/lib/node_modules/slopbuckets', 'linux', '/'],
    ['C:\\Users\\ana\\AppData\\Roaming\\npm\\node_modules\\slopbuckets', 'win32', 'C:\\Users\\ana\\AppData\\Roaming\\npm'],
    ['C:\\Program Files\\nodejs\\node_modules\\slopbuckets\\', 'win32', 'C:\\Program Files\\nodejs'],
    ['C:\\node_modules\\slopbuckets', 'win32', 'C:\\'],
    ['/usr/local/share/node_modules/slopbuckets', 'linux', null],
    ['/usr/lib/node_modules/other/node_modules/slopbuckets', 'linux', null],
    ['/usr/lib/node_modules/slopbuckets/dist', 'linux', null],
  ] as const)('%s on %s', (packageDir, platform, prefix) => {
    expect(npmGlobalPrefix(packageDir, platform)).toBe(prefix);
  });

  it('gives the prefix of nvm, mise and asdf installs to the install command', () => {
    for (const prefix of ['/home/ana/.nvm/versions/node/v24.0.0', '/home/ana/.local/share/mise/installs/node/24.0.0', '/home/ana/.asdf/installs/nodejs/24.0.0']) {
      const install = detectInstall(`${prefix}/lib/node_modules/slopbuckets`, '/', { platform: 'linux', env: { HOME: '/home/ana' } });
      expect(install).toEqual({ scope: 'global', manager: 'npm', dir: null, dev: false, prefix });
      expect(installCommand(install, '1.2.0', 'linux')).toBe(`npm install -g --prefix ${prefix} slopbuckets@1.2.0`);
    }
  });
});

describe('installCommand', () => {
  it('builds the command of each manager', () => {
    const global = (manager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'volta', prefix: string | null = null) => installCommand({ scope: 'global', manager, dir: null, dev: false, prefix }, '1.2.0', 'linux');
    expect(global('npm')).toBe('npm install -g slopbuckets@1.2.0');
    expect(global('npm', '/usr/local')).toBe('npm install -g --prefix /usr/local slopbuckets@1.2.0');
    expect(global('pnpm')).toBe('pnpm add -g slopbuckets@1.2.0');
    expect(global('yarn')).toBe('yarn global add slopbuckets@1.2.0');
    expect(global('bun')).toBe('bun add -g slopbuckets@1.2.0');
    expect(global('volta')).toBe('volta install slopbuckets@1.2.0');
    const local = (manager: 'npm' | 'pnpm' | 'yarn' | 'bun', dev: boolean) => installCommand({ scope: 'local', manager, dir: '/p', dev, prefix: null }, '1.2.0', 'linux');
    expect(local('npm', true)).toBe('npm install --save-dev --save-exact slopbuckets@1.2.0');
    expect(local('npm', false)).toBe('npm install --save-exact slopbuckets@1.2.0');
    expect(local('pnpm', true)).toBe('pnpm add --save-dev --save-exact slopbuckets@1.2.0');
    expect(local('yarn', true)).toBe('yarn add --dev --exact slopbuckets@1.2.0');
    expect(local('bun', false)).toBe('bun add --exact slopbuckets@1.2.0');
    expect(installCommand({ scope: 'unknown', manager: null, dir: null, dev: false, prefix: null }, '1.2.0')).toBeNull();
  });

  it('refuses anything but a version, because cmd.exe runs the command on Windows', () => {
    expect(() => installCommand({ scope: 'global', manager: 'npm', dir: null, dev: false, prefix: null }, '1.2.0 && evil')).toThrow('not a version');
  });

  it('keeps a prefix with spaces or shell characters in one argument, and quotes it for each shell', () => {
    const prefix = "/home/ana/it's $(evil) & co";
    const install = { scope: 'global', manager: 'npm', dir: null, dev: false, prefix } as const;
    expect(installArgs(install, '1.2.0')).toEqual(['npm', 'install', '-g', '--prefix', prefix, 'slopbuckets@1.2.0']);
    expect(installCommand(install, '1.2.0', 'linux')).toBe(`npm install -g --prefix '/home/ana/it'\\''s $(evil) & co' slopbuckets@1.2.0`);
    const windows = { ...install, prefix: 'C:\\Program Files (x86)\\node & co' };
    expect(installCommand(windows, '1.2.0', 'win32')).toBe('npm install -g --prefix "C:\\Program Files (x86)\\node & co" slopbuckets@1.2.0');
    expect(windowsCommandLine(installArgs(windows, '1.2.0') ?? [])).toBe('npm install -g --prefix "C:\\Program Files (x86)\\node & co" slopbuckets@1.2.0');
  });

  it('refuses to hand cmd.exe a path with a character it expands inside quotes', () => {
    for (const prefix of ['C:\\%PATH%\\npm', 'C:\\a!b!\\npm', 'C:\\a"&evil&"\\npm', 'C:\\a\nb']) {
      expect(windowsCommandLine(['npm', 'install', '-g', '--prefix', prefix, 'slopbuckets@1.2.0'])).toBeNull();
    }
    expect(formatCommand(['npm', 'prefix', '-g'], 'win32')).toBe('npm prefix -g');
  });
});

describe('after an install', () => {
  it('reads the version from the package link of pnpm, not from its store folder', () => {
    const { dir } = tree('node_modules/.pnpm/slopbuckets@1.0.0/node_modules/slopbuckets', {
      'package.json': '{ "devDependencies": { "slopbuckets": "1.0.0" } }',
      'node_modules/slopbuckets/package.json': '{ "name": "slopbuckets", "version": "1.2.0" }',
    });
    const packageDir = path.join(dir, 'node_modules', '.pnpm', 'slopbuckets@1.0.0', 'node_modules', 'slopbuckets');
    expect(installedPackageDir(detectInstall(packageDir, dir), packageDir)).toBe(path.join(dir, 'node_modules', 'slopbuckets'));
    const global = tree('lib/node_modules/slopbuckets');
    expect(installedPackageDir(detectInstall(global.packageDir, '/', { platform: 'linux' }), global.packageDir)).toBe(global.packageDir);
  });

  it('finds a program on PATH like which and where, without a shell', () => {
    const exe = process.platform === 'win32' ? 'buckets.CMD' : 'buckets';
    const dir = makeProject({ 'first/readme.txt': '', [`second/${exe}`]: '', [`third/${exe}`]: '' }, false);
    if (process.platform !== 'win32') for (const folder of ['second', 'third']) chmodSync(path.join(dir, folder, exe), 0o755);
    const pathValue = ['first', 'second', 'third'].map((folder) => path.join(dir, folder)).join(path.delimiter);
    const env = process.platform === 'win32' ? { Path: pathValue, PATHEXT: '.EXE;.CMD' } : { PATH: pathValue };
    expect(findOnPath('buckets', env, process.platform)).toBe(path.join(dir, 'second', exe.toLowerCase()));
    expect(findOnPath('buckets', {}, process.platform)).toBeNull();
  });

  it('follows an npm .cmd shim of Windows to its package, and knows a Volta shim', () => {
    const { dir } = tree('npm/node_modules/slopbuckets', {
      'npm/buckets.cmd': '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\slopbuckets\\dist\\index.js" %*\r\n',
      'npm/node_modules/slopbuckets/dist/index.js': '',
      'volta/buckets.cmd': '@echo off\r\n"%~dp0\\..\\volta.exe" run buckets %*\r\n',
      'other/buckets.cmd': '@echo off\r\nasdf exec buckets %*\r\n',
    });
    expect(binTarget(path.join(dir, 'npm', 'buckets.cmd'), 'win32')).toEqual({ kind: 'package', dir: path.join(dir, 'npm', 'node_modules', 'slopbuckets') });
    expect(binTarget(path.join(dir, 'volta', 'buckets.cmd'), 'win32')).toEqual({ kind: 'volta' });
    expect(binTarget(path.join(dir, 'other', 'buckets.cmd'), 'win32')).toEqual({ kind: 'unknown' });
  });
});
