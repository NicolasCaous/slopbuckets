// The process boundary of a command. index.ts wires the real process; tests pass fakes.
import type { UpdateDeps } from '../core/update.js';
import { styleFor, type Style } from '../output/style.js';

export interface Prompt {
  ask(question: string): Promise<string>;
  close(): void;
}

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
  /** True when both stdin and stdout are terminals. */
  isInteractive: boolean;
  openPrompt(): Prompt;
  cwd: string;
  env: Record<string, string | undefined>;
  /** Terminal facts used only for styling. Missing means neither stream is a terminal, so output stays plain. */
  terminal?: { stdout: boolean; stderr: boolean; columns?: number };
  /** The registry, clock, cache folder and process runner of the update check and `buckets update`. Missing turns both off. */
  updates?: UpdateDeps;
}

/** The style for text written to stdout: color and wrapping only on a terminal, and never for --json or hooks. */
export function stdoutStyle(io: Io): Style {
  return styleFor(io.env, { isTTY: io.terminal?.stdout ?? false, ...(io.terminal?.columns !== undefined ? { columns: io.terminal.columns } : {}) });
}

export function stderrStyle(io: Io): Style {
  return styleFor(io.env, { isTTY: io.terminal?.stderr ?? false, ...(io.terminal?.columns !== undefined ? { columns: io.terminal.columns } : {}) });
}
