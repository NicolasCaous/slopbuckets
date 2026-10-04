import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'buckets.config.json';
export const LOCK_FILE = 'buckets.lock.json';

/** Converts an OS path to the protocol format: forward slashes, no leading `./`, no trailing slash. */
export function toPosix(p: string): string {
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * A project-relative path (protocol format) spelled with the case of the names on disk. On a file system that
 * ignores case (Windows, macOS), `ROOT/_/Main.ts` names the file `root/_/main.ts`, and the rules compare paths as
 * text, so they need the disk spelling. A segment that does not exist, or exists with this exact spelling, is kept.
 */
export function diskCase(projectDir: string, rel: string): string {
  if (rel === '') return rel;
  const out: string[] = [];
  let dir = projectDir;
  for (const segment of rel.split('/')) {
    let name = segment;
    if (segment !== '.' && segment !== '..') {
      try {
        const entries = readdirSync(dir);
        if (!entries.includes(segment)) {
          const lower = segment.toLowerCase();
          const matches = entries.filter((e) => e.toLowerCase() === lower);
          if (matches.length === 1 && existsSync(path.join(dir, segment))) name = matches[0]!;
        }
      } catch {
        // Not a folder or not readable: keep the rest as typed.
      }
    }
    out.push(name);
    dir = path.join(dir, name);
  }
  return out.join('/');
}

/** Path of `absolute` relative to `projectDir` in protocol format, or `null` when it lies outside the project. */
export function relativeToProject(projectDir: string, absolute: string): string | null {
  const rel = path.relative(projectDir, absolute);
  if (rel === '') return '';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return toPosix(rel);
}

function joinPosix(...parts: string[]): string {
  return parts.filter((p) => p !== '').join('/');
}

/** Parent of a protocol path, or `''` for a single segment. */
export function parentPath(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/**
 * Splits a project path that lies under the root bucket into the bucket path and the rest.
 * The bucket path ends at the first `_` or `dmz` segment. Returns `null` for paths outside the root bucket.
 * Example with root `root`: `root/billing/_/a.ts` gives `{ bucket: 'root/billing', area: '_', rest: 'a.ts' }`.
 */
export function splitBucketPath(
  root: string,
  file: string,
): { bucket: string; area: '_' | 'dmz' | null; rest: string } | null {
  if (file !== root && !file.startsWith(`${root}/`)) return null;
  const segments = file === root ? [] : file.slice(root.length + 1).split('/');
  const bucketSegments: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg === '_' || seg === 'dmz') {
      return { bucket: joinPosix(root, ...bucketSegments), area: seg, rest: segments.slice(i + 1).join('/') };
    }
    bucketSegments.push(seg);
  }
  return { bucket: joinPosix(root, ...bucketSegments), area: null, rest: '' };
}

/** Bucket that owns a code file (`X/_/**`), or `null` when the file is not bucket code. */
export function codeBucket(root: string, file: string): string | null {
  const split = splitBucketPath(root, file);
  return split && split.area === '_' && split.rest !== '' ? split.bucket : null;
}
