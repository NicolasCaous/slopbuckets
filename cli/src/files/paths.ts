import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE } from '../contract/index.js';

/**
 * A path of any platform with forward slashes, no leading `./` and no trailing slash. Unlike toPosix of the adapter,
 * which splits at the separator of this OS, it also turns the `\` of a Windows path into `/` on Linux. `buckets update` needs
 * that, because its tests pass Windows paths on every OS.
 */
export function forwardSlashes(p: string): string {
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/** Windows and macOS ignore case in file names by default; Linux and the other systems do not. */
const ignoresCase = (platform: NodeJS.Platform): boolean => platform === 'win32' || platform === 'darwin';

/** A path for comparing as text: forward slashes, no trailing slash, lower case where the file system ignores case. */
export function comparablePath(p: string, platform: NodeJS.Platform = process.platform): string {
  const posix = forwardSlashes(p).replace(/\/+$/, '');
  return ignoresCase(platform) ? posix.toLowerCase() : posix;
}

/** True when two paths name the same file or folder on `platform`, ignoring a trailing separator. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return comparablePath(a, platform) === comparablePath(b, platform);
}

/**
 * A project-relative path (protocol format) spelled with the case of the names on disk. On a file system that
 * ignores case (Windows, macOS), `SRC/Main.ts` names the file `src/main.ts`, and the rules compare paths as
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

/**
 * `<projectDir>/.buckets/<sub>`, created when missing, or null when `.buckets` or `.buckets/<sub>` is a symlink, a
 * junction or not a folder, or cannot be created. Every write under .buckets/ goes through it: a link planted
 * there would point the write at a file outside the project. The project folder itself is never created.
 * ponytail: a link swapped in between this check and the write still wins; open with O_NOFOLLOW per folder if that
 * race ever matters.
 */
export function ensureBucketsDir(projectDir: string, sub: string): string | null {
  let dir = projectDir;
  for (const name of ['.buckets', sub]) {
    dir = path.join(dir, name);
    try {
      const st = lstatSync(dir, { throwIfNoEntry: false });
      if (st === undefined) mkdirSync(dir);
      else if (st.isSymbolicLink() || !st.isDirectory()) return null;
    } catch (error) {
      // Another process created it meanwhile: check what it made.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      const st = lstatSync(dir, { throwIfNoEntry: false });
      if (st === undefined || st.isSymbolicLink() || !st.isDirectory()) return null;
    }
  }
  return dir;
}

/**
 * Walks up from `start` to the first folder that holds buckets.config.json. Like git, it does not go up into a folder
 * that GIT_CEILING_DIRECTORIES of `env` lists.
 */
export function findProjectDir(start: string, env: Record<string, string | undefined>): string | null {
  const ceilings = (env.GIT_CEILING_DIRECTORIES ?? '').split(path.delimiter).filter((d) => d !== '');
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || ceilings.some((c) => samePath(c, parent))) return null;
    dir = parent;
  }
}
