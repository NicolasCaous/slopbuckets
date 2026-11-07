// The hook phases and the normalized input and decision that every harness adapter translates to and from.
import type { RuleEngine } from './engine.js';

/**
 * pre-edit: before a write, edit or patch; simulates it and warns, or denies on config-invalid.
 * pre-tool: before any other tool; shows the current pending list without simulating, and marks the session dirty
 * when the tool is a shell. stop and subagent-stop: end of a turn or a subagent; full check, blocks once.
 * post-compact: after a compaction; forgets what was shown.
 */
export const HOOK_PHASES = ['pre-edit', 'pre-tool', 'stop', 'subagent-stop', 'post-compact'] as const;
export type HookPhase = (typeof HOOK_PHASES)[number];

/** A file the tool is about to change. `content` is the whole new text, null for a delete, absent when unknown. */
export interface HookEdit {
  path: string;
  content?: string | null;
}

export interface HookInput {
  phase: HookPhase;
  /** Null when the harness gives no session id: the hook then keeps no memory. */
  sessionId: string | null;
  /** Set for a subagent, which has its own session state. */
  agentId: string | null;
  /** Working folder of the tool call. */
  cwd: string;
  /** The folder the check runs from: the harness project folder when it gives one (CLAUDE_PROJECT_DIR), else cwd. */
  root: string;
  /** The harness tool name, such as Write or Bash. Null outside the tool phases. */
  toolName: string | null;
  /** pre-edit: every file the tool changes. An edit without known content makes the core treat the call as pre-tool. */
  edits: HookEdit[];
  /**
   * pre-edit: the edits already landed, because the adapter runs after the tool (the post-tool fallback). A config that
   * is invalid then comes back as context with renderInterrupt(problems, { applied: true }) instead of a deny.
   */
  applied?: boolean;
  /** The tool runs shell commands (Bash, PowerShell, a terminal tool), so it may change any file. */
  isShell: boolean;
  /** The harness says this stop already follows a block (Claude Code stop_hook_active). False when it does not say. */
  stopHookActive: boolean;
}

/**
 * silent: no output, no tokens. context: add the text to the agent's context and let the tool run; never send
 * "allow" with it, because that skips the user's permission prompt. deny: the edit does not run, the text says why.
 * block: the turn does not end, the text says why. note: the turn ends, and the harness shows the text where it can
 * show text at the end of a turn without going on (Claude Code systemMessage); an adapter without such a place drops it.
 */
export type HookDecision =
  | { kind: 'silent' }
  | { kind: 'context'; text: string }
  | { kind: 'deny'; text: string }
  | { kind: 'block'; text: string }
  | { kind: 'note'; text: string };

/** The decisions each phase may return. */
export const PHASE_DECISIONS: Readonly<Record<HookPhase, readonly HookDecision['kind'][]>> = {
  'pre-edit': ['silent', 'context', 'deny'],
  'pre-tool': ['silent', 'context'],
  stop: ['silent', 'block', 'note'],
  'subagent-stop': ['silent', 'block', 'note'],
  'post-compact': ['silent'],
};

/**
 * The hook core: one call per hook event, after the adapter parsed the harness payload. What it must do beyond the
 * phases above (cli/src/contract/README.md, "Obligations of the hooks"):
 * - config-newer never denies an edit and never blocks a stop. The core shows renderEnvironment(e) once per session
 *   as context (SessionState.environmentShown) and stays silent for it afterwards.
 * - A pre-edit of buckets.config.json that removes a bucket key still named by a dependsOn and adds another key gets
 *   the bucket-renamed problem in its deny reason, in place of the unknown-bucket problems for that key.
 * - stop passes `advice` from the CheckResult to renderStop, and `repeated: true` when every violation key was in
 *   SessionState.stopKeys. Advice alone never blocks. A stop with nothing to block answers `note` with the
 *   reason-generic advice on purposes and reasons the session wrote, once.
 * - The first pre-edit or pre-tool after an edit of buckets.config.json, or after the hook sees it changed on disk,
 *   adds under its context, once, renderAdviceNote with the reason-generic advice on purposes and reasons that are not
 *   in the baseline of the session and that no pre-tool showed yet. The clean-stop note still lists them.
 * - The pending list shows every violation in full once and then as its one-line reminder, never collapsed.
 */
export type HookCore = (input: HookInput, engine: RuleEngine) => Promise<HookDecision>;
