import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { linkCommand } from '../commands/link.js';
import { cleanupProjects, LOGGER_PROJECT, makeProject, writeFile } from '../testing/fixture.js';
import { approve, fakeIo, testContext } from '../testing/harness.js';
import { buildSnapshot, exportedNames, linkSymbols, SNAPSHOT_VERSION, type InspectSnapshot } from './snapshot.js';

afterEach(cleanupProjects);

const NOW = new Date('2026-10-04T12:00:00.000Z');

async function snapshotOf(dir: string): Promise<InspectSnapshot> {
  return buildSnapshot(testContext(), dir, { now: NOW });
}

/** `api` and `store` use each other through root/dmz. */
const CYCLE: Record<string, string> = {
  'root/_/main.ts': 'export const main = 1;\n',
  'root/api/_/server.ts': "import { query } from '@root/dmz/store/api';\nexport const serve = () => query();\n",
  'root/api/_/route.ts': 'export function route(): string {\n  return "/";\n}\n',
  'root/store/_/db.ts': "import { route } from '@root/dmz/api/store';\nexport function query(): string {\n  return route();\n}\n",
  'root/dmz/store/api.ts': "export { query } from '@root/store/_/db';\n",
  'root/dmz/api/store.ts': "export { route } from '@root/api/_/route';\n",
};

const NESTED = 'root/log/_/engine';
const NESTED_FILES: Record<string, string> = {
  [`${NESTED}/buckets.config.json`]: '{ "root": "root", "alias": "@engine" }\n',
  [`${NESTED}/package.json`]: '{ "name": "engine" }\n',
  [`${NESTED}/root/_/run.ts`]: "import type { Engine } from '@engine/dmz/core/.self';\nexport const run = (e: Engine): string => e.name;\n",
  [`${NESTED}/root/core/_/engine.ts`]: 'export interface Engine {\n  name: string;\n}\n',
  [`${NESTED}/root/dmz/core/.self.ts`]: "export type { Engine } from '@engine/core/_/engine';\n",
  [`${NESTED}/root/dmz/core/.external.ts`]: "export type { Engine } from '@engine/core/_/engine';\n",
};

/** Code of `web` that uses the type the nested engine project publishes. */
const APP = "import type { Engine } from '@engine/dmz/core/.external';\nexport const name = (e: Engine): string => e.name;\n";

describe('buildSnapshot', () => {
  it('describes buckets, contracts, symbols and imports of a passing project', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    const snapshot = await snapshotOf(dir);
    expect(snapshot).toMatchObject({ snapshotVersion: SNAPSHOT_VERSION, cli: '1.0.0', generatedAt: NOW.toISOString(), dir, exitCode: 0 });
    expect(snapshot.summary).toEqual({ projects: 1, buckets: 5, contracts: 2, symbols: 2, violations: 0, lockChanges: 0, links: 0 });
    const [project] = snapshot.projects;
    expect(project).toMatchObject({ path: '.', name: 'fixture', parent: null, container: null, status: 'ok', lock: 'current', exitCode: 0 });
    expect(project!.buckets.map((b) => b.path)).toEqual(['root', 'root/billing', 'root/billing/invoices', 'root/billing/payments', 'root/log']);

    const invoices = project!.buckets.find((b) => b.path === 'root/billing/invoices')!;
    expect(invoices).toMatchObject({ level: 2, files: 1, situation: 'ok', dependsOn: ['root/log'], dependents: [], consumes: ['root/billing/dmz/.parent/invoices.ts'] });
    const log = project!.buckets.find((b) => b.path === 'root/log')!;
    expect(log.dependents).toEqual(['root/billing/invoices']);
    expect(log.offers).toEqual(['root/dmz/log/billing.ts']);
    expect(log.rewriteCost).toEqual({ symbols: 1, contracts: 1, dependents: 1 });

    const tip = project!.contracts.find((c) => c.file === 'root/billing/dmz/.parent/invoices.ts')!;
    expect(tip).toMatchObject({ owner: 'root/billing', provider: '.parent', consumer: 'invoices', providerBucket: null, consumerBucket: 'root/billing/invoices', situation: 'ok', lock: null });
    expect(tip.symbols).toEqual([
      {
        name: 'logger',
        typeOnly: false,
        line: 1,
        from: 'root/dmz/log/billing.ts',
        origin: 'root/log',
        declaredIn: 'root/log/_/logger.ts',
        chain: ['root/billing/dmz/.parent/invoices.ts', 'root/dmz/log/billing.ts', 'root/log/_/logger.ts'],
        signature: { hash: expect.stringMatching(/^sha256:/), text: 'export function logger(message: string): void' },
        used: true,
        importers: [{ file: 'root/billing/invoices/_/create-invoice.ts', line: 1, bucket: 'root/billing/invoices', used: true }],
        lock: null,
      },
    ]);
    expect(project!.imports).toEqual([
      { from: 'root/billing/invoices', to: 'root/log', symbols: ['logger'], cycle: false, files: [{ file: 'root/billing/invoices/_/create-invoice.ts', line: 1, symbol: 'logger', via: 'root/billing/dmz/.parent/invoices.ts' }] },
    ]);
  });

  it('marks cycles on the violations, the graph and the buckets', async () => {
    const dir = makeProject(CYCLE);
    await approve(dir);
    const [project] = (await snapshotOf(dir)).projects;
    expect(project!.status).toBe('violation');
    expect(project!.cycles).toEqual([['root/api', 'root/store']]);
    expect(project!.imports.every((e) => e.cycle)).toBe(true);
    const cycles = project!.violations.filter((v) => v.kind === 'cycle');
    expect(cycles.map((v) => v.cycle)).toEqual([
      ['root/api', 'root/store', 'root/api'],
      ['root/store', 'root/api', 'root/store'],
    ]);
    expect(cycles.map((v) => v.bucket)).toEqual(['root/api', 'root/store']);
    expect(project!.buckets.find((b) => b.path === 'root/api')!.situation).toBe('violation');
    expect(new Set(cycles.map((v) => v.id)).size).toBe(2);
  });

  it('gives orphans their chain and forbidden imports their target', async () => {
    const dir = makeProject({
      ...LOGGER_PROJECT,
      'root/billing/invoices/_/create-invoice.ts': "import { pay } from '@root/billing/payments/_/pay';\nexport const created = pay;\n",
    });
    const [project] = (await snapshotOf(dir)).projects;
    const orphans = project!.violations.filter((v) => v.kind === 'orphan');
    expect(orphans.map((v) => v.chain)).toEqual([
      { symbol: 'logger', origin: 'root/log', files: ['root/dmz/log/billing.ts', 'root/billing/dmz/.parent/invoices.ts'] },
      { symbol: 'logger', origin: 'root/log', files: ['root/dmz/log/billing.ts', 'root/billing/dmz/.parent/invoices.ts'] },
    ]);
    expect(project!.orphans).toEqual([{ symbol: 'logger', origin: 'root/log', files: ['root/dmz/log/billing.ts', 'root/billing/dmz/.parent/invoices.ts'] }]);
    const symbol = project!.contracts.find((c) => c.file === 'root/dmz/log/billing.ts')!.symbols[0]!;
    expect(symbol.used).toBe(false);
    const forbidden = project!.violations.find((v) => v.kind === 'forbidden')!;
    expect(forbidden).toMatchObject({ rule: 'import-forbidden', file: 'root/billing/invoices/_/create-invoice.ts', line: 1, bucket: 'root/billing/invoices', target: { file: 'root/billing/payments/_/pay.ts', bucket: 'root/billing/payments' } });
  });

  it('shows lock differences on contracts, symbols and buckets', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    writeFile(dir, 'root/log/_/logger.ts', 'export function logger(message: string, level: number): void {}\n');
    const [project] = (await snapshotOf(dir)).projects;
    expect(project).toMatchObject({ status: 'lock', lock: 'differs', exitCode: 2 });
    expect(project!.lockChanges.map((c) => [c.kind, c.path, c.symbol, c.bucket])).toEqual([
      ['signature-changed', 'root/billing/dmz/.parent/invoices.ts', 'logger', 'root/billing'],
      ['signature-changed', 'root/dmz/log/billing.ts', 'logger', 'root'],
    ]);
    const contract = project!.contracts.find((c) => c.file === 'root/dmz/log/billing.ts')!;
    expect(contract).toMatchObject({ situation: 'lock', lock: 'changed' });
    expect(contract.symbols[0]).toMatchObject({ lock: 'changed', signature: { text: 'export function logger(message: string, level: number): void' } });
    expect(project!.buckets.find((b) => b.path === 'root')!.situation).toBe('lock');
    expect(project!.buckets.find((b) => b.path === 'root/log')!.situation).toBe('ok');
  });

  it('reports a missing lock', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const [project] = (await snapshotOf(dir)).projects;
    expect(project).toMatchObject({ status: 'lock', lock: 'missing' });
    expect(project!.lockChanges[0]).toMatchObject({ kind: 'lock-missing', bucket: null });
  });

  it('walks nested projects, links and published surfaces', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, ...NESTED_FILES, 'root/web/_/app.ts': APP });
    const nested = path.join(dir, NESTED);
    const added = fakeIo({ cwd: dir });
    expect(await linkCommand(testContext(), added, ['add', 'engine', NESTED, '--bucket', 'root/web', '--copy']), added.err).toBe(0);
    await approve(dir);
    await approve(nested);

    const snapshot = await snapshotOf(dir);
    expect(snapshot.projects.map((p) => [p.path, p.name, p.parent, p.status])).toEqual([
      ['.', 'fixture', null, 'ok'],
      [NESTED, 'engine', '.', 'ok'],
    ]);
    const [top, engine] = snapshot.projects;
    expect(top!.nested).toEqual([NESTED]);
    expect(engine!.container).toEqual({ project: '.', bucket: 'root/log' });
    expect(top!.buckets.find((b) => b.path === 'root/log')!.projects).toEqual([NESTED]);
    expect(top!.buckets.find((b) => b.path === 'root/web')!.links).toEqual(['root/web/_/links/engine']);
    expect(top!.links).toEqual([
      {
        path: 'root/web/_/links/engine',
        name: 'engine',
        bucket: 'root/web',
        origin: NESTED,
        alias: '@engine',
        mode: 'copy',
        state: 'ok',
        target: { project: NESTED },
        symbols: [{ name: 'Engine', typeOnly: true, file: 'dmz/core/.external.ts', signature: expect.stringMatching(/^sha256:/) }],
        usedBy: [{ file: 'root/web/_/app.ts', line: 1, names: ['Engine'] }],
      },
    ]);
    expect(engine!.external).toEqual([
      {
        file: 'root/dmz/core/.external.ts',
        bucket: 'root/core',
        symbols: [{ name: 'Engine', typeOnly: true, origin: 'root/core', signature: 'export interface Engine {\n  name: string;\n}' }],
        consumers: [{ project: '.', link: 'root/web/_/links/engine' }],
      },
    ]);
    expect(snapshot.links).toEqual([
      { from: '.', to: NESTED, origin: NESTED, alias: '@engine', link: 'root/web/_/links/engine', name: 'engine', mode: 'copy', state: 'ok', symbols: ['Engine'] },
    ]);
  });

  it('shows a drifted copy with the files that differ, a changed signature, and a missing link', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, ...NESTED_FILES, 'root/web/_/app.ts': APP });
    const nested = path.join(dir, NESTED);
    await linkCommand(testContext(), fakeIo({ cwd: dir }), ['add', 'engine', NESTED, '--bucket', 'root/web', '--copy']);
    await approve(dir);
    writeFile(nested, 'root/core/_/engine.ts', 'export interface Engine {\n  name: string;\n  size: number;\n}\n');
    let [top] = (await snapshotOf(dir)).projects;
    expect(top!.links[0]).toMatchObject({ state: 'drift', drift: { added: [], removed: [], changed: ['core/_/engine.ts'] } });

    writeFile(nested, 'root/core/_/engine.ts', 'export interface Engine<T = string> {\n  name: T;\n}\n');
    await linkCommand(testContext(), fakeIo({ cwd: dir }), ['update', 'engine']);
    [top] = (await snapshotOf(dir)).projects;
    expect(top!.links[0]).toMatchObject({ state: 'changed' });
    expect(top!.lockChanges.map((c) => [c.kind, c.symbol])).toEqual([['link-changed', 'Engine']]);
    // The panel marks the symbol whose signature changed, as the approvals page does.
    expect(top!.links[0]!.symbols).toEqual([expect.objectContaining({ name: 'Engine', change: 'changed' })]);

    const { rmSync } = await import('node:fs');
    rmSync(path.join(dir, 'root/web/_/links/engine'), { recursive: true, force: true });
    [top] = (await snapshotOf(dir)).projects;
    expect(top!.links[0]).toMatchObject({ state: 'missing', symbols: [{ name: 'Engine', file: 'dmz/core/.external.ts' }] });
  });

  it('marks published symbols added, removed or changed against the approved lock, and nothing without a lock', () => {
    const typeOnly = new Map([['dmz/a/.external.ts\0B', true]]);
    const approved = { 'dmz/a/.external.ts': { A: 'sha256:a', B: 'sha256:b', C: 'sha256:c' } };
    const now = { 'dmz/a/.external.ts': { A: 'sha256:a', B: 'sha256:b2', D: 'sha256:d' } };
    expect(linkSymbols(now, approved, true, typeOnly)).toEqual([
      { name: 'A', typeOnly: false, file: 'dmz/a/.external.ts', signature: 'sha256:a' },
      { name: 'B', typeOnly: true, file: 'dmz/a/.external.ts', signature: 'sha256:b2', change: 'changed' },
      { name: 'C', typeOnly: false, file: 'dmz/a/.external.ts', signature: 'sha256:c', change: 'removed' },
      { name: 'D', typeOnly: false, file: 'dmz/a/.external.ts', signature: 'sha256:d', change: 'added' },
    ]);
    // A link the lock does not have yet: every symbol is new. A removed link: every approved symbol is gone.
    expect(linkSymbols(now, undefined, true, typeOnly).map((s) => s.change)).toEqual(['added', 'added', 'added']);
    expect(linkSymbols({}, approved, true, typeOnly).map((s) => s.change)).toEqual(['removed', 'removed', 'removed']);
    // No lock to compare with, or a link missing on disk: no marks.
    expect(linkSymbols(now, undefined, false, typeOnly).some((s) => s.change !== undefined)).toBe(false);
    expect(linkSymbols(undefined, approved, true, typeOnly).some((s) => s.change !== undefined)).toBe(false);
  });

  it('has no target project for an origin outside the visible projects', async () => {
    const dir = makeProject({
      'root/_/main.ts': 'export const main = 1;\n',
      'root/web/_/app.ts': "import type { Router } from '@api/dmz/server/.external';\nexport const route = (r: Router): string => r.path;\n",
      'vendor/api/buckets.config.json': '{ "root": "root", "alias": "@api" }\n',
      'vendor/api/root/dmz/server/.external.ts': "export type { Router } from '@api/server/_/router';\n",
      'vendor/api/root/server/_/router.ts': 'export interface Router {\n  path: string;\n}\n',
    });
    await approve(dir);
    expect(await linkCommand(testContext(), fakeIo({ cwd: dir }), ['add', 'api', 'vendor/api', '--bucket', 'root/web', '--copy'])).toBe(0);
    const snapshot = await snapshotOf(dir);
    expect(snapshot.projects[0]!.links[0]).toMatchObject({ target: null, state: 'added', alias: '@api', symbols: [{ name: 'Router', typeOnly: true }] });
    expect(snapshot.links).toEqual([expect.objectContaining({ from: '.', to: null, origin: 'vendor/api' })]);
  });

  it('keeps a project whose check could not run, without buckets', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const snapshot = await buildSnapshot(testContext({ analyzeError: new Error('boom') }), dir, { now: NOW });
    expect(snapshot.exitCode).toBe(3);
    expect(snapshot.projects[0]).toMatchObject({ status: 'environment', lock: 'unknown', buckets: [], contracts: [], environment: { code: 'adapter-failed' } });
  });

  it('can leave nested projects out', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, ...NESTED_FILES });
    const snapshot = await buildSnapshot(testContext(), dir, { recursive: false });
    expect(snapshot.projects.map((p) => p.path)).toEqual(['.']);
  });
});

describe('exportedNames', () => {
  it('reads named re-exports and declarations of a declaration file', () => {
    expect(exportedNames("export type { A, B as C } from './a';\nexport { d } from './d';\nexport declare function e(): void;\nexport interface F {}\n")).toEqual([
      { name: 'A', typeOnly: true },
      { name: 'C', typeOnly: true },
      { name: 'F', typeOnly: true },
      { name: 'd', typeOnly: false },
      { name: 'e', typeOnly: false },
    ]);
  });
});
