// A rule engine driven by hand-written violations, for the unit tests of commands, hooks and inspect.
import { exitCodeFor, type CheckResult, type EnvironmentError, type FileEdit, type RuleEngine } from '../contract/engine.js';
import type { SnapshotV2 } from '../contract/snapshot.js';
import { sortAdvice, sortViolations, violationKey, type Advice, type Violation } from '../contract/violation.js';

export interface FakeEngineScript {
  /** What the files on disk produce now. Default []. */
  violations?: Violation[];
  environment?: EnvironmentError[];
  /** What checkAll and checkEdit return as advice. Default []. */
  advice?: Advice[];
  projects?: string[];
  /**
   * The full violation list after an edit of this path (relative to root, `/` separators). A path that is not
   * listed leaves the list as it is. With several edits in one call, the last listed path wins.
   */
  edits?: Record<string, Violation[]>;
  /** What snapshot returns. Without it, snapshot throws. */
  snapshot?: SnapshotV2;
}

export type FakeCall =
  | { method: 'checkAll'; root: string; recursive?: boolean }
  | { method: 'checkEdit'; root: string; edits: FileEdit[] }
  | { method: 'recheck'; root: string; previous: Violation[] }
  | { method: 'snapshot'; root: string; changed?: string[] };

export interface FakeEngine extends RuleEngine {
  /** Every call, in order. */
  readonly calls: FakeCall[];
  /** Replaces what the files on disk produce, as a shell command or another agent would. */
  set(violations: Violation[], environment?: EnvironmentError[]): void;
  /** What the files on disk produce now. */
  current(): Violation[];
}

function relative(root: string, file: string): string {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const f = file.replace(/\\/g, '/');
  return f.startsWith(`${r}/`) ? f.slice(r.length + 1) : f;
}

/**
 * A rule engine driven by hand-written violations. checkEdit commits its result as the new disk state, because the
 * edit then lands, unless the result has config-invalid, because the hook denies that edit. recheck keeps the
 * previous violations whose key is still in the disk state.
 */
export function createFakeEngine(script: FakeEngineScript = {}): FakeEngine {
  let disk = [...(script.violations ?? [])];
  let environment = [...(script.environment ?? [])];
  const advice = sortAdvice(script.advice ?? []);
  const projects = script.projects ?? ['.'];
  const calls: FakeCall[] = [];
  const result = (violations: Violation[]): CheckResult => ({
    exitCode: exitCodeFor(violations, environment),
    violations: sortViolations(violations),
    environment: [...environment],
    advice: [...advice],
    projects: [...projects],
  });
  return {
    calls,
    set(violations, env) {
      disk = [...violations];
      if (env !== undefined) environment = [...env];
    },
    current: () => [...disk],
    async checkAll(root, options) {
      calls.push(options?.recursive === undefined ? { method: 'checkAll', root } : { method: 'checkAll', root, recursive: options.recursive });
      return result(disk);
    },
    async checkEdit(root, edit) {
      const edits = Array.isArray(edit) ? [...edit] : [edit as FileEdit];
      calls.push({ method: 'checkEdit', root, edits });
      let next = disk;
      for (const e of edits) next = script.edits?.[relative(root, e.path)] ?? next;
      if (!next.some((v) => v.rule === 'config-invalid')) disk = [...next];
      return result(next);
    },
    async recheck(root, previous) {
      calls.push({ method: 'recheck', root, previous: [...previous] });
      const live = new Set(disk.map(violationKey));
      return previous.filter((v) => live.has(violationKey(v)));
    },
    async snapshot(root, options) {
      calls.push(options?.changed === undefined ? { method: 'snapshot', root } : { method: 'snapshot', root, changed: [...options.changed] });
      if (script.snapshot === undefined) throw new Error('the fake engine has no snapshot');
      return script.snapshot;
    },
  };
}
