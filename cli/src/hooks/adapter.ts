// The interface every agent harness implements to run the slopbuckets hooks. An adapter is thin: one handler per event
// parses the harness payload, calls the core (./core.ts) and prints the answer in the harness format. `install` writes
// the harness config for `buckets init --agent <name>`, and `uninstall` removes it for `buckets uninstall`.
import type { Context, Io } from '../context/index.js';
import type { HookCore } from '../contract/index.js';
import type { JsonRecord } from '../files/index.js';

/** A harness slopbuckets knows about, with or without hooks. */
export interface HarnessInfo {
  /** The name for `--agent <name>`, lowercase, such as `claude` or `codex`. */
  name: string;
  /** The name people know, for messages, such as `Claude Code`. */
  title: string;
  /**
   * Paths relative to the project folder whose presence means the project uses this harness, such as `.claude`.
   * `buckets init --agent auto` installs every harness with a marker that exists.
   */
  markers: string[];
}

/** One line of what `install` or `uninstall` did, printed by `buckets init` or `buckets uninstall` as a checklist item. */
export interface InstallStep {
  /** done: a file changed. kept: already right. todo: left for the human, not a failure. failed: init exits with 1. */
  status: 'done' | 'kept' | 'todo' | 'failed';
  /** One sentence that names the file and the change, such as `Installed Claude Code hooks in .claude/settings.json`. */
  text: string;
}

export interface InstallOptions {
  /** The text of the slopbuckets skill, for a harness that keeps its own copy. Null when init could not find it. */
  skill: string | null;
  /** The command that runs slopbuckets, such as "buckets" or "node ./node_modules/slopbuckets/dist/index.js". */
  command?: string;
}

/** What a hook call gets. `hookCore` replaces the core of ./core.ts, for tests. */
export interface HookContext extends Context {
  hookCore?: HookCore;
}

/**
 * Handles one event: gets the parsed payload, calls the core and writes the harness output. Returns the exit code the
 * harness expects. A throw is caught by the caller, which prints the neutral answer of the event.
 */
export type HookHandler = (ctx: HookContext, io: Io, payload: JsonRecord) => Promise<number>;

export interface HookAdapter extends HarnessInfo {
  /** One handler per event of `buckets hook --agent <name> <event>`. */
  handlers: Readonly<Record<string, HookHandler>>;
  /** The keys of `handlers`, in the order help prints them. */
  events: readonly string[];
  /** What a handler that throws prints on stdout, by event: the answer that lets everything go on. Default: nothing. */
  neutral?: Readonly<Partial<Record<string, string>>>;
  /**
   * Writes the harness config in `projectDir`, idempotently: it merges into existing files, keeps every hook and
   * setting of the user, never adds an entry twice, and reports each file it changed or left alone.
   */
  install(projectDir: string, options: InstallOptions): InstallStep[];
  /** Removes only what `install` added, and reports each file it changed. Nothing to remove gives no step. */
  uninstall(projectDir: string): InstallStep[];
}

/** An adapter whose events are the keys of its handlers, so an event cannot lack a handler. */
export function defineAdapter<E extends string>(
  spec: HarnessInfo & {
    handlers: Record<E, HookHandler>;
    neutral?: Partial<Record<E, string>>;
    install: HookAdapter['install'];
    uninstall: HookAdapter['uninstall'];
  },
): HookAdapter & { events: readonly E[] } {
  return { ...spec, events: Object.keys(spec.handlers) as E[] };
}
