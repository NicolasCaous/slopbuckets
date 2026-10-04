// Source links with the real TypeScript adapter, end to end: `buckets link add` in both modes, the check and the lock
// on the result, and the consumer's code compiled with the TypeScript API and run, so a published value function
// of the origin actually executes through the alias mapped to the link.
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as TS from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultContext } from '../api.js';
import { linkCommand } from '../commands/link.js';
import { cleanupProjects, makeProject, readFile, writeFile } from '../testing/fixture.js';
import { fakeIo } from '../testing/harness.js';
import { runCheck } from './check.js';
import { linkState, removeLinkFolder } from './links.js';
import { writeLockFile } from './lock.js';

afterEach(cleanupProjects);

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof TS;

const TSCONFIG = (alias: string): string =>
  `${JSON.stringify({ compilerOptions: { strict: true, noUnusedLocals: true, skipLibCheck: true, types: [], target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', paths: { [`${alias}/*`]: ['./root/*'] } }, include: ['root'] }, null, 2)}\n`;

/** The origin: `greet` is published through root/dmz/greeter/.external.ts and calls an internal helper. */
function origin(): string {
  return makeProject(
    {
      'buckets.config.json': '{ "root": "root", "alias": "@api-k3x9pm2a" }\n',
      'package.json': '{ "name": "api" }\n',
      'tsconfig.json': TSCONFIG('@api-k3x9pm2a'),
      'root/_/main.ts': "import { greet } from '@api-k3x9pm2a/dmz/greeter/.self';\nexport const hello = greet('origin');\n",
      'root/dmz/greeter/.self.ts': "export { greet } from '@api-k3x9pm2a/greeter/_/greet';\n",
      'root/dmz/greeter/.external.ts': "export { greet } from '@api-k3x9pm2a/greeter/_/greet';\nexport type { Greeting } from '@api-k3x9pm2a/greeter/_/greet';\n",
      'root/greeter/_/greet.ts':
        "import { shout } from '@api-k3x9pm2a/greeter/_/shout';\n\nexport interface Greeting {\n  text: string;\n}\n\nexport function greet(name: string): Greeting {\n  return { text: shout(`hello ${name}`) };\n}\n",
      'root/greeter/_/shout.ts': 'export function shout(text: string): string {\n  return `${text}!`;\n}\n',
      'root/greeter/_/private.ts': 'export const secret = 42;\n',
    },
    false,
  );
}

function consumer(): string {
  return makeProject(
    {
      'buckets.config.json': '{ "root": "root", "alias": "@web-m4qz7tbc" }\n',
      'package.json': '{ "name": "web" }\n',
      'tsconfig.json': TSCONFIG('@web-m4qz7tbc'),
      'root/_/main.ts': 'export const main = 1;\n',
      'root/web/_/app.ts':
        "import { greet, type Greeting } from '@api-k3x9pm2a/dmz/greeter/.external';\n\nexport function welcome(name: string): string {\n  const greeting: Greeting = greet(name);\n  return greeting.text;\n}\n",
    },
    false,
  );
}

/**
 * Compiles the consumer with its tsconfig.json (CommonJS output kept in memory) and loads `entry`, resolving every
 * import with TypeScript's own module resolution, so the alias goes through the `paths` entry to the link.
 */
function compileAndLoad(projectDir: string, entry: string): { diagnostics: string[]; exports: Record<string, unknown> } {
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(projectDir, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  if (parsed === undefined) throw new Error('cannot read tsconfig.json');
  const options: TS.CompilerOptions = { ...parsed.options, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, noEmit: false, outDir: undefined, declaration: false };
  const program = ts.createProgram(parsed.fileNames, options);
  const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  const outputs = new Map<string, string>();
  program.emit(undefined, (fileName, text) => outputs.set(path.resolve(fileName), text));
  const loaded = new Map<string, Record<string, unknown>>();
  const load = (source: string): Record<string, unknown> => {
    const key = path.resolve(source);
    const cached = loaded.get(key);
    if (cached !== undefined) return cached;
    const js = outputs.get(key.replace(/\.tsx?$/, '.js'));
    if (js === undefined) throw new Error(`no output for ${source}`);
    const module = { exports: {} as Record<string, unknown> };
    loaded.set(key, module.exports);
    const requireFrom = (spec: string): unknown => {
      const resolved = ts.resolveModuleName(spec, source, options, ts.sys).resolvedModule;
      if (resolved === undefined) return require(spec);
      return load(resolved.resolvedFileName);
    };
    new Function('require', 'module', 'exports', js)(requireFrom, module, module.exports);
    return module.exports;
  };
  return { diagnostics, exports: load(path.join(projectDir, entry)) };
}

async function setup(mode: 'link' | 'copy'): Promise<{ web: string; api: string; mode: string }> {
  const api = origin();
  const web = consumer();
  const io = fakeIo({ cwd: path.join(web, 'root/web/_') });
  const code = await linkCommand(defaultContext(), io, ['add', 'api', path.relative(path.join(web, 'root/web/_'), api), ...(mode === 'copy' ? ['--copy'] : [])]);
  expect(code, io.err).toBe(0);
  expect(JSON.parse(readFile(web, 'tsconfig.json')).compilerOptions.paths).toEqual({ '@web-m4qz7tbc/*': ['./root/*'], '@api-k3x9pm2a/*': ['./root/web/_/links/api/*'] });
  return { web, api, mode: linkState(path.join(web, 'root/web/_/links/api')) };
}

async function approveReal(dir: string): Promise<void> {
  const result = await runCheck(defaultContext(), dir, { ignoreVersions: true });
  expect(result.report.violations).toEqual([]);
  await writeLockFile(dir, result.lock!);
}

describe('source links with the real adapter', () => {
  it('a copy runs the published value function of the origin in the consumer', async () => {
    const { web } = await setup('copy');
    expect(readFile(web, 'root/web/_/links/api/greeter/_/shout.ts')).toContain('shout');
    let { report } = await runCheck(defaultContext(), web);
    expect(report.violations).toEqual([]);
    await approveReal(web);
    const lock = JSON.parse(readFile(web, 'buckets.lock.json')) as { links: Record<string, { alias: string; symbols: Record<string, Record<string, string>> }> };
    expect(lock.links['root/web/_/links/api']!.alias).toBe('@api-k3x9pm2a');
    expect(Object.keys(lock.links['root/web/_/links/api']!.symbols['dmz/greeter/.external.ts']!).sort()).toEqual(['Greeting', 'greet']);
    ({ report } = await runCheck(defaultContext(), web));
    expect(report.exitCode).toBe(0);

    const { diagnostics, exports } = compileAndLoad(web, 'root/web/_/app.ts');
    expect(diagnostics).toEqual([]);
    expect((exports.welcome as (name: string) => string)('web')).toBe('hello web!');
  });

  it('a junction follows internal changes of the origin without approval, and asks for one when a published signature changes', async (ctx) => {
    const { web, api, mode } = await setup('link');
    if (mode !== 'link') return ctx.skip();
    await approveReal(web);
    expect((await runCheck(defaultContext(), web)).report.exitCode).toBe(0);
    expect((compileAndLoad(web, 'root/web/_/app.ts').exports.welcome as (name: string) => string)('web')).toBe('hello web!');

    // An internal change: the consumer runs the new code at once, and nothing needs approval.
    writeFile(api, 'root/greeter/_/shout.ts', 'export function shout(text: string): string {\n  return `${text.toUpperCase()}!`;\n}\n');
    let { report } = await runCheck(defaultContext(), web);
    expect(report.exitCode).toBe(0);
    expect(report.lockChanges).toEqual([]);
    expect((compileAndLoad(web, 'root/web/_/app.ts').exports.welcome as (name: string) => string)('web')).toBe('HELLO WEB!');

    // A published signature changes: the consumer's human approves it.
    writeFile(api, 'root/greeter/_/greet.ts', readFile(api, 'root/greeter/_/greet.ts').replace('export interface Greeting {\n  text: string;\n}', 'export interface Greeting {\n  text: string;\n  loud: boolean;\n}').replace('return { text:', 'return { loud: true, text:'));
    ({ report } = await runCheck(defaultContext(), web));
    expect(report.lockChanges.map((c) => `${c.kind} ${c.symbol}`)).toContain('link-changed Greeting');
    expect(report.exitCode).toBe(2);
  });

  it('refuses an import of a file the origin does not publish', async () => {
    const { web } = await setup('copy');
    writeFile(web, 'root/web/_/app.ts', "import { shout } from '@api-k3x9pm2a/greeter/_/shout';\n\nexport const loud = shout('x');\n");
    const { report } = await runCheck(defaultContext(), web);
    expect(report.violations.map((v) => `${v.rule} ${v.file}`)).toEqual(['link-forbidden-import root/web/_/app.ts']);
  });

  it('reports a package that a linked file imports and that does not resolve where the file lives', async (ctx) => {
    const { web, api, mode } = await setup('link');
    if (mode !== 'link') return ctx.skip();
    writeFile(api, 'root/greeter/_/shout.ts', "import pad from 'slopbuckets-test-missing-package';\n\nexport function shout(text: string): string {\n  return `${pad}${text}!`;\n}\n");
    const { report } = await runCheck(defaultContext(), web);
    const missing = report.violations.filter((v) => v.rule === 'link-missing-dependency');
    expect(missing.map((v) => v.file)).toEqual(['root/web/_/links/api/greeter/_/shout.ts']);
    expect(missing[0]!.message).toContain('npm install');
    removeLinkFolder(path.join(web, 'root/web/_/links/api'));
  });
});
