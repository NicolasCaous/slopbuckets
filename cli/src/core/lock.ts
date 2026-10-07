// buckets.lock.json: computing, reading, writing and comparing the approved state.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sortKeys, textHash } from './hash.js';
import { parseJson } from './json.js';
import { configChangeText, configDiff, lockConfig } from './lock-config.js';
import type { Model } from './model.js';
import { LOCK_FILE } from './paths.js';
import type { Lock, LockChange, LockLink } from './types.js';

/**
 * The format this CLI writes. Version 2 added `projects`, `links` and `dmz.<file>.external`. Version 3 changed links
 * to source links: each one records the origin's alias and published signatures, and `external` is gone. Version 4
 * stores the resolved config itself in `config` instead of its hash, so a review can show what changed in it.
 */
export const LOCK_VERSION = 4;

/** True for a lock format this CLI reads: the current one and older ones, whose missing sections count as empty. */
export function isSupportedLockVersion(version: number): boolean {
  return Number.isInteger(version) && version >= 1 && version <= LOCK_VERSION;
}

/** An empty record without a prototype, so any symbol or file name, `toString` and `__proto__` included, is an ordinary key. */
function record<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** The value stored under `key` in the record itself, ignoring anything inherited from Object.prototype. */
export function own<T>(items: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(items, key) ? items[key] : undefined;
}

export function computeLockFromModel(
  model: Model,
  projectDir: string,
  versions: { cli: string; adapter: { name: string; version: string; toolchain?: string } },
  links: Record<string, LockLink> = {},
): Lock {
  const dmz = record<Lock['dmz'][string]>();
  for (const file of [...model.layout.dmzFiles.keys()].sort()) {
    const text = readFileSync(path.join(projectDir, file), 'utf8');
    const symbols = record<string>();
    for (const [name, entry] of model.exports.get(file) ?? []) symbols[name] = entry.signature;
    dmz[file] = { text: textHash(text), symbols };
  }
  const adapter: Lock['adapter'] = { name: versions.adapter.name, version: versions.adapter.version };
  if (versions.adapter.toolchain !== undefined) adapter.toolchain = versions.adapter.toolchain;
  const lock: Lock = {
    lockVersion: LOCK_VERSION,
    cli: versions.cli,
    adapter,
    config: lockConfig(model.config),
    buckets: [...model.layout.buckets.keys()].sort(),
    dmz,
  };
  // Empty sections are left out, so a project without nested projects or links keeps the same sections as before.
  if (model.layout.nestedProjects.length > 0) lock.projects = [...model.layout.nestedProjects].sort();
  const linkPaths = Object.keys(links).sort();
  if (linkPaths.length > 0) {
    lock.links = record<LockLink>();
    for (const p of linkPaths) {
      const link = links[p]!;
      const entry: LockLink = { name: link.name, origin: link.origin, mode: link.mode };
      if (link.alias !== undefined) entry.alias = link.alias;
      if (link.symbols !== undefined) {
        const symbols = record<Record<string, string>>();
        for (const file of Object.keys(link.symbols).sort()) {
          const names = record<string>();
          for (const name of Object.keys(link.symbols[file]!).sort()) names[name] = link.symbols[file]![name]!;
          symbols[file] = names;
        }
        entry.symbols = symbols;
      }
      lock.links[p] = entry;
    }
  }
  return lock;
}

/** Deterministic serialization: sorted keys, 2-space indentation, trailing newline. */
export function serializeLock(lock: Lock): string {
  return `${JSON.stringify(sortKeys(lock), null, 2)}\n`;
}

/** Thrown when buckets.lock.json cannot be written safely, for example because it is a link or a folder. */
export class LockWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockWriteError';
  }
}

/**
 * Writes the lock to a temporary file in the same folder and renames it over buckets.lock.json, so a reader never
 * sees half a file and a link at that path is replaced instead of followed. Refuses when buckets.lock.json exists
 * and is not a regular file (a symbolic link, a junction or a folder).
 */
export async function writeLockFile(projectDir: string, lock: Lock): Promise<void> {
  const file = path.join(projectDir, LOCK_FILE);
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (stat !== undefined && !stat.isFile()) {
    const what = stat.isSymbolicLink() ? 'a symbolic link or junction' : stat.isDirectory() ? 'a folder' : 'not a regular file';
    throw new LockWriteError(`${file} is ${what}, so the lock was not written. Replace it with a regular file (or delete it), then approve again.`);
  }
  const temp = path.join(projectDir, `.${LOCK_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, serializeLock(lock), { encoding: 'utf8', flag: 'wx' });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export type LockRead = { kind: 'missing' } | { kind: 'invalid'; reason: string } | { kind: 'ok'; lock: Lock };

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * The config of a version 4 lock: an object. `access`, when present, must have the shape the review reads. Other
 * keys may hold any JSON value, so a key that a later version adds still reads and shows up in a diff.
 */
function validateConfigObject(config: unknown): string | null {
  if (config === undefined) return 'config is missing';
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return 'config is malformed';
  const access = (config as Record<string, unknown>).access;
  if (access === undefined) return null;
  if (access === null || typeof access !== 'object' || Array.isArray(access)) return 'config.access is malformed';
  const a = access as Record<string, unknown>;
  if ((a.default !== 'allow' && a.default !== 'deny') || !isStringArray(a.allow) || !isStringArray(a.deny)) return 'config.access is malformed';
  return null;
}

function validateLock(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'it is not a JSON object';
  const lock = raw as Record<string, unknown>;
  if (typeof lock.lockVersion !== 'number') return 'lockVersion is missing';
  if (typeof lock.cli !== 'string') return 'cli is missing';
  const adapter = lock.adapter as Record<string, unknown> | undefined;
  if (!adapter || typeof adapter !== 'object' || typeof adapter.name !== 'string' || typeof adapter.version !== 'string') {
    return 'adapter is missing or malformed';
  }
  if (adapter.toolchain !== undefined && typeof adapter.toolchain !== 'string') return 'adapter.toolchain is malformed';
  if (!isSupportedLockVersion(lock.lockVersion)) return null; // a newer format; the version check reports it
  const configProblem = lock.lockVersion >= 4 ? validateConfigObject(lock.config) : typeof lock.config === 'string' ? null : 'config is missing';
  if (configProblem !== null) return configProblem;
  if (!Array.isArray(lock.buckets) || !lock.buckets.every((b) => typeof b === 'string')) return 'buckets is malformed';
  const dmz = lock.dmz;
  if (dmz === null || typeof dmz !== 'object' || Array.isArray(dmz)) return 'dmz is malformed';
  for (const entry of Object.values(dmz)) {
    const e = entry as Record<string, unknown>;
    if (!e || typeof e.text !== 'string' || !isStringRecord(e.symbols)) return 'a dmz entry is malformed';
    if (e.external !== undefined && typeof e.external !== 'string') return 'a dmz entry is malformed';
  }
  if (lock.projects !== undefined && (!Array.isArray(lock.projects) || !lock.projects.every((p) => typeof p === 'string'))) {
    return 'projects is malformed';
  }
  const links = lock.links;
  if (links !== undefined) {
    if (links === null || typeof links !== 'object' || Array.isArray(links)) return 'links is malformed';
    for (const entry of Object.values(links)) {
      const e = entry as Record<string, unknown>;
      if (!e || typeof e.name !== 'string' || typeof e.origin !== 'string' || (e.mode !== 'link' && e.mode !== 'copy')) {
        return 'a links entry is malformed';
      }
      if (e.alias !== undefined && typeof e.alias !== 'string') return 'a links entry is malformed';
      if (e.hash !== undefined && typeof e.hash !== 'string') return 'a links entry is malformed';
      if (e.symbols !== undefined) {
        const files = e.symbols as Record<string, unknown> | null;
        if (files === null || typeof files !== 'object' || Array.isArray(files) || !Object.values(files).every(isStringRecord)) return 'a links entry is malformed';
      }
    }
  }
  return null;
}

export function readLock(projectDir: string): LockRead {
  const file = path.join(projectDir, LOCK_FILE);
  if (!existsSync(file)) return { kind: 'missing' };
  return parseLockText(readFileSync(file, 'utf8'));
}

/** Parses and validates the text of a lock, such as an older version of buckets.lock.json read from git. */
export function parseLockText(text: string): LockRead {
  let raw: unknown;
  try {
    raw = parseJson(text);
  } catch (error) {
    return { kind: 'invalid', reason: `it is not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  const problem = validateLock(raw);
  return problem ? { kind: 'invalid', reason: problem } : { kind: 'ok', lock: raw as Lock };
}

/**
 * True when both locks name a toolchain and the names differ. A lock written before adapters reported the toolchain
 * has none, and a missing toolchain on either side counts as unknown, which is never a difference.
 */
export function toolchainChanged(previous: Lock['adapter'], current: Lock['adapter']): boolean {
  return previous.toolchain !== undefined && current.toolchain !== undefined && previous.toolchain !== current.toolchain;
}

const REFRESH = 'A human must review this and run `buckets refresh`.';

/** `alias` of a link entry for messages: locks of version 2 have none. */
function aliasText(link: LockLink): string {
  return link.alias ?? 'no alias (a link of an older slopbuckets version)';
}

/** Every published symbol of a link entry as `file\0name` mapped to the signature hash. */
function publishedSymbols(link: LockLink): Map<string, string> {
  const out = new Map<string, string>();
  for (const [file, names] of Object.entries(link.symbols ?? {})) for (const [name, hash] of Object.entries(names)) out.set(`${file}\0${name}`, hash);
  return out;
}

function linkDiff(previous: Lock, current: Lock, changes: LockChange[]): void {
  const before = previous.links ?? {};
  const after = current.links ?? {};
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const p of [...paths].sort()) {
    const old = own(before, p);
    const now = own(after, p);
    if (!old && now) {
      const count = publishedSymbols(now).size;
      changes.push({
        kind: 'link-added',
        path: p,
        message: `New link ${p} (${now.mode} of the project ${now.origin}, imported as ${aliasText(now)}${now.symbols !== undefined ? `, ${count} published ${count === 1 ? 'symbol' : 'symbols'}` : ''}) is not in the lock. ${REFRESH}`,
      });
    } else if (old && !now) {
      changes.push({
        kind: 'link-removed',
        path: p,
        message: `Link ${p} (${old.mode} of the project ${old.origin}) was removed from buckets.links.json since the lock was approved. ${REFRESH}`,
      });
    } else if (old && now) {
      const what: string[] = [];
      if (old.origin !== now.origin) what.push(`its origin moved from ${old.origin} to ${now.origin}`);
      if (old.mode !== now.mode) what.push(`its mode changed from ${old.mode} to ${now.mode}`);
      if (old.alias !== now.alias) what.push(`its alias changed from ${aliasText(old)} to ${aliasText(now)}`);
      if (what.length > 0) changes.push({ kind: 'link-changed', path: p, message: `Link ${p} changed since the lock was approved: ${what.join(', ')}. ${REFRESH}` });
      // A link missing on disk has no published symbols; link-missing reports it.
      if (now.symbols === undefined) continue;
      const was = publishedSymbols(old);
      const is = publishedSymbols(now);
      for (const key of [...new Set([...was.keys(), ...is.keys()])].sort()) {
        const [file, name] = key.split('\0') as [string, string];
        const a = was.get(key);
        const b = is.get(key);
        if (a === b) continue;
        const where = `${file} of the linked project (${p}/${file})`;
        const message =
          a === undefined
            ? `The linked project now publishes \`${name}\` in ${where}. ${REFRESH}`
            : b === undefined
              ? `The linked project no longer publishes \`${name}\` in ${where}. Code here that imports it breaks. ${REFRESH}`
              : `The signature of \`${name}\`, published in ${where}, changed. Check the code here that uses it. ${REFRESH}`;
        changes.push({ kind: 'link-changed', path: p, symbol: name, message });
      }
    }
  }
}

/** Differences between the approved lock and the current state. Versions and the toolchain are compared elsewhere. */
export function diffLocks(previous: Lock, current: Lock): LockChange[] {
  const changes: LockChange[] = [];
  const before = new Set(previous.buckets);
  const after = new Set(current.buckets);
  for (const bucket of current.buckets) {
    if (!before.has(bucket)) changes.push({ kind: 'bucket-added', path: bucket, message: `New bucket ${bucket} is not in the lock. ${REFRESH}` });
  }
  for (const bucket of previous.buckets) {
    if (!after.has(bucket)) changes.push({ kind: 'bucket-removed', path: bucket, message: `Bucket ${bucket} was removed since the lock was approved. ${REFRESH}` });
  }
  const projectsBefore = new Set(previous.projects ?? []);
  const projectsAfter = new Set(current.projects ?? []);
  for (const p of current.projects ?? []) {
    if (!projectsBefore.has(p)) changes.push({ kind: 'project-added', path: p, message: `New nested project ${p} is not in the lock. ${REFRESH}` });
  }
  for (const p of previous.projects ?? []) {
    if (!projectsAfter.has(p)) changes.push({ kind: 'project-removed', path: p, message: `Nested project ${p} was removed since the lock was approved. ${REFRESH}` });
  }
  const config = configDiff(previous.config, current.config);
  if (config !== null) {
    const what = config.recorded
      ? config.changes.length > 0
        ? `: ${config.changes.map(configChangeText).join('; ')}`
        : ''
      : `. The approved lock (version ${previous.lockVersion}) stored only a hash of the config, so the old values are unknown`;
    changes.push({ kind: 'config-changed', path: 'buckets.config.json', message: `buckets.config.json changed since the lock was approved${what}. ${REFRESH}` });
  }
  const files = new Set([...Object.keys(previous.dmz), ...Object.keys(current.dmz)]);
  for (const file of [...files].sort()) {
    const old = own(previous.dmz, file);
    const now = own(current.dmz, file);
    if (!old && now) {
      const symbols = Object.keys(now.symbols).sort();
      changes.push({
        kind: 'dmz-added',
        path: file,
        message: `New DMZ file ${file}${symbols.length > 0 ? ` (re-exports ${symbols.join(', ')})` : ''} is not in the lock. ${REFRESH}`,
      });
      continue;
    }
    if (old && !now) {
      changes.push({ kind: 'dmz-removed', path: file, message: `DMZ file ${file} was deleted since the lock was approved. ${REFRESH}` });
      continue;
    }
    if (!old || !now) continue;
    // `external` of a version 2 lock (the hash of a generated folder) no longer exists and is ignored.
    if (old.text !== now.text) {
      changes.push({ kind: 'dmz-changed', path: file, message: `DMZ file ${file} changed since the lock was approved. ${REFRESH}` });
    }
    const names = new Set([...Object.keys(old.symbols), ...Object.keys(now.symbols)]);
    for (const name of [...names].sort()) {
      const was = own(old.symbols, name);
      const is = own(now.symbols, name);
      if (was === undefined && is !== undefined) {
        changes.push({ kind: 'symbol-added', path: file, symbol: name, message: `\`${name}\` was added to ${file}. ${REFRESH}` });
      } else if (was !== undefined && is === undefined) {
        changes.push({ kind: 'symbol-removed', path: file, symbol: name, message: `\`${name}\` was removed from ${file}. ${REFRESH}` });
      } else if (was !== is) {
        changes.push({
          kind: 'signature-changed',
          path: file,
          symbol: name,
          message: `The signature of \`${name}\` re-exported by ${file} changed (its declaration in _/ code was edited). ${REFRESH}`,
        });
      }
    }
  }
  linkDiff(previous, current, changes);
  return changes;
}
