// The rule engine of slopbuckets 2.0 (contract/engine.ts). One short-lived process per hook call, so every path starts
// from the cache in <project>/.buckets/cache/ (cache.ts).
//
// checkAll lists the files (git, or a walk outside a repository), stats only the files git cannot vouch for, analyzes
// the files that changed (from the object store when more than 1,000 changed), and runs every rule over the whole
// graph. The rules take about 10 ms at 50k files and 500 buckets, so checkEdit and recheck rerun all of them over the
// cached graph with the edited or changed files replaced, which keeps them equal to checkAll by construction. All
// three find what changed in their own way and then go through one pipeline, update().
// snapshot with known changes (the inspect server) skips the listing: it reads the named paths, keeps the cache entries
// of every other file, and asks git only whether a new file is ignored.
// ponytail: known changes trust the caller to name every change; inspect follows them with a full snapshot within
// 5 seconds, which is how long a change its watcher missed can stay off the page.
// ponytail: if the rules pass 30 ms, keep per-file rule results and project aggregates in the cache, and rerun only
// the edited files.
import { existsSync, readdirSync } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  ADAPTER_ABI,
  analyze,
  emptyState,
  info,
  resolveImports,
  toPosix,
  type AnalyzeOptions,
  type AnalyzeRequest,
  type FileAnalysis,
  type ResolveQuery,
} from '@slopbuckets/adapter-ts';
import {
  CONFIG_FILE,
  configNewerMessage,
  exitCodeFor,
  sortAdvice,
  sortViolations,
  violationKey,
  type Advice,
  type CheckResult,
  type EnvironmentCode,
  type EnvironmentError,
  type FileEdit,
  type RuleEngine,
  type SnapshotProject,
  type Violation,
} from '../contract/index.js';
import { diskCase, samePath } from '../files/index.js';
import { CacheStore, cacheDir, readText, sameInputs, sameList, sameStat, statOf, type CacheFile, type EditsFile } from './cache.js';
import { configHash, parseConfig, withRenames, type Config, type ConfigResult } from './config.js';
import { listedAmong, listFiles, readFromGit, slice, SOURCE, unlisted, type Listing } from './files.js';
import { applyChanges, editList, indexOf, lowerBound, type Graph } from './graph.js';
import { computeOwners, IGNORED, type Owners } from './owners.js';
import { computeAdvice, runRules, violationFiles, type RuleDetail } from './rules.js';
import { buildSnapshot, emptyProject } from './snapshot.js';

export type Engine = RuleEngine;

/** More changed files than this are read from git's object store in one process. */
const GIT_READ_MIN = 1000;
/**
 * Changed files whose change can move files in or out of the listing, or change how imports resolve. A snapshot
 * given one of them lists every file. A tsconfig that extends a file of another name is still safe: the adapter
 * hashes every file it read the settings from.
 */
const LISTING_INPUT = /(^|\/)(buckets\.config\.json|package\.json|tsconfig[^/]*\.json|\.gitignore)$/;
/** More known changes than this list every file instead: the paths go to one `git ls-files` command line. */
const KNOWN_MAX = 200;

class EnvError extends Error {
  constructor(
    readonly code: EnvironmentCode,
    message: string,
  ) {
    super(message);
  }
}

interface ProjectRef {
  /** '.' or the folder relative to the session root. */
  label: string;
  dir: string;
}

const projectsOf = (config: Config) => config.projects.map((p) => p.folder).sort();
const keyAt = (v: Violation) => violationKey(v.project === '.' ? v : { ...v, project: '.' });
const hasConfigOnDisk = (dir: string) => (folder: string) => existsSync(path.join(dir, folder, CONFIG_FILE));

/** A config that this CLI reads: valid, or with its problems. */
type ParsedConfig = Exclude<ConfigResult, { newer: string }>;

function configInvalid(project: string, result: Extract<ConfigResult, { problems: unknown }>): Violation[] {
  return result.problems.map((problem) => ({ rule: 'config-invalid', project, problem }));
}

/** The public files of a config that are in the file list but have no export details in the graph. */
function publicsWithoutExports(config: Config, files: readonly string[], g: Graph | null): string[] {
  const out: string[] = [];
  for (const b of config.buckets) {
    for (const f of b.public) if (indexOf(files, f) >= 0 && g?.exports.get(f) === undefined && !out.includes(f)) out.push(f);
  }
  return out;
}

/**
 * What one check run shares between projects: the listing and the object store reads of the session root. Every
 * entry point awaits settle() before it returns, so no process started for it still runs in the project folder,
 * which Windows would then refuse to delete.
 */
class Session {
  private listing: Promise<Listing & { git: boolean }> | null = null;
  private contents: Promise<Map<string, string>> | null = null;
  constructor(readonly root: string) {}
  list(): Promise<Listing & { git: boolean }> {
    this.listing ??= listFiles(this.root);
    return this.listing;
  }
  fromGit(): Promise<Map<string, string>> {
    this.contents ??= readFromGit(this.root).catch(() => new Map());
    return this.contents;
  }
  async settle(): Promise<void> {
    await Promise.allSettled([this.listing, this.contents]);
  }
}

interface ProjectRun {
  ref: ProjectRef;
  violations: Violation[];
  environment: EnvironmentError | null;
  advice?: Advice[];
  /** Valid nested project folders, relative to the project. */
  nested: string[];
  snapshot?: SnapshotProject;
}

/** What changed in a project since its cache, as each entry point finds it. */
interface Update {
  /** The new sorted file list; the same array as the cache's when no file came or went. */
  files: string[];
  /** Files of `files` whose content changed: read from disk, or from `contents`. */
  changed: readonly string[];
  contents?: Record<string, string>;
  /** mtime and size per file of `files`, NaN to keep the cached value. */
  mtime: Float64Array;
  size: Float64Array;
  /** Index blob per file of `files`, when the listing gave them. */
  blob?: string[];
  /** Folders inside the project that hold a buckets.config.json. */
  configs: string[];
  /** Folders inside the project that hold a tsconfig.json, '' for the project folder. */
  tsconfigs: string[];
  /** Files simulated as deleted that are still on disk. */
  deleted?: string[];
  hasConfig: (folder: string) => boolean;
}

/** What the entry points of one engine share: the cache store, and the CLI version for messages. */
interface EngineState {
  store: CacheStore;
  cli: string;
}

/** A check of one project, given its parsed config. */
type ProjectWork = (session: Session, ref: ProjectRef, config: ParsedConfig) => Promise<Omit<ProjectRun, 'ref' | 'nested'>>;

/** The config of a project, without the checks when the cache holds owners computed for this exact text. */
function readConfig(s: EngineState, dir: string, text: string): ConfigResult {
  return parseConfig(text, s.store.read(dir)?.owners?.hash);
}

/** The protocol version of the adapter, which must be the one this CLI speaks. */
function adapterAbi(): typeof ADAPTER_ABI {
  const { abi, version } = info();
  if (abi !== ADAPTER_ABI) {
    throw new EnvError('adapter-failed', `The TypeScript adapter ${version} speaks protocol ${abi}, and this CLI speaks protocol ${ADAPTER_ABI}. Reinstall slopbuckets.`);
  }
  return ADAPTER_ABI;
}

function analyzeFiles(dir: string, request: Omit<AnalyzeRequest, 'abi'>, options: AnalyzeOptions): Map<string, FileAnalysis> {
  const response = analyze(dir, { abi: adapterAbi(), ...request }, options);
  if ('error' in response) throw new EnvError(response.error.code, response.error.message);
  return new Map(Object.entries(response.files));
}

function resolver(dir: string, options: AnalyzeOptions) {
  return async (queries: ResolveQuery[]) => {
    adapterAbi();
    const r = resolveImports(dir, queries, options);
    if ('error' in r) throw new EnvError(r.error.code, r.error.message);
    return r.targets;
  };
}

/**
 * The one pipeline of every entry point: analyzes the changed files and the public files that lack export details,
 * applies the changes to the cached graph, computes the owners and runs every rule. `next` is the cache to keep;
 * the caller decides what to write.
 */
async function update(
  s: EngineState,
  ref: ProjectRef,
  config: Config,
  cache: CacheFile | null,
  u: Update,
  detail?: RuleDetail,
): Promise<{ violations: Violation[]; advice: Advice[]; next: CacheFile; graph: Graph; owners: Owners; filled: boolean }> {
  const old = cache?.graph ?? null;
  const state = cache?.adapter ?? emptyState();
  const publicFiles = config.buckets.flatMap((b) => b.public);
  const toAnalyze = [...new Set([...u.changed, ...publicsWithoutExports(config, u.files, old)])];
  // The owners depend only on the file list and the config. A project whose every file is ignored, such as a root
  // whose code lives in nested projects, needs no tsconfig.json.
  const owners = computeOwners(u.files, config, cache?.owners && old ? { files: old.files, owners: cache.owners } : undefined);
  const options: AnalyzeOptions = { fileList: u.files, state, tsconfigs: u.tsconfigs, deleted: u.deleted ?? [], requireTsconfig: owners.owner.some((o) => o !== IGNORED) };
  // Exports of every analyzed file: the graph keeps all of those of the public files, and the type names of the others.
  const analyses = analyzeFiles(ref.dir, { files: toAnalyze, publicFiles: toAnalyze, ...(u.contents ? { contents: u.contents } : {}) }, options);
  // A tsconfig or package.json that changed since the cache, or a tsconfig.json that came or went, moves the
  // targets of every file.
  const resolveAll = cache !== null && (!sameInputs(cache.inputs, state.inputs) || !sameList(cache.tsconfigs, u.tsconfigs));
  const unchanged = old !== null && toAnalyze.length === 0 && !resolveAll && u.files === old.files && (u.blob === undefined || sameList(u.blob, old.blob)) && u.mtime.every(Number.isNaN);
  const g = unchanged
    ? old
    : await applyChanges(old, { files: u.files, mtime: u.mtime, size: u.size, ...(u.blob ? { blob: u.blob } : {}), analyses, resolveAll, publicFiles: new Set(publicFiles) }, resolver(ref.dir, options));
  // The rules and the advice fill in what depends only on the config; the cache should then keep it.
  const filled = owners.cycles === undefined || owners.reasons === undefined;
  const violations = runRules({ project: ref.label, graph: g, config, owners, configs: u.configs, hasConfig: u.hasConfig }, detail);
  const advice = computeAdvice(ref.label, config, owners, u.files);
  const next: CacheFile = { ...s.store.stamp(ref.dir), graph: g, projects: projectsOf(config), owners, adapter: state, inputs: state.inputs, configs: u.configs, tsconfigs: u.tsconfigs };
  return { violations, advice, next, graph: g, owners, filled };
}

/**
 * The file list of a project after the `changed` paths (relative to the session root, `/`), from the cache and one
 * lstat per path, and the listed files among them to read again. Null when only the full listing can tell: a folder
 * or a link changed, a path the cache knew as a folder is gone, or a new file differs from a known one only in case.
 */
async function knownChanges(session: Session, ref: ProjectRef, config: Config, cache: CacheFile, changed: readonly string[]): Promise<{ files: string[]; touched: Set<string> } | null> {
  const old = cache.graph;
  const prefix = ref.label === '.' ? '' : `${ref.label}/`;
  const nested = config.projects.map((p) => p.folder);
  const touched = new Set<string>();
  const added: string[] = [];
  const removed: string[] = [];
  for (const p of changed) {
    if (!p.startsWith(prefix) || /(^|\/)(node_modules|\.git)(\/|$)/.test(p)) continue;
    const rel = p.slice(prefix.length);
    if (rel === '') return null;
    if (nested.some((n) => rel === n || rel.startsWith(`${n}/`))) continue;
    const st = await lstat(path.join(ref.dir, rel)).catch(() => null);
    if (st !== null && !st.isFile()) return null;
    const known = indexOf(old.files, rel) >= 0;
    if (st !== null) {
      if (!SOURCE.test(rel)) continue;
      if (known) touched.add(rel);
      else added.push(rel);
    } else if (known) removed.push(rel);
    else if (old.files[lowerBound(old.files, `${rel}/`)]?.startsWith(`${rel}/`) || cache.configs.some((c) => c === rel || c.startsWith(`${rel}/`))) return null;
  }
  if (added.length > 0) {
    // On a disk that ignores case, git keeps listing a file under the case it was added with.
    if (process.platform !== 'linux') {
      const lower = new Set(old.files.map((f) => f.toLowerCase()));
      for (const f of added) {
        const k = f.toLowerCase();
        if (lower.has(k)) return null;
        lower.add(k);
      }
    }
    const listed = await listedAmong(session.root, added.map((f) => prefix + f));
    for (const f of added) if (listed.has(prefix + f)) touched.add(f);
  }
  return { files: editList(old.files, touched, removed), touched };
}

/**
 * The listed files whose content may differ from the cache, with the columns of the new file list. A tracked file
 * whose index blob matches the cache is unchanged: git status already compared it with the working tree. Every other
 * file gets a stat, compared with the cached mtime and size. With known changes, only the changed files get a stat
 * and the others keep their blob. A listed file that is gone from the disk leaves the list.
 */
async function statListing(
  dir: string,
  listing: Listing,
  old: Graph | null,
  known: { touched: Set<string> } | null,
): Promise<{ files: string[]; blob: string[]; mtime: number[]; size: number[]; changed: string[] }> {
  const listed = listing.sources;
  const blob: string[] = [];
  const mtime: number[] = [];
  const size: number[] = [];
  const toStat: number[] = [];
  const oldIndex: number[] = [];
  for (let i = 0, j = 0; i < listed.length; i++) {
    const f = listed[i]!;
    while (old !== null && j < old.files.length && old.files[j]! < f) j++;
    const oi = old !== null && old.files[j] === f ? j : -1;
    const b = known === null ? (listing.clean.get(f) ?? '') : oi >= 0 && !known.touched.has(f) ? old!.blob[oi]! : '';
    blob.push(b);
    mtime.push(NaN);
    size.push(NaN);
    if (known === null ? oi >= 0 && b !== '' && old!.blob[oi] === b : !known.touched.has(f)) continue;
    toStat.push(i);
    oldIndex.push(oi);
  }
  const stats = await Promise.all(toStat.map((i) => stat(`${dir}/${listed[i]}`).catch(() => null)));
  const changed: string[] = [];
  const gone = new Set<number>();
  toStat.forEach((i, k) => {
    const st = stats[k];
    const oi = oldIndex[k]!;
    if (st == null || !st.isFile()) gone.add(i); // listed, but no longer on disk
    // A known change is read again even with the cached mtime and size: two writes within one tick of the clock
    // leave both the same.
    else if (known === null && oi >= 0 && blob[i] === '' && st.mtimeMs === old!.mtime[oi] && st.size === old!.size[oi]) return;
    else {
      mtime[i] = st.mtimeMs;
      size[i] = st.size;
      changed.push(listed[i]!);
    }
  });
  if (gone.size === 0) return { files: listed, blob, mtime, size, changed };
  const keep = (_: unknown, i: number) => !gone.has(i);
  return { files: listed.filter(keep), blob: blob.filter(keep), mtime: mtime.filter(keep), size: size.filter(keep), changed };
}

/** The text of the changed files from git's object store, when more than GIT_READ_MIN changed in a repository. */
async function gitContents(session: Session, folder: string, changed: readonly string[]): Promise<Record<string, string> | undefined> {
  if (changed.length <= GIT_READ_MIN || !(await session.list()).git) return undefined;
  const fromGit = await session.fromGit();
  const prefix = folder === '' ? '' : `${folder}/`;
  const contents: Record<string, string> = {};
  for (const f of changed) {
    const text = fromGit.get(prefix + f);
    if (text !== undefined) contents[f] = text;
  }
  return contents;
}

/**
 * Brings the cache of one project up to date with the disk and runs every rule. With `knownPaths` (see knownChanges)
 * and a warm cache, only those paths are read; the other files keep what the cache holds.
 */
async function refresh(
  s: EngineState,
  session: Session,
  ref: ProjectRef,
  config: Config,
  detail?: RuleDetail,
  knownPaths: readonly string[] | null = null,
): Promise<{ violations: Violation[]; advice: Advice[]; cache: CacheFile }> {
  const cache = s.store.read(ref.dir);
  const old = cache?.graph ?? null;
  // Without a cache every file needs reading: start the object store read now, alongside the listing.
  if (old === null) void session.fromGit();
  const folder = ref.label === '.' ? '' : ref.label;
  const known = cache !== null && knownPaths !== null ? await knownChanges(session, ref, config, cache, knownPaths) : null;
  const listing: Listing =
    cache !== null && known !== null
      ? { sources: known.files, configs: cache.configs, tsconfigs: cache.tsconfigs, clean: new Map() }
      : slice(await session.list(), folder, config.projects.map((p) => p.folder));
  const listed = await statListing(ref.dir, listing, old, known);
  // The same array lets applyChanges splice instead of rebuilding.
  const files = old !== null && sameList(listed.files, old.files) ? old.files : listed.files;
  const contents = await gitContents(session, folder, listed.changed);
  const { violations, advice, next, graph, owners, filled } = await update(
    s,
    ref,
    config,
    cache,
    {
      files,
      changed: listed.changed,
      ...(contents ? { contents } : {}),
      mtime: Float64Array.from(listed.mtime),
      size: Float64Array.from(listed.size),
      blob: listed.blob,
      configs: listing.configs,
      tsconfigs: listing.tsconfigs,
      hasConfig: hasConfigOnDisk(ref.dir),
    },
    detail,
  );
  const moved = cache === null || !sameList(cache.configs, listing.configs) || !sameList(cache.tsconfigs, listing.tsconfigs) || !sameList(cache.projects, next.projects);
  if (graph !== old || filled || owners.hash !== cache?.owners?.hash || moved) s.store.write(ref.dir, next, known !== null);
  s.store.writeState(ref.dir, config, graph, next.inputs, violations);
  return { violations, advice, cache: next };
}

/** Runs the projects below root, depth first, the root first. */
async function run(s: EngineState, root: string, work: ProjectWork, recursive: boolean, session = new Session(root), configText: (file: string) => string | null = readText): Promise<ProjectRun[]> {
  const runs: ProjectRun[] = [];
  const visit = async (ref: ProjectRef): Promise<void> => {
    const text = configText(path.join(ref.dir, CONFIG_FILE));
    if (text === null) {
      if (ref.label === '.') {
        const environment = { code: 'no-config' as const, project: '.', message: `${CONFIG_FILE} does not exist in ${ref.dir}. Run buckets init to create it.` };
        runs.push({ ref, violations: [], environment, nested: [], snapshot: emptyProject('.', environment) });
      }
      return;
    }
    const config = readConfig(s, ref.dir, text);
    if ('newer' in config) {
      // A newer format can hold anything: nothing else of this project is read, its nested projects included.
      const environment: EnvironmentError = { code: 'config-newer', project: ref.label, message: configNewerMessage(config.newer, s.cli) };
      runs.push({ ref, violations: [], environment, nested: [], snapshot: emptyProject(ref.label, environment) });
      return;
    }
    const nested = ('config' in config ? config.config.projects : config.projects).map((p) => p.folder).sort();
    let result: Omit<ProjectRun, 'ref' | 'nested'>;
    try {
      result = await work(session, ref, config);
    } catch (error) {
      if (!(error instanceof EnvError)) throw error;
      const environment = { code: error.code, project: ref.label, message: error.message };
      result = { violations: [], environment, snapshot: emptyProject(ref.label, environment) };
    }
    runs.push({ ref, nested, ...result });
    if (!recursive) return;
    for (const folder of nested) {
      await visit({ label: ref.label === '.' ? folder : `${ref.label}/${folder}`, dir: path.join(ref.dir, folder) });
    }
  };
  try {
    await visit({ label: '.', dir: path.resolve(root) });
  } finally {
    await session.settle();
  }
  return runs;
}

function result(runs: ProjectRun[]): CheckResult {
  const violations = sortViolations(runs.flatMap((r) => r.violations));
  const environment = runs.flatMap((r) => (r.environment === null ? [] : [r.environment]));
  return { exitCode: exitCodeFor(violations, environment), violations, environment, advice: sortAdvice(runs.flatMap((r) => r.advice ?? [])), projects: runs.map((r) => r.ref.label) };
}

/** The cache of a project, built from the disk first when there is none. */
async function cached(s: EngineState, session: Session, ref: ProjectRef, config: Config): Promise<CacheFile> {
  const c = s.store.read(ref.dir);
  if (c !== null && c.owners !== null) return c;
  return (await refresh(s, session, ref, config)).cache;
}

/** Project-relative path of an absolute one under the project, or null. */
function inProject(ref: ProjectRef, nested: readonly string[], abs: string): string | null {
  const rel = path.relative(ref.dir, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const p = toPosix(rel);
  return nested.some((n) => p === n || p.startsWith(`${n}/`)) ? null : p;
}

/**
 * The source files directly inside `folders` that changed on disk since the last full check without going through
 * an edit tool, such as files a shell command wrote, moved or deleted: content for a changed file, null for a
 * deleted one, and the new files, which the caller filters with `unlisted` before reading them. A cached file
 * without a stat (git vouched for it) counts as changed when it is newer than graph.bin. On Windows and macOS a file
 * whose name changed only in case keeps the name the graph has, as git keeps listing it under that name. About 1 ms
 * per folder.
 * ponytail: only the folders of the edited files; a shell change elsewhere waits for the next stop, because a stat of
 * every file or a git status costs 60 to 120 ms at 10k files.
 */
function shellChanges(ref: ProjectRef, old: Graph, folders: Set<string>): { changes: Map<string, string | null>; created: string[] } {
  const changes = new Map<string, string | null>();
  const created: string[] = [];
  const since = statOf(path.join(cacheDir(ref.dir), 'graph.bin'))?.[0];
  if (since === undefined) return { changes, created };
  for (const folder of folders) {
    const prefix = folder === '.' ? '' : `${folder}/`;
    let entries;
    try {
      entries = readdirSync(path.join(ref.dir, prefix), { withFileTypes: true });
    } catch {
      continue;
    }
    const onDisk = new Set(entries.filter((e) => e.isFile() && SOURCE.test(e.name)).map((e) => prefix + e.name));
    const byLower = process.platform === 'linux' ? null : new Map([...onDisk].map((f) => [f.toLowerCase(), f]));
    const end = prefix === '' ? old.files.length : lowerBound(old.files, `${prefix.slice(0, -1)}0`);
    for (let i = lowerBound(old.files, prefix); i < end; i++) {
      const f = old.files[i]!;
      if (f.indexOf('/', prefix.length) >= 0) continue; // in a subfolder
      const name = onDisk.has(f) ? f : (byLower?.get(f.toLowerCase()) ?? f);
      if (!onDisk.delete(name)) {
        changes.set(f, null);
        continue;
      }
      const st = statOf(path.join(ref.dir, f));
      const changed = st === null || (Number.isNaN(old.mtime[i]) ? st[0] > since : !sameStat([old.mtime[i]!, old.size[i]!], st));
      if (changed) changes.set(f, st === null ? null : readText(path.join(ref.dir, f)));
    }
    created.push(...onDisk);
  }
  return { changes, created };
}

/**
 * The spelling the graph uses for an edited path that is not in it as typed: the disk's spelling, or on a disk that
 * ignores case, the graph entry that differs only in case (a file renamed only in case keeps its listed name).
 */
function graphCase(dir: string, files: readonly string[], rel: string): string {
  const disk = diskCase(dir, rel);
  if (indexOf(files, disk) >= 0 || !existsSync(path.join(dir, disk))) return disk;
  const lower = disk.toLowerCase();
  return files.find((f) => f.toLowerCase() === lower) ?? disk;
}

/** An edit of checkEdit, with its absolute path. */
interface AbsEdit {
  abs: string;
  content: string | null;
}

/**
 * The source files of a project that an edit names, with their new content (null for a delete), and the config files
 * it writes or deletes, by folder ('' for the project).
 */
function editedFiles(ref: ProjectRef, nested: readonly string[], old: Graph, edits: readonly AbsEdit[]): { sources: Map<string, string | null>; configEdits: Map<string, boolean> } {
  const sources = new Map<string, string | null>();
  const configEdits = new Map<string, boolean>();
  const linux = process.platform === 'linux';
  for (const e of edits) {
    let rel = inProject(ref, nested, e.abs);
    if (rel === null) continue;
    const slash = rel.lastIndexOf('/');
    if (samePath(rel.slice(slash + 1), CONFIG_FILE)) {
      const folder = slash < 0 ? '' : rel.slice(0, slash);
      configEdits.set(linux || folder === '' ? folder : diskCase(ref.dir, folder), e.content !== null);
    } else if (SOURCE.test(rel) && !/(^|\/)node_modules\//.test(rel)) {
      if (!linux && indexOf(old.files, rel) < 0) rel = graphCase(ref.dir, old.files, rel);
      sources.set(rel, e.content);
    }
  }
  return { sources, configEdits };
}

/**
 * Adds to `sources` what changed on disk besides the edit: the files an earlier checkEdit simulated that have landed
 * since (the cache graph does not hold them yet), the files that a config moving folders in or out of nested
 * projects brings or takes away, and the shell changes in the folders of the edit. Returns the configs and tsconfigs
 * the project then has.
 */
async function diskChanges(session: Session, ref: ProjectRef, nested: string[], cache: CacheFile, recorded: EditsFile, sources: Map<string, string | null>): Promise<{ configs: Set<string>; tsconfigs: string[] }> {
  const old = cache.graph;
  for (const [f, st] of Object.entries(recorded.stats)) {
    if (sources.has(f) || !SOURCE.test(f)) continue;
    const now = statOf(path.join(ref.dir, f));
    if (!sameStat(st, now)) sources.set(f, now === null ? null : readText(path.join(ref.dir, f)));
  }
  let configs = new Set(cache.configs);
  let tsconfigs = cache.tsconfigs;
  if (!sameList(nested, cache.projects)) {
    // The config moves folders in or out of nested projects: the listing names the files the graph gains or loses.
    const listing = slice(await session.list(), ref.label === '.' ? '' : ref.label, nested);
    const listed = new Set(listing.sources);
    for (const f of listing.sources) if (!sources.has(f) && indexOf(old.files, f) < 0) sources.set(f, readText(path.join(ref.dir, f)));
    for (const f of old.files) if (!sources.has(f) && !listed.has(f)) sources.set(f, null);
    configs = new Set(listing.configs);
    tsconfigs = listing.tsconfigs;
  }
  const shell = shellChanges(ref, old, new Set([...sources.keys()].map((f) => path.posix.dirname(f))));
  for (const [f, content] of shell.changes) if (!sources.has(f)) sources.set(f, content);
  // A new file that checkAll would not list (git ignores it, or it sits in a dot folder outside a repository)
  // stays out of the simulation too. One process for the edited and the shell-created files.
  const fresh = [...sources].filter(([f, c]) => c !== null && indexOf(old.files, f) < 0).map(([f]) => f);
  const created = shell.created.filter((f) => !sources.has(f));
  const skip = await unlisted(ref.dir, [...fresh, ...created]);
  for (const f of fresh) if (skip.has(f)) sources.delete(f);
  for (const f of created) if (!skip.has(f)) sources.set(f, readText(path.join(ref.dir, f)));
  return { configs, tsconfigs };
}

/** checkEdit of one project: the rules over the cached graph with the edited and changed files replaced. */
async function editProject(s: EngineState, session: Session, ref: ProjectRef, parsed: ParsedConfig, edits: readonly AbsEdit[], configText: (file: string) => string | null): Promise<Omit<ProjectRun, 'ref' | 'nested'>> {
  if ('problems' in parsed) {
    // A key renamed in the edit: one bucket-renamed in place of the unknown-bucket problems it leaves.
    const file = path.join(ref.dir, CONFIG_FILE);
    const edited = configText(file);
    const problems = edited === null ? parsed.problems : withRenames(parsed.problems, readText(file), edited);
    return { violations: configInvalid(ref.label, { ...parsed, problems }), environment: null };
  }
  const config = parsed.config;
  const nested = projectsOf(config);
  const cache = await cached(s, session, ref, config);
  // The analysis of the simulated files updates cache.adapter in place, and graph.bin never gets that state.
  s.store.forget(ref.dir);
  const old = cache.graph;
  const { sources, configEdits } = editedFiles(ref, nested, old, edits);
  const recorded = s.store.readEdits(ref.dir);
  const { configs, tsconfigs } = await diskChanges(session, ref, nested, cache, recorded, sources);
  const added = [...sources].filter(([, c]) => c !== null).map(([f]) => f);
  const removed = [...sources].filter(([, c]) => c === null).map(([f]) => f);
  const files = editList(old.files, added, removed);
  const mtime = new Float64Array(files.length).fill(NaN);
  const size = new Float64Array(files.length).fill(NaN);
  for (const f of added) {
    const i = indexOf(files, f);
    mtime[i] = -1;
    size[i] = -1;
  }
  for (const [folder, exists] of configEdits) {
    if (folder === '') continue;
    if (exists) configs.add(folder);
    else configs.delete(folder);
  }
  const hasConfig = (folder: string) => configEdits.get(folder) ?? existsSync(path.join(ref.dir, folder, CONFIG_FILE));
  const contents = Object.fromEntries(added.map((f) => [f, sources.get(f) ?? '']));
  const { violations, advice } = await update(s, ref, config, cache, { files, changed: added, contents, mtime, size, configs: [...configs].sort(), tsconfigs, deleted: removed, hasConfig });
  // Remember the simulated files, so a later recheck looks at them on disk.
  const before = Object.keys(recorded.stats).length;
  for (const f of sources.keys()) {
    if (f in recorded.stats) continue;
    const i = indexOf(old.files, f);
    recorded.stats[f] = i >= 0 ? [old.mtime[i]!, old.size[i]!] : null;
  }
  if (Object.keys(recorded.stats).length > before) s.store.writeEdits(ref.dir, recorded);
  return { violations, advice, environment: null };
}

async function checkEdit(s: EngineState, root: string, edit: FileEdit | readonly FileEdit[]): Promise<CheckResult> {
  s.store.clear();
  const edits = (Array.isArray(edit) ? edit : [edit as FileEdit]).map((e) => ({ abs: path.resolve(root, e.path), content: e.content }));
  // An edited config replaces the one on disk.
  const configText = (file: string) => {
    const e = edits.find((x) => samePath(x.abs, file));
    return e === undefined ? readText(file) : e.content;
  };
  const runs = await run(s, root, (session, ref, parsed) => editProject(s, session, ref, parsed, edits, configText), true, new Session(path.resolve(root)), configText);
  return result(runs);
}

async function recheckProject(s: EngineState, session: Session, ref: ProjectRef, text: string, previous: Violation[]): Promise<Set<string>> {
  const state = s.store.readState(ref.dir);
  const edits = s.store.readEdits(ref.dir);
  const named = new Set(previous.flatMap(violationFiles));
  for (const f of Object.keys(edits.stats)) named.add(f);
  const now = new Map([...named].map((f) => [f, statOf(path.join(ref.dir, f))]));
  const known = (f: string) => (f in edits.stats ? edits.stats[f] : state?.stats[f]);
  // Fast path: the config, the tsconfig and package.json, and every file named are as the last full result saw them.
  if (
    state !== null &&
    state.configHash === configHash(text) &&
    [...now].every(([f, st]) => known(f) !== undefined && sameStat(known(f), st)) &&
    Object.entries(state.inputs).every(([p, st]) => sameStat(st, statOf(path.resolve(ref.dir, p), true)))
  ) {
    return new Set(state.keys);
  }
  const parsed = readConfig(s, ref.dir, text);
  // An environment error has no key to keep.
  if ('newer' in parsed) return new Set();
  if ('problems' in parsed) return new Set(configInvalid('.', parsed).map(keyAt));
  const config = parsed.config;
  const nested = projectsOf(config);
  const cache = s.store.read(ref.dir);
  // Without a cache, or when the config moved folders in or out of nested projects, only a listing can tell.
  if (cache === null || cache.owners === null || !sameList(cache.projects, nested)) {
    return new Set((await refresh(s, session, ref, config)).violations.map(keyAt));
  }
  // Bring the named files that moved on disk into the cache, then run the rules.
  const old = cache.graph;
  const changed: string[] = [];
  const removed: string[] = [];
  const configs = new Set(cache.configs);
  for (const [f, st] of now) {
    if (f.endsWith(CONFIG_FILE)) {
      const folder = f === CONFIG_FILE ? '' : f.slice(0, -CONFIG_FILE.length - 1);
      if (folder !== '' && !nested.some((n) => folder === n || folder.startsWith(`${n}/`))) {
        if (st === null) configs.delete(folder);
        else configs.add(folder);
      }
      continue;
    }
    if (!SOURCE.test(f) || nested.some((n) => f.startsWith(`${n}/`))) continue;
    const i = indexOf(old.files, f);
    const cachedStat: [number, number] | null = i >= 0 ? [old.mtime[i]!, old.size[i]!] : null;
    if (sameStat(cachedStat, st)) continue;
    if (st === null) removed.push(f);
    else changed.push(f);
  }
  const files = editList(old.files, changed, removed);
  const mtime = new Float64Array(files.length).fill(NaN);
  const size = new Float64Array(files.length).fill(NaN);
  for (const f of changed) {
    const i = indexOf(files, f);
    const st = now.get(f)!;
    mtime[i] = st[0];
    size[i] = st[1];
  }
  const { violations, next, graph } = await update(s, ref, config, cache, { files, changed, mtime, size, configs: [...configs].sort(), tsconfigs: cache.tsconfigs, hasConfig: hasConfigOnDisk(ref.dir) });
  s.store.write(ref.dir, next);
  // Edited files that did not move on disk stay recorded with their cached stats.
  const left: EditsFile = { ...s.store.stamp(ref.dir), stats: {} };
  for (const [f, st] of Object.entries(edits.stats)) if (!changed.includes(f) && !removed.includes(f)) left.stats[f] = st;
  s.store.writeState(ref.dir, config, graph, next.inputs, violations, left);
  return new Set(violations.map(keyAt));
}

/** The known changes of a snapshot relative to the root, or null to list every file. */
function snapshotChanges(root: string, changed: readonly string[] | undefined): string[] | null {
  if (changed === undefined || changed.length > KNOWN_MAX) return null;
  const out: string[] = [];
  for (const p of changed) {
    const rel = path.relative(root, path.resolve(root, p));
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    out.push(toPosix(rel));
  }
  return out.some((p) => LISTING_INPUT.test(p)) ? null : out;
}

export function createEngine(options: { cliVersion?: string } = {}): Engine {
  const cli = options.cliVersion ?? '';
  const s: EngineState = { store: new CacheStore(cli, keyAt), cli };
  const full: ProjectWork = async (session, ref, config) => {
    if ('problems' in config) return { violations: configInvalid(ref.label, config), environment: null };
    const { violations, advice } = await refresh(s, session, ref, config.config);
    return { violations, advice, environment: null };
  };

  return {
    async checkAll(root, opts = {}) {
      s.store.clear();
      const session = new Session(path.resolve(root));
      void session.list();
      return result(await run(s, root, full, opts.recursive !== false, session));
    },

    checkEdit: (root, edit) => checkEdit(s, root, edit),

    async recheck(root, previous) {
      s.store.clear();
      if (previous.length === 0) return [];
      const byProject = new Map<string, Violation[]>();
      for (const v of previous) {
        let list = byProject.get(v.project);
        if (list === undefined) byProject.set(v.project, (list = []));
        list.push(v);
      }
      const live = new Map<string, Set<string>>();
      const session = new Session(path.resolve(root));
      for (const [project, list] of byProject) {
        const dir = path.resolve(root, project);
        const text = readText(path.join(dir, CONFIG_FILE));
        if (text === null) continue;
        try {
          live.set(project, await recheckProject(s, session, { label: project, dir }, text, list));
        } catch (error) {
          if (!(error instanceof EnvError)) throw error;
        }
      }
      await session.settle();
      return previous.filter((v) => live.get(v.project)?.has(keyAt(v)) === true);
    },

    async snapshot(root, opts = {}) {
      s.store.clear();
      const session = new Session(path.resolve(root));
      const changed = snapshotChanges(session.root, opts.changed);
      if (changed === null) void session.list();
      const runs = await run(
        s,
        root,
        async (sess, ref, parsed) => {
          if ('problems' in parsed) {
            const violations = configInvalid(ref.label, parsed);
            return { violations, environment: null, snapshot: emptyProject(ref.label, null, violations) };
          }
          const detail: RuleDetail = { pairs: new Map(), consumers: new Map() };
          const { violations, advice, cache } = await refresh(s, sess, ref, parsed.config, detail, changed);
          const sorted = sortViolations(violations);
          const notes = sortAdvice(advice);
          return { violations, advice: notes, environment: null, snapshot: buildSnapshot(ref.label, cache.graph, parsed.config, cache.owners!, detail, sorted, notes) };
        },
        true,
        session,
      );
      return { snapshotVersion: 2, projects: runs.map((r) => r.snapshot!) };
    },
  };
}
