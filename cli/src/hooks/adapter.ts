// The interface every agent harness implements to run the slopbuckets hooks. An adapter is thin: it parses the harness
// payload, calls the core (./core.ts) and prints the answer in the harness format. `install` and `uninstall` write and
// remove the harness config for `buckets init --agent <name>`.
import type { Io } from '../commands/io.js';
import type { Context } from '../core/types.js';

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

/** One line of what `install` or `uninstall` did, printed by `buckets init` as a checklist item. */
export interface InstallStep {
  /** done: a file changed. kept: already right. todo: left for the human, not a failure. failed: init exits with 1. */
  status: 'done' | 'kept' | 'todo' | 'failed';
  /** One sentence that names the file and the change, such as `Installed Claude Code hooks in .claude/settings.json`. */
  text: string;
}

export interface InstallOptions {
  /** The text of the slopbuckets skill, for a harness that keeps its own copy. Null when init could not find it. */
  skill: string | null;
}

export interface HookAdapter extends HarnessInfo {
  /** The events `buckets hook --agent <name> <event>` accepts, in the order help prints them. */
  events: readonly string[];
  /**
   * Handles one hook call: reads the payload from `io.readStdin()`, calls the core and writes the harness output.
   * Returns the exit code the harness expects. It must not throw: a crash writes to stderr and fails as the harness
   * needs (allow before a tool, report after an edit, block once at a stop).
   */
  run(ctx: Context, io: Io, event: string): Promise<number>;
  /**
   * Writes the harness config in `projectDir`, idempotently: it merges into existing files, keeps every hook and
   * setting of the user, never adds an entry twice, and reports each file it changed or left alone.
   */
  install(projectDir: string, options: InstallOptions): InstallStep[];
  /** Removes only what `install` added, and reports each file it changed. */
  uninstall(projectDir: string): InstallStep[];
}
