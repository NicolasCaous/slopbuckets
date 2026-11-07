import { mkdirSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTypeScript } from './env.js';
import { analyze, emptyState, info, resolveImports, type AdapterState } from './index.js';
import { Fixture } from './test-fixture.js';
import { OUTSIDE_BASE, runFolder } from './test-support.js';

const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.remove();
});
function fixture(files: Record<string, string | object>, options?: ConstructorParameters<typeof Fixture>[1]): Fixture {
  const f = new Fixture(files, options);
  fixtures.push(f);
  return f;
}

const FILES = ['root/a.ts', 'src/app.ts', 'src/lib/index.ts', 'src/lib/util.ts', 'src/mod.mts', 'src/old.js']; // sorted, as the CLI passes it

function resolve(dir: string, from: string, specifier: string, state: AdapterState = emptyState(), files: string[] = FILES) {
  const r = resolveImports(dir, [{ from, specifier, kind: 'static' }], { fileList: files, state });
  if ('error' in r) throw new Error(r.error.message);
  return r.targets[0];
}

describe('resolution', () => {
  it('resolves relative imports against the file list, as TypeScript completes them', () => {
    const f = fixture({});
    expect(resolve(f.dir, 'src/app.ts', './lib/util.js')).toEqual({ file: 'src/lib/util.ts' });
    expect(resolve(f.dir, 'src/app.ts', './lib')).toEqual({ file: 'src/lib/index.ts' });
    expect(resolve(f.dir, 'src/lib/util.ts', '.')).toEqual({ file: 'src/lib/index.ts' });
    expect(resolve(f.dir, 'src/lib/util.ts', '../old')).toEqual({ file: 'src/old.js' });
    expect(resolve(f.dir, 'src/app.ts', './mod.mjs')).toEqual({ file: 'src/mod.mts' });
    expect(resolve(f.dir, 'src/app.ts', './missing')).toEqual({ unresolved: 'relative' });
    expect(resolve(f.dir, 'src/app.ts', '../../outside')).toEqual({ unresolved: 'relative' });
  });

  it('applies tsconfig paths and baseUrl, and names packages and built-ins', () => {
    const f = fixture({ 'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@root/*': ['./root/*'] } } } });
    expect(resolve(f.dir, 'src/app.ts', '@root/a')).toEqual({ file: 'root/a.ts' });
    expect(resolve(f.dir, 'src/app.ts', 'src/lib/util')).toEqual({ file: 'src/lib/util.ts' });
    expect(resolve(f.dir, 'src/app.ts', 'node:fs')).toEqual({ builtin: 'node:fs' });
    expect(resolve(f.dir, 'src/app.ts', 'path')).toEqual({ builtin: 'path' });
    expect(resolve(f.dir, 'src/app.ts', '@scope/pkg/sub')).toEqual({ package: '@scope/pkg' });
    expect(resolve(f.dir, 'src/app.ts', 'axios')).toEqual({ package: 'axios' });
  });

  it('keeps the settings in the state and reads them again when the tsconfig changes', () => {
    const f = fixture({});
    const state = emptyState();
    expect(resolve(f.dir, 'src/app.ts', '@root/a', state)).toEqual({ file: 'root/a.ts' });
    expect(state.inputs.map((i) => i.path).filter((p) => !p.includes('node_modules/'))).toEqual(['package.json', 'pnpm-workspace.yaml', 'tsconfig.json']);
    f.write({ 'tsconfig.json': { compilerOptions: { paths: { '@root/*': ['./src/lib/*'] } } } });
    expect(resolve(f.dir, 'src/app.ts', '@root/util', state, [...FILES])).toEqual({ file: 'src/lib/util.ts' });
  });

  it('resolves a #imports specifier again once its target file exists', () => {
    const f = fixture({ 'package.json': { name: 'p', type: 'module', imports: { '#x': './src/x.ts' } }, 'tsconfig.json': { compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', allowImportingTsExtensions: true, noEmit: true } } });
    const state = emptyState();
    expect(resolve(f.dir, 'src/app.ts', '#x', state)).toEqual({ unresolved: 'other' });
    expect(resolve(f.dir, 'src/app.ts', '#x', state, [...FILES, 'src/x.ts'].sort())).toEqual({ file: 'src/x.ts' });
  });

  it('reports a missing tsconfig.json as no-tsconfig', () => {
    const f = fixture({}, { tsconfig: false });
    expect(resolveImports(f.dir, [{ from: 'a.ts', specifier: './b', kind: 'static' }], { fileList: [], state: emptyState() })).toMatchObject({ error: { code: 'no-tsconfig' } });
  });

  it('resolves each file with its nearest tsconfig.json, and a project of nested tsconfigs needs none at the root', () => {
    const files = ['apps/api/src/db.ts', 'apps/api/src/main.ts', 'apps/web/src/main.ts', 'apps/web/src/ui.ts', 'tools/x.ts'];
    const alias = { compilerOptions: { paths: { '~/*': ['./src/*'] } } };
    const f = fixture({ 'apps/web/tsconfig.json': alias, 'apps/api/tsconfig.json': alias }, { tsconfig: false });
    const state = emptyState();
    const at = (from: string, spec: string) => {
      const r = resolveImports(f.dir, [{ from, specifier: spec, kind: 'static' }], { fileList: files, state, tsconfigs: ['apps/api', 'apps/web'] });
      if ('error' in r) throw new Error(r.error.message);
      return r.targets[0];
    };
    expect(at('apps/web/src/main.ts', '~/ui')).toEqual({ file: 'apps/web/src/ui.ts' });
    expect(at('apps/api/src/main.ts', '~/db')).toEqual({ file: 'apps/api/src/db.ts' });
    expect(at('apps/api/src/main.ts', '~/ui')).toEqual({ unresolved: 'paths', pattern: '~/*' });
    // a file with no tsconfig above it takes the defaults
    expect(at('tools/x.ts', '~/ui')).toEqual({ package: '~' });
    expect(state.inputs.map((i) => i.path)).toEqual(expect.arrayContaining(['apps/api/tsconfig.json', 'apps/web/tsconfig.json']));
  });

  it('names what an unresolved specifier was, and leaves a file the listing skips as other', () => {
    const f = fixture({ 'src/generated.ts': 'export {};\n' });
    expect(resolve(f.dir, 'src/app.ts', './generated')).toEqual({ unresolved: 'other' });
    expect(resolve(f.dir, 'src/app.ts', './nothing')).toEqual({ unresolved: 'relative' });
    expect(resolve(f.dir, 'src/app.ts', '@root/nothing')).toEqual({ unresolved: 'paths', pattern: '@root/*' });
    expect(resolve(f.dir, 'src/app.ts', 'not-installed')).toEqual({ package: 'not-installed' });
  });

  it('looks at the disk again for unlisted files at each call, and for folders that do not exist yet', () => {
    const f = fixture({ 'src/Upper.ts': 'export {};\n' });
    // One state and one file list: the second call reuses the resolver of the first.
    const state = emptyState();
    expect(resolve(f.dir, 'src/app.ts', './gen/out', state)).toEqual({ unresolved: 'relative' });
    expect(resolve(f.dir, 'src/app.ts', './later', state)).toEqual({ unresolved: 'relative' });
    f.write({ 'src/gen/out.ts': 'export {};\n', 'src/later/index.ts': 'export {};\n' });
    expect(resolve(f.dir, 'src/app.ts', './gen/out', state)).toEqual({ unresolved: 'other' });
    expect(resolve(f.dir, 'src/app.ts', './later', state)).toEqual({ unresolved: 'other' });
    // The disk decides the case, as statSync does.
    expect(resolve(f.dir, 'src/app.ts', './upper', state)).toEqual({ unresolved: process.platform === 'linux' ? 'relative' : 'other' });
  });

  it('reports a baseUrl path whose first segment is a project folder as paths, not as a package', () => {
    const f = fixture({ 'tsconfig.json': { compilerOptions: { baseUrl: '.' } }, 'src/lib/util.ts': '', 'node_modules/lodash/package.json': '{}' });
    expect(resolve(f.dir, 'src/app.ts', 'src/lib/util')).toEqual({ file: 'src/lib/util.ts' });
    expect(resolve(f.dir, 'src/app.ts', 'src/promotions/index')).toEqual({ unresolved: 'paths' });
    // a folder of the project that is also an installed package stays a package, as TypeScript falls back to node_modules
    f.write({ 'lodash/x.ts': '' });
    expect(resolve(f.dir, 'src/app.ts', 'lodash/fp')).toEqual({ package: 'lodash' });
    expect(resolve(f.dir, 'src/app.ts', 'axios/lib')).toEqual({ package: 'axios' });
  });

  it('leaves an import of an existing asset as other, with or without a bundler query', () => {
    const f = fixture({ 'src/a.css': '', 'src/b.module.css': '', 'src/c.json': '{}', 'src/logo.svg': '', 'root/x.css': '' });
    for (const spec of ['./a.css', './b.module.css', './c.json', './logo.svg', './logo.svg?url', './a.css?raw', '@root/x.css', '@root/x.css?inline']) {
      expect(resolve(f.dir, 'src/app.ts', spec), spec).toEqual({ unresolved: 'other' });
    }
    expect(resolve(f.dir, 'src/app.ts', './gone.css')).toEqual({ unresolved: 'relative' });
    expect(resolve(f.dir, 'src/app.ts', './gone.svg?url')).toEqual({ unresolved: 'relative' });
    expect(resolve(f.dir, 'src/app.ts', '@root/gone.css')).toEqual({ unresolved: 'paths', pattern: '@root/*' });
  });

  it('resolves a bundler query to the file before it, and leaves an asset on disk as other', () => {
    const f = fixture({ 'src/app.css': 'body {}\n' });
    expect(resolve(f.dir, 'src/app.ts', './old.js?raw')).toEqual({ file: 'src/old.js' });
    expect(resolve(f.dir, 'src/app.ts', './app.css')).toEqual({ unresolved: 'other' });
    expect(resolve(f.dir, 'src/app.ts', './gone.css')).toEqual({ unresolved: 'relative' });
  });

  it('reports a workspace package that resolves to no project file, until an install links it', () => {
    const f = fixture({
      'package.json': { name: 'mono', private: true, workspaces: ['packages/*'] },
      'packages/ui/package.json': { name: '@acme/ui', exports: { '.': './src/index.ts' } },
      'packages/ui/src/index.ts': 'export const ui = 1;\n',
      'packages/dist/package.json': { name: '@acme/dist', main: './dist/index.js' },
      'packages/dist/dist/index.js': 'exports.d = 1;\n',
    });
    // dist/ is a build output: git ignores it, so the listing leaves it out
    const files = ['packages/ui/src/index.ts', 'src/app.ts'];
    const state = emptyState();
    expect(resolve(f.dir, 'src/app.ts', '@acme/ui', state, files)).toEqual({ unresolved: 'workspace' });
    const before = JSON.stringify(state.inputs);
    // what npm install does for a workspace: a link per package, and its marker file
    f.write({ 'node_modules/.package-lock.json': '{}\n' });
    mkdirSync(path.join(f.dir, 'node_modules', '@acme'), { recursive: true });
    symlinkSync(path.join(f.dir, 'packages', 'ui'), path.join(f.dir, 'node_modules', '@acme', 'ui'), 'junction');
    symlinkSync(path.join(f.dir, 'packages', 'dist'), path.join(f.dir, 'node_modules', '@acme', 'dist'), 'junction');
    expect(resolve(f.dir, 'src/app.ts', '@acme/ui', state, [...files])).toEqual({ file: 'packages/ui/src/index.ts' });
    expect(JSON.stringify(state.inputs)).not.toBe(before);
    expect(resolve(f.dir, 'src/app.ts', '@acme/dist', state, [...files])).toEqual({ unresolved: 'workspace' });
  });

  it('resolves a linked workspace package of a project opened through a link or a short path', () => {
    const f = fixture({
      'package.json': { name: 'mono', private: true, workspaces: ['packages/*'] },
      'packages/ui/package.json': { name: '@acme/ui', exports: { '.': './src/index.ts' } },
      'packages/ui/src/index.ts': 'export const ui = 1;\n',
    });
    mkdirSync(path.join(f.dir, 'node_modules', '@acme'), { recursive: true });
    symlinkSync(path.join(f.dir, 'packages', 'ui'), path.join(f.dir, 'node_modules', '@acme', 'ui'), 'junction');
    // TypeScript answers with the real path, as with C:\Users\RUNNER~1 on the GitHub Windows runner
    const alias = path.join(f.dir, 'alias');
    symlinkSync(f.dir, alias, 'junction');
    const files = ['packages/ui/src/index.ts', 'src/app.ts'];
    expect(resolve(alias, 'src/app.ts', '@acme/ui', emptyState(), files)).toEqual({ file: 'packages/ui/src/index.ts' });
  });
});

describe('which typescript', () => {
  const realTs = createRequire(import.meta.url).resolve('typescript');
  const inputPaths = (state: AdapterState) => state.inputs.map((i) => i.path);
  const tsPackage = (dir: string) => path.join(dir, 'node_modules', 'typescript', 'package.json').split(path.sep).join('/');

  it('falls back to its own typescript for TypeScript 4, even with the JavaScript API', () => {
    const f = fixture({
      'node_modules/typescript/package.json': { name: 'typescript', version: '4.9.5', main: 'index.js' },
      'node_modules/typescript/index.js': `module.exports = { ...require(${JSON.stringify(realTs)}), version: '4.9.5' };\n`,
    });
    const { ts, files } = loadTypeScript(f.dir);
    expect(ts.version).not.toBe('4.9.5');
    expect(files).toHaveLength(2);
  });

  it('uses the typescript of the project when it has the JavaScript API', () => {
    const f = fixture({
      'node_modules/typescript/package.json': { name: 'typescript', version: '5.0.0-own', main: 'index.js' },
      'node_modules/typescript/index.js': `module.exports = { ...require(${JSON.stringify(realTs)}), version: '5.0.0-own' };\n`,
    });
    expect(loadTypeScript(f.dir)).toEqual({ ts: expect.objectContaining({ version: '5.0.0-own' }), files: [path.join(f.dir, 'node_modules', 'typescript', 'package.json')] });
    const state = emptyState();
    expect(resolve(f.dir, 'src/app.ts', '@root/a', state)).toEqual({ file: 'root/a.ts' });
    expect(inputPaths(state)).toContain(tsPackage(f.dir));
  });

  it('falls back to its own typescript for TypeScript 7, which has no JavaScript API', () => {
    const f = fixture({
      'node_modules/typescript/package.json': { name: 'typescript', version: '7.0.2', main: 'index.js' },
      'node_modules/typescript/index.js': "module.exports = { version: '7.0.2' };\n",
    });
    const { ts, files } = loadTypeScript(f.dir);
    expect(typeof ts.resolveModuleName).toBe('function');
    expect(files).toEqual([path.join(f.dir, 'node_modules', 'typescript', 'package.json'), path.join(path.dirname(realTs), '..', 'package.json')]);
    const state = emptyState();
    expect(resolve(f.dir, 'src/app.ts', '@root/a', state)).toEqual({ file: 'root/a.ts' });
    // Replacing TypeScript 7 changes the hash of its package.json, so the settings are read again.
    const before = JSON.stringify(state.inputs);
    f.write({ 'node_modules/typescript/package.json': { name: 'typescript', version: '7.0.3', main: 'index.js' } });
    resolve(f.dir, 'src/app.ts', '@root/a', state, [...FILES]);
    expect(JSON.stringify(state.inputs)).not.toBe(before);
  });

  it('falls back to its own typescript for a project without one', () => {
    // Outside the repository, so the repository's typescript does not resolve from the project.
    const f = fixture({}, { base: runFolder(OUTSIDE_BASE) });
    expect(loadTypeScript(f.dir).files[0]).toBe(path.join(f.dir, 'node_modules', 'typescript', 'package.json'));
    const state = emptyState();
    expect(resolve(f.dir, 'src/app.ts', '@root/a', state)).toEqual({ file: 'root/a.ts' });
    expect(inputPaths(state)).toContain(tsPackage(f.dir));
  });
});

describe('analyze', () => {
  it('speaks ABI 2', () => {
    expect(info()).toMatchObject({ abi: 2, name: 'ts' });
    const f = fixture({});
    expect(analyze(f.dir, { abi: 1 as 2, files: [] })).toMatchObject({ error: { code: 'adapter-failed' } });
  });

  it('scans files from disk or from contents, resolves them, and adds exports for public files', () => {
    const f = fixture({ 'src/lib/util.ts': 'export const u = 1;\n', 'src/lib/index.ts': "export { u } from './util';\n" });
    const r = analyze(f.dir, { abi: 2, files: ['src/lib/index.ts', 'src/app.ts', 'src/gone.ts'], publicFiles: ['src/lib/index.ts'], contents: { 'src/app.ts': "import { u } from './lib';\nconst m = (n: string) => import(n);\n" } }, { fileList: FILES });
    if ('error' in r) throw new Error(r.error.message);
    expect(Object.keys(r.files)).toEqual(['src/lib/index.ts', 'src/app.ts']);
    expect(r.files['src/app.ts']!.imports).toEqual([
      { specifier: './lib', line: 1, kind: 'static', literal: true, reexport: false, names: [{ name: 'u', typeOnly: false }], target: { file: 'src/lib/index.ts' } },
      { specifier: 'n', line: 2, kind: 'dynamic', literal: false, reexport: false, names: '*', target: { unresolved: 'other' } },
    ]);
    expect(r.files['src/lib/index.ts']!.exports).toEqual({
      names: [{ name: 'u', line: 1, typeOnly: false }],
      reexports: [{ line: 1, specifier: './util', target: { file: 'src/lib/util.ts' }, names: [{ name: 'u', as: 'u', typeOnly: false }] }],
      stars: [],
      codeLines: [],
    });
    expect(r.inputs.map((i) => i.path).filter((p) => !p.includes('node_modules/'))).toEqual(['package.json', 'pnpm-workspace.yaml']);
  });
});
