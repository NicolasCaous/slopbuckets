import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, LOGGER_PROJECT, makeProject, removeFile, writeFile } from '../testing/fixture.js';
import { approve, checkProject, pairs, testContext } from '../testing/harness.js';
import { DEFAULT_CONFIG } from './config.js';
import { readLock, serializeLock, writeLockFile } from './lock.js';
import { lockConfigHash } from './lock-config.js';
import { aggregateExitCode, discoverProjects, joinReports, runRecursiveCheck } from './recursive.js';
import { scanProject } from './scan.js';
import type { CheckReport } from './types.js';

afterEach(cleanupProjects);

const SCAN = { extensions: ['.ts'], dmzExtension: '.ts' };

/** A nested project at root/billing/_/engine with its own root bucket. */
const NESTED: Record<string, string> = {
  'root/billing/_/engine/buckets.config.json': '{ "root": "root", "alias": "@engine" }\n',
  'root/billing/_/engine/package.json': '{ "name": "engine" }\n',
  'root/billing/_/engine/root/_/run.ts': 'export const run = 1;\n',
};

describe('nested projects in the scan', () => {
  it('finds a project in a subfolder of _/ at any depth and does not list its files', () => {
    const dir = makeProject({ ...LOGGER_PROJECT, ...NESTED, 'root/log/_/vendor/deep/tool/buckets.config.json': '{}\n', 'root/log/_/vendor/deep/tool/root/_/x.ts': '' });
    const layout = scanProject(dir, DEFAULT_CONFIG, SCAN);
    expect(layout.nestedProjects).toEqual(['root/billing/_/engine', 'root/log/_/vendor/deep/tool']);
    expect(layout.codeFiles.filter((f) => f.includes('engine') || f.includes('tool'))).toEqual([]);
    expect(layout.violations).toEqual([]);
  });

  it.each([
    ['root/log/buckets.config.json', 'a config in a bucket folder'],
    ['root/buckets.config.json', 'a config in the root bucket folder'],
    ['root/log/_/buckets.config.json', 'a config directly in _/'],
    ['root/dmz/buckets.config.json', 'a config directly in dmz/'],
    ['root/dmz/log/sub/buckets.config.json', 'a config inside dmz/'],
    ['root/extra/buckets.config.json', 'a folder at bucket level that holds a config'],
  ])('reports project-misplaced for %s (%s)', (file) => {
    const dir = makeProject({ ...LOGGER_PROJECT, [file]: '{}\n', 'root/extra/_/a.ts': '' });
    const layout = scanProject(dir, DEFAULT_CONFIG, SCAN);
    expect(pairs2(layout.violations)).toEqual([`project-misplaced ${file}`]);
  });

  it('treats a misplaced project folder at bucket level as opaque', () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/extra/buckets.config.json': '{}\n', 'root/extra/notes.md': '', 'root/extra/root/_/a.ts': '' });
    const layout = scanProject(dir, DEFAULT_CONFIG, SCAN);
    expect(pairs2(layout.violations)).toEqual(['project-misplaced root/extra/buckets.config.json']);
    expect(layout.buckets.has('root/extra')).toBe(false);
  });
});

function pairs2(violations: { rule: string; file: string }[]): string[] {
  return violations.map((v) => `${v.rule} ${v.file}`).sort();
}

describe('nested projects in the check of the parent', () => {
  it('records nested projects in the lock and reports project-added and project-removed', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    for (const [file, content] of Object.entries(NESTED)) writeFile(dir, file, content);
    let result = await checkProject(dir);
    expect(result.report.lockChanges.map((c) => `${c.kind} ${c.path}`)).toEqual(['project-added root/billing/_/engine']);
    expect(result.report.exitCode).toBe(2);
    expect(result.lock?.projects).toEqual(['root/billing/_/engine']);
    await approve(dir);
    removeFile(dir, 'root/billing/_/engine');
    result = await checkProject(dir);
    expect(result.report.lockChanges.map((c) => `${c.kind} ${c.path}`)).toEqual(['project-removed root/billing/_/engine']);
  });

  it('forbids imports from the parent into a nested project and contracts that point into it', async () => {
    const dir = makeProject({
      ...LOGGER_PROJECT,
      ...NESTED,
      'root/billing/_/use.ts': "import { run } from '@root/billing/_/engine/root/_/run';\nexport const x = run;\n",
      'root/dmz/billing/.self.ts': "export { run } from '@root/billing/_/engine/root/_/run';\n",
      'root/_/main.ts': "import { run } from '@root/dmz/billing/.self';\nexport const main = run;\n",
    });
    const { report } = await checkProject(dir);
    const forbidden = report.violations.find((v) => v.rule === 'import-forbidden');
    expect(forbidden?.file).toBe('root/billing/_/use.ts');
    expect(forbidden?.message).toContain('separate slopbuckets project');
    expect(forbidden?.message).toContain('buckets link add');
    expect(report.violations.find((v) => v.rule === 'dmz-target')?.message).toContain('inside the nested project root/billing/_/engine/');
  });

  it('reads a lock of version 1 without the new sections and keeps comparing it', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const lock = await approve(dir);
    writeFileSync(path.join(dir, 'buckets.lock.json'), serializeLock({ ...lock, lockVersion: 1, config: lockConfigHash(lock.config) }));
    const result = await checkProject(dir);
    expect(result.report.exitCode).toBe(0);
    expect(result.previousLock?.lockVersion).toBe(1);
  });

  it('refuses a lock written in a newer format', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const lock = await approve(dir);
    writeFileSync(path.join(dir, 'buckets.lock.json'), serializeLock({ ...lock, lockVersion: 9 as 2 }));
    const result = await checkProject(dir);
    expect(result.report.environment?.code).toBe('cli-version');
  });
});

describe('recursive check', () => {
  async function tree(): Promise<string> {
    const dir = makeProject({ ...LOGGER_PROJECT, ...NESTED, 'root/billing/_/engine/root/_/inner/buckets.config.json': '{ "alias": "@inner" }\n', 'root/billing/_/engine/root/_/inner/root/_/i.ts': '' });
    await approve(dir);
    await approve(path.join(dir, 'root/billing/_/engine'));
    await approve(path.join(dir, 'root/billing/_/engine/root/_/inner'));
    return dir;
  }

  it('checks the project and every nested one, in tree order, and adds project to every item', async () => {
    const dir = await tree();
    writeFile(dir, 'root/billing/_/engine/root/_/inner/root/_/i.ts', "import x from './x';\n");
    const { report, runs } = await runRecursiveCheck(testContext(), dir);
    expect(runs.map((r) => r.path)).toEqual(['.', 'root/billing/_/engine', 'root/billing/_/engine/root/_/inner']);
    expect(report.projects).toEqual([
      { path: '.', exitCode: 0 },
      { path: 'root/billing/_/engine', exitCode: 0 },
      { path: 'root/billing/_/engine/root/_/inner', exitCode: 1 },
    ]);
    expect(report.violations).toEqual([expect.objectContaining({ rule: 'import-relative', file: 'root/_/i.ts', project: 'root/billing/_/engine/root/_/inner' })]);
    expect(report.exitCode).toBe(1);
  });

  it('checks only the current project with recursive: false', async () => {
    const dir = await tree();
    const { runs } = await runRecursiveCheck(testContext(), dir, { recursive: false });
    expect(runs.map((r) => r.path)).toEqual(['.']);
  });

  it('never goes up to the parent when it starts in a nested project', async () => {
    const dir = await tree();
    const { runs } = await runRecursiveCheck(testContext(), path.join(dir, 'root/billing/_/engine'));
    expect(runs.map((r) => r.path)).toEqual(['.', 'root/_/inner']);
  });

  it('lists the projects without analyzing code', async () => {
    const dir = await tree();
    const ctx = testContext();
    expect(discoverProjects(ctx, dir).map((p) => p.path)).toEqual(['.', 'root/billing/_/engine', 'root/billing/_/engine/root/_/inner']);
    expect(ctx.adapter.analyzeCalls).toEqual([]);
  });

  it('aggregates exit codes: 3, then 1, then 2, then 0', () => {
    expect(aggregateExitCode([0, 2, 1, 3])).toBe(3);
    expect(aggregateExitCode([2, 1, 0])).toBe(1);
    expect(aggregateExitCode([0, 2])).toBe(2);
    expect(aggregateExitCode([0, 0])).toBe(0);
    const env: CheckReport = { exitCode: 3, violations: [], lockChanges: [], environment: { code: 'no-tsconfig', message: 'no tsconfig' } };
    const joined = joinReports([
      { path: '.', report: { exitCode: 2, violations: [], lockChanges: [{ kind: 'lock-missing', path: 'buckets.lock.json', message: 'm' }] } },
      { path: 'a/_/b', report: env },
    ]);
    expect(joined.exitCode).toBe(3);
    expect(joined.environment).toEqual({ code: 'no-tsconfig', message: 'In the nested project a/_/b: no tsconfig' });
    expect(joined.lockChanges[0]!.project).toBe('.');
  });

  it('reports a nested project without a lock as lock-missing in that project only', async () => {
    const dir = await tree();
    removeFile(dir, 'root/billing/_/engine/buckets.lock.json');
    const { report } = await runRecursiveCheck(testContext(), dir);
    expect(report.lockChanges.map((c) => `${c.project} ${c.kind}`)).toEqual(['root/billing/_/engine lock-missing']);
    expect(report.exitCode).toBe(2);
  });

  it('writes nested locks that list their own nested projects', async () => {
    const dir = await tree();
    const lock = readLock(path.join(dir, 'root/billing/_/engine'));
    expect(lock.kind === 'ok' && lock.lock.projects).toEqual(['root/_/inner']);
    const top = readLock(dir);
    expect(top.kind === 'ok' && top.lock.projects).toEqual(['root/billing/_/engine']);
    expect(top.kind === 'ok' && top.lock.lockVersion).toBe(4);
    await writeLockFile(dir, top.kind === 'ok' ? top.lock : (undefined as never));
    expect(pairs((await checkProject(dir)).report.violations)).toEqual([]);
  });
});
