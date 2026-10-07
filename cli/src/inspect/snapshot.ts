// The snapshot of `buckets inspect`: everything the inspect page shows and `buckets inspect --json` prints, built
// from the real check model of the project and of every project nested in it. The page and the JSON output read the
// same object, so what an agent sees in the JSON is what a human sees on the page.
import path from 'node:path';
import type { CacheStore } from '../core/cache.js';
import { runRecursiveCheck, joinProject } from '../core/recursive.js';
import { EXTERNAL, PARENT, SELF } from '../core/dmz-path.js';
import { sha256 } from '../core/hash.js';
import { copyDrift, originSource, resolveOrigin as resolveLinkOrigin } from '../core/links.js';
import { resolveOrigin, type Model } from '../core/model.js';
import { codeBucket, splitBucketPath } from '../core/paths.js';
import { buildEdges, cyclicComponents } from '../core/rules/cycles.js';
import type { DmzUse } from '../core/rules/imports.js';
import type { OrphanChain } from '../core/rules/orphans.js';
import type { CheckResult } from '../core/check.js';
import type { Context, ExitCode, LockChangeKind, LockLink, RuleId } from '../core/types.js';
import { projectName } from '../web/lock-review.js';
import { signatureReader, type SignatureReader } from './signature-text.js';

/** The format of the snapshot. It changes when a field changes meaning or goes away. */
export const SNAPSHOT_VERSION = 1;

/** How a bucket, contract or project looks on the map: no problem, differs from the lock, or breaks a rule. */
export type Situation = 'ok' | 'lock' | 'violation';
export type ProjectStatus = Situation | 'environment';

export interface InspectSnapshot {
  snapshotVersion: typeof SNAPSHOT_VERSION;
  cli: string;
  /** ISO time of the check the snapshot comes from. */
  generatedAt: string;
  /** Absolute folder of the project where inspect started. */
  dir: string;
  /** The exit code `buckets check` would return for the same projects. */
  exitCode: ExitCode;
  summary: {
    projects: number;
    buckets: number;
    contracts: number;
    symbols: number;
    violations: number;
    lockChanges: number;
    links: number;
  };
  /** The starting project first as `.`, then the nested ones in tree order. */
  projects: ProjectSnapshot[];
  /** Every link of every project, as edges between projects for the constellation. */
  links: LinkEdge[];
}

export interface ProjectSnapshot {
  /** Relative to the starting project, `.` for it. */
  path: string;
  /** The `name` in package.json, or the folder name. */
  name: string;
  dir: string;
  /** The project that contains this one, or null for the starting project. */
  parent: string | null;
  /** The bucket of the parent project whose `_/` holds this project. */
  container: { project: string; bucket: string } | null;
  exitCode: ExitCode;
  status: ProjectStatus;
  environment?: { code: string; message: string };
  config: { root: string; alias: string; adapter: string } | null;
  /** `current` matches the lock, `differs` needs an approval, `missing` has no lock yet, `unknown` when the check could not run. */
  lock: 'current' | 'differs' | 'missing' | 'unknown';
  /** In tree order. */
  buckets: BucketSnapshot[];
  /** DMZ files, sorted by path. */
  contracts: ContractSnapshot[];
  /** Dependencies between buckets: an edge for each bucket whose `_/` imports a symbol declared in another bucket. */
  imports: BucketEdge[];
  /** Each cycle of the bucket graph as its buckets, sorted. */
  cycles: string[][];
  /** Unused re-export chains, from the origin side to the tip. */
  orphans: { symbol: string; origin: string | null; files: string[] }[];
  violations: ViolationSnapshot[];
  lockChanges: LockChangeSnapshot[];
  /** Links this project consumes, in `<bucket>/_/links/<name>`. */
  links: LinkSnapshot[];
  /** What this project publishes to other projects: its `.external.ts` files. */
  external: ExternalSnapshot[];
  /** Projects nested directly in this one, relative to the starting project. */
  nested: string[];
}

export interface BucketSnapshot {
  path: string;
  name: string;
  /** 0 for the root bucket. */
  level: number;
  parent: string | null;
  children: string[];
  /** Files in the bucket's own `_/`, nested projects and links left out. */
  files: number;
  situation: Situation;
  violations: number;
  lockChanges: number;
  /** DMZ files where this bucket is the provider. */
  offers: string[];
  /** DMZ files where this bucket is the consumer. */
  consumes: string[];
  /** Buckets whose symbols this bucket's code imports. */
  dependsOn: string[];
  /** Buckets whose code imports symbols declared in this bucket. */
  dependents: string[];
  /** Link folders in this bucket's `_/links/`. */
  links: string[];
  /** Nested projects in this bucket's `_/`, relative to the starting project. */
  projects: string[];
  /** What a rewrite of the bucket from its contracts has to keep. */
  rewriteCost: {
    /** Distinct symbols declared in this bucket that DMZ files pass on. */
    symbols: number;
    /** DMZ files where this bucket is the provider. */
    contracts: number;
    /** Buckets that import from this one. */
    dependents: number;
  };
}

export interface ContractSnapshot {
  file: string;
  /** The bucket that holds the `dmz/` folder. */
  owner: string;
  /** Child name, `.self` or `.parent`. */
  provider: string;
  /** Child name, `.self`, `.parent` or `.external`. */
  consumer: string;
  /** The bucket the provider name stands for, or null for `.parent` (outside the owner). */
  providerBucket: string | null;
  /** The bucket the consumer name stands for, or null for `.parent` and `.external`. */
  consumerBucket: string | null;
  situation: Situation;
  /** How the file differs from the lock, or null when it matches. */
  lock: 'added' | 'changed' | null;
  violations: number;
  symbols: SymbolSnapshot[];
}

export interface SymbolSnapshot {
  name: string;
  typeOnly: boolean;
  line: number;
  /** The file this DMZ file re-exports the symbol from. */
  from: string;
  /** The bucket whose `_/` declares the symbol, or null when the chain is broken. */
  origin: string | null;
  /** The `_/` file that declares the symbol, or null when the chain is broken. */
  declaredIn: string | null;
  /** Files from this DMZ file to the declaring file. */
  chain: string[];
  /** `hash` is the signature hash in the lock; `text` is the declaration read from the source, without bodies. */
  signature: { hash: string; text: string | null };
  /** False when the symbol is an orphan contract. */
  used: boolean;
  /** `_/` files that import the symbol from this DMZ file. `used` is false for an import the file never references. */
  importers: { file: string; line: number; bucket: string; used: boolean }[];
  /** How the symbol differs from the lock, or null. */
  lock: 'added' | 'changed' | null;
}

export interface BucketEdge {
  from: string;
  to: string;
  symbols: string[];
  /** True when the edge lies on a cycle. */
  cycle: boolean;
  files: { file: string; line: number; symbol: string; via: string }[];
}

export type ViolationKind = 'cycle' | 'orphan' | 'forbidden' | 'other';

export interface ViolationSnapshot {
  /** Stable while the violation stays the same, for links and for the event feed. */
  id: string;
  rule: RuleId;
  file: string;
  line?: number;
  message: string;
  project: string;
  /** The bucket the file belongs to (the owner for a DMZ file), or null for project files. */
  bucket: string | null;
  kind: ViolationKind;
  /** For `graph-cycle`: the cycle, first bucket repeated at the end. */
  cycle?: string[];
  /** For `dmz-orphan`: the unused chain. */
  chain?: { symbol: string; origin: string | null; files: string[] };
  /** For `import-forbidden`: what the import points at. */
  target?: { file: string; bucket: string | null };
}

export interface LockChangeSnapshot {
  id: string;
  kind: LockChangeKind;
  path: string;
  symbol?: string;
  message: string;
  project: string;
  bucket: string | null;
}

export type LinkState = 'ok' | 'missing' | 'drift' | 'changed' | 'added' | 'removed';

export interface LinkSnapshot {
  /** `<bucket>/_/links/<name>`. */
  path: string;
  name: string;
  bucket: string;
  /** The folder of the origin project, relative to this project, as registered. */
  origin: string;
  /** The import alias of the origin project. Empty for a link of an older lock that had none. */
  alias: string;
  mode: LockLink['mode'];
  state: LinkState;
  /** The origin resolved to a visible project, when it is one. */
  target: { project: string } | null;
  /**
   * The symbols the origin publishes: `file` is the `.external` file relative to the link folder (and to the origin's
   * root folder), `signature` the hash the analysis computed now, or the approved one when the link is missing.
   */
  symbols: LinkSymbol[];
  /** Code of this project that imports the link. */
  usedBy: { file: string; line: number; names: string[] }[];
  /** For a copy that drifted: files that differ between the origin folder and the copy. */
  drift?: { added: string[]; removed: string[]; changed: string[] };
}

export interface LinkSymbol {
  name: string;
  typeOnly: boolean;
  file: string;
  signature: string;
  /**
   * How the symbol differs from the approved lock, as the approvals page shows it: `added` (published now, not in the
   * lock), `removed` (in the lock, no longer published; `signature` is the approved one) or `changed` (another
   * signature hash). Absent when the symbol matches the lock, or when there is no approved lock to compare with.
   */
  change?: 'added' | 'removed' | 'changed';
}

export interface LinkEdge {
  /** The project that consumes the link. */
  from: string;
  /** The project that publishes it, or null when the origin is outside the visible projects. */
  to: string | null;
  /** The origin project folder, relative to the consuming project. */
  origin: string;
  /** The import alias of the origin project. */
  alias: string;
  link: string;
  name: string;
  mode: LockLink['mode'];
  state: LinkState;
  symbols: string[];
}

export interface ExternalSnapshot {
  /** The `.external.ts` file. */
  file: string;
  /** The bucket that publishes it. */
  bucket: string | null;
  symbols: { name: string; typeOnly: boolean; origin: string | null; signature: string | null }[];
  /** Links of visible projects to this project that hold this file. */
  consumers: { project: string; link: string }[];
}

export interface SnapshotOptions {
  /** `.buckets/cache` of the starting project. No cache when absent. */
  cacheDir?: string;
  /** Another place for the analysis cache, such as a read-only view of the disk cache. Takes precedence over `cacheDir`. */
  cache?: CacheStore;
  /** False inspects only the starting project. */
  recursive?: boolean;
  /** Fixed time, for tests. */
  now?: Date;
}

/** A short stable id. */
export function shortId(...parts: (string | number | undefined)[]): string {
  return sha256(JSON.stringify(parts)).slice('sha256:'.length, 'sha256:'.length + 12);
}

function sortStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function bucketOf(root: string, file: string): string | null {
  return splitBucketPath(root, file)?.bucket ?? null;
}

function worst(a: Situation, b: Situation): Situation {
  if (a === 'violation' || b === 'violation') return 'violation';
  if (a === 'lock' || b === 'lock') return 'lock';
  return 'ok';
}

/** The bucket a provider or consumer name of `owner/dmz/` stands for. `.parent` and `.external` stand for no bucket. */
function nameBucket(owner: string, name: string): string | null {
  if (name === SELF) return owner;
  if (name === PARENT || name === EXTERNAL) return null;
  return `${owner}/${name}`;
}

const NAMED_EXPORT = /^\s*export\s+(type\s+)?\{([^}]*)\}/;
const DECLARED_EXPORT = /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?(function|const|let|var|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/;

/** Exported names of a declaration file, read line by line. */
export function exportedNames(text: string): { name: string; typeOnly: boolean }[] {
  const out = new Map<string, boolean>();
  for (const line of text.split(/\r?\n/)) {
    let m = NAMED_EXPORT.exec(line);
    if (m) {
      for (const part of m[2]!.split(',')) {
        const piece = part.trim().replace(/^type\s+/, '');
        if (piece === '') continue;
        const name = (piece.split(/\s+as\s+/)[1] ?? piece).trim();
        out.set(name, m[1] !== undefined || /^\s*type\s/.test(part));
      }
      continue;
    }
    m = DECLARED_EXPORT.exec(line);
    if (m) out.set(m[2]!, m[1] === 'interface' || m[1] === 'type');
  }
  return [...out].map(([name, typeOnly]) => ({ name, typeOnly })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

interface Run {
  path: string;
  dir: string;
  result: CheckResult;
}

/** The symbol name of an orphan violation: the export on the violation's line. */
function orphanSymbol(model: Model, file: string, line: number | undefined, message: string): string | null {
  if (line !== undefined) {
    for (const entry of model.exports.get(file)?.values() ?? []) if (entry.line === line) return entry.name;
  }
  return /`([^`]+)`/.exec(message)?.[1] ?? null;
}

function projectSnapshot(run: Run, runs: Run[], parents: Map<string, { project: string; bucket: string }>, reader: (dir: string) => SignatureReader): ProjectSnapshot {
  const { result } = run;
  const report = result.report;
  const model = result.model;
  const config = result.config;
  const root = config?.root ?? 'root';
  const container = parents.get(run.path) ?? null;
  const status: ProjectStatus = report.environment ? 'environment' : report.violations.length > 0 ? 'violation' : report.lockChanges.length > 0 ? 'lock' : 'ok';
  const lock: ProjectSnapshot['lock'] = report.environment
    ? 'unknown'
    : report.lockChanges.some((c) => c.kind === 'lock-missing')
      ? 'missing'
      : report.lockChanges.length > 0
        ? 'differs'
        : 'current';
  const nested = result.nestedProjects.map((p) => joinProject(run.path, p));

  const violations: ViolationSnapshot[] = report.violations.map((v) => {
    const out: ViolationSnapshot = {
      id: shortId(run.path, v.rule, v.file, v.line, v.message),
      rule: v.rule,
      file: v.file,
      ...(v.line !== undefined ? { line: v.line } : {}),
      message: v.message,
      project: run.path,
      bucket: bucketOf(root, v.file),
      kind: v.rule === 'graph-cycle' ? 'cycle' : v.rule === 'dmz-orphan' ? 'orphan' : v.rule === 'import-forbidden' ? 'forbidden' : 'other',
    };
    if (v.rule === 'graph-cycle') {
      const m = /^Bucket cycle: (.+?)\. /.exec(v.message);
      if (m) out.cycle = m[1]!.split(' -> ');
    } else if (v.rule === 'dmz-orphan' && model) {
      const symbol = orphanSymbol(model, v.file, v.line, v.message);
      const chain = result.orphanChains.find((c) => c.symbol === symbol && c.files.includes(v.file));
      if (chain) out.chain = { symbol: chain.symbol, origin: chain.origin, files: chain.files };
      else if (symbol !== null) out.chain = { symbol, origin: null, files: [v.file] };
    } else if (v.rule === 'import-forbidden' && model) {
      const entry = (Object.hasOwn(model.response.code, v.file) ? model.response.code[v.file] : undefined)?.imports.find((i) => i.line === v.line && i.kind === 'internal');
      if (entry?.target) out.target = { file: entry.target, bucket: bucketOf(root, entry.target) };
    }
    return out;
  });

  const lockChanges: LockChangeSnapshot[] = report.lockChanges.map((c) => ({
    id: shortId(run.path, c.kind, c.path, c.symbol, c.message),
    kind: c.kind,
    path: c.path,
    ...(c.symbol !== undefined ? { symbol: c.symbol } : {}),
    message: c.message,
    project: run.path,
    bucket: c.kind === 'lock-missing' || c.kind === 'config-changed' ? null : c.kind === 'bucket-added' || c.kind === 'bucket-removed' ? c.path : bucketOf(root, c.path),
  }));

  const snapshot: ProjectSnapshot = {
    path: run.path,
    name: projectName(run.dir),
    dir: run.dir,
    parent: container?.project ?? null,
    container,
    exitCode: report.exitCode,
    status,
    ...(report.environment ? { environment: { code: report.environment.code, message: report.environment.message } } : {}),
    config: config ? { root: config.root, alias: config.alias, adapter: config.adapter } : null,
    lock,
    buckets: [],
    contracts: [],
    imports: [],
    cycles: [],
    orphans: result.orphanChains.map((c: OrphanChain) => ({ symbol: c.symbol, origin: c.origin, files: c.files })),
    violations,
    lockChanges,
    links: [],
    external: [],
    nested,
  };
  if (!model || !config) return snapshot;
  const uses: DmzUse[] = result.uses ?? [];
  const signatures = reader(run.dir);

  // Contracts and their symbols.
  const orphanKeys = new Set(result.orphanChains.flatMap((c) => c.files.map((f) => `${f}\0${c.symbol}`)));
  const lockByFile = new Map<string, LockChangeSnapshot[]>();
  for (const c of lockChanges) {
    if (!lockByFile.has(c.path)) lockByFile.set(c.path, []);
    lockByFile.get(c.path)!.push(c);
  }
  const violationsByFile = new Map<string, number>();
  for (const v of violations) violationsByFile.set(v.file, (violationsByFile.get(v.file) ?? 0) + 1);
  const textCache = new Map<string, string | null>();
  const signatureText = (file: string | null, name: string): string | null => {
    if (file === null) return null;
    const key = `${file}\0${name}`;
    if (!textCache.has(key)) textCache.set(key, signatures.read(file, name));
    return textCache.get(key)!;
  };

  for (const [file, dmzFile] of [...model.layout.dmzFiles].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const changes = lockByFile.get(file) ?? [];
    const symbols: SymbolSnapshot[] = [];
    for (const [name, entry] of model.exports.get(file) ?? []) {
      const origin = resolveOrigin(model, file, name);
      const declaredIn = origin.bucket !== null ? origin.chain[origin.chain.length - 1]! : null;
      const importers = uses
        .filter((u) => u.target === file && u.names.includes(name))
        .map((u) => ({ file: u.file, line: u.line, bucket: u.bucket, used: u.usedNames.includes(name) }))
        .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
      const symbolChange = changes.find((c) => c.symbol === name && (c.kind === 'symbol-added' || c.kind === 'signature-changed'));
      symbols.push({
        name,
        typeOnly: entry.typeOnly,
        line: entry.line,
        from: entry.from,
        origin: origin.bucket,
        declaredIn,
        chain: origin.chain,
        signature: { hash: entry.signature, text: signatureText(declaredIn, name) },
        used: dmzFile.consumer === EXTERNAL || !orphanKeys.has(`${file}\0${name}`),
        importers,
        lock: symbolChange ? (symbolChange.kind === 'symbol-added' ? 'added' : 'changed') : null,
      });
    }
    symbols.sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : 1));
    const fileViolations = violationsByFile.get(file) ?? 0;
    const lockState: ContractSnapshot['lock'] = changes.some((c) => c.kind === 'dmz-added') ? 'added' : changes.length > 0 ? 'changed' : null;
    snapshot.contracts.push({
      file,
      owner: dmzFile.owner,
      provider: dmzFile.provider,
      consumer: dmzFile.consumer,
      providerBucket: nameBucket(dmzFile.owner, dmzFile.provider),
      consumerBucket: nameBucket(dmzFile.owner, dmzFile.consumer),
      situation: fileViolations > 0 ? 'violation' : lockState !== null ? 'lock' : 'ok',
      lock: lockState,
      violations: fileViolations,
      symbols,
    });
  }

  // The bucket graph.
  const edges = buildEdges(model, uses);
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    adjacency.get(edge.from)!.add(edge.to);
  }
  const nodes = sortStrings(edges.flatMap((e) => [e.from, e.to]));
  snapshot.cycles = cyclicComponents(nodes, adjacency).sort((a, b) => (a.join() < b.join() ? -1 : 1));
  const inCycle = new Map<string, number>();
  snapshot.cycles.forEach((c, i) => c.forEach((b) => inCycle.set(b, i)));
  const byPair = new Map<string, BucketEdge>();
  for (const edge of edges) {
    const key = `${edge.from}\0${edge.to}`;
    let out = byPair.get(key);
    if (!out) {
      const ci = inCycle.get(edge.from);
      out = { from: edge.from, to: edge.to, symbols: [], cycle: ci !== undefined && ci === inCycle.get(edge.to), files: [] };
      byPair.set(key, out);
    }
    if (!out.symbols.includes(edge.symbol)) out.symbols.push(edge.symbol);
    out.files.push({ file: edge.file, line: edge.line, symbol: edge.symbol, via: edge.via });
  }
  snapshot.imports = [...byPair.values()].sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1));
  for (const edge of snapshot.imports) edge.symbols.sort();

  // Buckets.
  const files = new Map<string, number>();
  for (const file of [...model.layout.codeFiles, ...model.layout.otherFiles]) {
    const bucket = codeBucket(root, file);
    if (bucket !== null) files.set(bucket, (files.get(bucket) ?? 0) + 1);
  }
  const linksByBucket = new Map<string, string[]>();
  const linkPaths = sortStrings([...model.links, ...Object.keys(result.previousLock?.links ?? {})]);
  for (const link of linkPaths) {
    const bucket = codeBucket(root, link);
    if (bucket === null) continue;
    if (!linksByBucket.has(bucket)) linksByBucket.set(bucket, []);
    linksByBucket.get(bucket)!.push(link);
  }
  for (const bucket of model.layout.buckets.values()) {
    const own = (b: string | null) => b === bucket.path;
    const bucketViolations = violations.filter((v) => own(v.bucket)).length;
    const bucketLock = lockChanges.filter((c) => own(c.bucket)).length;
    const offers = snapshot.contracts.filter((c) => own(c.providerBucket)).map((c) => c.file);
    const consumes = snapshot.contracts.filter((c) => own(c.consumerBucket)).map((c) => c.file);
    const dependsOn = sortStrings(snapshot.imports.filter((e) => e.from === bucket.path).map((e) => e.to));
    const dependents = sortStrings(snapshot.imports.filter((e) => e.to === bucket.path).map((e) => e.from));
    const honored = new Set<string>();
    for (const contract of snapshot.contracts) for (const s of contract.symbols) if (s.origin === bucket.path && s.declaredIn) honored.add(`${s.declaredIn}\0${s.name}`);
    snapshot.buckets.push({
      path: bucket.path,
      name: bucket.name,
      level: bucket.level,
      parent: bucket.parent,
      children: bucket.children.map((c) => `${bucket.path}/${c}`),
      files: files.get(bucket.path) ?? 0,
      situation: bucketViolations > 0 ? 'violation' : bucketLock > 0 ? 'lock' : 'ok',
      violations: bucketViolations,
      lockChanges: bucketLock,
      offers,
      consumes,
      dependsOn,
      dependents,
      links: linksByBucket.get(bucket.path) ?? [],
      projects: result.nestedProjects.filter((p) => codeBucket(root, p) === bucket.path).map((p) => joinProject(run.path, p)),
      rewriteCost: { symbols: honored.size, contracts: offers.length, dependents: dependents.length },
    });
  }

  // Links this project consumes.
  const currentLinks = result.lock?.links ?? {};
  const previousLinks = result.previousLock?.links ?? {};
  for (const link of linkPaths) {
    const entry = Object.hasOwn(currentLinks, link) ? currentLinks[link]! : Object.hasOwn(previousLinks, link) ? previousLinks[link]! : null;
    if (entry === null) continue;
    const bucket = codeBucket(root, link) ?? root;
    const state: LinkState = !Object.hasOwn(currentLinks, link)
      ? 'removed'
      : violations.some((v) => v.rule === 'link-missing' && v.file === link)
        ? 'missing'
        : lockChanges.some((c) => c.kind === 'link-drift' && c.path === link)
          ? 'drift'
          : lockChanges.some((c) => c.kind === 'link-changed' && c.path === link)
            ? 'changed'
            : lockChanges.some((c) => c.kind === 'link-added' && c.path === link)
              ? 'added'
              : 'ok';
    const target = resolveTarget(runs, resolveLinkOrigin(run.dir, entry.origin));
    const typeOnly = new Map<string, boolean>();
    for (const e of model.response.links?.[link]?.exports ?? []) typeOnly.set(`${e.file.slice(link.length + 1)}\0${e.name}`, e.typeOnly);
    // A removed link publishes nothing now, so each approved symbol reads as removed. A link missing on disk has no
    // current symbols (undefined) and shows the approved ones unmarked.
    const symbols = linkSymbols(
      Object.hasOwn(currentLinks, link) ? currentLinks[link]!.symbols : {},
      Object.hasOwn(previousLinks, link) ? previousLinks[link]!.symbols : undefined,
      result.previousLock !== undefined,
      typeOnly,
    );
    const usedBy: LinkSnapshot['usedBy'] = [];
    for (const [file, analyzed] of Object.entries(model.response.code)) {
      for (const imp of analyzed.imports) {
        if (imp.kind !== 'internal' || imp.target === null || !(imp.target === link || imp.target.startsWith(`${link}/`))) continue;
        usedBy.push({ file, line: imp.line, names: (imp.names ?? []).filter((n) => n !== '*') });
      }
    }
    usedBy.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    const out: LinkSnapshot = { path: link, name: entry.name, bucket, origin: entry.origin, alias: entry.alias ?? '', mode: entry.mode, state, target, symbols, usedBy };
    if (state === 'drift') {
      const source = originSource(run.dir, { origin: entry.origin, mode: entry.mode, alias: entry.alias ?? '' }, model.dmzExtension);
      if (!('problem' in source)) {
        const drift = copyDrift(source, path.join(run.dir, link));
        out.drift = { added: drift.added.sort(), removed: drift.removed.sort(), changed: drift.changed.sort() };
      }
    }
    snapshot.links.push(out);
  }

  // What this project publishes.
  for (const contract of snapshot.contracts) {
    if (contract.consumer !== EXTERNAL) continue;
    snapshot.external.push({
      file: contract.file,
      bucket: contract.providerBucket,
      symbols: contract.symbols.map((s) => ({ name: s.name, typeOnly: s.typeOnly, origin: s.origin, signature: s.signature.text })),
      consumers: [],
    });
  }
  return snapshot;
}

/** The visible project whose folder is `originAbs`, or null when the origin is outside the visible projects (such as `vendor/api`). */
type PublishedSymbols = Record<string, Record<string, string>>;

/**
 * The published symbols of a link, marked against the approved lock like the approvals page marks them. `now` holds
 * the symbols the analysis found (absent when the link is missing on disk or removed), `approved` those of the lock.
 * `compare` is false when there is no approved lock: then nothing is marked. Sorted by file, then name.
 */
export function linkSymbols(now: PublishedSymbols | undefined, approved: PublishedSymbols | undefined, compare: boolean, typeOnly: ReadonlyMap<string, boolean>): LinkSymbol[] {
  const out: LinkSymbol[] = [];
  const symbol = (file: string, name: string, signature: string, change?: LinkSymbol['change']): LinkSymbol => ({
    name,
    typeOnly: typeOnly.get(`${file}\0${name}`) ?? false,
    file,
    signature,
    ...(change !== undefined ? { change } : {}),
  });
  const approvedSignature = (file: string, name: string): string | undefined =>
    approved !== undefined && Object.hasOwn(approved, file) && Object.hasOwn(approved[file]!, name) ? approved[file]![name] : undefined;
  if (now === undefined) {
    // A missing link shows what the lock approved; a removed link shows it all as removed.
    for (const [file, names] of Object.entries(approved ?? {})) for (const [name, signature] of Object.entries(names)) out.push(symbol(file, name, signature));
  } else {
    for (const [file, names] of Object.entries(now)) {
      for (const [name, signature] of Object.entries(names)) {
        const before = approvedSignature(file, name);
        out.push(symbol(file, name, signature, !compare ? undefined : before === undefined ? 'added' : before !== signature ? 'changed' : undefined));
      }
    }
    if (compare) {
      for (const [file, names] of Object.entries(approved ?? {})) {
        for (const [name, signature] of Object.entries(names)) if (!(Object.hasOwn(now, file) && Object.hasOwn(now[file]!, name))) out.push(symbol(file, name, signature, 'removed'));
      }
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function resolveTarget(runs: Run[], originAbs: string): { project: string } | null {
  const run = runs.find((r) => path.relative(r.dir, originAbs) === '');
  return run === undefined ? null : { project: run.path };
}

/** Builds the snapshot of a project and of every project nested in it. */
export async function buildSnapshot(ctx: Context, projectDir: string, options: SnapshotOptions = {}): Promise<InspectSnapshot> {
  const { report, runs } = await runRecursiveCheck(ctx, projectDir, {
    recursive: options.recursive ?? true,
    ...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
  });
  return assembleSnapshot(ctx, projectDir, report.exitCode, runs, options.now ?? new Date());
}

/** Turns check runs into a snapshot. Exported for tests. */
export function assembleSnapshot(ctx: Context, projectDir: string, exitCode: ExitCode, runs: Run[], now: Date): InspectSnapshot {
  const parents = new Map<string, { project: string; bucket: string }>();
  for (const run of runs) {
    const root = run.result.config?.root ?? 'root';
    for (const nested of run.result.nestedProjects) {
      parents.set(joinProject(run.path, nested), { project: run.path, bucket: codeBucket(root, nested) ?? root });
    }
  }
  const readers = new Map<string, SignatureReader>();
  const reader = (dir: string): SignatureReader => {
    if (!readers.has(dir)) readers.set(dir, signatureReader(dir));
    return readers.get(dir)!;
  };
  const projects = runs.map((run) => projectSnapshot(run, runs, parents, reader));

  // Who consumes each published file, and the constellation edges.
  const links: LinkEdge[] = [];
  for (const project of projects) {
    for (const link of project.links) {
      links.push({
        from: project.path,
        to: link.target?.project ?? null,
        origin: link.origin,
        alias: link.alias,
        link: link.path,
        name: link.name,
        mode: link.mode,
        state: link.state,
        symbols: [...new Set(link.symbols.map((s) => s.name))].sort(),
      });
      if (link.target === null) continue;
      const publisher = projects.find((p) => p.path === link.target!.project);
      if (!publisher) continue;
      // The link holds the publisher's root folder, so a file in the link is that path under the publisher's root.
      const root = publisher.config?.root ?? 'root';
      const held = new Set(link.symbols.map((s) => `${root}/${s.file}`));
      for (const surface of publisher.external) {
        if (held.size === 0 || held.has(surface.file)) surface.consumers.push({ project: project.path, link: link.path });
      }
    }
  }

  const summary = {
    projects: projects.length,
    buckets: projects.reduce((n, p) => n + p.buckets.length, 0),
    contracts: projects.reduce((n, p) => n + p.contracts.length, 0),
    symbols: projects.reduce((n, p) => n + p.contracts.reduce((m, c) => m + c.symbols.length, 0), 0),
    violations: projects.reduce((n, p) => n + p.violations.length, 0),
    lockChanges: projects.reduce((n, p) => n + p.lockChanges.length, 0),
    links: links.length,
  };
  return { snapshotVersion: SNAPSHOT_VERSION, cli: ctx.cliVersion, generatedAt: now.toISOString(), dir: projectDir, exitCode, summary, projects, links };
}

/** The situation of a project for the map: its status, with an environment problem shown as a violation. */
export function projectSituation(project: ProjectSnapshot): Situation {
  return project.status === 'environment' ? 'violation' : project.status;
}

export { worst as worstSituation };
