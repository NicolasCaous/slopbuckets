// How a caught error reads in one line of output, and the stderr line of an error nobody expected.

/** The message of a caught error, for one line of output. */
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The last-resort stderr line of a command or hook: the prefix, then the stack of the error when it has one. */
export function unexpectedError(prefix: string, error: unknown): string {
  return `${prefix}: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`;
}
