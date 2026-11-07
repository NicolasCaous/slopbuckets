// Session state of the hooks, kept in .buckets/sessions/<session_id>[-<agent_id>].json under the session root.
// Write it atomically: a temporary file in the same folder, then rename.
import type { Violation } from './violation.js';

export const SESSION_STATE_VERSION = 2;
export const SESSIONS_DIR = '.buckets/sessions';

export interface SessionState {
  version: typeof SESSION_STATE_VERSION;
  /** Keys (violationKey) of the violations of `pending` already shown in full. */
  shown: string[];
  /** The last pending list the hook computed, in display order. */
  pending: Violation[];
  /** A tool may have changed files since the last stop check: an edit, or a shell command. Stop checks only when true. */
  dirty: boolean;
  /** Stop already blocked once since the session last became dirty. For harnesses without stop_hook_active. */
  stopBlocked: boolean;
  /**
   * Keys of the violations the last blocking stop showed, kept across turns. When a later stop blocks and every one of
   * its keys is here, renderStop gets `repeated: true`. A stop that finds no violation empties it.
   */
  stopKeys: string[];
  /** environmentKey of every environment error already shown as context, so that config-newer shows once per session. */
  environmentShown: string[];
}

export function emptySessionState(): SessionState {
  return { version: SESSION_STATE_VERSION, shown: [], pending: [], dirty: false, stopBlocked: false, stopKeys: [], environmentShown: [] };
}

const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * The state file path relative to the session root, with `/`, or null when an id could be a path (`..`, a slash,
 * or characters outside letters, digits, `_`, `.` and `-`). The hook then keeps no memory for the call.
 */
export function sessionFile(sessionId: string, agentId?: string | null): string | null {
  const ids = agentId ? [sessionId, agentId] : [sessionId];
  if (!ids.every((id) => SAFE_ID.test(id) && !/^\.+$/.test(id))) return null;
  return `${SESSIONS_DIR}/${ids.join('-')}.json`;
}

const isStrings = (x: unknown): x is string[] => Array.isArray(x) && x.every((k) => typeof k === 'string');

/** Reads parsed JSON as a state. Returns an empty state for another version or a wrong shape, so a stale file never crashes a hook. */
export function parseSessionState(raw: unknown): SessionState {
  const r = raw as Partial<SessionState> | null;
  if (
    typeof r !== 'object' ||
    r === null ||
    r.version !== SESSION_STATE_VERSION ||
    !isStrings(r.shown) ||
    !Array.isArray(r.pending) ||
    !r.pending.every((v) => typeof v === 'object' && v !== null && typeof v.rule === 'string' && typeof v.project === 'string') ||
    typeof r.dirty !== 'boolean' ||
    typeof r.stopBlocked !== 'boolean' ||
    !isStrings(r.stopKeys) ||
    !isStrings(r.environmentShown)
  ) {
    return emptySessionState();
  }
  const { shown, pending, dirty, stopBlocked, stopKeys, environmentShown } = r;
  return { version: SESSION_STATE_VERSION, shown, pending, dirty, stopBlocked, stopKeys, environmentShown };
}
