import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderFull, renderSummary } from '../contract/messages.js';
import { snapshotFiles, type SnapshotProject } from '../contract/snapshot.js';
import { FIXTURE_SIZES, generateSnapshot } from './fixtures.js';

const DIR = new URL('../../../examples/fixtures/snapshots/', import.meta.url);

function hasCycle(project: SnapshotProject): boolean {
  const deps = new Map(project.buckets.map((b) => [b.name, b.dependsOn.map((d) => d.bucket)]));
  const state = new Map<string, 'open' | 'done'>();
  const visit = (name: string): boolean => {
    if (state.get(name) === 'done') return false;
    if (state.get(name) === 'open') return true;
    state.set(name, 'open');
    const cyclic = (deps.get(name) ?? []).some(visit);
    state.set(name, 'done');
    return cyclic;
  };
  return project.buckets.some((b) => visit(b.name));
}

describe.each(Object.entries(FIXTURE_SIZES))('%s snapshot', (name, options) => {
  const snapshot = generateSnapshot(options);
  const json = `${JSON.stringify(snapshot)}\n`;
  const file = new URL(`${name}.json`, DIR);

  it('matches the committed file (UPDATE_FIXTURES=1 rewrites it)', () => {
    if (process.env.UPDATE_FIXTURES === '1') writeFileSync(file, json);
    expect(readFileSync(file, 'utf8') === json, `${name}.json is stale; run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.stringify(generateSnapshot(options))).toBe(JSON.stringify(snapshot));
  });

  it('has the expected shape', () => {
    const [root, nested] = snapshot.projects;
    expect(snapshot.projects.map((p) => p.path)).toEqual(['.', 'packages/sdk']);
    expect(root!.projects).toEqual(['packages/sdk']);
    expect(root!.buckets).toHaveLength(options.buckets);
    for (const project of snapshot.projects) expect(hasCycle(project)).toBe(false);
    expect(root!.buckets.some((b) => b.public.length === 0)).toBe(true);
    expect(root!.buckets.some((b) => b.packages.length > 0)).toBe(true);
    expect(root!.advice.length).toBeGreaterThan(0);
    expect(root!.buckets.some((b) => b.external !== null)).toBe(true);
    expect(new Set(root!.edges.map((e) => e.state))).toEqual(new Set(['used', 'unused', 'undeclared']));
    const rules = new Set(root!.violations.map((v) => v.rule));
    expect(rules.size).toBeGreaterThanOrEqual(10);
    expect(root!.violations.some((v) => v.rule === 'file-unowned' && 'folder' in v)).toBe(true);
    expect(root!.violations.some((v) => v.rule === 'dependency-undeclared' && v.public.length === 0 && v.imports.some((i) => i.private))).toBe(true);
    for (const rule of ['import-private', 'import-unresolved', 'package-undeclared', 'package-unused'] as const) expect(rules.has(rule), rule).toBe(true);
    expect(nested!.violations.length).toBeGreaterThan(0);
    const names = new Set(root!.buckets.map((b) => b.name));
    for (const e of root!.edges) expect(names.has(e.from) && names.has(e.to)).toBe(true);
  });

  it('keeps file counts consistent and the file small', () => {
    const [root] = snapshot.projects;
    const files = [...snapshotFiles(root!)];
    for (const b of root!.buckets) {
      expect(files.filter((f) => f.owner.state === 'bucket' && f.owner.bucket === b.name).length).toBe(b.fileCount);
    }
    if (name === 'large') expect(files.length).toBeGreaterThan(49_000);
    expect(json.length).toBeLessThan(5_000_000);
  });

  it('renders every violation', () => {
    for (const v of snapshot.projects.flatMap((p) => p.violations)) {
      expect(renderFull(v)).toContain('  fix ');
      expect(renderSummary(v).length).toBeLessThanOrEqual(120);
    }
  });
});
