// Helpers that every command shares: strict argument parsing and checklist output.
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { stderrStyle, stdoutStyle, type Io } from '../context/index.js';
import { EXIT_CODES } from '../contract/index.js';
import { highlightCode, message, wrap, type Style } from '../output/index.js';

/** The parsed options and positionals of a command line. */
export interface ParsedArgs {
  values: Record<string, string | boolean | (string | boolean)[] | undefined>;
  positionals: string[];
}

/** 1 for a command that has no violations to report: it could not do what it was asked. */
export const FAILED = EXIT_CODES.violations;

/**
 * Parses the arguments of `buckets <command>` with util.parseArgs in strict mode. `-h` or `--help` anywhere prints
 * `help` (`usage` by default) and gives 0. A command line the parser does not accept, or more than `maxPositionals` positionals, prints
 * the problem and the usage on stderr and gives EXIT_CODES.usage. Otherwise it returns the parsed values.
 */
export function parseCommand(
  io: Io,
  command: string,
  usage: string,
  args: string[],
  options: NonNullable<ParseArgsConfig['options']>,
  maxPositionals = 0,
  help = `${usage}\n`,
): ParsedArgs | number {
  if (args.includes('-h') || args.includes('--help')) {
    io.stdout(help);
    return EXIT_CODES.ok;
  }
  let problem: string;
  try {
    const parsed = parseArgs({ args, options, strict: true, allowPositionals: maxPositionals > 0 });
    const extra = parsed.positionals[maxPositionals];
    if (extra === undefined) return parsed;
    problem = `unexpected argument "${extra}".`;
  } catch (error) {
    const text = message(error);
    const unknown = /^Unknown option '([^']+)'/.exec(text);
    const positional = /^Unexpected argument '([^']+)'/.exec(text);
    // "argument missing" at the end of the line, "is ambiguous" when the next argument starts with a dash.
    const missing = /^Option '(?:-\w, )?(--[\w-]+)[^']*' argument (?:missing|is ambiguous)/.exec(text);
    if (unknown !== null) problem = `unknown option "${unknown[1]}".`;
    else if (positional !== null) problem = `unexpected argument "${positional[1]}".`;
    else if (missing !== null) problem = `${missing[1]} needs a value.`;
    else problem = text.split('\n')[0]!;
  }
  io.stderr(`${stderrStyle(io).error(`buckets ${command}:`)} ${problem} ${usage}\n`);
  return EXIT_CODES.usage;
}

/** Checklist lines: a mark, then what happened. The marks are Unicode only on a terminal. */
export function checklist(io: Io) {
  const out = stdoutStyle(io);
  const err = stderrStyle(io);
  // On a terminal, long items wrap under their text, past the mark.
  const item = (style: Style, mark: string, text: string): string => {
    const lines = wrap(highlightCode(style, text), style.width, '    ');
    lines[0] = `  ${mark} ${lines[0]!.trimStart()}`;
    return `${lines.join('\n')}\n`;
  };
  return {
    out,
    done: (text: string): void => io.stdout(item(out, out.ok(out.tty ? '✓' : '+'), text)),
    kept: (text: string): void => io.stdout(out.dim(item(out, out.tty ? '·' : '=', text))),
    /** Something left to do by hand. Not a failure: setup goes on and exits with 0. */
    todo: (text: string): void => io.stdout(item(out, out.warn(out.tty ? '!' : '-'), text)),
    failed: (text: string): void => io.stderr(item(err, err.error(err.tty ? '✗' : '!'), text)),
  };
}
