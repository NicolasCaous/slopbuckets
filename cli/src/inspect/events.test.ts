import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, LOGGER_PROJECT, makeProject, removeFile, writeFile } from '../testing/fixture.js';
import { approve, testContext } from '../testing/harness.js';
import { fileEvents, locateFile, snapshotEvents } from './events.js';
import { buildSnapshot } from './snapshot.js';
import { ignoredPath, watchProjects } from './watch.js';

afterEach(cleanupProjects);

const AT = new Date('2026-10-04T12:00:00.000Z');
const NESTED = 'root/log/_/engine';
const NESTED_FILES: Record<string, string> = {
  [`${NESTED}/buckets.config.json`]: '{ "root": "root", "alias": "@engine" }\n',
  [`${NESTED}/package.json`]: '{ "name": "engine" }\n',
  [`${NESTED}/root/_/run.ts`]: 'export const run = 1;\n',
};

describe('feed events', () => {
  it('names the project and bucket of changed files, one event per bucket', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, ...NESTED_FILES });
    const snapshot = await buildSnapshot(testContext(), dir);
    expect(locateFile(snapshot, path.join(dir, 'root/log/_/logger.ts'))).toEqual({ project: '.', file: 'root/log/_/logger.ts', bucket: 'root/log' });
    expect(locateFile(snapshot, path.join(dir, NESTED, 'root/_/run.ts'))).toEqual({ project: NESTED, file: 'root/_/run.ts', bucket: 'root' });
    expect(locateFile(snapshot, path.join(dir, 'root/dmz/log/billing.ts'))?.bucket).toBe('root');
    const events = fileEvents(snapshot, [path.join(dir, 'root/log/_/logger.ts'), path.join(dir, 'root/log/_/a.ts'), path.join(dir, NESTED, 'root/_/run.ts'), path.join(dir, 'package.json')], AT);
    expect(events.map((e) => [e.kind, e.project, e.text, e.bucket])).toEqual([
      ['file', '.', '2 files changed in bucket root/log', 'root/log'],
      ['file', NESTED, 'root/_/run.ts changed in bucket root', 'root'],
      ['file', '.', 'package.json changed', undefined],
    ]);
    expect(events[0]!.at).toBe(AT.toISOString());
  });

  it('reports violations and lock differences that appear and go away', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    const clean = await buildSnapshot(testContext(), dir);
    writeFile(dir, 'root/log/_/logger.ts', 'export function logger(message: string, level: number): void {}\n');
    writeFile(dir, 'root/billing/payments/_/pay.ts', "import x from './x';\nexport const pay = x;\n");
    const broken = await buildSnapshot(testContext(), dir);
    const added = snapshotEvents(clean, broken, AT);
    expect(added.map((e) => [e.kind, e.text])).toEqual([
      ['violation-added', 'Violation appeared: import-relative in root/billing/payments/_/pay.ts:1'],
      ['lock-added', 'Lock difference appeared: signature-changed root/billing/dmz/.parent/invoices.ts (logger)'],
      ['lock-added', 'Lock difference appeared: signature-changed root/dmz/log/billing.ts (logger)'],
    ]);
    expect(added[0]!.ref).toBe(broken.projects[0]!.violations[0]!.id);
    expect(snapshotEvents(broken, clean, AT).map((e) => e.kind)).toEqual(['violation-resolved', 'lock-resolved', 'lock-resolved']);
    expect(snapshotEvents(clean, clean, AT)).toEqual([]);
  });

  it('reports nested projects that appear and go away', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const before = await buildSnapshot(testContext(), dir);
    for (const [file, text] of Object.entries(NESTED_FILES)) writeFile(dir, file, text);
    const after = await buildSnapshot(testContext(), dir);
    expect(snapshotEvents(before, after, AT).filter((e) => e.kind.startsWith('project')).map((e) => e.text)).toEqual([`Nested project ${NESTED} appeared`]);
    removeFile(dir, NESTED);
    const gone = await buildSnapshot(testContext(), dir);
    expect(snapshotEvents(after, gone, AT).filter((e) => e.kind.startsWith('project')).map((e) => e.kind)).toEqual(['project-removed']);
  });
});

async function waitFor<T>(get: () => T | undefined, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('watchProjects', () => {
  it('ignores git, node_modules and the cache folder', () => {
    expect(ignoredPath('.buckets/cache/x.json')).toBe(true);
    expect(ignoredPath('root/a/_/node_modules/x/index.js')).toBe(true);
    expect(ignoredPath('.git\\HEAD')).toBe(true);
    expect(ignoredPath('root/a/_/x.ts')).toBe(false);
  });

  it.each([['polling', true], ['native', false]] as const)('reports changes together after a quiet period (%s)', async (_, polling) => {
    const dir = makeProject({ 'root/_/a.ts': 'export const a = 1;\n' });
    const batches: string[][] = [];
    const watcher = watchProjects({ dirs: [dir], onChange: (paths) => batches.push(paths), debounceMs: 120, pollMs: 40, polling });
    try {
      if (polling) expect(watcher.mode).toBe('polling');
      await new Promise((r) => setTimeout(r, 150));
      writeFile(dir, 'root/_/a.ts', 'export const a = 2;\n');
      writeFile(dir, 'root/_/b.ts', 'export const b = 1;\n');
      writeFile(dir, '.buckets/cache/x.json', '{}');
      const batch = await waitFor(() => batches.find((b) => b.some((p) => p.endsWith('b.ts'))));
      expect(batch.some((p) => p.endsWith('a.ts'))).toBe(true);
      expect(batches.flat().some((p) => p.includes('.buckets'))).toBe(false);
    } finally {
      watcher.close();
    }
  });

  it('stops reporting after close and follows update', async () => {
    const a = makeProject({ 'root/_/a.ts': 'export const a = 1;\n' });
    const b = makeProject({ 'root/_/b.ts': 'export const b = 1;\n' });
    const seen: string[] = [];
    const watcher = watchProjects({ dirs: [a], onChange: (paths) => seen.push(...paths), debounceMs: 60, pollMs: 30, polling: true });
    watcher.update([b]);
    await new Promise((r) => setTimeout(r, 80));
    writeFile(a, 'root/_/a.ts', 'export const a = 2;\n');
    writeFile(b, 'root/_/b.ts', 'export const b = 2;\n');
    await waitFor(() => (seen.some((p) => p.endsWith('b.ts')) ? true : undefined));
    expect(seen.some((p) => p.endsWith('a.ts'))).toBe(false);
    watcher.close();
    seen.length = 0;
    writeFile(b, 'root/_/b.ts', 'export const b = 3;\n');
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toEqual([]);
  });
});
