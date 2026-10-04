import { describe, expect, it } from 'vitest';
import { capList, commonBucket, mapFocus, mapMode, matrixLayout, MATRIX_LIST_THRESHOLD, subtreeStats, visibleBox } from './scale.js';
import { largeProject } from '../testing/large-snapshot.js';

describe('map layout decisions', () => {
  it('shows every bucket of a small project and one level of a large one, or a treemap on request', () => {
    const small = largeProject(5);
    expect(small.buckets.length).toBeLessThanOrEqual(40);
    expect(mapMode(small, null)).toBe('full');
    expect(mapMode(small, 'all')).toBe('full');
    const large = largeProject(50);
    expect(mapMode(large, null)).toBe('level');
    expect(mapMode(large, 'all')).toBe('treemap');
  });

  it('drills into a selected bucket with children, and shows the siblings of a selected leaf', () => {
    const p = largeProject();
    expect(mapFocus(p, null)).toBe('root');
    expect(mapFocus(p, 'root/wide')).toBe('root/wide');
    expect(mapFocus(p, 'root/wide/s7')).toBe('root/wide');
    expect(mapFocus(p, 'root/nowhere')).toBe('root');
  });

  it('maps a bucket to the box that holds it on a level', () => {
    expect(visibleBox('root', 'root/wide/s1')).toBe('root/wide');
    expect(visibleBox('root/wide', 'root/wide/s1')).toBe('root/wide/s1');
    expect(visibleBox('root/wide', 'root/wide')).toBe('root/wide');
    expect(visibleBox('root/wide', 'root/small/a')).toBeNull();
    expect(visibleBox('root/wide', 'root/widest')).toBeNull();
    expect(commonBucket(['root/small/a', 'root/small/b'])).toBe('root/small');
    expect(commonBucket(['root/small/a', 'root/wide'])).toBe('root');
  });

  it('adds up subtree counts and the worst situation below each bucket', () => {
    const stats = subtreeStats(largeProject());
    expect(stats.get('root/small')).toMatchObject({ inside: 3, files: 12, violations: 2, lockChanges: 1, situation: 'violation' });
    expect(stats.get('root')!.inside).toBe(55);
    expect(stats.get('root/wide/s0')).toMatchObject({ inside: 0, situation: 'ok' });
  });
});

describe('matrix layout decisions', () => {
  const project = largeProject();
  const owner = (path: string) => project.buckets.find((b) => b.path === path)!;
  const none = { q: '', focus: null };

  it('keeps a small folder complete, empty rows and columns included', () => {
    const layout = matrixLayout(project, owner('root/small'), none, false)!;
    expect(layout.sparse).toBe(false);
    expect(layout.mode).toBe('table');
    expect(layout.providers).toEqual(['a', 'b', 'c', '.self', '.parent']);
    expect(layout.consumers).toEqual(['a', 'b', 'c', '.self', '.parent', '.external']);
  });

  it('leaves out the rows and columns without a contract, and lists a folder still too wide for a table', () => {
    const layout = matrixLayout(project, owner('root/wide'), none, false)!;
    expect(layout.sparse).toBe(true);
    expect(layout.providers).not.toContain('.self');
    expect(layout.providers).not.toContain('s49');
    expect(layout.consumers).not.toContain('s0');
    expect(layout.providers.length).toBeGreaterThan(MATRIX_LIST_THRESHOLD);
    expect(layout.mode).toBe('list');
    expect(layout.wide).toBe(true);
    expect(matrixLayout(project, owner('root/wide'), none, true)!.mode).toBe('table');
  });

  it('filters by text and by problems or pending approval, and drops a folder with no match', () => {
    const pending = matrixLayout(project, owner('root/wide'), { q: '', focus: 'pending' }, false)!;
    expect([...pending.contracts.values()].map((c) => c.file)).toEqual(['root/wide/dmz/s3/s4.ts']);
    expect(pending.providers).toEqual(['s3']);
    expect(pending.mode).toBe('table');
    expect(matrixLayout(project, owner('root/wide'), { q: '', focus: 'problems' }, false)).toBeNull();
    const text = matrixLayout(project, owner('root/small'), { q: 'atob', focus: null }, false)!;
    expect(text.contracts.size).toBe(1);
    expect(text.sparse).toBe(true);
  });
});

describe('long lists', () => {
  it('cuts a long list unless it is expanded or only a little over the cap', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    expect(capList(items, 20, false)).toEqual({ shown: items.slice(0, 20), rest: items.slice(20) });
    expect(capList(items, 20, true).rest).toEqual([]);
    expect(capList(items.slice(0, 24), 20, false).rest).toEqual([]);
  });
});
