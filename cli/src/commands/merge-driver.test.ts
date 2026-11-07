import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanupProjects, fileExists, makeProject, readFile, TMP_ROOT, writeFile } from '../testing/fixture.js';
import { formatConfig } from './fmt.js';
import { installMergeDriver, mergeConfigs, uninstallMergeDriver } from './merge-driver.js';

afterEach(cleanupProjects);

const bucket = (name: string, dependsOn: Record<string, string> = {}) => ({ purpose: `Keeps the ${name} rules and records`, files: [`src/${name}/**`], public: null, dependsOn, packages: {} });
const config = (buckets: Record<string, unknown>) => formatConfig({ version: '2.0', buckets });

/** A driver script for git, called as `<driver> merge-driver %O %A %B`: the merge driver bundled with esbuild, since the unit tests run without a build. */
let driver: string;
beforeAll(() => {
  // In the run folder itself, which stays until this file ends, unlike the projects that afterEach removes.
  const dir = path.join(TMP_ROOT, 'driver');
  const source = fileURLToPath(new URL('./merge-driver.ts', import.meta.url)).split(path.sep).join('/');
  writeFile(dir, 'entry.mjs', `import { mergeDriverCommand } from '${source}';\nconst io = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t), cwd: process.cwd() };\nprocess.exitCode = await mergeDriverCommand({}, io, process.argv.slice(3));\n`);
  driver = path.join(dir, 'driver.mjs');
  buildSync({ entryPoints: [path.join(dir, 'entry.mjs')], bundle: true, platform: 'node', format: 'esm', outfile: driver, logLevel: 'silent' });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
}

/** A repository whose main branch has `base`, with branches a and b that each commit their config, then a merge of b into a. */
function mergeBranches(base: string, a: string, b: string) {
  const dir = makeProject({ 'buckets.config.json': base }, false);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
  expect(installMergeDriver(dir, `node "${driver.split(path.sep).join('/')}"`).map((s) => s.status)).toEqual(['done', 'done']);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  for (const [branch, text] of [['a', a], ['b', b]] as const) {
    git(dir, 'checkout', '-qb', branch, 'main');
    writeFile(dir, 'buckets.config.json', text);
    git(dir, 'commit', '-qam', branch);
  }
  git(dir, 'checkout', '-q', 'a');
  const merge = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '--no-edit', 'b'], { cwd: dir, encoding: 'utf8' });
  return { dir, status: merge.status, result: readFile(dir, 'buckets.config.json') };
}

describe('buckets merge-driver', () => {
  it('git merges two branches that each add a dependency to the same bucket', () => {
    const base = config({ app: bucket('app', { log: 'Logs startup' }), billing: bucket('billing'), log: bucket('log'), payments: bucket('payments') });
    const a = config({ app: bucket('app', { billing: 'Mounts the invoice routes', log: 'Logs startup' }), billing: bucket('billing'), log: bucket('log'), payments: bucket('payments') });
    const b = config({ app: bucket('app', { log: 'Logs startup', payments: 'Mounts the webhook' }), billing: bucket('billing'), log: bucket('log'), payments: bucket('payments') });
    const { status, result } = mergeBranches(base, a, b);
    expect(status).toBe(0);
    expect(JSON.parse(result).buckets.app.dependsOn).toEqual({ billing: 'Mounts the invoice routes', log: 'Logs startup', payments: 'Mounts the webhook' });
    expect(result).toBe(formatConfig(JSON.parse(result)));
  });

  it('git merges two branches that each add a bucket', () => {
    const base = config({ app: bucket('app') });
    const { status, result } = mergeBranches(base, config({ app: bucket('app'), billing: bucket('billing') }), config({ app: bucket('app'), auth: bucket('auth') }));
    expect(status).toBe(0);
    expect(Object.keys(JSON.parse(result).buckets)).toEqual(['app', 'auth', 'billing']);
  });

  it('puts conflict markers around a bucket both sides changed differently, and exits with 1', () => {
    const base = config({ app: bucket('app', { log: 'Logs startup' }), log: bucket('log') });
    const a = config({ app: bucket('app', { log: 'Logs startup and shutdown' }), log: bucket('log') });
    const b = config({ app: bucket('app', { log: 'Logs every request' }), log: bucket('log') });
    const { status, result } = mergeBranches(base, a, b);
    expect(status).not.toBe(0);
    expect(result).toMatch(/^<<<<<<< ours\n {4}"app": \{\n[\s\S]*"log": "Logs startup and shutdown"[\s\S]*\n=======\n {4}"app": \{\n[\s\S]*"log": "Logs every request"[\s\S]*\n>>>>>>> theirs\n {4}"log": \{/m);
  });

  it('merges glob lists as sets and keeps removals', () => {
    const base = { version: '2.0', ignore: ['a/**', 'b/**'], buckets: {} };
    const merged = mergeConfigs(base, { ...base, ignore: ['a/**', 'b/**', 'c/**'] }, { ...base, ignore: ['b/**', 'd/**'] });
    expect(merged).toEqual({ value: { version: '2.0', ignore: ['b/**', 'c/**', 'd/**'], buckets: {} }, conflicts: 0 });
  });

  it('installMergeDriver keeps what is already set up', () => {
    const dir = makeProject({ '.gitattributes': '*.png binary\n' }, false);
    git(dir, 'init', '-q');
    expect(installMergeDriver(dir, 'buckets').map((s) => s.status)).toEqual(['done', 'done']);
    expect(installMergeDriver(dir, 'buckets').map((s) => s.status)).toEqual(['kept', 'kept']);
    expect(readFile(dir, '.gitattributes')).toBe('*.png binary\nbuckets.config.json merge=slopbuckets\n');
    expect(git(dir, 'config', '--get', 'merge.slopbuckets.driver').trim()).toBe('buckets merge-driver %O %A %B');
  });

  it('uninstallMergeDriver removes the line and the git config, and keeps the other attributes', () => {
    const dir = makeProject({ '.gitattributes': '*.png binary\n' }, false);
    git(dir, 'init', '-q');
    installMergeDriver(dir, 'buckets');
    expect(uninstallMergeDriver(dir).map((s) => s.status)).toEqual(['done', 'done']);
    expect(readFile(dir, '.gitattributes')).toBe('*.png binary\n');
    expect(spawnSync('git', ['config', '--get-regexp', '^merge\\.slopbuckets\\.'], { cwd: dir }).status).toBe(1);
    expect(uninstallMergeDriver(dir)).toEqual([]);
    installMergeDriver(dir, 'buckets');
    writeFile(dir, '.gitattributes', 'buckets.config.json merge=slopbuckets\n');
    expect(uninstallMergeDriver(dir)[0]!.text).toBe('Removed .gitattributes, which held only the slopbuckets merge driver line');
    expect(fileExists(dir, '.gitattributes')).toBe(false);
  });
});
