import { describe, expect, it } from 'vitest';
import { DIFF_LIMIT, diffTouchesView, snapshotDiff, staleViews } from './diff.js';
import { largeSnapshot } from '../testing/large-snapshot.js';
import type { InspectSnapshot } from './snapshot.js';

const VIEWS = ['map', 'matrix', 'trace', 'projects', 'approvals', 'timeline', 'impact'];
const copy = (s: InspectSnapshot): InspectSnapshot => JSON.parse(JSON.stringify(s)) as InspectSnapshot;

describe('snapshot diff for live updates', () => {
  it('is empty when only the time changed, so open pages fetch just the feed', () => {
    const before = largeSnapshot();
    const after = copy(before);
    after.generatedAt = '2026-10-04T12:05:00.000Z';
    const diff = snapshotDiff(before, after);
    expect(diff).toEqual({ same: true, full: false, projects: {} });
    expect(staleViews(diff, VIEWS, ['.'])).toEqual([]);
  });

  it('lists the changed buckets, contracts and violations of each project by id', () => {
    const before = largeSnapshot();
    const after = copy(before);
    const p = after.projects[0]!;
    p.buckets.find((b) => b.path === 'root/wide/s2')!.files = 4;
    p.violations = p.violations.filter((v) => v.id !== 'v2');
    const diff = snapshotDiff(before, after);
    expect(diff.same).toBe(false);
    expect(diff.projects['.']).toEqual({ buckets: ['root/wide/s2'], contracts: [], violations: ['v2'], lockChanges: [], other: false });
    // The JSON stays small: ids, not the snapshot.
    expect(JSON.stringify(diff).length).toBeLessThan(200);
  });

  it('marks the views a change makes stale: a new file count leaves the matrix as it is', () => {
    const before = largeSnapshot();
    const after = copy(before);
    after.projects[0]!.buckets.find((b) => b.path === 'root/wide/s2')!.files = 4;
    const diff = snapshotDiff(before, after);
    expect(diffTouchesView(diff, 'map', '.')).toBe(true);
    expect(diffTouchesView(diff, 'matrix', '.')).toBe(false);
    expect(diffTouchesView(diff, 'map', 'other/project')).toBe(false);
    expect(staleViews(diff, VIEWS, ['.'])).toEqual(['map|.', 'trace|.', 'projects|.', 'approvals|.', 'timeline|.', 'impact|.']);
  });

  it('says full instead of listing a very large change', () => {
    const before = largeSnapshot(DIFF_LIMIT + 10);
    const after = copy(before);
    for (const b of after.projects[0]!.buckets) b.files += 1;
    const diff = snapshotDiff(before, after);
    expect(diff).toEqual({ same: false, full: true, projects: {} });
    expect(staleViews(diff, VIEWS, ['.'])).toBe('*');
  });
});
