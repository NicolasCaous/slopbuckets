// Edge cases of checkEdit, recheck and the cache: agreement with checkAll, caches of another clone or shape, links
// and the case of paths.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import v8 from 'node:v8';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CheckResult } from '../contract/engine.js';
import { ensureBucketsDir } from '../files/paths.js';
import { cleanupProjects, makeProject, writeFile } from '../testing/fixture.js';
import { BASE_FILES, baseConfig, check, engine, git, keys, project, rules, TSCONFIG } from './engine-test-kit.js';
import { readFromGit } from './files.js';

// Wrapped, so a test can make one read from git slow.
vi.mock('./files.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('./files.js')>();
  return { ...m, readFromGit: vi.fn(m.readFromGit) };
});

afterEach(cleanupProjects);

describe('edge cases of checkEdit, recheck and the cache', () => {
  const PRIVATE = "import { charge } from '../payments/charge';\nconsole.log(charge);\n";
  const caseInsensitive = process.platform !== 'linux';
  const commit = (dir: string, message: string) => git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', message);

  /** checkEdit of `edits` equals checkAll once they are written. */
  async function agrees(dir: string, edits: { path: string; content: string }[]): Promise<CheckResult> {
    const simulated = await engine().checkEdit(dir, edits);
    for (const x of edits) writeFile(dir, x.path, x.content);
    const full = await engine().checkAll(dir);
    expect(keys(simulated.violations)).toEqual(keys(full.violations));
    return full;
  }

  it('waits for every process it started before it returns', async () => {
    let done = false;
    vi.mocked(readFromGit).mockImplementationOnce(() => new Promise((resolve) => setImmediate(() => ((done = true), resolve(new Map())))));
    await engine().checkAll(project(BASE_FILES));
    expect(done).toBe(true);
  });

  it('reports a glob that cannot compile as config-invalid, in checkAll and checkEdit', async () => {
    const bad = baseConfig((c) => c.buckets.billing.files.push('src/[z-a].ts'));
    const r = await check(BASE_FILES, bad);
    expect(r.exitCode).toBe(1);
    expect(rules(r)).toEqual(['config-invalid']);
    const dir = project(BASE_FILES);
    expect(rules(await engine().checkEdit(dir, { path: 'buckets.config.json', content: JSON.stringify(bad) }))).toEqual(['config-invalid']);
  });

  it('leaves a new edited file that git ignores, or in a dot folder outside git, out of checkEdit', async () => {
    const dir = project({ ...BASE_FILES, '.gitignore': 'dist/\n' });
    await engine().checkAll(dir);
    expect((await agrees(dir, [{ path: 'dist/out.js', content: 'export const o = 1;\n' }])).violations).toEqual([]);
    const plain = project(BASE_FILES, baseConfig(), { git: false });
    await engine().checkAll(plain);
    expect((await agrees(plain, [{ path: '.tools/x.ts', content: 'export const o = 1;\n' }])).violations).toEqual([]);
  });

  it('follows a config edit that changes projects, in checkEdit and recheck', async () => {
    const files = { ...BASE_FILES, 'packages/sdk/tsconfig.json': TSCONFIG, 'packages/sdk/buckets.config.json': JSON.stringify({ version: '2.0', buckets: {} }), 'packages/sdk/src/a.ts': 'export const a = 1;\n' };
    const nested = JSON.stringify(baseConfig((c) => (c.projects = ['packages/sdk'])), null, 2);
    const flat = JSON.stringify(baseConfig(), null, 2);
    const dir = project(files, flat);
    const before = (await engine().checkAll(dir)).violations;
    expect(rules(before)).toEqual(['file-unowned', 'project-undeclared']);
    await agrees(dir, [{ path: 'buckets.config.json', content: nested }]);
    await agrees(dir, [{ path: 'buckets.config.json', content: flat }]);
    // a shell edit of the config, then recheck
    writeFile(dir, 'buckets.config.json', nested);
    const live = await engine().recheck(dir, before);
    const now = keys((await engine().checkAll(dir, { recursive: false })).violations);
    expect(keys(live)).toEqual(keys(before).filter((k) => now.includes(k)));
  });

  it('resolves every file again after a tsconfig change, in checkEdit and recheck', async () => {
    const dir = project({ ...BASE_FILES, 'src/billing/charge.ts': 'export const charge = 2;\n', 'src/billing/main.ts': "import { charge } from '@p/charge';\nconsole.log(charge);\n" });
    const before = (await engine().checkAll(dir)).violations;
    expect(rules(before)).toEqual(['import-private']);
    // @p now points into billing itself: the private import is gone, though main.ts did not change
    writeFile(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', paths: { '@p/*': ['./src/billing/*'] } } }));
    expect(rules(await engine().recheck(dir, before))).toEqual([]);
    await agrees(dir, [{ path: 'src/billing/other.ts', content: 'export const o = 1;\n' }]);
  });

  it('starts over after a cache that came from another clone, even with the right version', async () => {
    const dir = project(BASE_FILES);
    await engine().checkAll(dir);
    // Plant the graph of the clean project under the blob of a file with a private import, as a pull request could.
    writeFile(dir, 'src/billing/main.ts', PRIVATE);
    git(dir, 'add', '-A');
    const blob = execFileSync('git', ['ls-files', '-s', 'src/billing/main.ts'], { cwd: dir, encoding: 'utf8' }).split(' ')[1]!;
    const file = path.join(dir, '.buckets', 'cache', 'graph.bin');
    const raw = v8.deserialize(readFileSync(file)) as any;
    const list = raw.graph.files[1].split('\0') as string[];
    const blobs = raw.graph.blob[1].split('\0') as string[];
    blobs[list.indexOf('src/billing/main.ts')] = blob;
    raw.graph.blob[1] = blobs.join('\0');
    writeFileSync(file, v8.serialize(raw));
    git(dir, 'add', '-A', '-f');
    commit(dir, 'cache');
    const clone = `${dir}-clone`;
    execFileSync('git', ['clone', '-q', dir, clone]);
    try {
      expect(existsSync(path.join(clone, '.buckets', 'cache', 'graph.bin'))).toBe(true);
      expect(rules(await engine().checkAll(clone))).toEqual(['import-private']);
    } finally {
      rmSync(clone, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('rebuilds a cache of another shape instead of failing', async () => {
    const dir = project({ ...BASE_FILES, 'src/billing/main.ts': PRIVATE });
    const all = (await engine().checkAll(dir)).violations;
    const at = (name: string) => path.join(dir, '.buckets', 'cache', name);
    const raw = v8.deserialize(readFileSync(at('graph.bin'))) as any;
    raw.graph.target[0] = 99_999;
    writeFileSync(at('graph.bin'), v8.serialize(raw));
    expect(keys((await engine().checkAll(dir)).violations)).toEqual(keys(all));
    const state = JSON.parse(readFileSync(at('state.json'), 'utf8'));
    writeFileSync(at('state.json'), JSON.stringify({ ...state, keys: 5 }));
    writeFileSync(at('edits.json'), JSON.stringify({ ...state, stats: null }));
    expect(keys(await engine().recheck(dir, all))).toEqual(keys(all));
    expect(rules(await engine().checkEdit(dir, { path: 'src/billing/x.ts', content: 'export {};\n' }))).toEqual(rules(all));
  });

  it('keeps the type-only exports of files it does not read again in graph.bin', async () => {
    const main = "import { Fee } from '../payments/fee';\nexport const f: Fee = { n: 1 };\n";
    const dir = project({ ...BASE_FILES, 'src/payments/fee.ts': 'export interface Fee { n: number }\nexport type Rate = number;\n', 'src/billing/main.ts': main });
    const privateImport = (r: CheckResult) => r.violations.find((v) => v.rule === 'import-private');
    const first = privateImport(await engine().checkAll(dir));
    expect(JSON.stringify(first)).toContain('"isType":true');
    // A new engine reads graph.bin, and only main.ts changed: the type names of fee.ts come from the cache.
    writeFile(dir, 'src/billing/main.ts', `${main}// touched\n`);
    expect(privateImport(await engine().checkAll(dir))).toEqual(first);
  });

  it('writes nothing through a .buckets folder that is a link', async () => {
    const dir = project(BASE_FILES);
    const outside = makeProject({ 'cache/edits.json': '{}' }, false);
    symlinkSync(outside, path.join(dir, '.buckets'), 'junction');
    expect((await engine().checkAll(dir)).violations).toEqual([]);
    expect(readdirSync(path.join(outside, 'cache'))).toEqual(['edits.json']);
    expect(ensureBucketsDir(dir, 'sessions')).toBeNull();
    const other = makeProject({}, false);
    expect(ensureBucketsDir(other, 'sessions')).toBe(path.join(other, '.buckets', 'sessions'));
    expect(ensureBucketsDir(path.join(other, 'missing'), 'sessions')).toBeNull();
  });

  it.skipIf(!caseInsensitive)('knows the config under another case of its path', async () => {
    const dir = project(BASE_FILES);
    const broken = '{ "buckets": { "billing": {} } }';
    const lower = dir[0]!.toLowerCase() + dir.slice(1);
    for (const p of [path.join(lower, 'buckets.config.json'), 'Buckets.Config.json']) {
      expect(rules(await engine().checkEdit(dir, { path: p, content: broken })), p).toContain('config-invalid');
    }
  });

  it.skipIf(!caseInsensitive)('lists the untracked files of a project named with another case', async () => {
    const repo = makeProject({ 'README.md': 'repo\n' }, false);
    for (const [f, t] of Object.entries({ ...BASE_FILES, 'buckets.config.json': JSON.stringify(baseConfig()), 'tsconfig.json': TSCONFIG })) writeFile(repo, `App/${f}`, t);
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    writeFile(repo, 'App/src/stray.ts', 'export {};\n');
    expect(rules(await engine().checkAll(path.join(repo, 'app')))).toEqual(['file-unowned']);
  });

  it.skipIf(!caseInsensitive)('keeps the listed name of a file renamed only in case', async () => {
    const dir = project({ ...BASE_FILES, 'src/billing/Util.ts': PRIVATE });
    await engine().checkAll(dir);
    renameSync(path.join(dir, 'src/billing/Util.ts'), path.join(dir, 'src/billing/util.ts'));
    await agrees(dir, [{ path: 'src/billing/main.ts', content: "import { charge } from '../payments';\nconsole.log(charge(3));\n" }]);
    await agrees(dir, [{ path: 'src/billing/util.ts', content: PRIVATE.replace('(charge)', '(charge, 1)') }]);
  });
});
