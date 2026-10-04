// Links between projects. A link works like a git submodule: `<bucket>/_/links/<name>/` holds the source of another
// project's root folder, as a junction (or folder symlink) to it, or as a copy of the files that the origin's
// `.external.ts` files reach. The consumer imports it through the origin's own alias and compiles it with its own
// tools. buckets.links.json lists the links the project wants (any agent may edit it, like the config);
// buckets.lock.json pins what a human approved: the origin, the mode, the alias and the published signatures.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, type ResolvedConfig } from './config.js';
import { listFilesRecursive } from './fs-walk.js';
import { normalizeText, sha256, sortKeys } from './hash.js';
import { parseJson } from './json.js';
import { CONFIG_FILE, diskCase, toPosix } from './paths.js';
import type { LockLink } from './types.js';

export const LINKS_FILE = 'buckets.links.json';
/** The folder inside a bucket's `_/` that holds its links. */
export const LINKS_DIR = 'links';
export const LINK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Consumer name of the files a project publishes to other projects: `P/dmz/<child>/.external.ts`. */
export const PUBLISHED_NAME = '.external';

export type LinkMode = LockLink['mode'];

export interface LinkRequest {
  /** The origin project folder, relative to this project with `/`, or absolute. */
  origin: string;
  mode: LinkMode;
  /** The import alias of the origin project. */
  alias: string;
}

export type ManifestRead = { kind: 'missing' } | { kind: 'invalid'; reason: string } | { kind: 'ok'; links: Record<string, LinkRequest> };

function record<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** `<bucket>/_/links/<name>`. */
export function linkPath(bucket: string, name: string): string {
  return `${bucket}/_/${LINKS_DIR}/${name}`;
}

/**
 * The bucket and name of a link path, or null when the path does not have the `<bucket>/_/links/<name>` shape.
 * Every segment of the bucket part must be a plain folder name: no empty segment, no `.` or `..`, no `_` or `dmz`,
 * no backslash and no drive or stream colon, so the path cannot leave the bucket's `_/links/` folder.
 */
export function parseLinkPath(p: string): { bucket: string; name: string } | null {
  const match = /^(.+)\/_\/links\/([^/]+)$/.exec(p);
  if (!match || !LINK_NAME.test(match[2]!)) return null;
  const bucket = match[1]!;
  if (/[\\:\0]/.test(bucket)) return null;
  for (const segment of bucket.split('/')) {
    if (segment === '' || segment === '.' || segment === '..' || segment === '_' || segment === 'dmz') return null;
  }
  return { bucket, name: match[2]! };
}

/**
 * The absolute location of an origin. Origins are stored relative to the project when that is possible and
 * absolute when it is not (another drive on Windows), so they are always resolved with `path.resolve`.
 */
export function resolveOrigin(projectDir: string, origin: string, api: path.PlatformPath = path): string {
  return api.resolve(projectDir, origin);
}

/**
 * How an origin is stored in buckets.links.json: relative to the project with `/` when the two share a root, else
 * the absolute path with `/`. `absolute` is true in the second case: such an origin only works on this machine.
 */
export function storedOrigin(projectDir: string, originAbs: string, api: path.PlatformPath = path): { origin: string; absolute: boolean } {
  const rel = api.relative(projectDir, originAbs);
  if (rel !== '' && !api.isAbsolute(rel)) return { origin: toPosix(rel), absolute: false };
  return { origin: originAbs.replace(/\\/g, '/'), absolute: true };
}

/** Why an origin from buckets.links.json is not acceptable, or null. Only the text is checked; see `loadOrigin`. */
export function originShapeProblem(origin: string): string | null {
  if (origin.includes('\0')) return 'it contains a NUL character';
  if (/(?:^|\/)\.external(?:\.[A-Za-z0-9]+)?\/?$/.test(origin.replace(/\\/g, '/'))) {
    return 'it names a .external file or folder, which is the format of older slopbuckets versions. A link now names the folder of the origin project (the folder with its buckets.config.json). Delete the entry and run `buckets link add <name> <origin project folder>` again';
  }
  return null;
}

export interface OriginProject {
  /** Absolute folder of the origin project. */
  dir: string;
  config: ResolvedConfig;
  /** Absolute root bucket folder of the origin: what a link in mode `link` points at. */
  rootAbs: string;
}

/**
 * The origin project at `originAbs`, or the reason it cannot be linked: the folder must hold a valid
 * buckets.config.json and the root bucket folder it names.
 */
export function loadOrigin(originAbs: string): OriginProject | { problem: string } {
  const shape = originShapeProblem(originAbs);
  if (shape !== null) return { problem: shape };
  let isDir = false;
  try {
    isDir = statSync(originAbs).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return { problem: `${toPosix(originAbs)} does not exist on this machine or is not a folder` };
  const config = loadConfig(originAbs);
  if (config.kind === 'missing') return { problem: `${toPosix(originAbs)} is not a slopbuckets project (it has no ${CONFIG_FILE}). Pass the folder that holds the ${CONFIG_FILE} of the project to link` };
  if (config.kind === 'invalid') return { problem: `the ${CONFIG_FILE} of ${toPosix(originAbs)} is invalid. Run \`buckets check\` in that project to see why` };
  const rootAbs = path.join(originAbs, config.config.root);
  try {
    if (!statSync(rootAbs).isDirectory()) throw new Error('not a folder');
  } catch {
    return { problem: `the root bucket folder ${config.config.root}/ of ${toPosix(originAbs)} does not exist` };
  }
  return { dir: originAbs, config: config.config, rootAbs };
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The absolute path of a link folder, after checking that it stays inside its bucket's `_/links/` folder: the path
 * has the link shape, the bucket is one of `buckets` (the scanned buckets of the project), and the real location of
 * `_/links/` (links and junctions followed) is that folder inside the real project. Throws with the reason otherwise,
 * so nothing is ever created, copied or deleted outside a bucket's `_/links/`.
 */
export function linkLocation(projectDir: string, linkRel: string, buckets: ReadonlySet<string>): string {
  const parsed = parseLinkPath(linkRel);
  if (parsed === null) throw new Error(`"${linkRel}" is not a link path of the form <bucket>/_/links/<name>`);
  if (!buckets.has(parsed.bucket)) throw new Error(`"${linkRel}" names ${parsed.bucket}, which is not a bucket of this project`);
  const linksDir = path.resolve(projectDir, parsed.bucket, '_', LINKS_DIR);
  const abs = path.join(linksDir, parsed.name);
  if (!samePath(path.dirname(abs), linksDir)) throw new Error(`"${linkRel}" does not stay inside ${parsed.bucket}/_/${LINKS_DIR}/`);
  let realLinks: string | null = null;
  try {
    realLinks = realpathSync.native(linksDir);
  } catch {
    realLinks = null; // Not created yet: materializeLinkAt creates it and checks again.
  }
  if (realLinks !== null) {
    let realProject: string;
    try {
      realProject = realpathSync.native(projectDir);
    } catch {
      realProject = path.resolve(projectDir);
    }
    if (!samePath(realLinks, path.join(realProject, parsed.bucket, '_', LINKS_DIR))) {
      throw new Error(`${parsed.bucket}/_/${LINKS_DIR}/ is (or is inside) a link to another folder, so slopbuckets does not write there`);
    }
  }
  return abs;
}

/** What a link is made from: the origin's root folder, and the files a copy takes from it. */
export interface LinkSource {
  rootAbs: string;
  /** Paths relative to `rootAbs`, with `/`. Only a copy uses them. */
  files: string[];
}

/** `materializeLink` at a checked link location. The parent folder is created first and checked once more. */
export function materializeLinkAt(projectDir: string, linkRel: string, buckets: ReadonlySet<string>, source: LinkSource, mode: LinkMode, deps: { symlink?: typeof symlinkSync } = {}): LinkMode {
  const abs = linkLocation(projectDir, linkRel, buckets);
  mkdirSync(path.dirname(abs), { recursive: true });
  linkLocation(projectDir, linkRel, buckets);
  return materializeLink(source, abs, mode, deps);
}

/** `removeLinkFolder` at a checked link location. */
export function removeLinkAt(projectDir: string, linkRel: string, buckets: ReadonlySet<string>): void {
  removeLinkFolder(linkLocation(projectDir, linkRel, buckets));
}

export function readLinksManifest(projectDir: string): ManifestRead {
  const file = path.join(projectDir, LINKS_FILE);
  if (!existsSync(file)) return { kind: 'missing' };
  let raw: unknown;
  try {
    raw = parseJson(readFileSync(file, 'utf8'));
  } catch (error) {
    return { kind: 'invalid', reason: `it is not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid', reason: 'it is not a JSON object' };
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) if (key !== 'links' && key !== '$comment') return { kind: 'invalid', reason: `unknown field "${key}"` };
  const links = record<LinkRequest>();
  const value = obj.links ?? {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid', reason: '"links" must be an object' };
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (parseLinkPath(key) === null) return { kind: 'invalid', reason: `"${key}" is not a link path of the form <bucket>/_/links/<name>` };
    const e = entry as Record<string, unknown> | null;
    if (e === null || typeof e !== 'object' || typeof e.origin !== 'string' || e.origin === '' || (e.mode !== 'link' && e.mode !== 'copy')) {
      return { kind: 'invalid', reason: `the entry "${key}" needs "origin" (the folder of the origin project), "mode" ("link" or "copy") and "alias" (the import alias of the origin)` };
    }
    const originIssue = originShapeProblem(e.origin);
    if (originIssue !== null) return { kind: 'invalid', reason: `the origin of "${key}" is not valid: ${originIssue}` };
    if (typeof e.alias !== 'string' || e.alias === '' || /[\s*]/.test(e.alias)) {
      return { kind: 'invalid', reason: `the entry "${key}" needs "alias", the import alias of the origin project as its buckets.config.json names it, such as "@root-k3x9pm2a"` };
    }
    links[key] = { origin: toPosix(e.origin), mode: e.mode, alias: e.alias };
  }
  return { kind: 'ok', links };
}

export function writeLinksManifest(projectDir: string, links: Record<string, LinkRequest>): void {
  const file = path.join(projectDir, LINKS_FILE);
  writeFileSync(file, `${JSON.stringify(sortKeys({ links }), null, 2)}\n`, 'utf8');
}

/**
 * A cheap fingerprint of a folder: the path, size and modification time of every file in it, links followed at the
 * top only. Null when the folder does not exist. The analysis cache uses it to see a change in a linked project.
 */
export function folderFingerprint(absDir: string): string | null {
  try {
    if (!statSync(absDir).isDirectory()) return null;
  } catch {
    return null;
  }
  const listing = listFilesRecursive(absDir);
  const lines: string[] = [];
  for (const file of listing.files) {
    try {
      const stat = statSync(path.join(absDir, file), { bigint: true });
      lines.push(`${file}\0${stat.size}:${stat.mtimeNs}`);
    } catch {
      lines.push(`${file}\0gone`);
    }
  }
  for (const link of listing.symlinks) lines.push(`${link}\0link`);
  for (const project of listing.projects) lines.push(`${project}\0project`);
  return sha256(lines.sort().join('\n'));
}

/** What is on disk at a link path. `dangling` is a link whose target is gone. */
export function linkState(absPath: string): 'missing' | 'link' | 'dangling' | 'copy' | 'file' {
  let stat;
  try {
    stat = lstatSync(absPath);
  } catch {
    return 'missing';
  }
  if (stat.isSymbolicLink()) {
    try {
      return statSync(absPath).isDirectory() ? 'link' : 'dangling';
    } catch {
      return 'dangling';
    }
  }
  return stat.isDirectory() ? 'copy' : 'file';
}

/** Copies `files` (relative to `rootAbs`) into `destAbs` byte for byte, in the same relative paths. */
export function copyFiles(rootAbs: string, files: string[], destAbs: string): void {
  mkdirSync(destAbs, { recursive: true });
  for (const file of files) {
    const target = path.join(destAbs, ...file.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(rootAbs, ...file.split('/')), target);
  }
}

/**
 * Creates `linkAbs` from the origin. Mode `link` tries a junction on Windows (no privilege needed) or a folder
 * symlink elsewhere to the origin's root folder, and copies when that fails. Returns the mode that was used.
 */
export function materializeLink(source: LinkSource, linkAbs: string, mode: LinkMode, deps: { symlink?: typeof symlinkSync } = {}): LinkMode {
  mkdirSync(path.dirname(linkAbs), { recursive: true });
  // A link inside the folder it points to would contain itself (a nested project linking the project around it).
  if (mode === 'link' && !linkContainsItself(source.rootAbs, linkAbs)) {
    try {
      (deps.symlink ?? symlinkSync)(source.rootAbs, linkAbs, process.platform === 'win32' ? 'junction' : 'dir');
      return 'link';
    } catch {
      // No permission or no support for links here: fall back to a copy.
    }
  }
  copyFiles(source.rootAbs, source.files, linkAbs);
  return 'copy';
}

function realOrResolved(abs: string): string {
  try {
    return realpathSync.native(abs);
  } catch {
    return path.resolve(abs);
  }
}

/**
 * True when a link at `linkAbs` to `targetAbs` would be inside its own target, which happens when a project nested
 * in another project's `_/` links that project. Walkers that follow links would loop through it, so such a link is
 * always a copy. The parent of `linkAbs` must exist.
 */
export function linkContainsItself(targetAbs: string, linkAbs: string): boolean {
  const target = realOrResolved(targetAbs);
  const at = path.join(realOrResolved(path.dirname(linkAbs)), path.basename(linkAbs));
  const rel = path.relative(target, at);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Removes a link or a copy. A link is unlinked without touching its target. */
export function removeLinkFolder(absPath: string): void {
  let stat;
  try {
    stat = lstatSync(absPath);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    try {
      unlinkSync(absPath);
    } catch {
      // A directory symlink on Windows is removed with rmdir; it does not follow the link either.
      rmdirSync(absPath);
    }
    return;
  }
  rmSync(absPath, { recursive: true, force: true });
}

/**
 * The real location of every link in mode `link`, mapped to the link path. The key is relative to the real project
 * folder with `/` (it can start with `../`), or the absolute real path with `/` when the origin is on another drive.
 * An adapter that follows junctions reports imports of a link by that real path.
 */
export function realLinkPrefixes(projectDir: string, links: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  let realProject: string;
  try {
    realProject = realpathSync.native(projectDir);
  } catch {
    return out;
  }
  for (const link of links) {
    const abs = path.join(projectDir, link);
    try {
      if (!lstatSync(abs).isSymbolicLink()) continue;
      const real = realpathSync.native(abs);
      const rel = path.relative(realProject, real);
      if (rel === '') continue;
      out.set(path.isAbsolute(rel) ? real.replace(/\\/g, '/') : toPosix(rel), link);
    } catch {
      // A dangling link: link-missing reports it.
    }
  }
  return out;
}

/** Adds or removes a `/<path>` line in the project's .gitignore. Returns true when the file changed. */
export function updateGitignore(projectDir: string, linkRel: string, present: boolean): boolean {
  const file = path.join(projectDir, '.gitignore');
  const line = `/${linkRel}`;
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = text.split(/\r?\n/);
  const has = lines.some((l) => l.trim() === line || l.trim() === `${line}/`);
  if (present === has) return false;
  if (present) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const prefix = text === '' || text.endsWith('\n') ? text : `${text}${eol}`;
    writeFileSync(file, `${prefix}${line}${eol}`, 'utf8');
  } else {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    writeFileSync(file, lines.filter((l) => l.trim() !== line && l.trim() !== `${line}/`).join(eol), 'utf8');
  }
  return true;
}

/**
 * True when `rel`, a path inside an origin's root folder, is one of its published files: `<bucket path>/dmz/<child>/
 * .external<ext>`, where no segment before `dmz` is `_` or `dmz` (a file of that name inside `_/` is ordinary code).
 */
export function isPublishedFile(rel: string, dmzExtension: string): boolean {
  const parts = rel.split('/');
  if (parts.length < 3) return false;
  if (parts[parts.length - 1] !== `${PUBLISHED_NAME}${dmzExtension}` || parts[parts.length - 3] !== 'dmz') return false;
  return parts.slice(0, -3).every((s) => s !== '_' && s !== 'dmz' && s !== '');
}

/** The published files of an origin's root folder, relative to it, sorted. Links inside it are not followed. */
export function publishedFiles(rootAbs: string, dmzExtension: string): string[] {
  let listing;
  try {
    listing = listFilesRecursive(rootAbs);
  } catch {
    return [];
  }
  return listing.files.filter((f) => isPublishedFile(f, dmzExtension));
}

/** Extensions tried when an import specifier has none, in the order TypeScript tries them. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.mts', '.d.mts', '.cts', '.d.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
/** A JavaScript extension written in a specifier, with the TypeScript sources it may stand for. */
const JS_TO_TS: [RegExp, string[]][] = [
  [/\.js$/, ['.ts', '.tsx', '.d.ts']],
  [/\.jsx$/, ['.tsx']],
  [/\.mjs$/, ['.mts', '.d.mts']],
  [/\.cjs$/, ['.cts', '.d.cts']],
];
const SPECIFIER = /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*(['"])([^'"\r\n]+)\1/g;
const REFERENCE = /\/\/\/\s*<reference\s+path\s*=\s*(['"])([^'"\r\n]+)\1/g;

function isFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** The file inside `rootAbs` that a specifier written in `fromAbs` names, or null (packages, files outside the root). */
function resolveSpecifier(rootAbs: string, alias: string, fromAbs: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith(`${alias}/`)) base = path.join(rootAbs, spec.slice(alias.length + 1));
  else if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(path.dirname(fromAbs), spec);
  else return null;
  const candidates = [base];
  for (const [pattern, replacements] of JS_TO_TS) if (pattern.test(base)) for (const ext of replacements) candidates.push(base.replace(pattern, ext));
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(base + ext);
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(path.join(base, `index${ext}`));
  for (const candidate of candidates) {
    const rel = path.relative(rootAbs, candidate);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    // On a file system that ignores case, `./a` finds A.TS through the candidate a.ts: keep the name on disk, so a
    // copy has the origin's file names.
    if (isFile(candidate)) return diskCase(rootAbs, toPosix(rel));
  }
  return null;
}

/**
 * The files a copy of an origin holds: its published `.external` files and every file they reach through imports
 * by the origin's alias or by relative paths, found with a plain text scan of the specifiers. Paths are relative to
 * the origin's root folder, sorted. Packages are not followed: the consumer installs them.
 */
export function linkClosure(rootAbs: string, alias: string, dmzExtension: string): string[] {
  const seen = new Set<string>();
  const queue = publishedFiles(rootAbs, dmzExtension);
  for (const file of queue) seen.add(file);
  while (queue.length > 0) {
    const file = queue.shift()!;
    const abs = path.join(rootAbs, ...file.split('/'));
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const pattern of [SPECIFIER, REFERENCE]) {
      pattern.lastIndex = 0;
      for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
        const target = resolveSpecifier(rootAbs, alias, abs, m[2]!);
        if (target !== null && !seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
  }
  return [...seen].sort();
}

export interface FolderDrift {
  /** In the origin, missing from the copy. */
  added: string[];
  /** In the copy, no longer part of what the origin publishes. */
  removed: string[];
  /** In both, with different content (CRLF counts as LF, and a leading byte order mark is ignored). */
  changed: string[];
}

function sameContent(a: string, b: string): boolean {
  try {
    const left = readFileSync(a);
    const right = readFileSync(b);
    if (left.equals(right)) return true;
    return normalizeText(left.toString('utf8')) === normalizeText(right.toString('utf8'));
  } catch {
    return false;
  }
}

/** How a copy differs from what copying the origin again would write. Empty lists mean no drift. */
export function copyDrift(origin: LinkSource, copyAbs: string): FolderDrift {
  const wanted = new Set(origin.files);
  let present: string[] = [];
  try {
    present = listFilesRecursive(copyAbs).files;
  } catch {
    present = [];
  }
  const have = new Set(present);
  const drift: FolderDrift = { added: [], removed: [], changed: [] };
  for (const file of origin.files) {
    if (!have.has(file)) drift.added.push(file);
    else if (!sameContent(path.join(origin.rootAbs, ...file.split('/')), path.join(copyAbs, ...file.split('/')))) drift.changed.push(file);
  }
  for (const file of present) if (!wanted.has(file)) drift.removed.push(file);
  return drift;
}

export function hasDrift(drift: FolderDrift): boolean {
  return drift.added.length + drift.removed.length + drift.changed.length > 0;
}

/** The source of a link from its registered origin, or the reason it is not available on this machine. */
export function originSource(projectDir: string, request: LinkRequest, dmzExtension: string): (LinkSource & { origin: OriginProject }) | { problem: string } {
  const origin = loadOrigin(resolveOrigin(projectDir, request.origin));
  if ('problem' in origin) return origin;
  return { rootAbs: origin.rootAbs, files: linkClosure(origin.rootAbs, origin.config.alias, dmzExtension), origin };
}
