// The files a check considers: what git sees (`git ls-files -co --exclude-standard`), or a walk of the folders outside
// a repository, plus bulk reads from git's object store.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { info, sourcePattern } from '@slopbuckets/adapter-ts';
import { CONFIG_FILE } from '../contract/index.js';

/** The source files: those with an extension that the adapter reads, as info() reports them. */
export const SOURCE = sourcePattern(info().extensions);
const TSCONFIG_FILE = 'tsconfig.json';

export interface Listing {
  /** Source files, relative to the folder that was listed, with `/`, sorted. */
  sources: string[];
  /** Folders (relative, '' for the folder itself) that hold a buckets.config.json. */
  configs: string[];
  /** Folders (relative, '' for the folder itself) that hold a tsconfig.json. */
  tsconfigs: string[];
  /** Tracked files whose working copy matches the index, with the blob hash: their content is known without a stat. */
  clean: Map<string, string>;
}

function parse(paths: Iterable<string>): Omit<Listing, 'clean'> {
  const sources: string[] = [];
  const configs: string[] = [];
  const tsconfigs: string[] = [];
  const folderOf = (p: string, name: string) => p.slice(0, Math.max(0, p.length - name.length - 1));
  for (const p of paths) {
    if (p === '' || /(^|\/)node_modules\//.test(p)) continue;
    if (SOURCE.test(p)) sources.push(p);
    else if (p === CONFIG_FILE || p.endsWith(`/${CONFIG_FILE}`)) configs.push(folderOf(p, CONFIG_FILE));
    else if (p === TSCONFIG_FILE || p.endsWith(`/${TSCONFIG_FILE}`)) tsconfigs.push(folderOf(p, TSCONFIG_FILE));
  }
  sources.sort();
  // `git ls-files` lists a file with merge conflicts once per stage
  const unique = sources.filter((f, i) => i === 0 || f !== sources[i - 1]);
  return { sources: unique, configs: [...new Set(configs)].sort(), tsconfigs: [...new Set(tsconfigs)].sort() };
}

/** Every file below `dir`, skipping node_modules and folders whose name starts with a dot. */
export function walk(dir: string): string[] {
  const out: string[] = [];
  const rec = (abs: string, prefix: string) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) rec(path.join(abs, e.name), `${prefix}${e.name}/`);
      } else if (e.isFile()) out.push(prefix + e.name);
    }
  };
  rec(dir, '');
  return out;
}

/**
 * Lists `dir` as `git ls-files -co --exclude-standard` would, without blocking, and falls back to a walk outside a
 * repository. The tracked files come from `git ls-files` and the untracked ones from `git status`, run in parallel:
 * at 10k files `ls-files -o` takes 150 to 900 ms to walk the folders, `status` about 100 ms. Tracked files deleted
 * from the working tree are left out, so the check treats them as gone.
 */
export async function listFiles(dir: string): Promise<Listing & { git: boolean }> {
  // Loaded here, so the hook paths that never list files do not compile it.
  const { execFile } = await import('node:child_process');
  const git = (args: string[]) =>
    new Promise<string | null>((resolve) =>
      execFile('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 29, windowsHide: true }, (error, out) => resolve(error ? null : out)),
    );
  const [tracked, status, top] = await Promise.all([
    git(['ls-files', '-s', '-z']),
    // --no-optional-locks: never take index.lock, so a git command the agent runs at the same time does not fail.
    // `-- .` keeps the walk for untracked files inside `dir`.
    git(['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules', '--', '.']),
    // status prints paths from the top of the repository, ls-files from `dir`. --show-prefix names `dir` with the
    // case git stored, which can differ from the case of `dir` itself on Windows and macOS.
    git(['rev-parse', '--show-prefix']),
  ]);
  if (tracked === null || status === null || top === null) return { ...parse(walk(dir)), clean: new Map(), git: false };
  const prefix = top.trim();
  const dirty = new Set<string>();
  const deleted = new Set<string>();
  const paths: string[] = [];
  for (const entry of status.split('\0')) {
    if (entry === '' || !entry.startsWith(prefix, 3)) continue;
    const p = entry.slice(3 + prefix.length);
    dirty.add(p);
    if (entry.startsWith('?? ')) paths.push(p);
    else if (entry[1] === 'D') deleted.add(p);
  }
  // ls-files -s: "<mode> <blob> <stage>\t<path>". A tracked file that status does not name has the blob's content.
  const clean = new Map<string, string>();
  for (const line of tracked.split('\0')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const p = line.slice(tab + 1);
    if (deleted.has(p)) continue; // deleted from the working tree: the check treats it as gone
    paths.push(p);
    if (!dirty.has(p) && line.charCodeAt(tab - 1) === 48 /* stage 0 */) clean.set(p, line.slice(line.indexOf(' ') + 1, tab - 2));
  }
  return { ...parse(paths), clean, git: true };
}

/** True for a path that the walk outside a repository skips: inside node_modules or a folder whose name starts with a dot. */
const walkSkips = (p: string) => p.split('/').slice(0, -1).some((s) => s.startsWith('.') || s === 'node_modules');

/**
 * The files among `paths` (existing files relative to `dir`, `/`) that listFiles would list: what
 * `git ls-files -co --exclude-standard` names, or, outside a repository, the ones the walk reaches. One process.
 */
export async function listedAmong(dir: string, paths: readonly string[]): Promise<Set<string>> {
  const { execFile } = await import('node:child_process');
  const out = await new Promise<string | null>((resolve) =>
    execFile(
      'git',
      ['--literal-pathspecs', 'ls-files', '-co', '--exclude-standard', '-z', '--', ...paths],
      { cwd: dir, encoding: 'utf8', windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout),
    ),
  );
  if (out !== null) return new Set(out.split('\0'));
  return new Set(paths.filter((p) => !walkSkips(p)));
}

/**
 * The paths among `paths` (relative to `dir`, `/`, existing or not) that listFiles leaves out: what git ignores, or,
 * outside a repository, what the walk skips. One process.
 */
export async function unlisted(dir: string, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const { spawnSync } = await import('node:child_process');
  // check-ignore prints the ignored paths and exits with 1 when none is, and with 128 outside a repository.
  const p = spawnSync('git', ['check-ignore', '-z', '--stdin'], { cwd: dir, input: paths.join('\0'), encoding: 'utf8', windowsHide: true });
  if (p.status === 0) return new Set(p.stdout.split('\0'));
  if (p.status === 1) return new Set();
  return new Set(paths.filter(walkSkips));
}

/** The part of a listing inside `folder` (relative, '' for all), relative to it, without the `exclude` folders. */
export function slice(listing: Listing, folder: string, exclude: readonly string[]): Listing {
  const prefix = folder === '' ? '' : `${folder}/`;
  const skip = exclude.map((e) => `${prefix}${e}/`);
  const keep = (p: string) => p.startsWith(prefix) && !skip.some((s) => p.startsWith(s));
  const kept = listing.sources.filter(keep);
  const sources = prefix === '' ? kept : kept.map((p) => p.slice(prefix.length));
  // A folder list relative to `folder`: the folder itself is '' for tsconfig.json, and left out for the configs.
  const folders = (list: readonly string[], self: boolean) => {
    const out: string[] = [];
    for (const c of list) {
      const asFile = `${c}/`;
      if ((c === folder && !self) || (c !== folder && !asFile.startsWith(prefix)) || skip.some((x) => asFile.startsWith(x))) continue;
      out.push(c === folder ? '' : c.slice(prefix.length));
    }
    return out;
  };
  const configs = folders(listing.configs, false);
  const tsconfigs = folders(listing.tsconfigs, true);
  // At the top the paths stay the same, so the map of the whole listing serves: nobody asks it for an excluded file.
  if (prefix === '') return { sources, configs, tsconfigs, clean: listing.clean };
  const clean = new Map<string, string>();
  for (const f of sources) {
    const hash = listing.clean.get(prefix + f);
    if (hash !== undefined) clean.set(f, hash);
  }
  return { sources, configs, tsconfigs, clean };
}

/**
 * The text of every tracked source file below `dir` whose working copy matches the index, from one
 * `git cat-file --batch`. Opening each working-tree file costs milliseconds when Windows Defender has no cached
 * verdict for it, and the object store is a few pack files. Paths are relative to `dir`.
 */
export async function readFromGit(dir: string): Promise<Map<string, string>> {
  const { execFile, spawn } = await import('node:child_process');
  const run = (args: string[]) =>
    new Promise<string>((resolve, reject) =>
      execFile('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 29, windowsHide: true }, (e, out) => (e ? reject(e) : resolve(out))),
    );
  const [staged, modifiedOut] = await Promise.all([run(['ls-files', '-s', '-z']), run(['ls-files', '-m', '-z'])]);
  const modified = new Set(modifiedOut.split('\0'));
  const entries: [string, string][] = [];
  for (const line of staged.split('\0')) {
    if (line === '') continue;
    const tab = line.indexOf('\t');
    const file = line.slice(tab + 1);
    const [mode, hash, stage] = line.slice(0, tab).split(' ');
    if (!SOURCE.test(file) || modified.has(file) || stage !== '0' || mode === '120000' || mode === '160000') continue;
    entries.push([file, hash!]);
  }
  const out = new Map<string, string>();
  if (entries.length === 0) return out;
  const p = spawn('git', ['cat-file', '--batch'], { cwd: dir, windowsHide: true });
  const chunks: Buffer[] = [];
  p.stdout.on('data', (c: Buffer) => chunks.push(c));
  const closed = new Promise<void>((resolve, reject) => {
    p.on('error', reject);
    p.on('close', () => resolve());
  });
  p.stdin.end(`${entries.map((e) => e[1]).join('\n')}\n`);
  await closed;
  const buf = Buffer.concat(chunks);
  let pos = 0;
  for (const [file] of entries) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break;
    const header = buf.toString('latin1', pos, nl).split(' ');
    if (header[1] === 'missing') {
      pos = nl + 1;
      continue;
    }
    const size = Number(header[2]);
    out.set(file, buf.toString('utf8', nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return out;
}
