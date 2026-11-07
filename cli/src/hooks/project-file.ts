// The one way `buckets init` writes a file. A symbolic link or a junction in the project, even a dangling one, would
// send the write to wherever it points, so every write refuses a path whose file or folders are links.
import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Throws when `file` (absolute, or relative to `base`) or one of its folders below `base` is a symbolic link or a
 * junction. A path that does not exist yet passes. For a file outside `base`, only the file itself is checked.
 */
export function refuseLinks(base: string, file: string): void {
  const abs = path.resolve(base, file);
  const rel = path.relative(path.resolve(base), abs);
  const inside = rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
  const parts = inside ? rel.split(path.sep) : [abs];
  let at = inside ? path.resolve(base) : '';
  for (const part of parts) {
    at = at === '' ? part : path.join(at, part);
    let link = false;
    try {
      link = lstatSync(at).isSymbolicLink();
    } catch {
      return; // Missing: nothing below it exists either.
    }
    if (link) throw new Error(`${inside ? rel.split(path.sep).join('/') : abs} goes through the link ${at}, and slopbuckets does not write through links`);
  }
}

/** Writes `text` to `file` (absolute, or relative to `base`), creating its folders, after refuseLinks. */
export function writeProjectFile(base: string, file: string, text: string, mode?: number): void {
  const abs = path.resolve(base, file);
  refuseLinks(base, abs);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
}

/**
 * Deletes `file` (absolute, or relative to `base`) after refuseLinks, then every folder above it, up to `base`, that
 * the removal left empty. Returns false when there was no file.
 */
export function removeProjectFile(base: string, file: string): boolean {
  const abs = path.resolve(base, file);
  if (!existsSync(abs)) return false;
  refuseLinks(base, abs);
  rmSync(abs, { recursive: true, force: true });
  removeEmptyFolders(base, path.dirname(abs));
  return true;
}

/** Removes `dir` and each folder above it, up to `base`, while it is empty. A folder that cannot be read stays. */
export function removeEmptyFolders(base: string, dir: string): void {
  for (let at = path.resolve(base, dir); ; at = path.dirname(at)) {
    const rel = path.relative(path.resolve(base), at);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return;
    try {
      if (readdirSync(at).length > 0) return;
      rmdirSync(at);
    } catch {
      return;
    }
  }
}
