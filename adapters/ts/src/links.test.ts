// Tests for source-code links: a consumer project whose `<bucket>/_/links/<name>` folder is a junction to another
// project's root folder, or a copy of its source files.

import { cpSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { analyze, type AnalyzeResponse, type LinkReport, type LinkRequest } from './index.js';
import { Fixture, makeTempDir, removeFolder, TMP_ROOT, TSCONFIG } from './test-fixture.js';

const fixtures: Fixture[] = [];
const links: string[] = [];
const folders: string[] = [];
function fixture(...args: ConstructorParameters<typeof Fixture>): Fixture {
  const created = new Fixture(...args);
  fixtures.push(created);
  return created;
}
afterAll(() => {
  // Remove links first, so that removing a fixture never walks into the link target.
  for (const link of links) {
    try {
      unlinkSync(link);
    } catch {
      // already gone
    }
  }
  for (const created of fixtures) created.remove();
  for (const folder of folders) removeFolder(folder);
});

/** Creates a directory link (a junction on Windows). Returns false when the system does not allow it. */
function linkDir(target: string, link: string): boolean {
  mkdirSync(path.dirname(link), { recursive: true });
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS') return false;
    throw error;
  }
  links.push(link);
  return true;
}

const ORIGIN_ALIAS = '@origin-k3x9pm2a';

/** The origin's root-folder files that its `.external.ts` reaches, plus one file it does not reach. */
const ORIGIN_ROOT = {
  'dmz/api/.external.ts': `export { handle } from '${ORIGIN_ALIAS}/api/_/handle';\nexport type { User } from '${ORIGIN_ALIAS}/api/_/user';\n`,
  'api/_/handle.ts': [
    "import { join } from 'node:path';",
    "import { send, type Reply } from 'fake-http';",
    `import type { User } from '${ORIGIN_ALIAS}/api/_/user';`,
    'export type Handler = typeof handle;',
    'export function handle(user: User): Reply {',
    "  return send(join('users', user.id));",
    '}',
    '',
  ].join('\n'),
  'api/_/user.ts': [
    `import type { Handler } from '${ORIGIN_ALIAS}/api/_/handle';`,
    'export interface User {',
    '  id: string;',
    '  name?: string;',
    '  next?: Handler;',
    '}',
    '',
  ].join('\n'),
  'api/_/unreached.ts': "import { nothing } from 'unreached-pkg';\nexport const value = nothing;\n",
};
const LINKED_FILES = ['dmz/api/.external.ts', 'api/_/handle.ts', 'api/_/user.ts'];

const FAKE_HTTP = {
  'node_modules/fake-http/package.json': { name: 'fake-http', version: '1.0.0', types: 'index.d.ts' },
  'node_modules/fake-http/index.d.ts': 'export interface Reply { status: number; body: string }\nexport declare function send(path: string): Reply;\n',
};

/** The origin project: its own tsconfig with its alias, and fake-http installed when `withPackage` is true. */
function origin(withPackage: boolean): Fixture {
  const files: Record<string, string | object> = {
    'tsconfig.json': { compilerOptions: { ...TSCONFIG.compilerOptions, paths: { [`${ORIGIN_ALIAS}/*`]: ['./root/*'] } } },
    'package.json': { name: 'origin', private: true, dependencies: { 'fake-http': '^1.0.0' } },
    ...Object.fromEntries(Object.entries(ORIGIN_ROOT).map(([name, content]) => [`root/${name}`, content])),
  };
  return fixture(withPackage ? { ...files, ...FAKE_HTTP } : files);
}

const USE = `import { handle, type User } from '${ORIGIN_ALIAS}/dmz/api/.external';\nexport const run = (user: User) => handle(user).status;\n`;

/** A consumer with `root/b/_/use.ts`, which imports the link through the origin's alias. */
function consumer(withPackage: boolean): Fixture {
  const files: Record<string, string | object> = {
    'package.json': { name: 'consumer', private: true, dependencies: { 'fake-http': '^1.0.0' } },
    'root/b/_/use.ts': USE,
  };
  return fixture(withPackage ? { ...files, ...FAKE_HTTP } : files);
}

/** Copies what the origin's `.external.ts` reaches into `linkPath`, as `buckets link add --copy` does. */
function copyLink(from: Fixture, to: Fixture, linkPath: string): void {
  for (const file of LINKED_FILES) {
    const target = path.join(to.dir, linkPath, file);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(from.dir, 'root', file), target);
  }
}

async function run(project: Fixture, linkRequests: LinkRequest[], code: string[] = ['root/b/_/use.ts']): Promise<AnalyzeResponse> {
  return analyze(project.dir, { ...project.request([], code), links: linkRequests });
}

const API = 'root/b/_/links/api';
const EXTERNAL = `${API}/dmz/api/.external.ts`;

function signatures(report: LinkReport): Record<string, string> {
  return Object.fromEntries(report.exports.map((e) => [e.name, e.signature]));
}

describe('a junction link', () => {
  test('reports the published symbols, the packages they need and the consumer imports through the link', async (context) => {
    const source = origin(true);
    const project = consumer(false);
    if (!linkDir(path.join(source.dir, 'root'), path.join(project.dir, API))) context.skip();
    // A linked file listed as code is not analyzed: the origin's rules cover it.
    const response = await run(project, [{ path: API, alias: ORIGIN_ALIAS }], ['root/b/_/use.ts', `${API}/api/_/handle.ts`]);
    const report = response.links![API]!;

    expect(report.problems).toEqual([]);
    expect(report.exports.map(({ signature, ...rest }) => rest)).toEqual([
      { file: EXTERNAL, name: 'handle', typeOnly: false, line: 1 },
      { file: EXTERNAL, name: 'User', typeOnly: true, line: 2 },
    ]);
    for (const entry of report.exports) expect(entry.signature).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(new Set(report.exports.map((e) => e.signature)).size).toBe(2);
    // At runtime the package resolves from the real path of handle.ts, which is in the origin, where fake-http is
    // installed. The type checker reads handle.ts through the link path and looks in the consumer, which lacks it.
    // Builtins and the file the .external.ts does not reach are left out.
    expect(report.dependencies).toEqual([{ package: 'fake-http', from: `${API}/api/_/handle.ts`, resolved: false, resolvedForTypes: false, resolvedAtRuntime: true }]);

    expect(Object.keys(response.code)).toEqual(['root/b/_/use.ts']);
    expect(response.code['root/b/_/use.ts']!.imports).toEqual([{ kind: 'internal', target: EXTERNAL, names: ['handle', 'User'], line: 1 }]);

    // A change in the origin must reach the consumer's cache key. The compiler loads linked files through the
    // junction, so they are inputs by their path through the link, and the CLI hashes their text.
    expect(response.inputs).toEqual(expect.arrayContaining([EXTERNAL, `${API}/api/_/handle.ts`, `${API}/api/_/user.ts`]));
    expect(response.inputs!.filter((input) => input.startsWith(source.dir) && input.endsWith('.ts'))).toEqual([]);
    // The package the lookup found in the origin is an input too, so reinstalling it changes the key.
    expect(response.inputs).toContain(path.join(source.dir, 'node_modules', 'fake-http', 'package.json'));
  });

  test('a package installed in both projects resolves for a junction, both for types and at runtime', async (context) => {
    const source = origin(true);
    const project = consumer(true);
    if (!linkDir(path.join(source.dir, 'root'), path.join(project.dir, API))) context.skip();
    const response = await run(project, [{ path: API, alias: ORIGIN_ALIAS }]);
    expect(response.links![API]!.dependencies).toEqual([{ package: 'fake-http', from: `${API}/api/_/handle.ts`, resolved: true, resolvedForTypes: true, resolvedAtRuntime: true }]);
    // The consumer's copy of the package is an input too, so removing it changes the key.
    expect(response.inputs).toContain('node_modules/fake-http/package.json');
  });

  test('a package installed only in the consumer does not resolve at runtime for a junction', async (context) => {
    const source = origin(false);
    const project = consumer(true);
    if (!linkDir(path.join(source.dir, 'root'), path.join(project.dir, API))) context.skip();
    const response = await run(project, [{ path: API, alias: ORIGIN_ALIAS }]);
    expect(response.links![API]!.dependencies).toEqual([{ package: 'fake-http', from: `${API}/api/_/handle.ts`, resolved: false, resolvedForTypes: true, resolvedAtRuntime: false }]);
    // Installing it in the origin later must change the inputs: the probed paths are listed although they are missing.
    expect(response.inputs).toContain(path.join(source.dir, 'root', 'api', '_', 'node_modules', 'fake-http', 'package.json'));
    expect(response.inputs).toContain(path.join(source.dir, 'node_modules', 'fake-http', 'package.json'));
  });
});

describe('a copied link', () => {
  test('resolves packages from the consumer and imports through the alias land in the copy', async () => {
    const source = origin(true);
    const bare = consumer(false);
    copyLink(source, bare, API);
    const unresolved = await run(bare, [{ path: API, alias: ORIGIN_ALIAS }]);
    // The origin has fake-http, but a copy lives in the consumer, which does not.
    expect(unresolved.links![API]!.dependencies).toEqual([{ package: 'fake-http', from: `${API}/api/_/handle.ts`, resolved: false, resolvedForTypes: false, resolvedAtRuntime: false }]);
    expect(unresolved.code['root/b/_/use.ts']!.imports).toEqual([{ kind: 'internal', target: EXTERNAL, names: ['handle', 'User'], line: 1 }]);
    expect(unresolved.inputs).toEqual(expect.arrayContaining([EXTERNAL, `${API}/api/_/handle.ts`, `${API}/api/_/user.ts`]));

    const installed = consumer(true);
    copyLink(source, installed, API);
    const resolved = await run(installed, [{ path: API, alias: ORIGIN_ALIAS }]);
    expect(resolved.links![API]!.problems).toEqual([]);
    expect(resolved.links![API]!.dependencies).toEqual([{ package: 'fake-http', from: `${API}/api/_/handle.ts`, resolved: true, resolvedForTypes: true, resolvedAtRuntime: true }]);
  });

  test('signatures are the same for a junction and a copy, wherever the link lives', async (context) => {
    const source = origin(true);
    const junction = consumer(true);
    if (!linkDir(path.join(source.dir, 'root'), path.join(junction.dir, API))) context.skip();
    const elsewhere = 'root/c/_/links/other';
    const copied = consumer(true);
    copyLink(source, copied, elsewhere);
    // A copy outside the default fixture folder, so that no path is shared with the other two.
    const base = makeTempDir(TMP_ROOT, 'far-');
    folders.push(base);
    const far = fixture({ 'root/b/_/use.ts': 'export const x = 1;\n', ...FAKE_HTTP }, { base });
    copyLink(source, far, API);

    const viaJunction = (await run(junction, [{ path: API, alias: ORIGIN_ALIAS }])).links![API]!;
    const viaCopy = (await run(copied, [{ path: elsewhere, alias: ORIGIN_ALIAS }], [])).links![elsewhere]!;
    const viaFar = (await run(far, [{ path: API, alias: ORIGIN_ALIAS }])).links![API]!;
    expect(viaCopy.problems).toEqual([]);
    expect(viaCopy.exports.map((e) => e.file)).toEqual([`${elsewhere}/dmz/api/.external.ts`, `${elsewhere}/dmz/api/.external.ts`]);
    expect(signatures(viaJunction)).toEqual(signatures(viaCopy));
    expect(signatures(viaJunction)).toEqual(signatures(viaFar));
  });
});

describe('link problems', () => {
  test('a broken link is reported without throwing', async (context) => {
    const project = consumer(false);
    // A junction whose target is gone.
    const gone = makeTempDir(TMP_ROOT, 'gone-');
    if (!linkDir(gone, path.join(project.dir, 'root/b/_/links/gone'))) context.skip();
    rmSync(gone, { recursive: true, force: true });
    // A folder without any .external.ts.
    project.write({ 'root/b/_/links/empty/api/_/a.ts': 'export const a = 1;\n' });
    // A copy whose linked file does not parse, and whose .external.ts names a symbol that does not exist.
    project.write({
      'root/b/_/links/bad/dmz/api/.external.ts': `export { handle, missing } from '${ORIGIN_ALIAS}/api/_/handle';\n`,
      'root/b/_/links/bad/api/_/handle.ts': 'export function handle( {\n',
    });
    project.write({ 'root/b/_/links/same/dmz/api/.external.ts': '' });
    const response = await run(project, [
      { path: 'root/b/_/links/nowhere', alias: '@nowhere-aaaaaaaa' },
      { path: 'root/b/_/links/gone', alias: '@gone-aaaaaaaa' },
      { path: 'root/b/_/links/empty', alias: '@empty-aaaaaaaa' },
      { path: 'root/b/_/links/bad', alias: ORIGIN_ALIAS },
      { path: 'root/b/_/links/same', alias: '@root' },
    ]);
    const linksOut = response.links!;
    expect(linksOut['root/b/_/links/nowhere']).toEqual({ exports: [], dependencies: [], problems: [{ message: 'the link folder root/b/_/links/nowhere does not exist' }] });
    expect(linksOut['root/b/_/links/gone']!.problems).toEqual([{ message: 'root/b/_/links/gone points to a folder that does not exist' }]);
    expect(linksOut['root/b/_/links/empty']!.problems).toEqual([{ message: 'root/b/_/links/empty has no .external.ts file in a dmz/ folder, so it publishes nothing' }]);
    expect(linksOut['root/b/_/links/same']!.problems[0]!.message).toMatch(/also this project's alias/);

    const bad = linksOut['root/b/_/links/bad']!;
    expect(bad.problems).toEqual([
      { file: 'root/b/_/links/bad/api/_/handle.ts', line: 2, message: "syntax error: '}' expected." },
      { file: 'root/b/_/links/bad/dmz/api/.external.ts', line: 1, message: `"${ORIGIN_ALIAS}/api/_/handle" does not export "missing"` },
    ]);
    expect(bad.exports.map((e) => e.name)).toEqual(['handle']);
  });

  test('an analysis with links and no files still reports the links', async () => {
    const project = fixture({});
    const response = await analyze(project.dir, { ...project.request([], []), links: [{ path: 'root/b/_/links/x', alias: '@x-aaaaaaaa' }] });
    expect(response.links).toEqual({ 'root/b/_/links/x': { exports: [], dependencies: [], problems: [{ message: 'the link folder root/b/_/links/x does not exist' }] } });
  });
});
