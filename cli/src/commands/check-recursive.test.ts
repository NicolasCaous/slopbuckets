import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../cli.js';
import { CACHE_DIR, memoryCache } from '../core/cache.js';
import { runCheck } from '../core/check.js';
import { cleanupProjects, fileExists, LOGGER_PROJECT, makeProject, readFile, writeFile } from '../testing/fixture.js';
import { approve, fakeIo, testContext } from '../testing/harness.js';

afterEach(cleanupProjects);

const NESTED = 'root/billing/_/engine';

async function tree(): Promise<string> {
  const dir = makeProject({
    ...LOGGER_PROJECT,
    [`${NESTED}/buckets.config.json`]: '{ "root": "root", "alias": "@engine" }\n',
    [`${NESTED}/root/_/run.ts`]: 'export const run = 1;\n',
  });
  await approve(dir);
  await approve(path.join(dir, NESTED));
  return dir;
}

describe('buckets check on nested projects', () => {
  it('checks nested projects and groups the text by project', async () => {
    const dir = await tree();
    writeFile(dir, `${NESTED}/root/_/run.ts`, "import x from './x';\n");
    writeFile(dir, 'root/mail/_/m.ts', 'export const m = 1;\n');
    const io = fakeIo({ cwd: dir });
    expect(await main(testContext(), io, ['check'])).toBe(1);
    expect(io.out).toContain('== Project . (where the check ran)');
    expect(io.out).toContain(`== Project ${NESTED} (nested, paths below are relative to it)`);
    expect(io.out.indexOf('bucket-added')).toBeLessThan(io.out.indexOf(`== Project ${NESTED}`));
    expect(io.out).toContain('in 2 projects');
  });

  it('prints projects and project fields in JSON, and --no-recursive skips the nested ones', async () => {
    const dir = await tree();
    writeFile(dir, `${NESTED}/root/_/run.ts`, "import x from './x';\n");
    let io = fakeIo({ cwd: dir });
    expect(await main(testContext(), io, ['check', '--json'])).toBe(1);
    const report = JSON.parse(io.out);
    expect(report.projects).toEqual([
      { path: '.', exitCode: 0 },
      { path: NESTED, exitCode: 1 },
    ]);
    expect(report.violations[0]).toMatchObject({ rule: 'import-relative', file: 'root/_/run.ts', project: NESTED });
    io = fakeIo({ cwd: dir });
    expect(await main(testContext(), io, ['check', '--json', '--no-recursive'])).toBe(0);
    expect(JSON.parse(io.out).projects).toEqual([{ path: '.', exitCode: 0 }]);
  });

  it('check --file uses the nearest project of the file', async () => {
    const dir = await tree();
    writeFile(dir, `${NESTED}/root/_/run.ts`, "import x from './x';\n");
    const io = fakeIo({ cwd: dir });
    expect(await main(testContext(), io, ['check', '--json', '--file', `${NESTED}/root/_/run.ts`])).toBe(1);
    const report = JSON.parse(io.out);
    expect(report.violations).toEqual([expect.objectContaining({ rule: 'import-relative', file: 'root/_/run.ts', project: NESTED })]);
    expect(report.projects).toEqual([{ path: NESTED, exitCode: 1 }]);
  });

  it('check --file refuses a file that does not exist instead of saying it passes', async () => {
    const dir = await tree();
    const io = fakeIo({ cwd: dir });
    expect(await main(testContext(), io, ['check', '--file', 'root/_/typo.ts'])).toBe(1);
    expect(io.out).not.toContain('passes every bucket rule');
    expect(io.err).toContain('root/_/typo.ts does not exist');
  });

  it('check --file names the nested project in the text report, because its paths are relative to it', async () => {
    const dir = await tree();
    writeFile(dir, `${NESTED}/root/_/run.ts`, "import x from './x';\n");
    const io = fakeIo({ cwd: dir });
    expect(await main(testContext(), io, ['check', '--file', `${NESTED}/root/_/run.ts`])).toBe(1);
    expect(io.out).toContain(`== Project ${NESTED} (nested, paths below are relative to it)`);
    expect(io.out).toContain('root/_/run.ts');
  });
});

describe('analysis cache', () => {
  it('reuses the analysis of a project whose files did not change, and gitignores itself', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const ctx = testContext();
    const cacheDir = path.join(dir, CACHE_DIR);
    const first = await runCheck(ctx, dir, { cacheDir });
    const second = await runCheck(ctx, dir, { cacheDir });
    expect(ctx.adapter.analyzeCalls).toHaveLength(1);
    expect(second.report).toEqual(first.report);
    expect(readFile(dir, '.buckets/.gitignore')).toBe('*\n');

    writeFile(dir, 'root/log/_/logger.ts', 'export function logger(message: string, level: number): void {}\n');
    await runCheck(ctx, dir, { cacheDir });
    expect(ctx.adapter.analyzeCalls).toHaveLength(2);
    writeFile(dir, 'root/log/_/asset.svg', '<svg/>');
    await runCheck(ctx, dir, { cacheDir });
    expect(ctx.adapter.analyzeCalls).toHaveLength(3);
    writeFile(dir, 'tsconfig.json', '{}');
    await runCheck(ctx, dir, { cacheDir });
    expect(ctx.adapter.analyzeCalls).toHaveLength(4);
    await runCheck(ctx, dir, { cacheDir });
    expect(ctx.adapter.analyzeCalls).toHaveLength(4);
  });

  it('analyzes again when a linked project gains a published file', async () => {
    const origin = makeProject({ 'buckets.config.json': '{ "root": "root", "alias": "@api" }\n', 'root/_/m.ts': '', 'root/server/_/a.ts': 'export const a = 1;\n', 'root/dmz/server/.external.ts': "export { a } from '@api/server/_/a';\n" });
    const dir = makeProject({ 'root/_/m.ts': '', 'root/web/_/w.ts': 'export const w = 1;\n' });
    const files = ['dmz/server/.external.ts', 'server/_/a.ts'];
    for (const f of files) writeFile(dir, `root/web/_/links/api/${f}`, readFile(origin, `root/${f}`));
    writeFile(dir, 'buckets.links.json', JSON.stringify({ links: { 'root/web/_/links/api': { origin: path.relative(dir, origin), mode: 'copy', alias: '@api' } } }));
    const ctx = testContext();
    const cacheDir = path.join(dir, CACHE_DIR);
    await runCheck(ctx, dir, { cacheDir });
    await runCheck(ctx, dir, { cacheDir });
    expect(ctx.adapter.analyzeCalls).toHaveLength(1);
    expect(ctx.adapter.analyzeCalls[0]!.links).toEqual([{ path: 'root/web/_/links/api', alias: '@api' }]);
    // A new provider folder in the link is a new published file, which no file of the analysis listed before.
    writeFile(dir, 'root/web/_/links/api/dmz/other/.external.ts', "export { a } from '@api/server/_/a';\n");
    await runCheck(ctx, dir, { cacheDir });
    expect(ctx.adapter.analyzeCalls).toHaveLength(2);
  });

  it('keys the cache on the files the adapter read, inside and outside the project', async () => {
    const outside = makeProject({ 'types/global.d.ts': 'declare const a: number;\n' }, false);
    const external = path.join(outside, 'types', 'global.d.ts');
    const dir = makeProject({ ...LOGGER_PROJECT, 'tsconfig.base.json': '{}\n' });
    const ctx = testContext({ extraInputs: ['tsconfig.base.json', external, 'node_modules/@types/x/index.d.ts'] });
    const cacheDir = path.join(dir, CACHE_DIR);
    await runCheck(ctx, dir, { cacheDir });
    await runCheck(ctx, dir, { cacheDir });
    expect(ctx.adapter.analyzeCalls).toHaveLength(1);
    // A config in the extends chain, which the first part of the key does not list.
    writeFile(dir, 'tsconfig.base.json', '{ "compilerOptions": { "strict": true } }\n');
    await runCheck(ctx, dir, { cacheDir });
    expect(ctx.adapter.analyzeCalls).toHaveLength(2);
    // A .d.ts outside the project, compared by size and modification time.
    writeFile(outside, 'types/global.d.ts', 'declare const a: string; // changed\n');
    await runCheck(ctx, dir, { cacheDir });
    expect(ctx.adapter.analyzeCalls).toHaveLength(3);
    // A type package that appears.
    writeFile(dir, 'node_modules/@types/x/index.d.ts', 'export {};\n');
    await runCheck(ctx, dir, { cacheDir });
    expect(ctx.adapter.analyzeCalls).toHaveLength(4);
    await runCheck(ctx, dir, { cacheDir });
    expect(ctx.adapter.analyzeCalls).toHaveLength(4);
  });

  it('does not cache an answer without inputs', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const ctx = testContext({ omitInputs: true });
    const cacheDir = path.join(dir, CACHE_DIR);
    await runCheck(ctx, dir, { cacheDir });
    await runCheck(ctx, dir, { cacheDir });
    expect(ctx.adapter.analyzeCalls).toHaveLength(2);
    expect(fileExists(dir, '.buckets/cache')).toBe(false);
  });

  it('ignores a malformed cache entry or one of another version', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const ctx = testContext();
    const cacheDir = path.join(dir, CACHE_DIR);
    const first = await runCheck(ctx, dir, { cacheDir });
    const [entryName] = readdirSync(cacheDir);
    const entryPath = path.join(cacheDir, entryName!);
    const entry = JSON.parse(readFileSync(entryPath, 'utf8')) as Record<string, unknown>;
    for (const broken of [
      { ...entry, analyze: { ...(entry.analyze as object), dmz: 5 } },
      { ...entry, analyze: { ...(entry.analyze as object), inputs: undefined } },
      { ...entry, version: 1 },
      { ...entry, inputs: 7 },
      { ...entry, analyze: { ...(entry.analyze as object), links: { 'root/web/_/links/api': { exports: 5 } } } },
    ]) {
      writeFileSync(entryPath, JSON.stringify(broken));
      const again = await runCheck(ctx, dir, { cacheDir });
      expect(again.report).toEqual(first.report);
    }
    expect(ctx.adapter.analyzeCalls).toHaveLength(6);
    writeFileSync(entryPath, '{ truncated');
    await runCheck(ctx, dir, { cacheDir });
    expect(ctx.adapter.analyzeCalls).toHaveLength(7);
  });

  it('can keep the cache in memory, and gives the same state key for the same files', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const ctx = testContext();
    const cache = memoryCache();
    const a = await runCheck(ctx, dir, { cache });
    const b = await runCheck(ctx, dir, { cache });
    expect(ctx.adapter.analyzeCalls).toHaveLength(1);
    expect(fileExists(dir, '.buckets')).toBe(false);
    expect(a.stateKey).toBeDefined();
    expect(b.stateKey).toBe(a.stateKey);
    writeFile(dir, 'root/log/_/logger.ts', 'export function logger(message: string, level: number): void {}\n');
    const c = await runCheck(ctx, dir, { cache });
    expect(c.stateKey).not.toBe(a.stateKey);
  });

  it('is used by buckets check, one entry per project, in the project where the check ran', async () => {
    const dir = await tree();
    const ctx = testContext();
    await main(ctx, fakeIo({ cwd: dir }), ['check']);
    await main(ctx, fakeIo({ cwd: dir }), ['check']);
    expect(ctx.adapter.analyzeCalls).toHaveLength(2);
    expect(fileExists(dir, '.buckets/cache')).toBe(true);
    expect(fileExists(dir, `${NESTED}/.buckets`)).toBe(false);
  });
});
