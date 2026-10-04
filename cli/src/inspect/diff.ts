// What changed between two snapshots, in a few ids, for the live updates of `buckets inspect`. The server sends it
// with each update event, so an open page can tell whether what it shows changed (and fetch the page again) or only
// the event feed did (and fetch just the feed). A large change is sent as `full` instead of a long list.
import type { InspectSnapshot, ProjectSnapshot } from './snapshot.js';

/** Above this many changed ids the diff only says `full`. */
export const DIFF_LIMIT = 200;

export interface ProjectDiff {
  /** Buckets added, removed or changed (files, situation, counts, contracts, dependencies). */
  buckets: string[];
  /** Contract files added, removed or changed (symbols, signatures, importers, situation). */
  contracts: string[];
  /** Violation and lock difference ids that appeared or went away. */
  violations: string[];
  lockChanges: string[];
  /** True when the project's status, lock state, links or published files changed. */
  other: boolean;
}

export interface SnapshotDiff {
  /** True when nothing a page shows changed, apart from the time and the event feed. */
  same: boolean;
  /** True when the change is too large to list; the page then reloads what it shows. */
  full: boolean;
  /** Changes by project path. A project added or removed is listed with `other` true. */
  projects: Record<string, ProjectDiff>;
}

function keyed<T>(items: T[], key: (item: T) => string): Map<string, string> {
  return new Map(items.map((item) => [key(item), JSON.stringify(item)]));
}

function changedKeys(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of after) if (before.get(k) !== v) out.push(k);
  for (const k of before.keys()) if (!after.has(k)) out.push(k);
  return out.sort();
}

function idSet(items: { id: string }[]): Set<string> {
  return new Set(items.map((i) => i.id));
}

function symmetric(a: Set<string>, b: Set<string>): string[] {
  return [...[...a].filter((x) => !b.has(x)), ...[...b].filter((x) => !a.has(x))].sort();
}

function projectDiff(before: ProjectSnapshot | undefined, after: ProjectSnapshot | undefined): ProjectDiff {
  const empty = { buckets: [], contracts: [], violations: [], lockChanges: [] };
  if (before === undefined || after === undefined) return { ...empty, other: true };
  const rest = (p: ProjectSnapshot) =>
    JSON.stringify([p.status, p.exitCode, p.lock, p.environment ?? null, p.config, p.links, p.external, p.nested, p.cycles, p.orphans, p.imports.length]);
  return {
    buckets: changedKeys(keyed(before.buckets, (b) => b.path), keyed(after.buckets, (b) => b.path)),
    contracts: changedKeys(keyed(before.contracts, (c) => c.file), keyed(after.contracts, (c) => c.file)),
    violations: symmetric(idSet(before.violations), idSet(after.violations)),
    lockChanges: symmetric(idSet(before.lockChanges), idSet(after.lockChanges)),
    other: rest(before) !== rest(after),
  };
}

/** The changes from `before` to `after`, by project. */
export function snapshotDiff(before: InspectSnapshot, after: InspectSnapshot): SnapshotDiff {
  const projects: Record<string, ProjectDiff> = {};
  const paths = new Set([...before.projects.map((p) => p.path), ...after.projects.map((p) => p.path)]);
  let size = 0;
  for (const path of paths) {
    const d = projectDiff(
      before.projects.find((p) => p.path === path),
      after.projects.find((p) => p.path === path),
    );
    const n = d.buckets.length + d.contracts.length + d.violations.length + d.lockChanges.length;
    if (n === 0 && !d.other) continue;
    size += n;
    projects[path] = d;
  }
  const linksChanged = JSON.stringify(before.links) !== JSON.stringify(after.links) || before.exitCode !== after.exitCode;
  const same = Object.keys(projects).length === 0 && !linksChanged;
  if (size > DIFF_LIMIT) return { same: false, full: true, projects: {} };
  return { same, full: false, projects };
}

/** True when a page showing `view` of `project` has to fetch its content again after this diff. */
export function diffTouchesView(diff: SnapshotDiff, view: string, project: string): boolean {
  if (diff.full) return true;
  if (diff.same) return false;
  // These views show every project.
  if (view === 'projects' || view === 'approvals' || view === 'timeline' || view === 'trace') return true;
  const p = diff.projects[project];
  if (p === undefined) return false;
  if (view === 'matrix') return p.other || p.contracts.length > 0 || p.violations.length > 0 || p.lockChanges.length > 0;
  return true;
}

/** The pages (`view|project`) an update makes stale, or `*` for all of them. Pages not listed only fetch the feed. */
export function staleViews(diff: SnapshotDiff, views: readonly string[], projects: readonly string[]): string[] | '*' {
  if (diff.full) return '*';
  const out: string[] = [];
  for (const project of projects) for (const view of views) if (diffTouchesView(diff, view, project)) out.push(`${view}|${project}`);
  return out;
}
