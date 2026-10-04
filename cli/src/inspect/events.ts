// The event feed of `buckets inspect`: what changed between two snapshots, in words, tagged by project. File events
// come from the watcher; violations, lock differences, projects and links come from comparing the snapshots.
import path from 'node:path';
import { splitBucketPath, toPosix } from '../core/paths.js';
import { plural } from '../output/text.js';
import type { InspectSnapshot, LockChangeSnapshot, ViolationSnapshot } from './snapshot.js';

export type FeedKind =
  | 'start'
  | 'file'
  | 'violation-added'
  | 'violation-resolved'
  | 'lock-added'
  | 'lock-resolved'
  | 'project-added'
  | 'project-removed'
  | 'link'
  | 'error';

export interface FeedEvent {
  id: string;
  /** ISO time. */
  at: string;
  kind: FeedKind;
  /** The project the event is about, relative to the starting project. */
  project: string;
  text: string;
  bucket?: string;
  /** The id of the violation or lock difference, for a link to it. */
  ref?: string;
}

let counter = 0;

export function feedEvent(kind: FeedKind, project: string, text: string, at: Date, extra: { bucket?: string; ref?: string } = {}): FeedEvent {
  counter++;
  return { id: `e${at.getTime().toString(36)}${counter.toString(36)}`, at: at.toISOString(), kind, project, text, ...extra };
}

function where(v: { file: string; line?: number }): string {
  return v.line !== undefined ? `${v.file}:${v.line}` : v.file;
}

function violationText(v: ViolationSnapshot): string {
  return `${v.rule} in ${where(v)}`;
}

function lockText(c: LockChangeSnapshot): string {
  return `${c.kind} ${c.path}${c.symbol !== undefined ? ` (${c.symbol})` : ''}`;
}

/** The project of an absolute file path: the deepest project folder that holds it, with the path relative to it. */
export function locateFile(snapshot: InspectSnapshot, abs: string): { project: string; file: string; bucket: string | null } | null {
  let best: InspectSnapshot['projects'][number] | null = null;
  for (const project of snapshot.projects) {
    const rel = path.relative(project.dir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (best === null || project.dir.length > best.dir.length) best = project;
  }
  if (best === null) return null;
  const file = toPosix(path.relative(best.dir, abs));
  const root = best.config?.root;
  const split = root !== undefined ? splitBucketPath(root, file) : null;
  return { project: best.path, file, bucket: split && split.area !== null ? split.bucket : null };
}

/** Events for files that changed, one per bucket when several files of the same bucket changed together. */
export function fileEvents(snapshot: InspectSnapshot, paths: string[], at: Date): FeedEvent[] {
  const groups = new Map<string, { project: string; bucket: string | null; files: string[] }>();
  for (const abs of paths) {
    const located = locateFile(snapshot, abs);
    if (located === null) {
      const key = `\0outside`;
      if (!groups.has(key)) groups.set(key, { project: '.', bucket: null, files: [] });
      groups.get(key)!.files.push(toPosix(abs));
      continue;
    }
    const key = `${located.project}\0${located.bucket ?? ''}`;
    if (!groups.has(key)) groups.set(key, { project: located.project, bucket: located.bucket, files: [] });
    groups.get(key)!.files.push(located.file);
  }
  const out: FeedEvent[] = [];
  for (const group of groups.values()) {
    const files = [...new Set(group.files)].sort();
    const what = files.length === 1 ? files[0]! : plural(files.length, 'file');
    const text = group.bucket !== null ? `${what} changed in bucket ${group.bucket}` : files.length === 1 ? `${what} changed` : `${what} changed outside the buckets`;
    out.push(feedEvent('file', group.project, text, at, group.bucket !== null ? { bucket: group.bucket } : {}));
  }
  return out;
}

/** Events for what the new snapshot has that the old one does not, and the other way around. */
export function snapshotEvents(before: InspectSnapshot, after: InspectSnapshot, at: Date): FeedEvent[] {
  const out: FeedEvent[] = [];
  const beforeProjects = new Map(before.projects.map((p) => [p.path, p]));
  const afterProjects = new Map(after.projects.map((p) => [p.path, p]));
  for (const p of after.projects) if (!beforeProjects.has(p.path)) out.push(feedEvent('project-added', p.path, `Nested project ${p.path} appeared`, at));
  for (const p of before.projects) if (!afterProjects.has(p.path)) out.push(feedEvent('project-removed', p.path, `Nested project ${p.path} is gone`, at));

  const oldViolations = new Map(before.projects.flatMap((p) => p.violations).map((v) => [v.id, v]));
  const newViolations = new Map(after.projects.flatMap((p) => p.violations).map((v) => [v.id, v]));
  for (const [id, v] of newViolations) {
    if (!oldViolations.has(id)) out.push(feedEvent('violation-added', v.project, `Violation appeared: ${violationText(v)}`, at, { ref: id, ...(v.bucket !== null ? { bucket: v.bucket } : {}) }));
  }
  for (const [id, v] of oldViolations) {
    if (!newViolations.has(id)) out.push(feedEvent('violation-resolved', v.project, `Violation resolved: ${violationText(v)}`, at, v.bucket !== null ? { bucket: v.bucket } : {}));
  }

  const oldLock = new Map(before.projects.flatMap((p) => p.lockChanges).map((c) => [c.id, c]));
  const newLock = new Map(after.projects.flatMap((p) => p.lockChanges).map((c) => [c.id, c]));
  for (const [id, c] of newLock) {
    if (!oldLock.has(id)) out.push(feedEvent('lock-added', c.project, `Lock difference appeared: ${lockText(c)}`, at, { ref: id, ...(c.bucket !== null ? { bucket: c.bucket } : {}) }));
  }
  for (const [id, c] of oldLock) {
    if (!newLock.has(id)) out.push(feedEvent('lock-resolved', c.project, `Lock difference gone: ${lockText(c)}`, at, c.bucket !== null ? { bucket: c.bucket } : {}));
  }

  const oldLinks = new Map(before.links.map((l) => [`${l.from}\0${l.link}`, l]));
  for (const link of after.links) {
    const old = oldLinks.get(`${link.from}\0${link.link}`);
    if (old && old.state !== link.state) out.push(feedEvent('link', link.from, `Link ${link.name} is now ${link.state} (was ${old.state})`, at));
  }

  for (const p of after.projects) {
    const old = beforeProjects.get(p.path);
    if (old && old.status !== 'environment' && p.status === 'environment') out.push(feedEvent('error', p.path, `The check could not run: ${p.environment?.code ?? 'environment problem'}`, at));
  }
  return out;
}
