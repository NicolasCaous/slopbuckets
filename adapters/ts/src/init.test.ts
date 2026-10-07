import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { analyze, init, type AnalyzeRequest, type InitRequest } from './index.js';
import { excludeMatches, includeMatches } from './env.js';
import { CONFIG, Fixture } from './test-fixture.js';

const fixtures: Fixture[] = [];
function fixture(...args: ConstructorParameters<typeof Fixture>): Fixture {
  const created = new Fixture(...args);
  fixtures.push(created);
  return created;
}
afterAll(() => {
  for (const created of fixtures) created.remove();
});

const REQUEST: InitRequest = { abi: 1, config: CONFIG };

const RAW_TSCONFIG = `{
  // Nest-style tsconfig with comments
  "compilerOptions": {
    "module": "commonjs",
    "strict": true, /* keep */
    "noUnusedLocals": false,
    "paths": { "@other/*": ["lib/*"] },
  },
}
`;

describe('init', () => {
  test('writes the alias and noUnusedLocals into tsconfig.json, then changes nothing', async () => {
    const project = fixture({ 'tsconfig.json': RAW_TSCONFIG });
    const first = await init(project.dir, REQUEST);
    expect(first).toEqual({ abi: 1, changed: [{ file: 'tsconfig.json', description: 'alias @root/* and noUnusedLocals' }] });

    const tsconfig = project.jsonc('tsconfig.json');
    expect(tsconfig.compilerOptions).toEqual({
      module: 'commonjs',
      strict: true,
      noUnusedLocals: true,
      paths: { '@other/*': ['lib/*'], '@root/*': ['./root/*'] },
    });

    // The file is edited in place: comments, trailing commas and layout stay.
    const written = project.read('tsconfig.json');
    expect(written).toBe(`{
  // Nest-style tsconfig with comments
  "compilerOptions": {
    "module": "commonjs",
    "strict": true, /* keep */
    "noUnusedLocals": true,
    "paths": { "@other/*": ["lib/*"], "@root/*": ["./root/*"] },
  },
}
`);
    expect(await init(project.dir, REQUEST)).toEqual({ abi: 1, changed: [] });
    expect(project.read('tsconfig.json')).toBe(written);

    const analysis = await analyze(project.dir, { abi: 1, config: CONFIG, files: { dmz: [], code: [] } });
    expect(analysis.config).toEqual([]);
  });

  test('reports only what it changed', async () => {
    const project = fixture({ 'tsconfig.json': { compilerOptions: { noUnusedLocals: true } } });
    expect((await init(project.dir, REQUEST)).changed).toEqual([{ file: 'tsconfig.json', description: 'alias @root/*' }]);

    const other = fixture({ 'tsconfig.json': { compilerOptions: { paths: { '@root/*': ['./root/*'] } } } });
    expect((await init(other.dir, REQUEST)).changed).toEqual([{ file: 'tsconfig.json', description: 'noUnusedLocals' }]);
  });

  test('replaces a wrong alias target and writes it relative to baseUrl', async () => {
    const project = fixture({ 'tsconfig.json': { compilerOptions: { baseUrl: './src', noUnusedLocals: true, paths: { '@root/*': ['*'] } } } });
    await init(project.dir, REQUEST);
    expect(project.json('tsconfig.json').compilerOptions.paths).toEqual({ '@root/*': ['../root/*'] });
    expect((await init(project.dir, REQUEST)).changed).toEqual([]);
  });

  test('leaves tsconfig.json alone when an extended config already has the settings', async () => {
    const project = fixture({
      'tsconfig.base.json': { compilerOptions: { noUnusedLocals: true, paths: { '@root/*': ['./root/*'] } } },
      'tsconfig.json': '{ "extends": "./tsconfig.base.json" }\n',
    });
    expect((await init(project.dir, REQUEST)).changed).toEqual([]);
    expect(project.read('tsconfig.json')).toBe('{ "extends": "./tsconfig.base.json" }\n');
  });

  test('sets sourceRoot and entryFile in nest-cli.json', async () => {
    const project = fixture({
      'nest-cli.json': '{\n    "collection": "@nestjs/schematics",\n    "sourceRoot": "src"\n}\n',
    });
    const first = await init(project.dir, REQUEST);
    expect(first.changed).toContainEqual({ file: 'nest-cli.json', description: 'sourceRoot and entryFile' });
    expect(project.json('nest-cli.json')).toEqual({ collection: '@nestjs/schematics', sourceRoot: 'root', entryFile: '_/main' });
    // The original 4-space indentation is kept.
    expect(project.read('nest-cli.json')).toContain('\n    "sourceRoot": "root"');
    expect((await init(project.dir, REQUEST)).changed).toEqual([]);
  });

  test('adds a Jest moduleNameMapper for the alias, relative to Jest rootDir', async () => {
    const project = fixture({
      'package.json': { name: 'app', jest: { rootDir: 'src', moduleNameMapper: { '^x$': 'y' } } },
    });
    const first = await init(project.dir, REQUEST);
    expect(first.changed).toContainEqual({ file: 'package.json', description: 'jest moduleNameMapper for @root' });
    expect(project.json('package.json').jest.moduleNameMapper).toEqual({ '^x$': 'y', '^@root/(.*)$': '<rootDir>/../root/$1' });
    expect((await init(project.dir, REQUEST)).changed).toEqual([]);

    const plain = fixture({ 'package.json': { name: 'app', jest: {} } });
    await init(plain.dir, REQUEST);
    expect(plain.json('package.json').jest.moduleNameMapper).toEqual({ '^@root/(.*)$': '<rootDir>/root/$1' });
  });

  test('does not touch package.json without Jest config, nor create nest-cli.json', async () => {
    const project = fixture({ 'package.json': '{"name":"app"}' });
    const result = await init(project.dir, REQUEST);
    expect(result.changed).toEqual([]);
    expect(project.read('package.json')).toBe('{"name":"app"}');
    expect(existsSync(path.join(project.dir, 'nest-cli.json'))).toBe(false);
  });

  test('uses the alias and root from the request', async () => {
    const project = fixture({ 'tsconfig.json': {}, 'package.json': { name: 'app', jest: {} } });
    await init(project.dir, { abi: 1, config: { root: 'src', alias: '~' } });
    expect(project.json('tsconfig.json').compilerOptions).toEqual({ paths: { '~/*': ['./src/*'] }, noUnusedLocals: true });
    expect(project.json('package.json').jest.moduleNameMapper).toEqual({ '^~/(.*)$': '<rootDir>/src/$1' });
  });

  test('environment errors', async () => {
    const noTsconfig = fixture({}, { tsconfig: false });
    await expect(init(noTsconfig.dir, REQUEST)).rejects.toMatchObject({ name: 'AdapterEnvironmentError', code: 'no-tsconfig' });
    // The message says what to do, also for a nested project, which needs its own tsconfig.json.
    await expect(init(noTsconfig.dir, REQUEST)).rejects.toThrow(/and so does a nested project.* Create a tsconfig\.json in .*, then run `buckets init`/);

    // Outside the repository, so that the repository's typescript cannot be found.
    const base = mkdtempSync(path.join(os.tmpdir(), 'slopbuckets-adapter-'));
    try {
      const outside = new Fixture({}, { base });
      await expect(init(outside.dir, REQUEST)).rejects.toMatchObject({ name: 'AdapterEnvironmentError', code: 'no-typescript' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }

    const broken = fixture({ 'tsconfig.json': '{ "compilerOptions": ' });
    await expect(init(broken.dir, REQUEST)).rejects.toMatchObject({ code: 'adapter-failed' });
  });
  test('copies inherited paths into the child before adding the alias, and keeps inherited noUnusedLocals', async () => {
    const project = fixture({
      'config/tsconfig.base.json': { compilerOptions: { noUnusedLocals: true, paths: { '@lib/*': ['./lib/*'] } } },
      'tsconfig.json': '{\n  // child config\n  "extends": "./config/tsconfig.base.json",\n  "compilerOptions": {\n    "strict": true\n  }\n}\n',
    });
    expect((await init(project.dir, REQUEST)).changed).toEqual([{ file: 'tsconfig.json', description: 'alias @root/*' }]);
    const text = project.read('tsconfig.json');
    expect(text).toContain('// child config');
    expect(text).not.toContain('noUnusedLocals');
    // Without baseUrl, inherited targets resolve from the base config's folder, so they are rewritten from the project folder.
    expect(project.jsonc('tsconfig.json').compilerOptions.paths).toEqual({ '@lib/*': ['./config/lib/*'], '@root/*': ['./root/*'] });
    expect((await init(project.dir, REQUEST)).changed).toEqual([]);
    expect((await analyze(project.dir, { abi: 1, config: CONFIG, files: { dmz: [], code: [] } })).config).toEqual([]);
  });

  test('inherited paths under an inherited baseUrl are copied as they are', async () => {
    const project = fixture({
      'config/tsconfig.base.json': { compilerOptions: { baseUrl: '..', noUnusedLocals: true, paths: { '@lib/*': ['lib/*'] } } },
      'tsconfig.json': { extends: './config/tsconfig.base.json' },
    });
    await init(project.dir, REQUEST);
    expect(project.jsonc('tsconfig.json').compilerOptions.paths).toEqual({ '@lib/*': ['lib/*'], '@root/*': ['root/*'] });
    expect((await init(project.dir, REQUEST)).changed).toEqual([]);
  });

  test('a comment after the last property stays on its line', async () => {
    const project = fixture({ 'tsconfig.json': '{\n  "compilerOptions": {\n    "strict": true // keep me\n  }\n}\n' });
    await init(project.dir, REQUEST);
    expect(project.read('tsconfig.json')).toBe(
      '{\n  "compilerOptions": {\n    "strict": true, // keep me\n    "paths": {\n      "@root/*": ["./root/*"]\n    },\n    "noUnusedLocals": true\n  }\n}\n',
    );
  });

  test('adds compilerOptions to a config that has none, keeping CRLF line endings', async () => {
    const project = fixture({ 'tsconfig.json': '{\r\n  /* empty */\r\n  "extends": "./base.json"\r\n}\r\n', 'base.json': {} });
    await init(project.dir, REQUEST);
    expect(project.read('tsconfig.json')).toBe(
      '{\r\n  /* empty */\r\n  "extends": "./base.json",\r\n  "compilerOptions": {\r\n    "paths": {\r\n      "@root/*": ["./root/*"]\r\n    },\r\n    "noUnusedLocals": true\r\n  }\r\n}\r\n',
    );
  });

  test('does not write when an edit would drop a comment, and says what to add', async () => {
    const original = '{\n  "compilerOptions": {\n    "noUnusedLocals": true,\n    "paths": { "@root/*": ["src/*" /* old */] }\n  }\n}\n';
    const project = fixture({ 'tsconfig.json': original });
    const result = await init(project.dir, REQUEST);
    expect(result.changed).toEqual([{ file: 'tsconfig.json', written: false, description: expect.stringContaining('"paths": { "@root/*": ["./root/*"] }') }]);
    expect(result.changed[0]!.description).toContain('by hand');
    expect(project.read('tsconfig.json')).toBe(original);
  });

  test('keeps a UTF-8 BOM in tsconfig.json and package.json', async () => {
    const project = fixture({
      'tsconfig.json': '﻿{ "compilerOptions": { "noUnusedLocals": true } }\n',
      'package.json': `﻿${JSON.stringify({ name: 'app', jest: {} }, null, 2)}\n`,
    });
    const result = await init(project.dir, REQUEST);
    expect(result.changed.map((c) => c.file)).toEqual(['tsconfig.json', 'package.json']);
    expect(project.read('tsconfig.json')).toBe('﻿{ "compilerOptions": { "noUnusedLocals": true, "paths": { "@root/*": ["./root/*"] } } }\n');
    const manifest = project.read('package.json');
    expect(manifest.charCodeAt(0)).toBe(0xfeff);
    expect(JSON.parse(manifest.slice(1)).jest.moduleNameMapper).toEqual({ '^@root/(.*)$': '<rootDir>/root/$1' });
    expect((await init(project.dir, REQUEST)).changed).toEqual([]);
  });
});

describe('solution-style tsconfig.json', () => {
  const SOLUTION = { files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }] };
  const NODE = { compilerOptions: { strict: true }, include: ['vite.config.ts'] };
  const EMPTY: AnalyzeRequest = { abi: 1, config: CONFIG, files: { dmz: [], code: [] } };

  test('edits the referenced config whose include covers the root folder, and analyzes with it', async () => {
    const project = fixture(
      { 'tsconfig.json': SOLUTION, 'tsconfig.node.json': NODE, 'tsconfig.app.json': { compilerOptions: { strict: true }, include: ['root'] } },
      { tsconfig: false },
    );
    const solution = project.read('tsconfig.json');
    expect(await init(project.dir, REQUEST)).toEqual({ abi: 1, changed: [{ file: 'tsconfig.app.json', description: 'alias @root/* and noUnusedLocals' }] });
    expect(project.read('tsconfig.json')).toBe(solution);
    expect(project.json('tsconfig.app.json').compilerOptions).toEqual({ strict: true, paths: { '@root/*': ['./root/*'] }, noUnusedLocals: true });
    expect(project.json('tsconfig.node.json')).toEqual(NODE);
    expect(await init(project.dir, REQUEST)).toEqual({ abi: 1, changed: [] });
    expect((await analyze(project.dir, EMPTY)).config).toEqual([]);
  });

  test('a config that is referenced as a folder and covers the root folder with a wildcard counts', async () => {
    const project = fixture(
      {
        'tsconfig.json': { references: [{ path: './tsconfig.node.json' }, { path: './app' }] },
        'tsconfig.node.json': NODE,
        'app/tsconfig.json': { compilerOptions: { strict: true }, include: ['../root/**/*.ts'] },
      },
      { tsconfig: false },
    );
    expect(await init(project.dir, REQUEST)).toEqual({ abi: 1, changed: [{ file: 'app/tsconfig.json', description: 'alias @root/* and noUnusedLocals' }] });
    // Without baseUrl, paths resolve from the folder of the config that declares them.
    expect(project.json('app/tsconfig.json').compilerOptions.paths).toEqual({ '@root/*': ['../root/*'] });
    expect((await analyze(project.dir, EMPTY)).config).toEqual([]);
  });

  test('falls back to the app config when no reference covers the root folder yet, and says so', async () => {
    const project = fixture(
      { 'tsconfig.json': SOLUTION, 'tsconfig.node.json': NODE, 'tsconfig.app.json': { compilerOptions: { strict: true }, include: ['src'] } },
      { tsconfig: false },
    );
    const result = await init(project.dir, REQUEST);
    expect(result.changed).toEqual([
      { file: 'tsconfig.app.json', description: 'alias @root/* and noUnusedLocals; its "include" does not cover root/ yet, so add root/ to it' },
    ]);
    expect(project.json('tsconfig.app.json').compilerOptions.noUnusedLocals).toBe(true);
  });

  test('writes nothing and names the files to edit when no reference fits', async () => {
    const project = fixture(
      {
        'tsconfig.json': { files: [], references: [{ path: './tsconfig.node.json' }, { path: './tsconfig.lib.json' }] },
        'tsconfig.node.json': NODE,
        'tsconfig.lib.json': { compilerOptions: { strict: true }, include: ['lib'] },
      },
      { tsconfig: false },
    );
    const before = ['tsconfig.json', 'tsconfig.node.json', 'tsconfig.lib.json'].map((f) => project.read(f));
    const result = await init(project.dir, REQUEST);
    expect(result.changed).toEqual([{ file: 'tsconfig.json', written: false, description: expect.stringContaining('not changed, because tsconfig.json is a solution-style config') }]);
    expect(result.changed[0]!.description).toContain('"tsconfig.node.json", "tsconfig.lib.json"');
    expect(['tsconfig.json', 'tsconfig.node.json', 'tsconfig.lib.json'].map((f) => project.read(f))).toEqual(before);
    const config = (await analyze(project.dir, EMPTY)).config;
    expect(config).toEqual([{ file: 'tsconfig.json', message: expect.stringContaining('solution-style config') }]);
  });

  test('a tsconfig.json with include or files of its own is not solution-style', async () => {
    const project = fixture(
      { 'tsconfig.json': { include: ['root'], references: [{ path: './tsconfig.node.json' }] }, 'tsconfig.node.json': NODE },
      { tsconfig: false },
    );
    expect((await init(project.dir, REQUEST)).changed).toEqual([{ file: 'tsconfig.json', description: 'alias @root/* and noUnusedLocals' }]);
  });
});

describe('nested projects', () => {
  const NESTED: InitRequest = { ...REQUEST, nestedProjects: ['root/log/_/engine'] };
  const OPTIONS = { strict: true, noUnusedLocals: true, paths: { '@root/*': ['./root/*'] } };

  test('appends a nested project to "exclude" in place, keeping comments, then changes nothing', async () => {
    const text = `{
  // app settings
  "compilerOptions": ${JSON.stringify(OPTIONS)},
  "include": ["root"],
  "exclude": [
    "dist" // build output
  ]
}
`;
    const project = fixture({ 'tsconfig.json': text });
    expect((await init(project.dir, NESTED)).changed).toEqual([{ file: 'tsconfig.json', description: 'exclude root/log/_/engine (nested project)' }]);
    expect(project.read('tsconfig.json')).toBe(text.replace('"dist" // build output', '"dist", // build output\n    "root/log/_/engine"'));
    expect((await init(project.dir, NESTED)).changed).toEqual([]);
    const response = await analyze(project.dir, { ...project.request([], []), nestedProjects: ['root/log/_/engine'] });
    expect(response.config).toEqual([]);
  });

  test('adds "exclude" with the entries inherited through extends', async () => {
    const project = fixture({
      'tsconfig.json': { extends: './tsconfig.base.json', compilerOptions: OPTIONS },
      'tsconfig.base.json': { include: ['root'], exclude: ['dist'] },
    });
    expect((await init(project.dir, NESTED)).changed).toEqual([{ file: 'tsconfig.json', description: 'exclude root/log/_/engine (nested project)' }]);
    expect(project.jsonc('tsconfig.json').exclude).toEqual(['dist', 'root/log/_/engine']);
  });

  test('leaves alone a nested project that "include" does not reach', async () => {
    const project = fixture({ 'tsconfig.json': { compilerOptions: OPTIONS, include: ['root/_', 'root/log/_/*.ts'] } });
    expect((await init(project.dir, NESTED)).changed).toEqual([]);
  });

  test('does not write when the edit could lose a comment, and prints the exact line to add', async () => {
    const text = `{ "compilerOptions": ${JSON.stringify(OPTIONS)}, "exclude": [ /* none yet */ ] }\n`;
    const project = fixture({ 'tsconfig.json': text });
    const [change] = (await init(project.dir, NESTED)).changed;
    expect(change!.description).toContain('add this line to the "exclude" array of tsconfig.json: "root/log/_/engine"');
    expect(project.read('tsconfig.json')).toBe(text);
  });

  test('says what to change when the root folder is outside the build, without editing it', async () => {
    const project = fixture({ 'tsconfig.json': { compilerOptions: OPTIONS, include: ['src'] } });
    const before = project.read('tsconfig.json');
    expect((await init(project.dir, REQUEST)).changed).toEqual([
      { file: 'tsconfig.json', written: false, description: expect.stringContaining('no change written, but the effective "include" and "files" of tsconfig.json (after "extends") do not reach root/') },
    ]);
    expect(project.read('tsconfig.json')).toBe(before);
  });
});

describe('excludeMatches', () => {
  const base = path.resolve('/project');
  const probe = `${base.split(path.sep).join('/')}/root/log/_/engine/index.ts`;
  test.each([
    ['root', true],
    ['root/log/_/engine', true],
    ['root/log/_/engine/**', true],
    ['root/**/engine', true],
    ['**/engine', true],
    ['root/*/_/engine', true],
    ['root/log/_/engine/index.ts', true],
    ['root/log/_/eng', false],
    ['root/log/_/engine2', false],
    ['root/*/engine', false],
    ['**/*.spec.ts', false],
  ])('%s excludes root/log/_/engine/index.ts: %s', (spec, expected) => {
    expect(excludeMatches(spec, base, probe, true)).toBe(expected);
  });
});

describe('includeMatches', () => {
  const base = path.resolve('/project');
  const probe = `${base.split(path.sep).join('/')}/root/a/_/index.ts`;
  test.each([
    ['root', true],
    ['root/**/*', true],
    ['root/**/*.ts', true],
    ['**/*', true],
    ['root/*', false],
    ['root/**/*.tsx', false],
    ['src', false],
    ['root/a/_/index.ts', true],
    ['./root/?/_/*.ts', true],
  ])('%s matches root/a/_/index.ts: %s', (spec, expected) => {
    expect(includeMatches(spec, base, probe, true)).toBe(expected);
  });
});
