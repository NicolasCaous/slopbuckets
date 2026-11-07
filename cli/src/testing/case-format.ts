// The v2 case.json format of the examples battery (examples/README.md). A case is a folder
// examples/<case>/ with case.json, project/ and an optional after/ copied over the project before the run.
import type { HookDecision, HookPhase } from '../contract/hooks.js';
import type { AdviceId, RuleId } from '../contract/rules.js';

export interface ExpectedViolation {
  rule: RuleId;
  /** Compared with violationLocation(v).file. An array lists acceptable alternatives. */
  file?: string | string[];
  /** Compared with violationLocation(v).line, only when given. */
  line?: number;
  /** `.` or a nested project folder, compared only when given. `file` is then relative to that project. */
  project?: string;
}

/** One advice of `check --json` (CheckResult.advice). */
export interface ExpectedAdvice {
  advice: AdviceId;
  /** The config path as messages.ts formats it, such as 'buckets.billing.dependsOn.log' or 'ignore[0]'. Compared only when given. */
  at?: string;
  /** `.` or a nested project folder, compared only when given. */
  project?: string;
}

export interface CaseExpect {
  /** The exact exit code, or "nonzero" for any code but 0. */
  exitCode?: number | 'nonzero';
  /** Compared as a set of (rule, file, line, project) with the fields the case gives. [] means none. */
  violations?: ExpectedViolation[];
  /** Command cases with --json only: the advice of the report, compared as a set like violations. [] means none. */
  advice?: ExpectedAdvice[];
  /**
   * The exact text the agent or human reads: the text output of `buckets check`, or for a hook the additionalContext,
   * deny reason or block reason, whichever the harness output carries. Line endings are compared as \n.
   */
  message?: string;
  /** Strings the message must contain. */
  messageIncludes?: string | string[];
  /** Rule ids of the session's pending list after the step, compared as a sorted list with repeats. */
  pending?: RuleId[];
  /**
   * Hook steps only: the decision the harness output carries, read the way cli/src/contract/README.md describes.
   * Every hook step also fails when its stdout JSON approves the call (an allow, an approve or `"continue": true`).
   */
  decision?: HookDecision['kind'];
  /** Partial match against the parsed stdout: every key given must match, extra keys are ignored, arrays must have the same length. */
  stdoutJson?: unknown;
  /** stdout is empty, whitespace ignored. */
  stdoutEmpty?: boolean;
  stderrIncludes?: string | string[];
  /** Paths checked in the project copy after the run. */
  filesExist?: string[];
  filesMissing?: string[];
  /** Runs the command a second time and requires the same exit code and an unchanged project tree. */
  idempotent?: boolean;
}

interface CaseBase {
  /** One line that says what the case checks. */
  description: string;
  /** CLI argument lists run in the project copy before the case, such as [["init", "--yes"]]. Each must exit with 0. */
  setup?: string[][];
  /** Paths removed after after/ is applied. A folder is removed with its contents. */
  delete?: string[];
  /** "parent" sets CLAUDE_PROJECT_DIR to the folder above the project copy, a session opened above the project. */
  claudeProjectDir?: 'project' | 'parent';
}

/** One run of the CLI. */
export interface CommandCase extends CaseBase {
  /** Default ["check", "--json"]. */
  args?: string[];
  /** JSON sent on stdin. Strings may contain ${PROJECT}, replaced by the absolute path of the project copy. */
  stdin?: Record<string, unknown> | null;
  expect: CaseExpect;
}

/** A sequence of hook calls that share one session state, for the pending list across edits. */
export interface HookStep {
  /**
   * The phase the step exercises. It documents the step and decides how the battery reads the decision (a message is
   * a block in stop and subagent-stop, context elsewhere). An adapter may turn an event into another phase.
   */
  hook: HookPhase;
  /**
   * The exact event the battery passes: `buckets hook --agent <agent> <event>`. It is the harness's own event name as
   * the adapter registers it, such as `pre-tool-use` for Claude Code or `after-tool` for Gemini CLI. A step that
   * shows the list after the tool (an agent without context before it) names the adapter's post-tool event.
   */
  event: string;
  /** Harness name for --agent, default "claude". */
  agent?: string;
  /**
   * Files written to the project copy before the hook runs, null to delete: the effect of the previous tool call,
   * since a pre-edit hook runs before its edit lands.
   */
  files?: Record<string, string | null>;
  /** The harness JSON sent on stdin. Strings may contain ${PROJECT}. */
  payload: Record<string, unknown>;
  expect: CaseExpect;
}

export interface HookSequenceCase extends CaseBase {
  steps: HookStep[];
}

export type CaseSpec = CommandCase | HookSequenceCase;

export const DEFAULT_ARGS = ['check', '--json'];

export function isHookSequence(spec: CaseSpec): spec is HookSequenceCase {
  return 'steps' in spec;
}
