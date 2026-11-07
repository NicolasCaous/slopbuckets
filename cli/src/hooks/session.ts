// Reading and writing the hook session state (../contract/session.ts) under <root>/.buckets/sessions/. Every function
// here swallows file errors: a missing, broken or unwritable state means "no memory", never a crash.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  emptySessionState,
  parseSessionState,
  sessionFile,
  violationKey,
  type EnvironmentError,
  type SessionState,
  type Violation,
} from '../contract/index.js';
import { ensureBucketsDir, isRecord } from '../files/index.js';

/** A larger state file is malformed. */
export const MAX_STATE_BYTES = 1024 * 1024;

/**
 * The session state plus what only the hooks need. `configs` maps every project the session checked (its folder
 * relative to the session root, `.` for the root) to the mtime and size of its buckets.config.json when the hook last
 * saw it, `missing` when there was none, or `written:<hash>` with the hash of the text an edit of this session wrote
 * to it, which the next pre-tool compares with the file on disk. An older state may hold null, read as a first sighting.
 * `adviceSeen` maps the same projects to the reasonAdviceKey of every purpose and reason that had reason-generic
 * advice when the session first saw the project or last showed that advice, so the stop can tell the advice the session
 * caused. `adviceShown` maps them to the reasonAdviceKey of every purpose and reason with that advice that a pre-tool
 * already showed after an edit of the config, so each shows there once; the stop clears it. `shellRan` is true when a shell command ran since the last stop check, so the pending list may miss what it
 * changed.
 */
export interface HookState extends SessionState {
  configs: Record<string, string | null>;
  adviceSeen: Record<string, string[]>;
  adviceShown: Record<string, string[]>;
  shellRan: boolean;
}

export function emptyHookState(): HookState {
  return { ...emptySessionState(), configs: {}, adviceSeen: {}, adviceShown: {}, shellRan: false };
}

function parseAdviceSeen(raw: unknown): Record<string, string[]> {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((k) => typeof k === 'string')));
}

function parseConfigs(raw: unknown): Record<string, string | null> {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string | null] => typeof entry[1] === 'string' || entry[1] === null));
}

/** Where one session (or one subagent of it) keeps its state. `file` is null when there is no memory. */
export interface SessionRef {
  root: string;
  file: string | null;
}

/** The state file of a session, absolute, or null when the session id is missing or unsafe. */
export function sessionRef(root: string, sessionId: string | null, agentId: string | null = null): SessionRef {
  const rel = sessionId === null ? null : sessionFile(sessionId, agentId);
  return { root, file: rel === null ? null : path.join(root, rel) };
}

/** The saved state, or an empty one when the file is missing, too large or broken. */
export function loadSession(ref: SessionRef): HookState {
  if (ref.file === null) return emptyHookState();
  try {
    const text = readFileSync(ref.file, 'utf8');
    if (text.length > MAX_STATE_BYTES) return emptyHookState();
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw)) return { ...parseSessionState(raw), configs: {}, adviceSeen: {}, adviceShown: {}, shellRan: false };
    return {
      ...parseSessionState(raw),
      configs: parseConfigs(raw.configs),
      adviceSeen: parseAdviceSeen(raw.adviceSeen),
      adviceShown: parseAdviceSeen(raw.adviceShown),
      shellRan: raw.shellRan === true,
    };
  } catch {
    return emptyHookState();
  }
}

/**
 * Writes the state through a temporary file and a rename, so a reader never sees half a file. Two hooks of one
 * session can run at once (parallel tool calls), and the last rename wins. `dirty` must not be lost that way, because
 * a lost flag skips the stop check, so unless `clearDirty` is set the flag already on disk is kept. Returns whether
 * the state landed; a hook ignores a failure, which only costs memory.
 */
export function saveSession(ref: SessionRef, state: HookState, options: { clearDirty?: boolean } = {}): boolean {
  if (ref.file === null) return false;
  let next = state;
  if (options.clearDirty !== true && !state.dirty) {
    // ponytail: the re-read narrows the lost-update window to microseconds; a lock file would close it if that matters.
    const disk = loadSession(ref);
    if (disk.dirty) next = { ...state, dirty: true, stopBlocked: disk.stopBlocked };
  }
  // A .buckets or .buckets/sessions that is a link would send the write outside the project: keep no memory then.
  const dir = ensureBucketsDir(ref.root, 'sessions');
  if (dir === null) return false;
  const file = path.join(dir, path.basename(ref.file));
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(next)}\n`, 'utf8');
    renameWithRetry(temp, file);
    return true;
  } catch {
    rmSync(temp, { force: true });
    return false;
  }
}

const PAUSE = new Int32Array(new SharedArrayBuffer(4));

/**
 * Windows refuses a rename onto a file that another process is renaming at the same moment, or that an antivirus has
 * open. Retry with a pause that grows by 1 ms each time, about 200 ms in all.
 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
      Atomics.wait(PAUSE, 0, 0, attempt);
    }
  }
}

/** Marks a session dirty, for the main session when one of its subagents changes files. */
export function markSessionDirty(ref: SessionRef): void {
  if (ref.file === null) return;
  const state = loadSession(ref);
  if (state.dirty && !state.stopBlocked) return;
  saveSession(ref, { ...state, dirty: true, stopBlocked: false });
}

/* ---------- what to show ---------- */

/** The id of an environment error for SessionState.environmentShown. */
export function environmentKey(e: EnvironmentError): string {
  return JSON.stringify([e.project, e.code]);
}

export interface PendingDiff {
  /** In `current` and not shown in full yet. */
  fresh: Violation[];
  /** In `current` and already shown in full. */
  old: Violation[];
  /** In `previous` and not in `current`. */
  resolved: Violation[];
}

/** Splits the current list for renderPending. Matching is by violationKey. */
export function diffPending(previous: readonly Violation[], current: readonly Violation[], shownKeys: Iterable<string>): PendingDiff {
  const shown = new Set(shownKeys);
  const now = new Set(current.map(violationKey));
  return {
    fresh: current.filter((v) => !shown.has(violationKey(v))),
    old: current.filter((v) => shown.has(violationKey(v))),
    resolved: previous.filter((v) => !now.has(violationKey(v))),
  };
}

/**
 * Computes what to show for `current` and the state to save after showing it. Fresh violations become shown, and
 * keys of violations that are gone are dropped, so a problem that comes back later shows in full again. Resolved
 * violations show once, because `pending` no longer holds them.
 */
export function advance(state: SessionState, current: readonly Violation[]): { diff: PendingDiff; next: SessionState } {
  const diff = diffPending(state.pending, current, state.shown);
  // Every current violation is now either old or shown as fresh, so the shown set is exactly the current keys.
  return { diff, next: { ...state, pending: [...current], shown: [...new Set(current.map(violationKey))] } };
}

/** After a compaction the agent forgot the full forms, so every pending violation shows in full again. */
export function resetShown(state: SessionState): SessionState {
  return { ...state, shown: [] };
}
