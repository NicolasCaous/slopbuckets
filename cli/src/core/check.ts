// Runs the whole check: config, folder scan, one adapter call, every rule, and the lock comparison.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ABI_VERSION, type InfoResponse } from '@slopbuckets/adapter-ts';
import { analysisKey, diskCache, lookupCache, makeCacheEntry, type CacheEntry, type CacheStore } from './cache.js';
import { sha256 } from './hash.js';
import { loadConfig, protocolConfig, type ResolvedConfig } from './config.js';
import {
  copyDrift,
  folderFingerprint,
  hasDrift,
  LINKS_FILE,
  linkState,
  originSource,
  parseLinkPath,
  readLinksManifest,
  realLinkPrefixes,
  resolveOrigin,
  type LinkRequest,
} from './links.js';
import { computeLockFromModel, diffLocks, isSupportedLockVersion, readLock, toolchainChanged } from './lock.js';
import { buildModel, type Model } from './model.js';
import { CONFIG_FILE, diskCase, LOCK_FILE, relativeToProject, toPosix } from './paths.js';
import { checkCycles } from './rules/cycles.js';
import { checkImports, type DmzUse } from './rules/imports.js';
import { checkOrphans, type OrphanChain } from './rules/orphans.js';
import { checkDmzTargets } from './rules/targets.js';
import { aliasReuseViolations } from './project.js';
import { scanProject } from './scan.js';
import {
  EnvironmentError,
  type CheckReport,
  type Context,
  type LinkedAnalyzeRequest,
  type LinkAnalysis,
  type LinkedAnalyzeResponse,
  type Lock,
  type LockChange,
  type LockLink,
  type Violation,
} from './types.js';

export interface CheckOptions {
  /** Check a single file: project-relative or absolute. Skips the orphan rule and the lock comparison. */
  file?: string;
  /** Skip the CLI, adapter and toolchain version checks against the lock. Used by `buckets refresh`, which updates the versions. */
  ignoreVersions?: boolean;
  /** Folder of the analysis cache (`.buckets/cache` of the project where the check runs). No cache when absent. */
  cacheDir?: string;
  /** Another place for the analysis cache, such as memory. Takes precedence over `cacheDir`. */
  cache?: CacheStore;
}

export interface CheckResult {
  report: CheckReport;
  config?: ResolvedConfig;
  /** The state as a lock, present when the analysis ran on the whole project. */
  lock?: Lock;
  /** The lock on disk, when it exists and is readable. */
  previousLock?: Lock;
  orphanChains: OrphanChain[];
  /** Nested projects found by the scan, relative to this project. Empty when the scan did not run. */
  nestedProjects: string[];
  /** The joined scan and analysis, present when the analysis ran on the whole project. `buckets inspect` reads it. */
  model?: Model;
  /** The allowed imports of DMZ symbols that the rules found, present with `model`. */
  uses?: DmzUse[];
  /**
   * Identifies the state the analysis saw: the cache key plus the fingerprint of the adapter's inputs. Present only
   * when a cache was given and the adapter reported its inputs. Equal keys mean the same analysis.
   */
  stateKey?: string;
}

export function exitCodeFor(report: Pick<CheckReport, 'violations' | 'lockChanges' | 'environment'>): 0 | 1 | 2 | 3 {
  if (report.environment) return 3;
  if (report.violations.length > 0) return 1;
  if (report.lockChanges.length > 0) return 2;
  return 0;
}

function environmentResult(error: EnvironmentError, config?: ResolvedConfig): CheckResult {
  const report: CheckReport = { exitCode: 3, violations: [], lockChanges: [], environment: { code: error.code, message: error.message } };
  return config ? { report, config, orphanChains: [], nestedProjects: [] } : { report, orphanChains: [], nestedProjects: [] };
}

const ADAPTER_ERROR_CODES = new Set(['no-typescript', 'no-tsconfig', 'adapter-failed']);

/** Maps anything an adapter throws to an EnvironmentError. */
export function toEnvironmentError(error: unknown, adapterName: string): EnvironmentError {
  if (error instanceof EnvironmentError) return error;
  if (error instanceof Error && error.name === 'AdapterEnvironmentError') {
    const code = (error as Error & { code?: string }).code;
    if (code && ADAPTER_ERROR_CODES.has(code)) return new EnvironmentError(code as EnvironmentError['code'], error.message);
  }
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return new EnvironmentError('adapter-failed', `The ${adapterName} adapter failed unexpectedly: ${detail}`);
}

function versionProblem(lock: Lock, cliVersion: string, info: InfoResponse): EnvironmentError | null {
  const stop = 'An AI agent must stop here and show this message to the human.';
  if (!isSupportedLockVersion(lock.lockVersion)) {
    return new EnvironmentError(
      'cli-version',
      `${LOCK_FILE} has lockVersion ${String(lock.lockVersion)}, a format that slopbuckets ${cliVersion} cannot read. It was written by slopbuckets ${lock.cli}. Install a slopbuckets version that reads this lock (npm install -g slopbuckets@${lock.cli}), or a human runs \`buckets refresh\` to write it again. ${stop}`,
    );
  }
  if (lock.cli !== cliVersion) {
    return new EnvironmentError(
      'cli-version',
      `${LOCK_FILE} was written by slopbuckets ${lock.cli}, but the installed CLI is ${cliVersion}. Install the matching version (npm install -g slopbuckets@${lock.cli}), or, to move the project to ${cliVersion}, a human runs \`buckets refresh\`. ${stop}`,
    );
  }
  if (lock.adapter.name !== info.name || lock.adapter.version !== info.version) {
    return new EnvironmentError(
      'adapter-version',
      `${LOCK_FILE} was written with adapter ${lock.adapter.name} ${lock.adapter.version}, but the installed adapter is ${info.name} ${info.version}. Install the slopbuckets version that ships adapter ${lock.adapter.name} ${lock.adapter.version}, or, to move the project to the new adapter, a human runs \`buckets refresh\`. ${stop}`,
    );
  }
  return null;
}

/**
 * The toolchain is known only after the analysis, so it is compared after the CLI and adapter versions.
 * A toolchain difference alone is not a problem: a TypeScript patch release usually computes the same
 * hashes. It stops the check only when a signature hash also differs from the lock, because then the
 * check cannot tell a real contract change from a hash that the new compiler computes differently.
 */
function toolchainProblem(lock: Lock, current: Lock['adapter'], changes: LockChange[]): EnvironmentError | null {
  if (!toolchainChanged(lock.adapter, current)) return null;
  const changed = changes.filter((c) => c.kind === 'signature-changed').map((c) => `\`${c.symbol}\` in ${c.path}`);
  if (changed.length === 0) return null;
  const listed = changed.length > 3 ? `${changed.slice(0, 3).join(', ')} and ${changed.length - 3} more` : changed.join(', ');
  return new EnvironmentError(
    'adapter-version',
    `${LOCK_FILE} was written with ${lock.adapter.toolchain}, but the project now uses ${current.toolchain}, and ${changed.length === 1 ? `the signature hash of ${listed} differs` : `the signature hashes of ${listed} differ`} from the lock. A different compiler version can change the signature hashes of DMZ symbols, so this check cannot tell a real contract change from a toolchain change. A human confirms the toolchain change (for example a TypeScript upgrade in package.json or the lockfile) and runs \`buckets refresh\`, or installs ${lock.adapter.toolchain} again. An AI agent must stop here and show this message to the human.`,
  );
}

/** Ends a message from the adapter with a period so more text can follow. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function projectConfigViolations(response: LinkedAnalyzeResponse): Violation[] {
  return response.config.map((problem) => ({
    rule: 'project-config' as const,
    file: problem.file,
    ...(problem.line !== undefined ? { line: problem.line } : {}),
    message: `${sentence(problem.message)} slopbuckets needs this project setting to check the rules. Fix ${problem.file}, or run \`buckets init\`, which applies the settings it can and says what to change by hand.`,
  }));
}

function syntaxViolations(model: Model): Violation[] {
  const out: Violation[] = [];
  for (const file of model.layout.dmzFiles.keys()) {
    for (const v of model.response.dmz[file]?.violations ?? []) {
      out.push({
        rule: 'dmz-syntax',
        file,
        line: v.line,
        message: `${sentence(v.message)} A DMZ file may contain only \`export { name } from '...'\` and \`export type { Name } from '...'\` statements, with no \`as\`, no \`export *\`, no default export, no imports and no declarations.`,
      });
    }
  }
  return out;
}

function compareViolations(a: Violation, b: Violation): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if ((a.line ?? 0) !== (b.line ?? 0)) return (a.line ?? 0) - (b.line ?? 0);
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
}

function normalizeTarget(projectDir: string, file: string): string | null {
  const rel = path.isAbsolute(file) ? relativeToProject(projectDir, file) : toPosix(path.posix.normalize(toPosix(file)));
  return rel === null ? null : diskCase(projectDir, rel);
}


/**
 * Makes the adapter's view of links match the registered link paths. An adapter that follows junctions can report a
 * file of a link by the real path of the origin; this maps imports, published files, dependencies and problems back
 * to the path through the link.
 */
export function normalizeLinkPaths(projectDir: string, response: LinkedAnalyzeResponse, links: ReadonlySet<string>): void {
  if (links.size === 0) return;
  const prefixes = realLinkPrefixes(projectDir, links);
  if (prefixes.size === 0) return;
  const map = (file: string): string => {
    const posix = file.replace(/\\/g, '/');
    for (const [real, link] of prefixes) {
      if (posix === real || posix.startsWith(`${real}/`)) return link + posix.slice(real.length);
    }
    return file;
  };
  for (const analyzed of Object.values(response.code)) {
    for (const imp of analyzed.imports) if (imp.kind === 'internal' && imp.target !== null) imp.target = map(imp.target);
  }
  for (const analysis of Object.values(response.links ?? {})) {
    for (const entry of analysis.exports) entry.file = map(entry.file);
    for (const dep of analysis.dependencies) dep.from = map(dep.from);
    for (const problem of analysis.problems) if (problem.file !== undefined) problem.file = map(problem.file);
  }
}

const LINK_SYNC = 'Run `buckets link sync` to recreate it from buckets.links.json.';

/** A registered link inside a bucket of the project, with what is on disk at its path. */
interface LinkEntry {
  path: string;
  request: LinkRequest;
  state: ReturnType<typeof linkState>;
}

/** The links of the manifest that live in a bucket, config-invalid for the others, and link-missing for those not on disk. */
function linkStatus(projectDir: string, requests: Record<string, LinkRequest>, buckets: ReadonlySet<string>): { violations: Violation[]; entries: LinkEntry[] } {
  const violations: Violation[] = [];
  const entries: LinkEntry[] = [];
  for (const p of Object.keys(requests).sort()) {
    const request = requests[p]!;
    const bucket = parseLinkPath(p)?.bucket;
    if (bucket === undefined || !buckets.has(bucket)) {
      // The folder is never read: an entry outside every bucket's _/links/ is a broken manifest, not a link.
      violations.push({
        rule: 'config-invalid',
        file: LINKS_FILE,
        message: `${LINKS_FILE} registers ${p}, but ${bucket ?? p} is not a bucket of this project, so the link is ignored. A link lives in <bucket>/_/links/<name> of a bucket that exists. Fix the entry, or remove it with \`buckets link remove\`.`,
      });
      continue;
    }
    const state = linkState(path.join(projectDir, p));
    entries.push({ path: p, request, state });
    if (state === 'link' || state === 'copy') continue;
    const sync = `${LINK_SYNC.charAt(0).toLowerCase()}${LINK_SYNC.slice(1)}`;
    const why =
      state === 'dangling'
        ? `${p} is a link whose target is gone: the origin project ${request.origin} is not on this machine at that path. Make the project available there, then ${sync}`
        : state === 'file'
          ? `${p} must be a folder (a link to or a copy of the project ${request.origin}), but it is a file. Delete it, then ${sync}`
          : `The link ${p} (${request.mode} of the project ${request.origin}) is registered in buckets.links.json but missing on disk. Links in mode "link" are not in git, so a fresh clone needs this step. ${LINK_SYNC}`;
    violations.push({ rule: 'link-missing', file: p, message: why });
  }
  return { violations, entries };
}

function present(entry: LinkEntry): boolean {
  return entry.state === 'link' || entry.state === 'copy';
}

/** The lock entry of each link: origin, mode, alias, and the published signatures when the link is on disk. */
function linkLockEntries(entries: LinkEntry[], response: LinkedAnalyzeResponse): Record<string, LockLink> {
  const links: Record<string, LockLink> = {};
  for (const entry of entries) {
    const lock: LockLink = { name: entry.path.slice(entry.path.lastIndexOf('/') + 1), origin: entry.request.origin, mode: entry.request.mode, alias: entry.request.alias };
    if (present(entry)) {
      const symbols = Object.create(null) as Record<string, Record<string, string>>;
      for (const e of response.links?.[entry.path]?.exports ?? []) {
        const file = e.file.startsWith(`${entry.path}/`) ? e.file.slice(entry.path.length + 1) : e.file;
        symbols[file] ??= Object.create(null) as Record<string, string>;
        symbols[file]![e.name] = e.signature;
      }
      lock.symbols = symbols;
    }
    links[entry.path] = lock;
  }
  return links;
}

/**
 * The message of link-missing-dependency. In a link (junction or symlink), `tsc` here reads the linked file through
 * the link path and looks up packages from this project, while Node and bundlers follow the link and look them up
 * from the origin, so the message says which side lacks the package. In a copy, both look in this project.
 * `inOrigin` is true when the origin of a link has a package.json.
 */
export function missingDependencyMessage(entry: Pick<LinkEntry, 'path' | 'request' | 'state'>, dep: LinkAnalysis['dependencies'][number], inOrigin: boolean): string {
  const name = dep.package;
  const origin = entry.request.origin;
  const head = `${dep.from}, a file of the project linked in ${entry.path}, imports the package "${name}"`;
  const tail = 'Then run `buckets check` again.';
  if (entry.state !== 'link') {
    return `${head}, which does not resolve from where that file lives. ${entry.path} is a copy, so its files resolve packages from this project, both for type checking and at runtime. Add "${name}" to the package.json of this project, with the version the origin project uses, and install it. ${tail}`;
  }
  const kind = process.platform === 'win32' ? 'junction' : 'symlink';
  const runtimeFix = inOrigin
    ? `install it in the origin: run \`npm install\` in ${origin}, where "${name}" belongs in package.json`
    : `install it in the origin: ${origin} has no package.json, so create one there with "${name}" in its dependencies and run \`npm install\` there`;
  const typesFix = `install it in this project, the consumer, for example with \`npm install --save-dev ${name}\` (or its @types package when "${name}" ships no types)`;
  if (dep.resolvedForTypes === undefined || dep.resolvedAtRuntime === undefined) {
    // An adapter that does not tell the two lookups apart: name both places.
    return `${head}, which does not resolve. ${entry.path} is a ${kind} to the project ${origin}. At runtime, Node and bundlers follow the link and load the package from the origin, so ${runtimeFix}. For type checking, \`tsc\` here reads the file through the link path and looks up the package from this project, so also ${typesFix}. ${tail}`;
  }
  const parts: string[] = [];
  if (!dep.resolvedForTypes) {
    parts.push(`Missing for type checking: \`tsc\` here reads the file through the link path, so it looks up "${name}" from the node_modules folders of this project, not of the origin. To fix it, ${typesFix}.`);
  }
  if (!dep.resolvedAtRuntime) {
    parts.push(`Missing at runtime: Node and bundlers follow the ${kind} to ${origin} and load "${name}" from the node_modules folders of the origin. To fix it, ${runtimeFix}.`);
  }
  const which = parts.length === 2 ? 'for type checking and at runtime' : !dep.resolvedForTypes ? 'for type checking' : 'at runtime';
  return `${head}, which is missing ${which}. ${entry.path} is a ${kind} to the project ${origin}. ${parts.join(' ')} ${tail}`;
}

/** link-missing-dependency for each package a linked file imports that does not resolve, and the adapter's link problems. */
function linkAnalysisViolations(projectDir: string, entries: LinkEntry[], response: LinkedAnalyzeResponse, adapterName: string): Violation[] {
  const violations: Violation[] = [];
  for (const entry of entries) {
    if (!present(entry)) continue;
    const analysis = response.links?.[entry.path];
    if (analysis === undefined) continue;
    const originDir = resolveOrigin(projectDir, entry.request.origin);
    const inOrigin = entry.state === 'link' && existsSync(path.join(originDir, 'package.json'));
    // The links of the origin: an import through one of their aliases reads like a scoped package.
    const originLinks = readLinksManifest(originDir);
    const seen = new Set<string>();
    for (const dep of analysis.dependencies) {
      if (dep.resolved) continue;
      const key = `${dep.from}\0${dep.package}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const transitive = originLinks.kind === 'ok' ? Object.entries(originLinks.links).find(([, l]) => dep.package === l.alias || dep.package.startsWith(`${l.alias}/`)) : undefined;
      if (transitive !== undefined) {
        const [theirPath, theirs] = transitive;
        const target = toPosix(path.relative(projectDir, resolveOrigin(originDir, theirs.origin))) || '.';
        const bucket = parseLinkPath(entry.path)?.bucket ?? entry.path;
        violations.push({
          rule: 'link-missing-dependency',
          file: dep.from,
          message: `${dep.from}, a file of the project linked in ${entry.path}, imports through ${theirs.alias}, the alias of the project that ${entry.request.origin} links in ${theirPath}. This project has no link with that alias, so the import does not resolve here. Link that project here too: run \`buckets link add <name> ${target}\` in ${bucket}. Then run \`buckets check\` again.`,
        });
        continue;
      }
      violations.push({ rule: 'link-missing-dependency', file: dep.from, message: missingDependencyMessage(entry, dep, inOrigin) });
    }
    for (const problem of analysis.problems) {
      violations.push({
        rule: 'project-config',
        file: problem.file ?? entry.path,
        ...(problem.line !== undefined ? { line: problem.line } : {}),
        message: `The ${adapterName} adapter could not read the project linked in ${entry.path}: ${sentence(problem.message)} Check that the origin project ${entry.request.origin} passes \`buckets check\`, and that tsconfig.json maps "${entry.request.alias}/*" to ["./${entry.path}/*"] in compilerOptions.paths.`,
      });
    }
  }
  return violations;
}

/**
 * The links that the approved lock lists and buckets.links.json no longer does, as origin alias to link path. An
 * alias that a registered link still uses is left out. Locks of version 2 have no aliases, so they give none.
 */
function removedLinks(lockRead: ReturnType<typeof readLock> | undefined, requests: Record<string, LinkRequest>): Map<string, string> {
  const out = new Map<string, string>();
  if (lockRead?.kind !== 'ok') return out;
  const current = new Set(Object.values(requests).map((r) => r.alias));
  for (const [p, link] of Object.entries(lockRead.lock.links ?? {})) {
    if (Object.hasOwn(requests, p) || link.alias === undefined || link.alias === '' || current.has(link.alias)) continue;
    out.set(link.alias, p);
  }
  return out;
}

/** link-drift for every copy whose origin is available and differs from what copying it again would write. */
function linkDrift(projectDir: string, entries: LinkEntry[], dmzExtension: string): LockChange[] {
  const changes: LockChange[] = [];
  for (const entry of entries) {
    if (entry.request.mode !== 'copy' || entry.state !== 'copy') continue;
    const source = originSource(projectDir, entry.request, dmzExtension);
    if ('problem' in source) continue; // The origin is not on this machine: the committed copy is what counts.
    const drift = copyDrift(source, path.join(projectDir, entry.path));
    if (!hasDrift(drift)) continue;
    const files = [...drift.changed.map((f) => `${f} (changed)`), ...drift.added.map((f) => `${f} (new)`), ...drift.removed.map((f) => `${f} (no longer imported by the published files)`)];
    const listed = files.length > 5 ? `${files.slice(0, 5).join(', ')} and ${files.length - 5} more` : files.join(', ');
    const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    changes.push({
      kind: 'link-drift',
      path: entry.path,
      message: `The copy in ${entry.path} differs from its origin project ${entry.request.origin}: ${listed}. Run \`buckets link update ${name}\` to copy the origin again, fix any code that the new version breaks, then ask a human to approve with \`buckets refresh --web\`.`,
    });
  }
  return changes;
}

export async function runCheck(ctx: Context, projectDir: string, options: CheckOptions = {}): Promise<CheckResult> {
  const configResult = loadConfig(projectDir);
  if (configResult.kind === 'missing') {
    return environmentResult(
      new EnvironmentError('no-config', `No ${CONFIG_FILE} in ${projectDir}. This is not a slopbuckets project. A human runs \`buckets init\` to set one up.`),
    );
  }
  if (configResult.kind === 'invalid') {
    const violations = [...configResult.violations].sort(compareViolations);
    return { report: { exitCode: 1, violations, lockChanges: [] }, orphanChains: [], nestedProjects: [] };
  }
  const config = configResult.config;
  const singleFile = options.file !== undefined;

  let info: InfoResponse;
  try {
    info = ctx.adapter.info();
  } catch (error) {
    return environmentResult(toEnvironmentError(error, config.adapter), config);
  }
  if (info.abi !== ABI_VERSION) {
    return environmentResult(
      new EnvironmentError('adapter-failed', `The ${info.name} adapter speaks protocol ${info.abi}, but this CLI speaks protocol ${ABI_VERSION}. Reinstall slopbuckets.`),
      config,
    );
  }

  const lockRead = singleFile ? undefined : readLock(projectDir);
  if (lockRead?.kind === 'ok' && !options.ignoreVersions) {
    const problem = versionProblem(lockRead.lock, ctx.cliVersion, info);
    if (problem) return environmentResult(problem, config);
  }

  const manifest = readLinksManifest(projectDir);
  const requests = manifest.kind === 'ok' ? manifest.links : {};
  const linkSet = new Set(Object.keys(requests));
  const layout = scanProject(projectDir, config, { extensions: info.extensions, dmzExtension: info.dmzExtension, links: linkSet });
  const linkEntries = linkStatus(projectDir, requests, new Set(layout.buckets.keys()));
  const presentLinks = linkEntries.entries.filter(present);
  const request: LinkedAnalyzeRequest = {
    abi: ABI_VERSION,
    config: protocolConfig(config),
    files: { dmz: [...layout.dmzFiles.keys()].sort(), code: layout.codeFiles },
  };
  if (presentLinks.length > 0) request.links = presentLinks.map((e) => ({ path: e.path, alias: e.request.alias }));
  // The adapter reports when this project's build settings still reach a nested project, which builds on its own.
  if (layout.nestedProjects.length > 0) request.nestedProjects = [...layout.nestedProjects].sort();

  const store = options.cache ?? (options.cacheDir !== undefined ? diskCache(options.cacheDir) : undefined);
  let cacheKey: string | undefined;
  let cached: CacheEntry | null = null;
  const hashes = new Map<string, string>();
  if (store !== undefined) {
    const linkHashes: Record<string, string | null> = {};
    for (const entry of linkEntries.entries) linkHashes[entry.path] = folderFingerprint(path.join(projectDir, entry.path));
    cacheKey = analysisKey({ projectDir, request, otherFiles: layout.otherFiles, links: linkHashes, versions: [ctx.cliVersion, info.name, info.version], hashes });
    cached = lookupCache(store, projectDir, cacheKey, hashes);
  }

  let response: LinkedAnalyzeResponse;
  if (cached) {
    response = cached.analyze;
  } else {
    try {
      response = await ctx.adapter.analyze(projectDir, request);
    } catch (error) {
      return environmentResult(toEnvironmentError(error, info.name), config);
    }
    if (response.abi !== ABI_VERSION) {
      return environmentResult(
        new EnvironmentError('adapter-failed', `The ${info.name} adapter answered with protocol ${response.abi}, but this CLI speaks protocol ${ABI_VERSION}. Reinstall slopbuckets.`),
        config,
      );
    }
  }

  let stateKey: string | undefined;
  if (store !== undefined && cacheKey !== undefined) {
    // The cache keeps the adapter's answers as they came, before the CLI rewrites link targets.
    const entry = cached ?? makeCacheEntry(projectDir, cacheKey, response, hashes);
    if (entry !== null) {
      if (entry !== cached) store.write(projectDir, entry);
      stateKey = sha256(`${cacheKey}\n${entry.inputs}`);
    }
  }
  response = structuredClone(response);
  normalizeLinkPaths(projectDir, response, linkSet);

  const linkInfo = new Map(linkEntries.entries.map((e) => [e.path, { alias: e.request.alias, present: present(e) }]));
  const model = buildModel(config, layout, response, info.dmzExtension, linkSet, linkInfo, removedLinks(singleFile ? readLock(projectDir) : lockRead, requests));
  const imports = checkImports(model);
  const target = singleFile ? normalizeTarget(projectDir, options.file!) : null;
  // When the single file is a DMZ file, cycles whose edges pass through its re-exports are reported on it too.
  const dmzTarget = target !== null && model.exports.has(target) ? target : undefined;
  let violations: Violation[] = [
    ...(manifest.kind === 'invalid'
      ? [
          {
            rule: 'config-invalid' as const,
            file: LINKS_FILE,
            message: `${LINKS_FILE} cannot be read: ${manifest.reason}. It lists the links of this project as {"links": {"<bucket>/_/links/<name>": {"origin": "<origin project folder>", "mode": "link" or "copy", "alias": "<alias of the origin>"}}}. Fix it, or use \`buckets link add\` and \`buckets link remove\`, which write it for you.`,
          },
        ]
      : []),
    ...aliasReuseViolations(projectDir, config),
    ...projectConfigViolations(response),
    ...layout.violations,
    ...syntaxViolations(model),
    ...checkDmzTargets(model),
    ...imports.violations,
    ...checkCycles(model, imports.uses, dmzTarget),
    ...linkEntries.violations,
    ...linkAnalysisViolations(projectDir, linkEntries.entries, response, info.name),
  ];

  if (singleFile) {
    violations = target === null ? [] : violations.filter((v) => v.file === target);
    violations.sort(compareViolations);
    const report: CheckReport = { exitCode: 0, violations, lockChanges: [] };
    report.exitCode = exitCodeFor(report);
    return { report, config, orphanChains: [], nestedProjects: layout.nestedProjects };
  }

  const syntaxBroken = new Set(violations.filter((v) => v.rule === 'dmz-syntax').map((v) => v.file));
  const orphans = checkOrphans(model, imports.uses, syntaxBroken);
  violations.push(...orphans.violations);
  violations.sort(compareViolations);

  const adapter: Lock['adapter'] = { name: info.name, version: info.version };
  if (typeof response.toolchain === 'string' && response.toolchain !== '') adapter.toolchain = response.toolchain;
  const lock = computeLockFromModel(model, projectDir, { cli: ctx.cliVersion, adapter }, linkLockEntries(linkEntries.entries, response));
  let lockChanges: LockChange[];
  if (lockRead?.kind === 'missing') {
    lockChanges = [
      { kind: 'lock-missing', path: LOCK_FILE, message: `${LOCK_FILE} does not exist yet, so no state has been approved. A human must run \`buckets refresh\` to create it.` },
    ];
  } else if (lockRead?.kind === 'invalid') {
    lockChanges = [
      { kind: 'lock-missing', path: LOCK_FILE, message: `${LOCK_FILE} cannot be read: ${lockRead.reason}. A human must run \`buckets refresh\` to write it again.` },
    ];
  } else {
    lockChanges = lockRead?.kind === 'ok' && isSupportedLockVersion(lockRead.lock.lockVersion) ? diffLocks(lockRead.lock, lock) : [];
    if (lockRead?.kind === 'ok') lockChanges.push(...linkDrift(projectDir, linkEntries.entries, info.dmzExtension));
  }
  if (lockRead?.kind === 'ok' && !options.ignoreVersions) {
    const problem = toolchainProblem(lockRead.lock, adapter, lockChanges);
    if (problem) return environmentResult(problem, config);
  }

  const report: CheckReport = { exitCode: 0, violations, lockChanges };
  report.exitCode = exitCodeFor(report);
  const result: CheckResult = { report, config, lock, orphanChains: orphans.chains, nestedProjects: layout.nestedProjects, model, uses: imports.uses };
  if (lockRead?.kind === 'ok') result.previousLock = lockRead.lock;
  if (stateKey !== undefined) result.stateKey = stateKey;
  return result;
}
