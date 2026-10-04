import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { linkCommand } from '../commands/link.js';
import { cleanupProjects, LOGGER_PROJECT, makeProject } from '../testing/fixture.js';
import { approve, fakeIo, testContext } from '../testing/harness.js';
import { bucketImpact, codeExports, cycleThrough, externalImpact, specifierOf, symbolPath, type SymbolPath } from './impact.js';
import { buildSnapshot, type InspectSnapshot } from './snapshot.js';

const NESTED = 'root/log/_/engine';

/** The SPEC example, a nested project that publishes `Engine`, and web, which links it and uses `logger`. */
async function project(): Promise<string> {
  const dir = makeProject({
    ...LOGGER_PROJECT,
    'root/log/_/levels.ts': "export type Level = 'info' | 'warn';\nexport const levels = ['info', 'warn'];\n",
    'root/web/_/app.ts': "import type { Engine } from '@engine/dmz/core/.external';\nimport { logger } from '@root/dmz/log/web';\nexport const name = (e: Engine): string => { logger(e.name); return e.name; };\n",
    'root/dmz/log/web.ts': "export { logger } from '@root/log/_/logger';\n",
    [`${NESTED}/buckets.config.json`]: '{ "root": "root", "alias": "@engine" }\n',
    [`${NESTED}/package.json`]: '{ "name": "engine" }\n',
    [`${NESTED}/root/_/run.ts`]: 'export const run = 1;\n',
    [`${NESTED}/root/core/_/engine.ts`]: 'export interface Engine {\n  name: string;\n}\n',
    [`${NESTED}/root/dmz/core/.external.ts`]: "export type { Engine } from '@engine/core/_/engine';\n",
  });
  await linkCommand(testContext(), fakeIo({ cwd: dir }), ['add', 'engine', NESTED, '--bucket', 'root/web', '--copy']);
  await approve(dir);
  await approve(path.join(dir, NESTED));
  return dir;
}

let snapshot: InspectSnapshot;
beforeAll(async () => {
  snapshot = await buildSnapshot(testContext(), await project(), { now: new Date('2026-10-04T12:00:00.000Z') });
});
afterAll(cleanupProjects);

function route(symbol: string, declaredIn: string, consumer: string, typeOnly = false): SymbolPath {
  const result = symbolPath(snapshot, { project: '.', symbol, declaredIn, consumer, typeOnly });
  if ('problem' in result) throw new Error(result.problem);
  return result;
}

describe('bucket removal', () => {
  it('lists the contracts, symbols, importing files and buckets that break, through re-export chains', () => {
    const impact = bucketImpact(snapshot, '.', 'root/log')!;
    expect(impact.removed).toEqual(['root/log']);
    expect(impact.nested).toEqual([NESTED]);
    expect(impact.contracts.map((c) => [c.file, c.reason, c.symbols])).toEqual([
      ['root/billing/dmz/.parent/invoices.ts', 'broken', ['logger']],
      ['root/dmz/log/billing.ts', 'broken', ['logger']],
      ['root/dmz/log/web.ts', 'broken', ['logger']],
    ]);
    expect(impact.symbols).toEqual([{ name: 'logger', origin: 'root/log', declaredIn: 'root/log/_/logger.ts', carriers: ['root/billing/dmz/.parent/invoices.ts', 'root/dmz/log/billing.ts', 'root/dmz/log/web.ts'] }]);
    expect(impact.files.map((f) => `${f.file}:${f.line} ${f.symbols.join()} ${f.via}`)).toEqual([
      'root/billing/invoices/_/create-invoice.ts:1 logger root/billing/dmz/.parent/invoices.ts',
      'root/web/_/app.ts:2 logger root/dmz/log/web.ts',
    ]);
    expect(impact.buckets).toEqual(['root/billing/invoices', 'root/web']);
  });

  it('takes the sub-buckets, their contracts and the projects nested in them, and names the projects that link them', () => {
    const billing = bucketImpact(snapshot, '.', 'root/billing')!;
    expect(billing.removed).toEqual(['root/billing', 'root/billing/invoices', 'root/billing/payments']);
    expect(billing.contracts).toEqual([expect.objectContaining({ file: 'root/billing/dmz/.parent/invoices.ts', reason: 'removed' })]);
    expect(billing.files).toEqual([]);
    const log = bucketImpact(snapshot, '.', 'root/log')!;
    expect(log.external).toEqual([
      {
        project: NESTED,
        file: 'root/dmz/core/.external.ts',
        reason: 'project',
        symbols: ['Engine'],
        consumers: [{ project: '.', link: 'root/web/_/links/engine', name: 'engine', mode: 'copy', state: 'ok', files: [{ file: 'root/web/_/app.ts', line: 1, names: ['Engine'] }] }],
      },
    ]);
  });

  it('follows published files of the project itself to the projects that link them', () => {
    const core = bucketImpact(snapshot, NESTED, 'root/core')!;
    expect(core.external).toEqual([expect.objectContaining({ project: NESTED, file: 'root/dmz/core/.external.ts', reason: 'contract', consumers: [expect.objectContaining({ project: '.', name: 'engine' })] })]);
    expect(bucketImpact(snapshot, '.', 'root/nope')).toBeNull();
  });
});

describe('symbol path', () => {
  it('builds the SPEC example and marks the files that already pass the symbol on', () => {
    const result = route('logger', 'root/log/_/logger.ts', 'root/billing/invoices');
    expect(result.steps.map((s) => [s.level, s.file, s.role, s.status, s.line])).toEqual([
      [0, 'root/dmz/log/billing.ts', 'across', 'present', "export { logger } from '@root/log/_/logger';"],
      [1, 'root/billing/dmz/.parent/invoices.ts', 'down', 'present', "export { logger } from '@root/dmz/log/billing';"],
    ]);
    expect(result.importLine).toBe("import { logger } from '@root/billing/dmz/.parent/invoices';");
    expect(result.cycle).toBeNull();
  });

  it('writes new files and lines for a new consumer, with export type for types', () => {
    const result = route('Level', 'root/log/_/levels.ts', 'root/billing/payments', true);
    expect(result.steps.map((s) => [s.file, s.status, s.line])).toEqual([
      ['root/dmz/log/billing.ts', 'add', "export type { Level } from '@root/log/_/levels';"],
      ['root/billing/dmz/.parent/payments.ts', 'create', "export type { Level } from '@root/dmz/log/billing';"],
    ]);
    expect(result.importLine).toBe("import type { Level } from '@root/billing/dmz/.parent/payments';");
  });

  it('goes up through .parent, to the parent through .self and down from .self', () => {
    const up = route('logger', 'root/log/_/logger.ts', 'root');
    expect(up.steps.map((s) => [s.file, s.role])).toEqual([['root/dmz/log/.self.ts', 'to-parent']]);
    const across = route('pay', 'root/billing/payments/_/pay.ts', 'root/log');
    expect(across.steps.map((s) => [s.file, s.role, s.from])).toEqual([
      ['root/billing/dmz/payments/.parent.ts', 'up', 'root/billing/payments/_/pay.ts'],
      ['root/dmz/billing/log.ts', 'across', 'root/billing/dmz/payments/.parent.ts'],
    ]);
    const down = route('main', 'root/_/main.ts', 'root/billing/invoices');
    expect(down.steps.map((s) => [s.file, s.role])).toEqual([
      ['root/dmz/.self/billing.ts', 'self'],
      ['root/billing/dmz/.parent/invoices.ts', 'down'],
    ]);
    expect(down.steps[1]!.status).toBe('add');
    const same = route('logger', 'root/log/_/logger.ts', 'root/log');
    expect(same.steps).toEqual([]);
    expect(same.note).toContain('own _/ folder');
    expect(same.importLine).toBe("import { logger } from '@root/log/_/logger';");
  });

  it('warns when the import would close a cycle and refuses files outside _/', () => {
    // billing/invoices imports logger from log, so log importing from invoices closes a cycle.
    const result = route('x', 'root/billing/invoices/_/create-invoice.ts', 'root/log');
    expect(result.cycle).toEqual(['root/log', 'root/billing/invoices', 'root/log']);
    expect(cycleThrough(snapshot.projects[0]!, 'root/billing/invoices', 'root/log')).toBeNull();
    expect(symbolPath(snapshot, { project: '.', symbol: 'logger', declaredIn: 'root/dmz/log/billing.ts', consumer: 'root/web' })).toEqual({ problem: 'root/dmz/log/billing.ts is not a file in the _/ folder of a bucket. Pick a symbol from the list.' });
    expect(symbolPath(snapshot, { project: '.', symbol: 'logger', declaredIn: 'root/log/_/logger.ts', consumer: 'root/zzz' })).toHaveProperty('problem');
  });

  it('turns project files into alias specifiers', () => {
    expect(specifierOf(snapshot.projects[0]!, 'root/log/_/logger.ts')).toBe('@root/log/_/logger');
    expect(specifierOf(snapshot.projects[0]!, 'root/web/_/types.d.ts')).toBe('@root/web/_/types');
  });

  it('lists the exports of the _/ files, without links and nested projects', () => {
    const list = codeExports(snapshot.projects[0]!);
    expect(list).toContainEqual({ bucket: 'root/log', file: 'root/log/_/levels.ts', name: 'Level', typeOnly: true });
    expect(list).toContainEqual({ bucket: 'root/log', file: 'root/log/_/levels.ts', name: 'levels', typeOnly: false });
    expect(list.some((e) => e.file.includes('/links/') || e.file.includes('engine'))).toBe(false);
  });
});

describe('published symbol change', () => {
  it('names the projects that link it, the files that use it and what each link mode does', () => {
    const result = externalImpact(snapshot, NESTED, 'root/dmz/core/.external.ts', 'Engine');
    if ('problem' in result) throw new Error(result.problem);
    expect(result).toMatchObject({ origin: 'root/core', declaredIn: 'root/core/_/engine.ts', carriers: [], inside: [] });
    expect(result.signature).toContain('interface Engine');
    expect(result.consumers).toEqual([{ project: '.', link: 'root/web/_/links/engine', name: 'engine', mode: 'copy', state: 'ok', holds: true, files: [{ file: 'root/web/_/app.ts', line: 1, names: ['Engine'] }] }]);
    expect(externalImpact(snapshot, NESTED, 'root/dmz/core/.external.ts', 'Nope')).toEqual({ problem: 'root/dmz/core/.external.ts does not publish Nope. Pick a symbol from the list.' });
    expect(externalImpact(snapshot, '.', 'root/dmz/log/web.ts', 'logger')).toHaveProperty('problem');
  });
});
