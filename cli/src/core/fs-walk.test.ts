import { mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, LOGGER_PROJECT, makeProject } from '../testing/fixture.js';
import { checkProject, pairs, testContext } from '../testing/harness.js';
import { DEFAULT_CONFIG } from './config.js';
import { listDir, listFilesRecursive } from './fs-walk.js';
import { scanProject } from './scan.js';

afterEach(cleanupProjects);

const options = { extensions: ['.ts', '.tsx'], dmzExtension: '.ts' };

/**
 * Creates a link at `link` pointing at the absolute `target`. Folders use a junction on Windows, which needs no
 * special permission, and a directory symlink elsewhere. Returns false when the system does not allow it.
 */
function tryLink(dir: string, target: string, link: string, kind: 'dir' | 'file' = 'dir'): boolean {
  const type = kind === 'dir' ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file';
  try {
    mkdirSync(path.dirname(path.join(dir, link)), { recursive: true });
    symlinkSync(path.join(dir, target), path.join(dir, link), type);
    return true;
  } catch {
    return false;
  }
}

describe('walking folders with links', () => {
  it('reports links as links and does not descend into them', ({ skip }) => {
    const dir = makeProject({ 'outside/secret.ts': '', 'base/real/a.ts': '' }, false);
    if (!tryLink(dir, 'outside', 'base/linked')) skip('cannot create links here');
    const entries = listDir(path.join(dir, 'base'));
    expect(entries).toEqual([
      { name: 'linked', isDir: false, isSymlink: true },
      { name: 'real', isDir: true, isSymlink: false },
    ]);
    expect(listFilesRecursive(path.join(dir, 'base'))).toEqual({ files: ['real/a.ts'], symlinks: ['linked'], projects: [] });
  });
});

describe('folder-symlink', () => {
  const scan = (dir: string) => scanProject(dir, DEFAULT_CONFIG, options);

  it('reports a junction inside _/ and keeps its files out of the analysis', async ({ skip }) => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'shared/util.ts': 'export const util = 1;\n' });
    if (!tryLink(dir, 'shared', 'root/log/_/shared')) skip('cannot create links here');
    const layout = scan(dir);
    expect(pairs(layout.violations)).toEqual(['folder-symlink root/log/_/shared']);
    expect(layout.codeFiles.some((f) => f.includes('shared'))).toBe(false);

    const ctx = testContext();
    const { report } = await checkProject(dir, {}, ctx);
    expect(pairs(report.violations)).toEqual(['folder-symlink root/log/_/shared']);
    expect(report.exitCode).toBe(1);
    expect(ctx.adapter.analyzeCalls[0]!.files.code.some((f) => f.includes('shared'))).toBe(false);
  });

  it('reports a linked child bucket once, without cascading DMZ errors', ({ skip }) => {
    const { 'root/log/_/logger.ts': logger, ...rest } = LOGGER_PROJECT;
    const dir = makeProject({ ...rest, 'elsewhere/_/logger.ts': logger! });
    if (!tryLink(dir, 'elsewhere', 'root/log')) skip('cannot create links here');
    const layout = scan(dir);
    expect(pairs(layout.violations)).toEqual(['folder-symlink root/log']);
    expect(layout.buckets.has('root/log')).toBe(false);
    expect(layout.codeFiles.some((f) => f.startsWith('root/log/'))).toBe(false);
    // root/dmz/log/billing.ts still names a known child, so it is not a dmz-path violation.
    expect(layout.dmzFiles.has('root/dmz/log/billing.ts')).toBe(true);
  });

  it('reports a linked _/ without also reporting folder-missing-code', ({ skip }) => {
    const { 'root/log/_/logger.ts': logger, ...rest } = LOGGER_PROJECT;
    const dir = makeProject({ ...rest, 'elsewhere/logger.ts': logger! });
    if (!tryLink(dir, 'elsewhere', 'root/log/_')) skip('cannot create links here');
    expect(pairs(scan(dir).violations)).toEqual(['folder-symlink root/log/_']);
  });

  it('reports a link inside dmz/', ({ skip }) => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'contracts/billing.ts': "export { logger } from '@root/log/_/logger';\n" });
    if (!tryLink(dir, 'contracts', 'root/dmz/extra')) skip('cannot create links here');
    const layout = scan(dir);
    expect(pairs(layout.violations)).toEqual(['folder-symlink root/dmz/extra']);
    expect([...layout.dmzFiles.keys()].some((f) => f.startsWith('root/dmz/extra'))).toBe(false);
  });

  it('reports a file symlink inside _/', ({ skip }) => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'outside.ts': 'export const o = 1;\n' });
    if (!tryLink(dir, 'outside.ts', 'root/_/outside.ts', 'file')) skip('file symlinks need extra permissions here');
    const layout = scan(dir);
    expect(pairs(layout.violations)).toEqual(['folder-symlink root/_/outside.ts']);
    expect(layout.codeFiles).not.toContain('root/_/outside.ts');
  });

  it('reports a root folder that is itself a link and scans nothing', ({ skip }) => {
    const files = Object.fromEntries(Object.entries(LOGGER_PROJECT).map(([k, v]) => [k.replace(/^root\//, 'real/'), v]));
    const dir = makeProject(files);
    if (!tryLink(dir, 'real', 'root')) skip('cannot create links here');
    const layout = scan(dir);
    expect(pairs(layout.violations)).toEqual(['folder-symlink root']);
    expect(layout.codeFiles).toEqual([]);
  });
});
