import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { linkCommand } from '../commands/link.js';
import { canLink, cleanupProjects, fileExists, makeProject, readFile, removeFile, writeFile } from '../testing/fixture.js';
import { approve, checkProject, fakeIo, pairs, testContext } from '../testing/harness.js';
import { normalizeLinkPaths } from './check.js';
import {
  copyDrift,
  hasDrift,
  isPublishedFile,
  linkClosure,
  linkLocation,
  linkState,
  materializeLink,
  parseLinkPath,
  publishedFiles,
  readLinksManifest,
  realLinkPrefixes,
  removeLinkFolder,
  resolveOrigin,
  storedOrigin,
  updateGitignore,
  writeLinksManifest,
} from './links.js';
import { readLock } from './lock.js';
import { toPosix } from './paths.js';
import type { LinkedAnalyzeResponse } from './types.js';

afterEach(cleanupProjects);


/**
 * The consumer project: `web` uses `handle` and the type `Router`, which an API project in vendor/api (outside the
 * root folder, like another project checked out next to this one) publishes in root/dmz/server/.external.ts.
 */
const ORIGIN = 'vendor/api';
const LINK = 'root/web/_/links/api';
const API: Record<string, string> = {
  [`${ORIGIN}/buckets.config.json`]: '{ "root": "root", "alias": "@api" }\n',
  [`${ORIGIN}/package.json`]: '{ "name": "api" }\n',
  [`${ORIGIN}/root/_/main.ts`]: 'export const main = 1;\n',
  [`${ORIGIN}/root/server/_/router.ts`]:
    "import { helper } from '@api/server/_/helper';\nexport interface Router {\n  path: string;\n}\nexport function handle(path: string): string {\n  return helper(path);\n}\n",
  [`${ORIGIN}/root/server/_/helper.ts`]: 'export function helper(path: string): string {\n  return `handled ${path}`;\n}\n',
  [`${ORIGIN}/root/server/_/unused.ts`]: 'export const unused = 1;\n',
  [`${ORIGIN}/root/dmz/server/.external.ts`]: "export type { Router } from '@api/server/_/router';\nexport { handle } from '@api/server/_/router';\n",
};
const CONSUMER: Record<string, string> = {
  ...API,
  'tsconfig.json': '{\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": {\n      "@root/*": ["./root/*"]\n    }\n  }\n}\n',
  'root/_/main.ts': 'export const main = 1;\n',
  'root/web/_/app.ts': "import { handle } from '@api/dmz/server/.external';\nexport const run = (): string => handle('/');\n",
};

async function link(dir: string, args: string[], cwd = dir): Promise<{ code: number; out: string; err: string }> {
  const io = fakeIo({ cwd });
  const code = await linkCommand(testContext(), io, args);
  return { code, out: io.out, err: io.err };
}

async function linked(mode: 'copy' | 'link' = 'copy', files: Record<string, string> = {}): Promise<string> {
  const dir = makeProject({ ...CONSUMER, ...files });
  const result = await link(dir, ['add', 'api', ORIGIN, '--bucket', 'root/web', ...(mode === 'copy' ? ['--copy'] : [])]);
  expect(result.code, result.err).toBe(0);
  return dir;
}

function lockKinds(report: { lockChanges: { kind: string; path: string; symbol?: string }[] }): string[] {
  return report.lockChanges.map((c) => `${c.kind} ${c.path}${c.symbol !== undefined ? ` ${c.symbol}` : ''}`);
}

describe('link helpers', () => {
  it('parses link paths', () => {
    expect(parseLinkPath(LINK)).toEqual({ bucket: 'root/web', name: 'api' });
    expect(parseLinkPath(`${LINK}/x`)).toBeNull();
  });

  it('reads, validates and writes buckets.links.json with the alias of the origin', () => {
    const dir = makeProject({});
    expect(readLinksManifest(dir)).toEqual({ kind: 'missing' });
    writeLinksManifest(dir, { [LINK]: { origin: ORIGIN, mode: 'copy', alias: '@api' } });
    expect(readLinksManifest(dir)).toEqual({ kind: 'ok', links: { [LINK]: { origin: ORIGIN, mode: 'copy', alias: '@api' } } });
    for (const bad of [
      '[]',
      '{"links": {"root/web/api": {"origin": "x", "mode": "copy", "alias": "@x"}}}',
      '{"links": {"root/web/_/links/a": {"mode": "zip"}}}',
      '{"links": {"root/web/_/links/a": {"origin": "x", "mode": "copy"}}}',
      '{"extra": 1}',
      '{',
    ]) {
      writeFile(dir, 'buckets.links.json', bad);
      expect(readLinksManifest(dir).kind, bad).toBe('invalid');
    }
  });

  it('explains an entry in the format of older versions, which named a .external file', () => {
    const dir = makeProject({ 'buckets.links.json': JSON.stringify({ links: { [LINK]: { origin: 'vendor/api/root/dmz/server/.external.ts', mode: 'copy', alias: '@api' } } }) });
    const read = readLinksManifest(dir);
    expect(read.kind).toBe('invalid');
    expect((read as { reason: string }).reason).toContain('buckets link add <name> <origin project folder>');
  });

  it('finds published files only at DMZ positions', () => {
    expect(isPublishedFile('dmz/server/.external.ts', '.ts')).toBe(true);
    expect(isPublishedFile('billing/dmz/invoices/.external.ts', '.ts')).toBe(true);
    expect(isPublishedFile('server/_/dmz/x/.external.ts', '.ts')).toBe(false);
    expect(isPublishedFile('dmz/server/other.ts', '.ts')).toBe(false);
    expect(isPublishedFile('dmz/.external.ts', '.ts')).toBe(false);
    const dir = makeProject(API);
    expect(publishedFiles(path.join(dir, ORIGIN, 'root'), '.ts')).toEqual(['dmz/server/.external.ts']);
  });

  it('collects what the published files reach: alias and relative imports, .js specifiers and index files, not packages', () => {
    const dir = makeProject({
      ...API,
      [`${ORIGIN}/root/server/_/helper.ts`]:
        "import { a } from './a.js';\nimport { b } from '@api/server/_/b';\nimport lodash from 'lodash';\nimport { c } from 'node:path';\nexport function helper(path: string): string {\n  return a + b + lodash + c + path;\n}\n",
      [`${ORIGIN}/root/server/_/a.ts`]: 'export const a = 1;\n',
      [`${ORIGIN}/root/server/_/b/index.ts`]: "export * from '../a';\nexport const b = 2;\n",
    });
    expect(linkClosure(path.join(dir, ORIGIN, 'root'), '@api', '.ts')).toEqual([
      'dmz/server/.external.ts',
      'server/_/a.ts',
      'server/_/b/index.ts',
      'server/_/helper.ts',
      'server/_/router.ts',
    ]);
  });

  it('keeps the names on disk in the closure, so a copy has the same file names as the origin', (ctx) => {
    const dir = makeProject({
      ...API,
      [`${ORIGIN}/root/server/_/helper.ts`]: "import { u } from '@api/server/_/Upper';\nexport const helper = u;\n",
      [`${ORIGIN}/root/server/_/Upper.TS`]: 'export const u = 1;\n',
    });
    // Only a file system that ignores case resolves `Upper` to Upper.TS, as TypeScript does there.
    if (!fileExists(dir, `${ORIGIN}/root/server/_/upper.ts`)) ctx.skip();
    const closure = linkClosure(path.join(dir, ORIGIN, 'root'), '@api', '.ts');
    expect(closure).toContain('server/_/Upper.TS');
    expect(closure).not.toContain('server/_/Upper.ts');
    materializeLink({ rootAbs: path.join(dir, ORIGIN, 'root'), files: closure }, path.join(dir, 'copy'), 'copy');
    expect(readdirSync(path.join(dir, 'copy/server/_'))).toContain('Upper.TS');
  });

  it('compares a copy with the origin by file and by text, CRLF counted as LF', () => {
    const dir = makeProject({ 'origin/a.ts': 'a\n', 'origin/b.ts': 'b\n', 'origin/c.ts': 'c\n', 'copy/a.ts': 'a\r\n', 'copy/b.ts': 'B\n', 'copy/d.ts': 'd\n' });
    const drift = copyDrift({ rootAbs: path.join(dir, 'origin'), files: ['a.ts', 'b.ts', 'c.ts'] }, path.join(dir, 'copy'));
    expect(drift).toEqual({ added: ['c.ts'], removed: ['d.ts'], changed: ['b.ts'] });
    expect(hasDrift(copyDrift({ rootAbs: path.join(dir, 'origin'), files: ['a.ts'] }, path.join(dir, 'origin')))).toBe(true);
    expect(hasDrift({ added: [], removed: [], changed: [] })).toBe(false);
  });

  it('copies the listed files byte for byte when a link cannot be created', () => {
    const dir = makeProject({ 'src/a.ts': 'a\r\n', 'src/deep/b.ts': 'b\n', 'src/skip.ts': 'no\n' });
    const mode = materializeLink({ rootAbs: path.join(dir, 'src'), files: ['a.ts', 'deep/b.ts'] }, path.join(dir, 'out/link'), 'link', {
      symlink: () => {
        throw new Error('EPERM');
      },
    });
    expect(mode).toBe('copy');
    expect(readFile(dir, 'out/link/a.ts')).toBe('a\r\n');
    expect(readFile(dir, 'out/link/deep/b.ts')).toBe('b\n');
    expect(fileExists(dir, 'out/link/skip.ts')).toBe(false);
    expect(linkState(path.join(dir, 'out/link'))).toBe('copy');
  });

  it('creates a junction or symlink to the whole folder, and removing it keeps the target', (ctx) => {
    const dir = makeProject({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
    if (!canLink(dir)) return ctx.skip();
    const target = path.join(dir, 'out/link');
    expect(materializeLink({ rootAbs: path.join(dir, 'src'), files: ['a.ts'] }, target, 'link')).toBe('link');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(linkState(target)).toBe('link');
    expect(readFile(dir, 'out/link/b.ts')).toBe('b\n');
    expect(realLinkPrefixes(dir, ['out/link'])).toEqual(new Map([['src', 'out/link']]));
    removeLinkFolder(target);
    expect(existsSync(target)).toBe(false);
    expect(readFile(dir, 'src/a.ts')).toBe('a\n');
  });

  it('adds and removes .gitignore lines once', () => {
    const dir = makeProject({ '.gitignore': 'node_modules' });
    expect(updateGitignore(dir, LINK, true)).toBe(true);
    expect(updateGitignore(dir, LINK, true)).toBe(false);
    expect(readFile(dir, '.gitignore')).toBe(`node_modules\n/${LINK}\n`);
    expect(updateGitignore(dir, LINK, false)).toBe(true);
    expect(readFile(dir, '.gitignore')).toBe('node_modules\n');
  });

  it('maps paths reported through the real location of a junction back to the link', (ctx) => {
    const dir = makeProject({ ...API, 'root/web/_/a.ts': '' });
    if (!canLink(dir)) return ctx.skip();
    materializeLink({ rootAbs: path.join(dir, ORIGIN, 'root'), files: [] }, path.join(dir, LINK), 'link');
    const response: LinkedAnalyzeResponse = {
      abi: 1,
      config: [],
      dmz: {},
      code: { 'root/web/_/a.ts': { imports: [{ kind: 'internal', target: `${ORIGIN}/root/dmz/server/.external.ts`, names: ['handle'], line: 1 }] } },
      links: {
        [LINK]: {
          exports: [{ file: `${ORIGIN}/root/dmz/server/.external.ts`, name: 'handle', typeOnly: false, signature: 'sha256:x', line: 2 }],
          dependencies: [{ package: 'lodash', from: `${ORIGIN}/root/server/_/router.ts`, resolved: true }],
          problems: [{ file: `${ORIGIN}/root/server/_/router.ts`, message: 'x' }],
        },
      },
    };
    normalizeLinkPaths(dir, response, new Set([LINK]));
    expect(response.code['root/web/_/a.ts']!.imports[0]!.target).toBe(`${LINK}/dmz/server/.external.ts`);
    expect(response.links![LINK]!.exports[0]!.file).toBe(`${LINK}/dmz/server/.external.ts`);
    expect(response.links![LINK]!.dependencies[0]!.from).toBe(`${LINK}/server/_/router.ts`);
    expect(response.links![LINK]!.problems[0]!.file).toBe(`${LINK}/server/_/router.ts`);
  });
});

describe('links in the check', () => {
  it('reports a new link as link-added, then passes once approved', async () => {
    const dir = makeProject(CONSUMER);
    writeFile(dir, 'root/web/_/app.ts', 'export const run = 1;\n');
    await approve(dir);
    expect((await link(dir, ['add', 'api', ORIGIN, '--bucket', 'root/web', '--copy'])).code).toBe(0);
    const { report } = await checkProject(dir);
    expect(lockKinds(report)).toEqual([`link-added ${LINK}`]);
    expect(report.lockChanges[0]!.message).toContain('2 published symbols');
    await approve(dir);
    expect((await checkProject(dir)).report.exitCode).toBe(0);
  });

  it('passes the links to the adapter and records origin, mode, alias and published signatures in the lock', async () => {
    const dir = await linked();
    const ctx = testContext();
    const lock = await approve(dir, ctx);
    expect(ctx.adapter.analyzeCalls[0]!.links).toEqual([{ path: LINK, alias: '@api' }]);
    expect(ctx.adapter.analyzeCalls[0]!.files.code.some((f) => f.includes('links'))).toBe(false);
    expect(lock.lockVersion).toBe(3);
    expect(lock.links).toEqual({
      [LINK]: {
        name: 'api',
        origin: ORIGIN,
        mode: 'copy',
        alias: '@api',
        symbols: { 'dmz/server/.external.ts': { Router: expect.stringMatching(/^sha256:/), handle: expect.stringMatching(/^sha256:/) } },
      },
    });
    expect(readLock(dir).kind).toBe('ok');
  });

  it('allows value imports of a published file and refuses any other file of the link with link-forbidden-import', async () => {
    const dir = await linked();
    expect((await checkProject(dir)).report.violations).toEqual([]);
    writeFile(dir, 'root/web/_/app.ts', "import { helper } from '@api/server/_/helper';\nexport const run = (): string => helper('/');\n");
    const { report } = await checkProject(dir);
    expect(pairs(report.violations)).toEqual(['link-forbidden-import root/web/_/app.ts']);
    expect(report.violations[0]!.message).toContain("'@api/dmz/server/.external'");
    expect(report.exitCode).toBe(1);
  });

  it('forbids another bucket from importing the link of a bucket', async () => {
    const dir = await linked();
    writeFile(dir, 'root/mail/_/m.ts', "import { handle } from '@api/dmz/server/.external';\nexport const m = handle('/m');\n");
    expect(pairs((await checkProject(dir)).report.violations)).toEqual(['import-forbidden root/mail/_/m.ts']);
  });

  it('asks for no approval when only the internals of the origin change, in link mode', async (ctx) => {
    const dir = await linked('link');
    if (linkState(path.join(dir, LINK)) !== 'link') return ctx.skip();
    expect(readFile(dir, '.gitignore')).toContain(`/${LINK}`);
    await approve(dir);
    writeFile(dir, `${ORIGIN}/root/server/_/helper.ts`, 'export function helper(path: string): string {\n  return `served ${path}`;\n}\n');
    writeFile(dir, `${ORIGIN}/root/server/_/router.ts`, readFile(dir, `${ORIGIN}/root/server/_/router.ts`).replace('return helper(path);', 'return helper(path).trim();'));
    let { report } = await checkProject(dir);
    expect(report.exitCode).toBe(0);
    expect(report.lockChanges).toEqual([]);
    // A published signature that changes needs the consumer's human.
    writeFile(dir, `${ORIGIN}/root/server/_/router.ts`, readFile(dir, `${ORIGIN}/root/server/_/router.ts`).replace('handle(path: string): string', 'handle(path: string, method: string): string'));
    ({ report } = await checkProject(dir));
    expect(lockKinds(report)).toEqual([`link-changed ${LINK} handle`]);
    expect(report.exitCode).toBe(2);
  });

  it('reports a published symbol added or removed in the origin as link-changed', async (ctx) => {
    const dir = await linked('link');
    if (linkState(path.join(dir, LINK)) !== 'link') return ctx.skip();
    await approve(dir);
    writeFile(dir, `${ORIGIN}/root/dmz/server/.external.ts`, "export { handle } from '@api/server/_/router';\nexport { helper } from '@api/server/_/helper';\n");
    expect(lockKinds((await checkProject(dir)).report).sort()).toEqual([`link-changed ${LINK} Router`, `link-changed ${LINK} helper`]);
  });

  it('accepts a registered junction or symlink, and still forbids any other link', async (ctx) => {
    const dir = await linked('link');
    if (linkState(path.join(dir, LINK)) !== 'link') return ctx.skip();
    await approve(dir);
    expect((await checkProject(dir)).report.exitCode).toBe(0);
    symlinkSync(path.join(dir, 'vendor'), path.join(dir, 'root/web/_/links/other'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(pairs((await checkProject(dir)).report.violations)).toEqual(['folder-symlink root/web/_/links/other']);
  });

  it('reports link-drift for a copy whose origin changed, and nothing after link update when no signature changed', async () => {
    const dir = await linked();
    await approve(dir);
    writeFile(dir, `${ORIGIN}/root/server/_/helper.ts`, 'export function helper(path: string): string {\n  return `served ${path}`;\n}\n');
    let { report } = await checkProject(dir);
    expect(lockKinds(report)).toEqual([`link-drift ${LINK}`]);
    expect(report.lockChanges[0]!.message).toContain('server/_/helper.ts (changed)');
    expect(report.lockChanges[0]!.message).toContain('buckets link update api');
    expect((await link(dir, ['update', 'api'])).code).toBe(0);
    expect(readFile(dir, `${LINK}/server/_/helper.ts`)).toContain('served');
    ({ report } = await checkProject(dir));
    expect(report.exitCode).toBe(0);
    // A file the published files never reach does not matter.
    writeFile(dir, `${ORIGIN}/root/server/_/unused.ts`, 'export const unused = 2;\n');
    expect((await checkProject(dir)).report.exitCode).toBe(0);
    // A file the published files stop importing still exists in the origin: the copy just no longer needs it.
    writeFile(dir, `${ORIGIN}/root/server/_/router.ts`, 'export interface Router {\n  path: string;\n}\nexport function handle(path: string): string {\n  return path;\n}\n');
    ({ report } = await checkProject(dir));
    expect(report.lockChanges[0]!.message).toContain('server/_/helper.ts (no longer imported by the published files)');
    expect(report.lockChanges[0]!.message).not.toContain('(gone)');
  });

  it('accepts a copy whose origin is not available', async () => {
    const dir = await linked();
    await approve(dir);
    removeFile(dir, 'vendor');
    expect((await checkProject(dir)).report.exitCode).toBe(0);
  });

  it('reports link-missing with the sync instruction, and no unresolved import for it', async () => {
    const dir = await linked();
    await approve(dir);
    removeFile(dir, LINK);
    const { report } = await checkProject(dir);
    expect(pairs(report.violations)).toEqual([`link-missing ${LINK}`]);
    expect(report.violations[0]!.message).toContain('buckets link sync');
    expect(report.exitCode).toBe(1);
  });

  it('explains an import of the alias that does not resolve inside a present link', async () => {
    const dir = await linked();
    writeFile(dir, 'root/web/_/app.ts', "import { handle } from '@api/dmz/nope/.external';\nexport const run = (): string => handle('/');\n");
    const { report } = await checkProject(dir);
    expect(pairs(report.violations)).toEqual(['import-unresolved root/web/_/app.ts']);
    expect(report.violations[0]!.message).toContain('"@api/*" to ["./root/web/_/links/api/*"]');
  });

  it('reports link-removed when the link leaves buckets.links.json', async () => {
    const dir = await linked();
    await approve(dir);
    writeFile(dir, 'root/web/_/app.ts', 'export const run = 1;\n');
    expect((await link(dir, ['remove', 'api'])).code).toBe(0);
    expect(lockKinds((await checkProject(dir)).report)).toEqual([`link-removed ${LINK}`]);
  });

  it('says that the link was removed when code still imports through its alias after buckets link remove', async () => {
    const dir = await linked();
    await approve(dir);
    expect((await link(dir, ['remove', 'api'])).code).toBe(0);
    const { report } = await checkProject(dir);
    expect(pairs(report.violations)).toEqual(['import-unresolved root/web/_/app.ts']);
    const message = report.violations[0]!.message;
    expect(message).toContain(`@api, the alias of the project that was linked in ${LINK}. That link was removed with \`buckets link remove api\``);
    expect(message).toContain('Remove the imports of @api, or replace them with code of this project');
    expect(message).not.toContain('package.json');
    expect(lockKinds(report)).toEqual([`link-removed ${LINK}`]);
    // `check --file`, which the edit hook runs, knows the removed link too.
    const single = await checkProject(dir, { file: 'root/web/_/app.ts' });
    expect(single.report.violations.map((v) => v.message)).toEqual([message]);
  });

  it('reports a package a copied file imports and this project lacks, and says to install it here', async () => {
    const dir = await linked('copy', { [`${ORIGIN}/root/server/_/helper.ts`]: "import pad from 'left-pad';\nexport function helper(path: string): string {\n  return pad(path);\n}\n" });
    const { report } = await checkProject(dir);
    expect(pairs(report.violations)).toEqual([`link-missing-dependency ${LINK}/server/_/helper.ts`]);
    expect(report.violations[0]!.message).toContain('Add "left-pad" to the package.json of this project');
    writeFile(dir, 'node_modules/left-pad/package.json', '{ "name": "left-pad" }\n');
    expect((await checkProject(dir)).report.violations).toEqual([]);
  });

  it('says to link the project that the origin links when a linked file imports through its alias, instead of installing a package', async () => {
    const dir = await linked('copy', {
      [`${ORIGIN}/buckets.links.json`]: JSON.stringify({ links: { 'root/server/_/links/fmt': { origin: '../lib', mode: 'copy', alias: '@lib-k3x9pm2a' } } }),
      [`${ORIGIN}/root/server/_/helper.ts`]: "import { pad } from '@lib-k3x9pm2a/dmz/fmt/.external';\nexport function helper(path: string): string {\n  return pad(path);\n}\n",
    });
    const { report } = await checkProject(dir);
    expect(pairs(report.violations)).toEqual([`link-missing-dependency ${LINK}/server/_/helper.ts`]);
    const message = report.violations[0]!.message;
    expect(message).toContain('@lib-k3x9pm2a, the alias of the project that vendor/api links in root/server/_/links/fmt');
    expect(message).toContain('buckets link add <name> vendor/lib');
    expect(message).not.toContain('package.json');
  });

  it('says to install a missing package in the origin when the link is a junction to a project with a package.json', async (ctx) => {
    const dir = await linked('link', { [`${ORIGIN}/root/server/_/helper.ts`]: "import pad from 'left-pad';\nexport function helper(path: string): string {\n  return pad(path);\n}\n" });
    if (linkState(path.join(dir, LINK)) !== 'link') return ctx.skip();
    const { report } = await checkProject(dir);
    expect(pairs(report.violations)).toEqual([`link-missing-dependency ${LINK}/server/_/helper.ts`]);
    // Neither project has the package: the message names both sides.
    const both = report.violations[0]!.message;
    expect(both).toContain('which is missing for type checking and at runtime');
    expect(both).toContain('Missing for type checking');
    expect(both).toContain('install it in this project, the consumer');
    expect(both).toContain('Missing at runtime');
    expect(both).toContain('run `npm install` in vendor/api');
    // Installed in the origin only: Node finds it, but tsc here reads the file through the link path and does not.
    writeFile(dir, `${ORIGIN}/node_modules/left-pad/package.json`, '{ "name": "left-pad" }\n');
    const typesOnly = (await checkProject(dir)).report;
    expect(pairs(typesOnly.violations)).toEqual([`link-missing-dependency ${LINK}/server/_/helper.ts`]);
    expect(typesOnly.violations[0]!.message).toContain('which is missing for type checking.');
    expect(typesOnly.violations[0]!.message).toContain('install it in this project, the consumer, for example with `npm install --save-dev left-pad`');
    expect(typesOnly.violations[0]!.message).not.toContain('Missing at runtime');
    // Its @types package in the consumer is enough for type checking.
    writeFile(dir, 'node_modules/@types/left-pad/package.json', '{ "name": "@types/left-pad" }\n');
    expect((await checkProject(dir)).report.violations).toEqual([]);
  });

  it('says to install a missing package next to the origin when the link is a junction to a folder without a package.json', async (ctx) => {
    // The origin lives outside the consumer, so Node, following the junction, never looks in the consumer's node_modules.
    const origin = makeProject(
      Object.fromEntries(
        Object.entries({ ...API, [`${ORIGIN}/root/server/_/helper.ts`]: "import pad from 'left-pad';\nexport function helper(path: string): string {\n  return pad(path);\n}\n" })
          .filter(([file]) => !file.endsWith('package.json'))
          .map(([file, text]) => [file.slice(ORIGIN.length + 1), text]),
      ),
      false,
    );
    const dir = makeProject(Object.fromEntries(Object.entries(CONSUMER).filter(([file]) => !file.startsWith(`${ORIGIN}/`))));
    const added = await link(dir, ['add', 'api', origin, '--bucket', 'root/web']);
    expect(added.code, added.err).toBe(0);
    if (linkState(path.join(dir, LINK)) !== 'link') return ctx.skip();
    const where = toPosix(path.relative(dir, origin));
    expect(added.out).toContain(`run \`npm install\` in ${where}`);
    // TypeScript reads package types through the link path, so the consumer's tsc needs them here too.
    expect(added.out).toContain('install each one (or its @types package) in this project too');
    writeFile(dir, 'node_modules/left-pad/package.json', '{ "name": "left-pad" }\n');
    const { report } = await checkProject(dir);
    expect(pairs(report.violations)).toEqual([`link-missing-dependency ${LINK}/server/_/helper.ts`]);
    // The consumer has the package, so only the runtime side, in the origin, lacks it.
    expect(report.violations[0]!.message).toContain('which is missing at runtime.');
    expect(report.violations[0]!.message).toContain(`install it in the origin: ${where} has no package.json`);
    expect(report.violations[0]!.message).not.toContain('Missing for type checking');
    expect(report.violations[0]!.message).not.toContain('package.json of this project');
    writeFile(origin, 'node_modules/left-pad/package.json', '{ "name": "left-pad" }\n');
    expect((await checkProject(dir)).report.violations).toEqual([]);
  });

  it('reports what the adapter could not read in a link as project-config', async () => {
    const dir = await linked();
    const { report } = await checkProject(dir, {}, testContext({ linkProblems: { [LINK]: [{ message: 'no tsconfig maps the alias' }] } }));
    expect(pairs(report.violations)).toEqual([`project-config ${LINK}`]);
    expect(report.violations[0]!.message).toContain('no tsconfig maps the alias.');
  });

  it('reports an invalid buckets.links.json as config-invalid', async () => {
    const dir = makeProject({ ...CONSUMER, 'buckets.links.json': '{"links": 3}' });
    expect(pairs((await checkProject(dir)).report.violations)).toContain('config-invalid buckets.links.json');
  });

  it('points at a leftover .external folder of an older version once', async () => {
    const dir = makeProject({ ...API, 'root/_/m.ts': '', [`${ORIGIN}/root/dmz/server/.external/index.d.ts`]: 'export {};\n', [`${ORIGIN}/root/dmz/server/.external/src/a.d.ts`]: '' });
    const { report } = await checkProject(path.join(dir, ORIGIN));
    expect(pairs(report.violations)).toEqual(['dmz-path root/dmz/server/.external']);
    expect(report.violations[0]!.message).toContain('Delete root/dmz/server/.external/');
  });

  it('keeps .external.ts out of the orphan rule in the publishing project', async () => {
    const dir = makeProject(API);
    const { report } = await checkProject(path.join(dir, ORIGIN));
    expect(report.violations).toEqual([]);
  });
});

describe('buckets link commands', () => {
  it('add derives the bucket from the current folder, edits tsconfig.json and prints how to import', async () => {
    const dir = makeProject({ ...CONSUMER, 'vite.config.ts': 'export default {};\n' });
    const ok = await link(dir, ['add', 'api', '../../../vendor/api', '--copy'], path.join(dir, 'root/web/_'));
    expect(ok.code, ok.err).toBe(0);
    expect(readLinksManifest(dir)).toEqual({ kind: 'ok', links: { [LINK]: { origin: ORIGIN, mode: 'copy', alias: '@api' } } });
    // The link folder is excluded, so tsc here compiles only the linked files that code imports.
    expect(readFile(dir, 'tsconfig.json')).toBe(
      '{\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": {\n      "@root/*": ["./root/*"],\n      "@api/*": ["./root/web/_/links/api/*"]\n    }\n  },\n  "exclude": ["root/web/_/links/api"]\n}\n',
    );
    expect(ok.out).toContain(`Added "@api/*": ["./${LINK}/*"]`);
    expect(ok.out).toContain(`Added "exclude": ["${LINK}"] to tsconfig.json`);
    expect(ok.out).toContain("'@api/dmz/server/.external'");
    expect(ok.out).toContain("resolve: { alias: { '@api': fileURLToPath(new URL('./root/web/_/links/api', import.meta.url)) } }");
    expect(readFile(dir, 'vite.config.ts')).toBe('export default {};\n');
    expect(fileExists(dir, `${LINK}/server/_/helper.ts`)).toBe(true);
    expect(fileExists(dir, `${LINK}/server/_/unused.ts`)).toBe(false);
    expect((await link(dir, ['add', 'api', ORIGIN, '--bucket', 'root/web'])).err).toContain('already the alias of the link');
  });

  it('add refuses bad input with a fix', async () => {
    const dir = makeProject({ ...CONSUMER, 'other/buckets.config.json': '{ "root": "root" }\n', 'other/root/_/x.ts': '' });
    expect((await link(dir, ['add', 'api', ORIGIN])).err).toContain('not inside a bucket');
    expect((await link(dir, ['add', 'bad name', ORIGIN, '--bucket', 'root/web'])).err).toContain('not a valid link name');
    expect((await link(dir, ['add', 'api', 'vendor', '--bucket', 'root/web'])).err).toContain('is not a slopbuckets project');
    expect((await link(dir, ['add', 'api', 'nowhere', '--bucket', 'root/web'])).err).toContain('does not exist on this machine');
    // A folder inside the origin project, or its published file, names the project to pass instead.
    const inner = await link(dir, ['add', 'api', `${ORIGIN}/root/server`, '--bucket', 'root/web']);
    expect(inner.err).toContain(`is inside the slopbuckets project ${ORIGIN}. Pass that folder`);
    const published = await link(dir, ['add', 'api', `${ORIGIN}/root/dmz/server/.external.ts`, '--bucket', 'root/web']);
    expect(published.err).toContain(`Pass the folder of the origin project, ${ORIGIN}`);
    expect(published.err).not.toContain('Delete the entry');
    expect((await link(dir, ['add', 'api', '.', '--bucket', 'root/web'])).err).toContain('this same project');
    const clash = await link(dir, ['add', 'other', 'other', '--bucket', 'root/web']);
    expect(clash.code).toBe(1);
    expect(clash.err).toContain('uses the alias @root, which is also the alias of this project');
    expect(fileExists(dir, 'root/web/_/links/other')).toBe(false);
  });

  it('add explains how another bucket reaches a project that is already linked', async () => {
    const dir = await linked('copy', { 'root/admin/_/a.ts': 'export const a = 1;\n' });
    const again = await link(dir, ['add', 'api2', ORIGIN, '--bucket', 'root/admin', '--copy']);
    expect(again.code).toBe(1);
    expect(again.err).toContain(`already the alias of the link ${LINK}`);
    expect(again.err).toContain('re-export the symbols root/admin needs from root/web through a DMZ contract');
    expect(again.err).not.toContain('Import the existing link from the bucket that owns it');
  });

  it('add explains a --bucket folder that does not exist, resolved from the current folder', async () => {
    const dir = makeProject(CONSUMER);
    // From inside root/, "root/web" names root/root/web, which does not exist.
    const fromRoot = await link(dir, ['add', 'api', '../vendor/api', '--bucket', 'root/web'], path.join(dir, 'root'));
    expect(fromRoot.code).toBe(1);
    expect(fromRoot.err).toContain('--bucket root/web names root/root/web, which does not exist');
    expect(fromRoot.err).toContain('relative to the current folder');
    expect(fromRoot.err).not.toContain('has no _/ folder');
    const missing = await link(dir, ['add', 'api', ORIGIN, '--bucket', 'root/nope']);
    expect(missing.err).toContain('root/nope, which does not exist');
    expect(missing.err).not.toContain('has no _/ folder');
    // A bucket folder that exists without _/ still gets the instruction to create it.
    writeFile(dir, 'root/empty/dmz/x/.self.ts', '');
    expect((await link(dir, ['add', 'api', ORIGIN, '--bucket', 'root/empty'])).err).toContain('The bucket root/empty/ has no _/ folder');
    expect(fileExists(dir, 'buckets.links.json')).toBe(false);
  });

  it('add links the project that contains a nested consumer as a copy, because a junction there would contain itself', async () => {
    const dir = makeProject({
      ...CONSUMER,
      'root/dmz/web/.external.ts': "export { run } from '@root/web/_/app';\n",
      'root/web/_/inner/buckets.config.json': '{ "root": "root", "alias": "@inner" }\n',
      'root/web/_/inner/root/_/x.ts': '',
    });
    const inner = path.join(dir, 'root/web/_/inner');
    for (const copy of [false, true]) {
      const result = await link(inner, ['add', 'outer', '../../../..', '--bucket', 'root', ...(copy ? ['--copy'] : [])], inner);
      expect(result.code, result.err).toBe(0);
      expect(linkState(path.join(inner, 'root/_/links/outer'))).toBe('copy');
      expect(readLinksManifest(inner)).toEqual({ kind: 'ok', links: { 'root/_/links/outer': { origin: '../../../..', mode: 'copy', alias: '@root' } } });
      // The copy holds what the enclosing project publishes, and never the nested project itself.
      expect(fileExists(inner, 'root/_/links/outer/dmz/web/.external.ts')).toBe(true);
      expect(fileExists(inner, 'root/_/links/outer/web/_/app.ts')).toBe(true);
      expect(fileExists(inner, 'root/_/links/outer/web/_/inner')).toBe(false);
      if (!copy) expect(result.out).toContain('would contain this project');
      expect((await link(inner, ['remove', 'outer'], inner)).code).toBe(0);
    }
  });

  it('never creates a junction or symlink inside the folder it points to', () => {
    const dir = makeProject({ 'origin/dmz/a/.external.ts': 'export {};\n' });
    const origin = path.join(dir, 'origin');
    const inner = path.join(origin, 'a/_/inner/root/_/links/up');
    expect(materializeLink({ rootAbs: origin, files: ['dmz/a/.external.ts'] }, inner, 'link')).toBe('copy');
    expect(linkState(inner)).toBe('copy');
    expect(fileExists(inner, 'dmz/a/.external.ts')).toBe(true);
  });

  it('add prints the line to add when tsconfig.json has no paths of its own', async () => {
    const dir = makeProject({ ...CONSUMER, 'tsconfig.json': '{ "extends": "./tsconfig.base.json" }\n' });
    const result = await link(dir, ['add', 'api', ORIGIN, '--bucket', 'root/web', '--copy']);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain(`Did not edit tsconfig.json`);
    expect(result.out).toContain(`  "@api/*": ["./${LINK}/*"]`);
    expect(readFile(dir, 'tsconfig.json')).toBe('{ "extends": "./tsconfig.base.json" }\n');
  });

  it('sync recreates missing links and keeps existing copies', async () => {
    const dir = await linked();
    writeFile(dir, `${LINK}/local.ts`, 'export {};\n');
    expect((await link(dir, ['sync'])).out).toContain('Nothing to do');
    expect(fileExists(dir, `${LINK}/local.ts`)).toBe(true);
    removeFile(dir, LINK);
    const result = await link(dir, ['sync']);
    expect(result.out).toContain(`Created ${LINK}`);
    expect(fileExists(dir, `${LINK}/dmz/server/.external.ts`)).toBe(true);
  });

  it('sync explains a missing origin and exits 1', async () => {
    const dir = await linked();
    removeFile(dir, LINK);
    removeFile(dir, 'vendor');
    const result = await link(dir, ['sync']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('does not exist on this machine');
  });

  it('remove deletes the folder, the entry, the .gitignore line and the tsconfig.json entry', async () => {
    const dir = makeProject(CONSUMER);
    const before = readFile(dir, 'tsconfig.json');
    await link(dir, ['add', 'api', ORIGIN, '--bucket', 'root/web']);
    const result = await link(dir, ['remove', 'api']);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain(`Removed "@api/*": ["./${LINK}/*"]`);
    expect(result.out).toContain(`Removed "${LINK}" from "exclude" in tsconfig.json`);
    expect(readFile(dir, 'tsconfig.json')).toBe(before);
    expect(fileExists(dir, LINK)).toBe(false);
    expect(readLinksManifest(dir)).toEqual({ kind: 'ok', links: {} });
    expect(fileExists(dir, `${ORIGIN}/root/dmz/server/.external.ts`)).toBe(true);
    expect(fileExists(dir, '.gitignore') ? readFile(dir, '.gitignore') : '').not.toContain('links/api');
    expect((await link(dir, ['remove', 'api'])).err).toContain('No link named "api"');
  });

  it('update says a link in link mode needs no copy, and build and unknown subcommands are refused', async () => {
    const dir = makeProject(CONSUMER);
    expect((await link(dir, ['update'])).out).toContain('no links in copy mode');
    expect((await link(dir, ['build'])).err).toContain('"build" no longer exists');
    expect((await link(dir, ['frobnicate'])).err).toContain('unknown subcommand');
    expect((await link(dir, [])).err).toContain('missing subcommand');
  });
});

describe('link origins on another drive', () => {
  it('stores an origin relative when possible and absolute when not, and always resolves with path.resolve', () => {
    const same = storedOrigin('C:\\work\\web', 'C:\\work\\api', path.win32);
    expect(same).toEqual({ origin: '../api', absolute: false });
    const other = storedOrigin('C:\\work\\web', 'D:\\api', path.win32);
    expect(other).toEqual({ origin: 'D:/api', absolute: true });
    // path.join would glue the two drives together; path.resolve keeps the absolute origin.
    expect(resolveOrigin('C:\\work\\web', other.origin, path.win32)).toBe('D:\\api');
    expect(resolveOrigin('C:\\work\\web', same.origin, path.win32)).toBe('C:\\work\\api');
    expect(resolveOrigin('/work/web', '/mnt/api', path.posix)).toBe('/mnt/api');
  });

  it('syncs, checks and updates a link whose origin is an absolute path', async () => {
    const dir = makeProject(CONSUMER);
    const absolute = path.join(dir, ORIGIN).replace(/\\/g, '/');
    writeLinksManifest(dir, { [LINK]: { origin: absolute, mode: 'copy', alias: '@api' } });
    const synced = await link(dir, ['sync']);
    expect(synced.code, synced.err).toBe(0);
    expect(readFile(dir, `${LINK}/server/_/router.ts`)).toContain('interface Router');
    await approve(dir);
    expect((await checkProject(dir)).report.exitCode).toBe(0);
    writeFile(dir, `${ORIGIN}/root/server/_/helper.ts`, 'export function helper(path: string): string {\n  return path;\n}\n');
    expect((await checkProject(dir)).report.lockChanges.map((c) => c.kind)).toEqual(['link-drift']);
    expect((await link(dir, ['update', 'api'])).code).toBe(0);
    expect(readFile(dir, `${LINK}/server/_/helper.ts`)).toContain('return path;');
  });
});

describe('link paths that leave the bucket', () => {
  it.each([
    '../x/_/links/a',
    'root/../../x/_/links/a',
    'root//web/_/links/a',
    './_/links/a',
    'root/./web/_/links/a',
    'C:/x/_/links/a',
    'root\\web/_/links/a',
    'root/_/x/_/links/a',
    'root/dmz/_/links/a',
    '/_/links/a',
    'root/web/_/links/..',
    'root/web/_/links/.',
  ])('rejects %j', (p) => {
    expect(parseLinkPath(p)).toBeNull();
  });

  it('refuses manifest entries with such paths', () => {
    const dir = makeProject({});
    writeFile(dir, 'buckets.links.json', JSON.stringify({ links: { 'root/../../outside/_/links/a': { origin: ORIGIN, mode: 'copy', alias: '@api' } } }));
    expect(readLinksManifest(dir).kind).toBe('invalid');
  });

  it('reports an entry outside every scanned bucket as config-invalid and never reads or writes there', async () => {
    const dir = makeProject({ ...CONSUMER, 'root/ghost/x.txt': 'not a bucket\n' });
    writeLinksManifest(dir, { 'root/nope/_/links/api': { origin: ORIGIN, mode: 'copy', alias: '@api' } });
    const { report } = await checkProject(dir);
    expect(pairs(report.violations)).toContain('config-invalid buckets.links.json');
    expect(report.violations.find((v) => v.rule === 'config-invalid')!.message).toContain('root/nope is not a bucket of this project');
    const synced = await link(dir, ['sync']);
    expect(synced.code).toBe(1);
    expect(synced.err).toContain('not a bucket of this project');
    expect(existsSync(path.join(dir, 'root/nope'))).toBe(false);
    expect((await link(dir, ['update'])).code).toBe(1);
    const removed = await link(dir, ['remove', 'api']);
    expect(removed.code, removed.err).toBe(0);
    expect(removed.out).toContain('Nothing on disk was deleted');
    expect(readLinksManifest(dir)).toEqual({ kind: 'ok', links: {} });
  });

  it('never copies into or deletes from a _/links folder that is a link to another folder', async (ctx) => {
    const dir = makeProject(CONSUMER);
    const outside = makeProject({ 'keep.txt': 'keep\n' }, false);
    if (!canLink(dir)) return ctx.skip();
    mkdirSync(path.join(dir, 'root/web/_'), { recursive: true });
    symlinkSync(outside, path.join(dir, 'root/web/_/links'), process.platform === 'win32' ? 'junction' : 'dir');
    writeLinksManifest(dir, { [LINK]: { origin: ORIGIN, mode: 'copy', alias: '@api' } });
    const synced = await link(dir, ['sync']);
    expect(synced.code).toBe(1);
    expect(synced.err).toContain('is (or is inside) a link to another folder');
    expect(existsSync(path.join(outside, 'api'))).toBe(false);
    mkdirSync(path.join(outside, 'api'), { recursive: true });
    writeFile(outside, 'api/index.ts', 'export {};\n');
    expect((await link(dir, ['update'])).code).toBe(1);
    await link(dir, ['remove', 'api']);
    expect(readFile(outside, 'api/index.ts')).toBe('export {};\n');
    expect(readFile(outside, 'keep.txt')).toBe('keep\n');
    expect(lstatSync(path.join(dir, 'root/web/_/links')).isSymbolicLink()).toBe(true);
  });

  it('linkLocation accepts only a scanned bucket', () => {
    const dir = makeProject(CONSUMER);
    expect(linkLocation(dir, LINK, new Set(['root/web']))).toBe(path.join(dir, 'root', 'web', '_', 'links', 'api'));
    expect(() => linkLocation(dir, LINK, new Set(['root']))).toThrow('not a bucket of this project');
    expect(() => linkLocation(dir, 'root/../x/_/links/api', new Set(['root/../x']))).toThrow('not a link path');
  });
});
