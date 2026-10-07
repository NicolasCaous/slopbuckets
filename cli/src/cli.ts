// Command dispatch, separate from index.ts so tests can run it with a fake adapter and fake IO.
import { checkCommand } from './commands/check.js';
import { hookCommand, HOOK_EVENTS } from './commands/hook.js';
import { initCommand } from './commands/init.js';
import { inspectCommand } from './commands/inspect.js';
import { linkCommand } from './commands/link.js';
import { stderrStyle, stdoutStyle, type Io } from './commands/io.js';
import { refreshCommand } from './commands/refresh.js';
import { updateCommand } from './commands/update.js';
import type { Context } from './core/types.js';
import { checkForUpdate, type UpdateNotice } from './core/update.js';
import { renderSplash } from './output/splash.js';
import { code, highlightCode, padEnd, PLAIN, wrap, type Style } from './output/style.js';

const HOMEPAGE = 'https://nicolascaous.github.io/slopbuckets/';
const COMMANDS = ['init', 'check', 'refresh', 'inspect', 'link', 'hook', 'update', 'help'];

/**
 * Help is laid out for 80 columns: the descriptions start at column 24 and wrap before column 79.
 * A terminal narrower than 62 columns gets each description on its own lines under the command.
 */
const HELP_COLUMN = 24;

function table(rows: [string, string][], paint: (text: string) => string, width: number): string[] {
  const lines: string[] = [];
  for (const [left, description] of rows) {
    if (width < 60) {
      lines.push(`  ${paint(left)}`, ...wrap(description, width, '      '));
      continue;
    }
    const wrapped = wrap(description, width, ' '.repeat(HELP_COLUMN));
    if (left.length + 3 > HELP_COLUMN) {
      // A command too long for the column gets its own line, so it never runs into its description.
      lines.push(`  ${paint(left)}`, ...wrapped);
      continue;
    }
    wrapped[0] = padEnd(`  ${paint(left)}`, HELP_COLUMN) + wrapped[0]!.trimStart();
    lines.push(...wrapped);
  }
  return lines;
}

/** The help text. `header: false` leaves out the first line, for when the splash already shows the version. */
export function helpText(version: string, style: Style = PLAIN, options: { header?: boolean } = {}): string {
  const width = Math.min(78, (style.width ?? 80) - 2);
  const heading = (text: string): string => style.bold(style.phos(text));
  const cmd = (text: string): string => style.path(text);
  const lines: string[] = [];
  if (options.header !== false) lines.push(`${style.bold('buckets')} ${version}`);
  lines.push(
    ...wrap(
      'Sealed folders for AI-written code. Code in one bucket reaches another bucket only through DMZ contracts that a human approved.',
      width,
      '',
    ),
    '',
    `${heading('Usage:')} buckets <command> [options]`,
    '',
    heading('Commands'),
    ...table(
      [
        ['init [--yes]', 'Set up slopbuckets in this folder: config, Claude Code hooks, AGENTS.md and the skill. --yes takes the defaults without asking.'],
        ['init --agent <names>', 'Install the hooks of these agents instead of Claude Code, as a comma separated list, or auto for every agent whose folder exists here, such as .claude or .codex.'],
        ['init --git-hook', 'Also install a git pre-commit hook that runs buckets check, after any hook already there.'],
        ['check', 'Check every rule and compare the project with buckets.lock.json. Nested projects (folders with their own buckets.config.json inside a _/ folder) are checked too, each against its own lock.'],
        ['check --json', 'The same check as a JSON report, for scripts and CI.'],
        ['check --no-recursive', 'Check only the current project, without the nested ones.'],
        ['check --file <path>', 'Check one file in its nearest project, bucket cycles included. Skips the orphan rule and the lock comparison.'],
        ['refresh', 'Review the changes since the last approval and write the lock, project by project. Humans only, in a terminal.'],
        ['refresh --web', 'Show the same review on a local web page, one section per project. The human approves each project in a confirmation window of the operating system. Agents run this one in the background.'],
        ['inspect', 'Open a read-only page on 127.0.0.1 with the map of buckets, the DMZ matrix, symbol traces, nested projects, links and pending approvals. It updates while files change and stops with Ctrl+C. Agents may run it freely.'],
        ['inspect --json', 'Print the same state as JSON and exit: projects, buckets, contracts with symbols, origins and chains, imports between buckets, violations, lock differences and links.'],
        ['inspect --export <format>', 'Print the map as SVG (svg), the bucket graph of every project as a Mermaid flowchart (mermaid) or the whole page as one self-contained HTML file that works offline (html), and exit without a server. --out <file> writes it to a file instead.'],
        ['link add <name> <folder>', 'Link the source of another slopbuckets project (the folder with its buckets.config.json) into <bucket>/_/links/<name>/ of the current bucket (or --bucket <path>): a junction or symlink to its root folder, or with --copy a copy of what its .external.ts files reach. Adds its alias to tsconfig.json paths and prints the alias for Vite, Next or webpack. Code imports only its .external files, values included.'],
        ['link sync', 'Recreate every link listed in buckets.links.json that is missing, for example after a clone.'],
        ['link update [name]', 'Copy the origin of links in copy mode again.'],
        ['link remove <name>', 'Delete a link, its entry in buckets.links.json and its tsconfig.json paths entry.'],
        ['update [<version>]', 'Install the latest slopbuckets, or this version, the way the running CLI was installed: globally or as a project dependency with npm, pnpm, yarn or bun. Asks first in a terminal, and without one installs only with --yes. Humans only.'],
        ['update --check', 'Print the installed and latest versions and the install command, without installing. --json prints them as JSON.'],
        ['hook <event>', `Run a Claude Code hook. Events: ${HOOK_EVENTS.join(', ')}.`],
        ['hook --agent <name> <event>', 'Run the hook of another agent, in its own input and output format.'],
      ],
      cmd,
      width,
    ),
    '',
    heading('Options'),
    ...table(
      [
        ['-h, --help', 'Print this help.'],
        ['-v, --version', 'Print the CLI and adapter versions.'],
      ],
      cmd,
      width,
    ),
    '',
    heading('Exit codes of check'),
  );
  const exits: [string, (text: string) => string, string][] = [
    ['0', style.ok, 'Every rule passes and the state matches the lock.'],
    ['1', style.error, 'A rule is broken. Fix it.'],
    ['2', style.warn, 'The rules pass but the lock differs. A human approves with `buckets refresh` or `buckets refresh --web`.'],
    ['3', style.error, 'Environment problem. Stop and tell the human.'],
  ];
  for (const [exit, paint, text] of exits) {
    const wrapped = wrap(highlightCode(style, text), width, '     ');
    wrapped[0] = `  ${paint(style.bold(exit))}  ${wrapped[0]!.trimStart()}`;
    lines.push(...wrapped);
  }
  lines.push('', `${style.dim('Docs:')} ${style.path(HOMEPAGE)}`);
  return `${lines.join('\n')}\n`;
}

/** Edit distance, to suggest a command for a typo. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = current;
    }
  }
  return row[b.length]!;
}

export function suggestCommand(input: string): string | undefined {
  const best = COMMANDS.map((name) => ({ name, d: distance(input.toLowerCase(), name) })).sort((a, b) => a.d - b.d)[0]!;
  return best.d <= 2 && best.d < best.name.length ? best.name : undefined;
}

const KNOWN = new Set([...COMMANDS, '-h', '--help', '-v', '--version']);

/**
 * Whether a command prints the update notice. Not the agent hooks, whose output the coding agent reads, not
 * `check --file`, which runs after every edit, not `update`, which shows the versions itself, and not a typo.
 */
function wantsUpdateNotice(command: string | undefined, rest: string[]): boolean {
  if (command === undefined) return true;
  if (!KNOWN.has(command) || command === 'hook' || command === 'update') return false;
  return !(command === 'check' && rest.some((arg) => arg === '--file' || arg.startsWith('--file=')));
}

/** Prints the update notice on stderr, so that stdout stays clean for --json and exports. */
async function updateNotice(ctx: Context, io: Io, command: string | undefined, rest: string[]): Promise<UpdateNotice | null> {
  if (io.updates === undefined || !wantsUpdateNotice(command, rest)) return null;
  const notice = await checkForUpdate(io.updates, io.env, ctx.cliVersion);
  if (notice !== null) {
    const style = stderrStyle(io);
    io.stderr(`${highlightCode(style, notice.message)}\n`);
  }
  return notice;
}

export async function main(ctx: Context, io: Io, args: string[]): Promise<number> {
  const [command, ...rest] = args;
  // First, so that the last line of a command (the link of `refresh --web`) stays last in a shared log file.
  const notice = await updateNotice(ctx, io, command, rest);

  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    const style = stdoutStyle(io);
    // The splash greets a human who typed `buckets` alone. Asking for help explicitly, or piping, gets the plain help.
    const splash = command === undefined && style.tty;
    io.stdout((splash ? renderSplash(ctx.cliVersion, io.terminal?.columns, style) : '') + helpText(ctx.cliVersion, style, { header: !splash }));
    return 0;
  }

  if (command === '-v' || command === '--version') {
    const adapter = ctx.adapter.info();
    io.stdout(`buckets ${ctx.cliVersion}\nadapter ${adapter.name} ${adapter.version} (protocol ${adapter.abi})\n`);
    return 0;
  }

  switch (command) {
    case 'check':
      return checkCommand(ctx, io, rest, notice);
    case 'update':
      return updateCommand(ctx, io, rest);
    case 'refresh':
      return refreshCommand(ctx, io, rest);
    case 'init':
      return initCommand(ctx, io, rest);
    case 'inspect':
      return inspectCommand(ctx, io, rest);
    case 'hook':
      return hookCommand(ctx, io, rest);
    case 'link':
      return linkCommand(ctx, io, rest);

    default: {
      const style = stderrStyle(io);
      const guess = suggestCommand(command);
      const hint = guess !== undefined ? ` Did you mean ${code(style, `buckets ${guess}`)}?` : '';
      io.stderr(`${style.error('buckets:')} unknown command "${command}".${hint} Run ${code(style, 'buckets --help')} to see the commands.\n`);
      return 1;
    }
  }
}
