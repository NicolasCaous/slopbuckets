// Command dispatch, separate from index.ts so tests can run it with a fake engine and fake IO. Each command loads
// only when it runs, so a hook call does not compile the inspect server or the update code.
import { createInterface } from 'node:readline/promises';
import { info as adapterInfo } from '@slopbuckets/adapter-ts';
import { stderrStyle, stdoutStyle, type Context, type Io } from './context/index.js';
import { EXIT_CODES } from './contract/index.js';
import { createEngine } from './engine/index.js';
import { code, highlightCode, padEnd, PLAIN, unexpectedError, wrap, type Style } from './output/index.js';
import { processUpdateDeps } from './update/index.js';
import { CLI_VERSION } from './version.js';

const HOMEPAGE = 'https://nicolascaous.github.io/slopbuckets/';
// One command per line, so that new commands merge without conflicts.
const COMMANDS = [
  'init',
  'check',
  'inspect',
  'doctor',
  'hook',
  'update',
  'uninstall',
  'fix',
  'fmt',
  'show',
  'merge-driver',
  'help',
];

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
      'The architecture of the project lives in buckets.config.json: its buckets, what each one does, and which bucket may import which and why. AI agents keep that file. The hooks stay silent while the code follows it and warn the agent when code and config disagree; fixing the code and editing the config are both valid answers.',
      width,
      '',
    ),
    '',
    `${heading('Usage:')} buckets <command> [options]`,
    '',
    heading('Commands'),
    ...table(
      [
        ['init', 'Set up slopbuckets in this folder. It writes an empty buckets.config.json, adds .buckets/ to .gitignore, installs the Claude Code hooks, AGENTS.md and the skill, and makes git merge buckets.config.json with buckets merge-driver.'],
        ['init --agent <names>', 'Install the hooks of these agents instead of Claude Code, as a comma separated list, or auto for every agent whose folder or file is in this folder, such as .codex, .cursor or GEMINI.md.'],
        ['init --git-hook', 'Also install a git pre-commit hook that runs buckets check before any hook already there, which then runs unchanged.'],
        ['init --root', 'In a folder below the top of the git repository, also install the agent hooks at the top folder, where a session opened there reads them.'],
        ['check', 'Check the code against buckets.config.json, in this project and in its nested projects, and print every violation with how to fix it.'],
        ['check --json', 'The same check as a JSON report, for scripts and CI.'],
        ['check --no-recursive', 'Check only the current project, without the nested ones.'],
        ['check --summary', 'Print only the number of violations per rule and per bucket, for a first look at a large project.'],
        ['check --base <ref>', 'Also list what changed in the architecture since the git ref: buckets, dependencies and packages with their reasons, public files and their exports. With GITHUB_STEP_SUMMARY set, it goes to the step summary too. It does not change the exit code.'],
        ['check --format <format>', 'text (the default), json (as --json), github (also prints ::error annotations on stderr, which GITHUB_ACTIONS=true turns on too) or sarif (a SARIF 2.1.0 log for code scanning).'],
        ['inspect', 'Serve a read-only page on 127.0.0.1 with the architecture of the project and print its address. It updates while files change, and stops with Ctrl+C or after 30 minutes without an open page.'],
        ['inspect --json', 'Print the same state as JSON and exit.'],
        ['inspect --no-recursive', 'Show only the current project, without the nested ones.'],
        ['inspect --export <format>', 'Print the bucket graph as SVG (svg), as a Mermaid flowchart (mermaid) or as Graphviz DOT (dot), or the whole page as one self-contained HTML file (html), and exit without a server. --out <file> writes it to a file.'],
        ['doctor', 'Check how slopbuckets is installed and wired into this project: PATH, versions, tsconfig.json, TypeScript, imports that do not resolve, skill copies and the commands the hooks run. Says how to fix each problem.'],
        ['update [<version>]', 'Install the latest slopbuckets, or this version, the way the running CLI was installed: globally with npm, pnpm, yarn, bun or Volta, or as a project dependency. Asks first in a terminal, and without one installs only with --yes. Checks the version on disk afterwards.'],
        ['update --check', 'Print the installed and latest versions and the install command, without installing. --json prints them as JSON.'],
        ['uninstall [--agent <names>]', 'Remove what init installed: the hooks of every agent, or only of these, the slopbuckets rules in AGENTS.md, the skill, the .gitignore line, .buckets/, the slopbuckets lines of the git pre-commit hook and the merge driver. --config also deletes buckets.config.json.'],
        ['show <bucket>', 'Print one bucket: its purpose, files, public files, dependencies and packages with their reasons, the buckets that depend on it, and its violations. <project>:<bucket> names a bucket of a nested project, and --json prints it as JSON.'],
        ['fix import-private', 'Add the re-exports that private imports need to the public file of the imported bucket, and point those imports at it, keeping their alias or relative style. --bucket <name> fixes only the imports into that bucket, --public <file> picks its public file, --dry-run prints the plan. It never edits dependsOn.'],
        ['fmt', 'Rewrite buckets.config.json in its canonical form, with keys and buckets in a fixed order. --check only reports a config that is not formatted, and exits with 1.'],
        ['merge-driver <O> <A> <B>', 'The git merge driver of buckets.config.json, which init sets up. It merges the config as a map, so two branches that each add a bucket or a dependency merge cleanly.'],
        ['hook <event>', 'Run a Claude Code hook, with its JSON on stdin. buckets hook --help lists the events.'],
        ['hook --agent <name> <event>', 'Run the hook of another agent, in its own input and output format.'],
        ['help', 'Print this help. Every command also takes -h or --help and prints its usage.'],
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
    ['0', style.ok, 'Every rule passes.'],
    ['1', style.error, 'A rule is broken. Fix the code or edit buckets.config.json.'],
    ['3', style.error, 'Environment problem. Fix it if it is part of your task, otherwise show it to the human.'],
    ['64', style.error, 'The command line is wrong. Every command exits with 64 for that and prints its usage.'],
  ];
  for (const [exit, paint, text] of exits) {
    const wrapped = wrap(highlightCode(style, text), width, '      ');
    wrapped[0] = `  ${paint(style.bold(exit.padEnd(2)))}  ${wrapped[0]!.trimStart()}`;
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
 * Whether a command prints the update notice. Not the agent hooks, whose output the coding agent reads, not `update`,
 * which shows the versions itself, and not a typo.
 */
function wantsUpdateNotice(command: string | undefined): boolean {
  if (command === undefined) return true;
  return KNOWN.has(command) && command !== 'hook' && command !== 'update' && command !== 'merge-driver';
}

/** Prints the update notice on stderr, so that stdout stays clean for --json and exports. */
async function updateNotice(ctx: Context, io: Io, command: string | undefined): Promise<void> {
  if (io.updates === undefined || !wantsUpdateNotice(command)) return;
  const { checkForUpdate } = await import('./update/index.js');
  const notice = await checkForUpdate(io.updates, io.env, ctx.cliVersion);
  if (notice !== null) {
    const style = stderrStyle(io);
    io.stderr(`${highlightCode(style, notice.message)}\n`);
  }
}

export async function main(ctx: Context, io: Io, args: string[]): Promise<number> {
  const [command, ...rest] = args;
  // First, so that the last line of a command stays last in a shared log file.
  await updateNotice(ctx, io, command);

  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    const style = stdoutStyle(io);
    // The splash greets a human who typed `buckets` alone. Asking for help explicitly, or piping, gets the plain help.
    const splash = command === undefined && style.tty;
    const splashText = splash ? await import('./splash.js').then(({ renderSplash }) => renderSplash(ctx.cliVersion, io.terminal?.columns, style)) : '';
    io.stdout(splashText + helpText(ctx.cliVersion, style, { header: !splash }));
    return EXIT_CODES.ok;
  }

  if (command === '-v' || command === '--version') {
    const adapter = adapterInfo();
    io.stdout(`buckets ${ctx.cliVersion}\nadapter ${adapter.name} ${adapter.version} (protocol ${adapter.abi})\n`);
    return EXIT_CODES.ok;
  }

  switch (command) {
    case 'check':
      return (await import('./commands/check.js')).checkCommand(ctx, io, rest);
    case 'update':
      return (await import('./commands/update.js')).updateCommand(ctx, io, rest);
    case 'init':
      return (await import('./commands/init.js')).initCommand(ctx, io, rest);
    case 'inspect':
      return (await import('./commands/inspect.js')).inspectCommand(ctx, io, rest);
    case 'doctor':
      return (await import('./commands/doctor.js')).doctorCommand(ctx, io, rest);
    case 'hook':
      return (await import('./commands/hook.js')).hookCommand(ctx, io, rest);
    case 'uninstall':
      return (await import('./commands/uninstall.js')).uninstallCommand(ctx, io, rest);
    case 'fix':
      return (await import('./commands/fix.js')).fixCommand(ctx, io, rest);
    case 'fmt':
      return (await import('./commands/fmt.js')).fmtCommand(ctx, io, rest);
    case 'show':
      return (await import('./commands/show.js')).showCommand(ctx, io, rest);
    case 'merge-driver':
      return (await import('./commands/merge-driver.js')).mergeDriverCommand(ctx, io, rest);

    default: {
      const style = stderrStyle(io);
      const guess = suggestCommand(command);
      const hint = guess !== undefined ? ` Did you mean ${code(style, `buckets ${guess}`)}?` : '';
      const what = command.startsWith('-') ? 'option' : 'command';
      io.stderr(`${style.error('buckets:')} unknown ${what} "${command}".${hint} Run ${code(style, 'buckets --help')} to see the commands.\n`);
      return EXIT_CODES.usage;
    }
  }
}

/** The context with the real rule engine. */
function defaultContext(): Context {
  return { cliVersion: CLI_VERSION, engine: createEngine({ cliVersion: CLI_VERSION }) };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** The Io of this process. `packageDir` is the folder of the CLI's package.json. */
function processIo(packageDir: string): Io {
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    readStdin,
    isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    openPrompt: () => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      return { ask: (question) => rl.question(question), close: () => rl.close() };
    },
    cwd: process.cwd(),
    env: process.env,
    terminal: { stdout: Boolean(process.stdout.isTTY), stderr: Boolean(process.stderr.isTTY), columns: process.stdout.columns ?? process.stderr.columns },
    updates: processUpdateDeps(packageDir),
  };
}

/** Runs the CLI in this process with the real context and sets the exit code. */
export async function run(packageDir: string, argv: string[]): Promise<void> {
  try {
    process.exitCode = await main(defaultContext(), processIo(packageDir), argv);
  } catch (error) {
    process.stderr.write(unexpectedError('buckets', error));
    process.exitCode = EXIT_CODES.environment;
  }
}
