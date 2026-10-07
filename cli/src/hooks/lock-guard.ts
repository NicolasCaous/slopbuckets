// The lock guard of the hooks: the text rules for shell commands and the identity rules for file targets. It guards
// buckets.lock.json and buckets.config.json of every project, nested ones included, because a human owns both. It
// also refuses a `buckets update` that can install, because a human updates the CLI. Nothing here knows about a harness. Every function swallows its errors and answers "not guarded", so a hook never
// crashes here.
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { readLock } from '../core/lock.js';
import { CONFIG_FILE, LOCK_FILE } from '../core/paths.js';
import { findProjectDir } from '../core/project.js';
import { projectsBelow } from './session.js';

/** A file that only a human may change: the lock or the config of a project. */
export type GuardedFile = 'lock' | 'config';

const GUARDED: Record<GuardedFile, string> = { lock: LOCK_FILE, config: CONFIG_FILE };

/** The guarded file a base name refers to, ignoring case, or null. */
export function guardedName(base: string): GuardedFile | null {
  const lower = base.toLowerCase();
  return lower === LOCK_FILE ? 'lock' : lower === CONFIG_FILE ? 'config' : null;
}

/** Characters a shell may drop or treat as escapes: quotes, backticks, carets (cmd) and backslashes. */
const SHELL_NOISE = /["'`^\\]/g;

/**
 * How a shell reads a backtick and a backslash. Bash starts a command substitution with a backtick and escapes with a
 * backslash. PowerShell escapes with a backtick and keeps a backslash as a path separator. The guard reads every
 * command both ways, and a call that either reading finds counts.
 */
type ShellMode = 'posix' | 'powershell';

/** A piece of a command line. */
type Token =
  /** A word. `text` has its quotes removed and its escapes applied, `raw` is the word as written. */
  | { kind: 'word'; text: string; raw: string }
  /** A command separator or a parenthesis: `;`, `&`, `&&`, `|`, `||`, `(`, `)`, a newline, or a backtick in bash. */
  | { kind: 'op'; op: string }
  /**
   * A redirection, such as `> log`, `2>&1` or `< in`, with its target word, or null when it has none. `feed` is the
   * text it sends to the command's input: the body of a here-doc (`<<EOF`) or the word of a here-string (`<<<`).
   */
  | { kind: 'redirect'; input: boolean; target: string | null; feed?: string };

type RedirectToken = Extract<Token, { kind: 'redirect' }>;

const BLANK = /[ \t]/;

/** A here-doc start: `<<EOF`, `<<-EOF`, `<<'EOF'` or `<<"EOF"`, with the delimiter in group 2, 3 or 4. */
const HEREDOC = /<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;&|<>()'"`]+))/y;

/**
 * The body of a here-doc whose first line starts at `from`, and the index after its delimiter line. Without a
 * delimiter line the body runs to the end of the text. `<<-` strips leading tabs before the comparison.
 */
function heredocBody(text: string, from: number, delimiter: string, stripTabs: boolean): { body: string; end: number } {
  let lineStart = from;
  while (lineStart < text.length) {
    let nl = text.indexOf('\n', lineStart);
    if (nl === -1) nl = text.length;
    let line = text.slice(lineStart, nl);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (stripTabs) line = line.replace(/^\t+/, '');
    if (line === delimiter) return { body: text.slice(from, lineStart), end: Math.min(nl + 1, text.length) };
    lineStart = nl + 1;
  }
  return { body: text.slice(from), end: text.length };
}

/**
 * The index after the parenthesis that closes the one at `open`, or the end of the text. Here-doc bodies are skipped,
 * so a parenthesis in a commit message written through `"$(cat <<'EOF' ...)"` does not count.
 */
function closingParen(text: string, open: number): number {
  let depth = 0;
  const pending: { delimiter: string; stripTabs: boolean }[] = [];
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i + 1;
    else if (ch === '<' && text[i + 1] === '<' && text[i + 2] !== '<' && text[i - 1] !== '<') {
      HEREDOC.lastIndex = i;
      const match = HEREDOC.exec(text);
      if (match !== null) {
        pending.push({ delimiter: match[2] ?? match[3] ?? match[4] ?? '', stripTabs: match[1] === '-' });
        i += match[0].length - 1;
      }
    } else if (ch === '\n' && pending.length > 0) {
      let at = i + 1;
      for (const doc of pending.splice(0)) at = heredocBody(text, at, doc.delimiter, doc.stripTabs).end;
      i = at - 1;
    }
  }
  return text.length;
}

/** Pushes the inner command of each `$(...)` and backtick pair in `text`, such as an unquoted here-doc body, to `nested`. */
function substitutions(text: string, nested: string[]): void {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '$' && text[i + 1] === '(') {
      const end = closingParen(text, i + 1);
      nested.push(text.slice(i + 2, end - 1));
      i = end - 1;
    } else if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end === -1) return;
      nested.push(text.slice(i + 1, end));
      i = end;
    }
  }
}

/**
 * Splits a command line into words, operators and redirections, the way `mode` reads it. A command substitution inside
 * double quotes (`"$(...)"`, and a backtick pair in bash) cannot be split here, so its inner command goes to `nested`
 * to be read on its own.
 */
function lex(command: string, mode: ShellMode, nested: string[]): Token[] {
  const tokens: Token[] = [];
  const n = command.length;
  let i = 0;
  const isOpChar = (ch: string | undefined): boolean => ch !== undefined && (';&|()<>\r\n'.includes(ch) || (mode === 'posix' && ch === '`'));
  const escape = mode === 'posix' ? '\\' : '`';

  const readWord = (): { text: string; raw: string } => {
    const start = i;
    let text = '';
    // `<#` opens a PowerShell block comment. It is read as a word so that it ends the arguments of a call.
    if (command.startsWith('<#', i)) {
      text = '<#';
      i += 2;
    }
    while (i < n && !BLANK.test(command[i]!) && !isOpChar(command[i])) {
      const ch = command[i]!;
      if (ch === "'") {
        const end = command.indexOf("'", i + 1);
        const stop = end === -1 ? n : end;
        text += command.slice(i + 1, stop);
        i = stop + 1;
      } else if (ch === '"') {
        i++;
        while (i < n && command[i] !== '"') {
          const c = command[i]!;
          if (c === escape && i + 1 < n) {
            text += command[i + 1];
            i += 2;
          } else if (c === '$' && command[i + 1] === '(') {
            const end = closingParen(command, i + 1);
            nested.push(command.slice(i + 2, end - 1));
            text += command.slice(i, end);
            i = end;
          } else if (c === '`') {
            const end = command.indexOf('`', i + 1);
            const stop = end === -1 ? n : end;
            nested.push(command.slice(i + 1, stop));
            text += command.slice(i, stop + 1);
            i = stop + 1;
          } else {
            text += c;
            i++;
          }
        }
        i++;
      } else if (ch === escape && i + 1 < n) {
        if (command[i + 1] !== '\n' && command[i + 1] !== '\r') text += command[i + 1];
        i += 2;
      } else {
        text += ch;
        i++;
      }
    }
    return { text, raw: command.slice(start, Math.min(i, n)) };
  };

  // Here-docs whose body starts after the next newline.
  const pending: { token: RedirectToken; delimiter: string; stripTabs: boolean; quoted: boolean }[] = [];

  const readRedirect = (): Token => {
    let op = '';
    if (command[i] === '&') {
      op += '&';
      i++;
    }
    const input = command[i] === '<';
    op += command[i];
    i++;
    if (input) {
      while (command[i] === '<' && op.length < 3) op += command[i++];
      if (op === '<<' && command[i] === '-') op += command[i++];
      else if (command[i] === '&' || command[i] === '>') op += command[i++];
    } else {
      if (command[i] === '>') op += command[i++];
      if (command[i] === '|' || command[i] === '&') op += command[i++];
    }
    if (op.endsWith('&')) {
      const stream = /^(?:[0-9]+|-)/.exec(command.slice(i));
      if (stream !== null) {
        i += stream[0].length;
        return { kind: 'redirect', input, target: stream[0] };
      }
    }
    while (i < n && BLANK.test(command[i]!)) i++;
    if (i >= n || isOpChar(command[i])) return { kind: 'redirect', input, target: null };
    const word = readWord();
    const token: RedirectToken = { kind: 'redirect', input, target: word.text };
    if (op === '<<<') token.feed = word.text;
    else if (op === '<<' || op === '<<-') pending.push({ token, delimiter: word.text, stripTabs: op === '<<-', quoted: /["'\\`]/.test(word.raw) });
    return token;
  };

  while (i < n) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (BLANK.test(ch)) i++;
    else if (ch === '\r' || ch === '\n') {
      tokens.push({ kind: 'op', op: '\n' });
      i++;
      if (ch === '\r' && command[i] === '\n' && pending.length > 0) i++;
      // A here-doc body is text, not commands. It goes to the command as its input, and only a shell runs it. The
      // command substitutions in an unquoted body (`<<EOF`) still run, so bash reads them as nested commands.
      for (const doc of pending.splice(0)) {
        const { body, end } = heredocBody(command, i, doc.delimiter, doc.stripTabs);
        doc.token.feed = body;
        if (!doc.quoted && mode === 'posix') substitutions(body, nested);
        i = end;
      }
    } else if (ch === '<' && next === '#') tokens.push({ kind: 'word', ...readWord() });
    else if (ch === '>' || ch === '<' || (ch === '&' && next === '>')) tokens.push(readRedirect());
    else if (ch === '&' || ch === '|') {
      const op = next === ch ? ch + ch : ch;
      i += next === ch || (ch === '|' && next === '&') ? 2 : 1;
      tokens.push({ kind: 'op', op });
    } else if (isOpChar(ch)) {
      tokens.push({ kind: 'op', op: ch });
      i++;
    } else {
      const word = readWord();
      // A stream number or `*` written right before `>` or `<` belongs to the redirection: `2>&1`, `*> log`.
      if (/^(?:[0-9]+|\*)$/.test(word.raw) && (command[i] === '>' || command[i] === '<')) tokens.push(readRedirect());
      else tokens.push({ kind: 'word', ...word });
    }
  }
  return tokens;
}

/** The CLI by its name, also as `slopbuckets`, with a version (`slopbuckets@0.1.0`), a shim (`buckets.cmd`) or a folder. */
const CLI_NAME = /(?:^|[\\/:])(?:slop)?buckets(?:\.[a-z0-9]+)?(?:@\S*)?$/i;

/** A script whose file name says index, cli or buckets, such as `cli/dist/index.js`. */
const CLI_ENTRY = /(?:index|cli|buckets)[^\\/]*\.[cm]?[jt]s$/i;

function isCli(word: { text: string; raw: string }): boolean {
  return [word.text, word.raw.replace(/["'`^]/g, '')].some((s) => CLI_NAME.test(s) || CLI_ENTRY.test(s));
}

/**
 * Programs that run the program named after them: package runners (`npx`, `npm exec`, `pnpm exec`, `pnpm dlx`,
 * `yarn`, `bunx`), script runners (`node`, `tsx`) and wrappers such as `env`, `nohup`, `sudo`, `timeout` and `xargs`.
 */
const RUNNERS = new Set(
  'npx pnpx bunx npm pnpm yarn bun exec dlx x run env nohup sudo doas time nice command builtin xargs call start node tsx ts-node deno timeout stdbuf watch ionice unbuffer'.split(
    ' ',
  ),
);

/** Shell keywords that may open a command and leave the next word in program position: `{ buckets update; }`, `then buckets update`. */
const KEYWORDS = new Set(['{', '!', 'if', 'then', 'do', 'else', 'elif', 'while', 'until']);

/** The duration argument of `timeout`, such as `120`, `1.5` or `10m`. */
const DURATION = /^[0-9]+(?:\.[0-9]+)?[smhd]?$/i;

/** Shells that run the command text after `-c`, `-Command` or `/c`. */
const SHELLS = new Set('bash sh zsh dash ksh fish pwsh powershell cmd'.split(' '));

/** Commands that run their arguments as a command line. */
const EVALS = new Set(['eval', 'iex', 'invoke-expression']);

/** The name of a program word: lower case, without its folder and without a Windows extension such as `.exe`. */
function programName(text: string): string {
  return (text.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '');
}

/** The word texts of the command that starts at `from`, up to its end. */
function wordsFrom(tokens: Token[], from: number): string[] {
  const words: string[] = [];
  for (let i = from; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.kind === 'op') break;
    if (tok.kind === 'word') words.push(tok.text);
  }
  return words;
}

/** The `-Command` parameter of Invoke-Expression, also abbreviated (`-C`, `-Com`). */
const COMMAND_PARAM = /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?:?$/i;

/**
 * The text a shell or `eval` at `start` would read on its input: the here-doc bodies and here-strings of its command
 * (`bash <<< "buckets update"`), and the command before a pipe (`echo "buckets update" | bash`), as its whole text and
 * as its arguments alone. A literal `\n` becomes a newline, as `printf` and `echo -e` write it.
 */
function fedText(tokens: Token[], start: number): string[] {
  const out: string[] = [];
  const feeds = (from: number): void => {
    for (let k = from; k < tokens.length; k++) {
      const tok = tokens[k]!;
      if (tok.kind === 'op') return;
      if (tok.kind === 'redirect' && tok.feed !== undefined) out.push(tok.feed);
    }
  };
  feeds(start);
  const pipe = tokens[start - 1];
  if (pipe?.kind === 'op' && pipe.op === '|') {
    let from = start - 1;
    while (from > 0 && tokens[from - 1]!.kind !== 'op') from--;
    const words = wordsFrom(tokens, from);
    out.push(words.join(' '), words.slice(1).join(' '));
    feeds(from);
  }
  return out.filter((text) => text.trim() !== '').map((text) => text.replace(/\\n/g, '\n'));
}

/** Start-Process parameters that take no value. */
const START_PROCESS_SWITCHES = ['loaduserprofile', 'nonewwindow', 'passthru', 'wait', 'usenewenvironment', 'whatif', 'confirm'];

/**
 * The command line that `Start-Process` runs: `-FilePath` or the first positional word, then `-ArgumentList` or the
 * second positional word, with the commas of an argument list read as spaces. Parameter names may be abbreviated.
 */
function startProcessCommand(words: string[]): string {
  let file: string | undefined;
  let args: string | undefined;
  const positional: string[] = [];
  for (let k = 0; k < words.length; k++) {
    const param = /^-([a-z]+):?$/i.exec(words[k]!)?.[1]?.toLowerCase();
    if (param === undefined) positional.push(words[k]!);
    else if ('filepath'.startsWith(param) || param === 'path') file = words[++k];
    else if ('argumentlist'.startsWith(param) || param === 'args') args = words[++k];
    else if (!START_PROCESS_SWITCHES.some((name) => name.startsWith(param))) k++;
  }
  file ??= positional.shift();
  args ??= positional.join(' ');
  return `${file ?? ''} ${args.replace(/,/g, ' ')}`;
}

/** A call of the CLI: the subcommand word as written and every token after it. */
interface CliCall {
  word: string;
  rest: Token[];
}

/**
 * Records the call when the program of the CLI, at `from`, is followed by the subcommand. Flags may stand between
 * them, each with one optional value: `npx slopbuckets --cwd /repo refresh`, `npm exec slopbuckets -- refresh`.
 * Another CLI word may stand there too, because the first one can be the package of a runner:
 * `npx -p slopbuckets buckets update`.
 */
function findSubcommand(tokens: Token[], from: number, isSubcommand: (word: string) => boolean, calls: CliCall[]): void {
  let afterFlag = false;
  for (let i = from; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.kind === 'op') return;
    if (tok.kind === 'redirect') continue;
    if (isSubcommand(tok.text)) {
      calls.push({ word: tok.text, rest: tokens.slice(i + 1) });
      return;
    }
    if (isCli(tok)) afterFlag = false;
    else if (tok.text.startsWith('-')) afterFlag = true;
    else if (afterFlag) afterFlag = false;
    else return;
  }
}

/**
 * Reads the command whose first word is at `start` and looks for the CLI in program position: the first word, or
 * the word a runner runs, past the runner's flags and their values and past `NAME=value` assignments. Shell keywords
 * such as `{`, `!`, `then` and `do` before the first word are skipped. After a CLI word the scan goes on, because that
 * word can be the package a runner installs: `pnpm --package slopbuckets dlx buckets update`. The command text that a
 * shell runs with `-c` and the arguments of `eval` go to `nested`.
 */
function scanCommand(tokens: Token[], start: number, isSubcommand: (word: string) => boolean, calls: CliCall[], nested: string[]): void {
  let afterFlag = false;
  let atStart = true;
  // After `timeout`, its duration still stands before the program it runs.
  let duration = false;
  // After `start` (cmd), flags are written `/b`, `/wait`.
  let slashFlags = false;
  for (let i = start; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.kind === 'op') return;
    if (tok.kind === 'redirect') continue;
    if (atStart && KEYWORDS.has(tok.text.toLowerCase())) continue;
    atStart = false;
    if (isCli(tok)) {
      findSubcommand(tokens, i + 1, isSubcommand, calls);
      afterFlag = false;
      continue;
    }
    const name = programName(tok.text);
    if (SHELLS.has(name)) {
      const words = wordsFrom(tokens, i + 1);
      const at = words.findIndex((w) => /^(?:-[a-z]*c|-command|\/[ck])$/i.test(w));
      if (at !== -1) nested.push(words.slice(at + 1).join(' '));
      nested.push(...fedText(tokens, start));
      return;
    }
    if (EVALS.has(name)) {
      const words = wordsFrom(tokens, i + 1);
      if (words[0] !== undefined && COMMAND_PARAM.test(words[0])) words.shift();
      nested.push(words.join(' '), ...fedText(tokens, start));
      return;
    }
    if (name === 'start-process' || name === 'saps') {
      nested.push(startProcessCommand(wordsFrom(tokens, i + 1)));
      return;
    }
    // In PowerShell, `start` is Start-Process. In cmd, it is a runner.
    if (name === 'start') nested.push(startProcessCommand(wordsFrom(tokens, i + 1)));
    if (RUNNERS.has(name) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.text)) {
      afterFlag = false;
      if (name === 'timeout') duration = true;
      if (name === 'start') slashFlags = true;
    } else if (i > start && (tok.text.startsWith('-') || (slashFlags && /^\/[a-z?]/i.test(tok.text)))) afterFlag = true;
    else if (afterFlag) afterFlag = false;
    else if (duration && DURATION.test(tok.text)) duration = false;
    else return;
  }
}

/** A lookup of the CLI's path, such as `$(which buckets)`, `` `command -v buckets` `` or `(Get-Command buckets).Source`. */
const LOOKUP =
  /\$\(\s*(?:which|where(?:\.exe)?|command\s+-v|type\s+-p|Get-Command)\s+([^\s()`;&|]+)\s*\)|`\s*(?:which|where(?:\.exe)?|command\s+-v|type\s+-p)\s+([^\s()`;&|]+)\s*`|\(\s*Get-Command\s+([^\s()`;&|]+)\s*\)(?:\.(?:Source|Path|Definition))?/gi;

/**
 * Every call of the CLI with a subcommand that `isSubcommand` accepts, in the command and in the commands nested in it.
 * The CLI counts only in program position: at the start of a command (after `;`, `&`, `|`, `&&`, `||`, `(`, a newline
 * or a backtick), after a runner, or as the script of `node` or `tsx`. So `git commit -m "buckets update"` and
 * `gcloud storage buckets update` are not calls. A path lookup such as `$(which buckets)` counts as the CLI's name.
 */
function cliCalls(command: string, isSubcommand: (word: string) => boolean): CliCall[] {
  const calls: CliCall[] = [];
  const queue = [command.replace(LOOKUP, (_m, a?: string, b?: string, c?: string) => a ?? b ?? c ?? '')];
  for (let q = 0; q < queue.length && q < 32; q++) {
    for (const mode of ['posix', 'powershell'] as const) {
      const nested: string[] = [];
      const tokens = lex(queue[q]!, mode, nested);
      let start = true;
      tokens.forEach((tok, i) => {
        if (tok.kind === 'op') start = true;
        else if (tok.kind === 'word' && start) {
          start = false;
          scanCommand(tokens, i, isSubcommand, calls, nested);
        }
      });
      for (const inner of nested) {
        const text = inner.replace(LOOKUP, (_m, a?: string, b?: string, c?: string) => a ?? b ?? c ?? '');
        if (!queue.includes(text)) queue.push(text);
      }
    }
  }
  return calls;
}

/**
 * True when the tokens after `refresh` are exactly the `--web` flag, any number of output redirections with a target,
 * then the end of the command or a separator (`;`, `&`, `|`, a newline or `)`). That covers a trailing `&` and a pipe
 * to `tee`. A second flag, an argument after a redirection, an input redirection or a substitution is not allowed.
 * A redirection target that names the lock is denied by `mentionsLock`, which reads the whole command.
 */
function webOnly(rest: Token[]): boolean {
  const [first, ...more] = rest;
  if (first?.kind !== 'word' || first.text !== '--web') return false;
  for (const tok of more) {
    if (tok.kind === 'redirect') {
      if (tok.input || tok.target === null) return false;
    } else if (tok.kind === 'op') return tok.op !== '(' && tok.op !== '`';
    else return false;
  }
  return true;
}

/**
 * True when a shell command runs `buckets refresh` in any form other than `buckets refresh --web`. Every call in
 * the command must pass, so `buckets refresh --web; buckets refresh` is refused. A word that starts with `refresh`,
 * such as `refreshx`, counts as the call and is refused.
 */
export function runsForbiddenRefresh(command: string): boolean {
  return cliCalls(command, (w) => w.toLowerCase().startsWith('refresh')).some((call) => call.word.toLowerCase() !== 'refresh' || !webOnly(call.rest));
}

/**
 * True when the arguments of a `buckets update` call include `--check` or `--json`, which only report. The arguments
 * are the words after `update`, with their quotes removed, up to the end of the command or a comment (a word that
 * starts with `#` or `<#`). Redirections and their targets are not arguments. Arguments that hold a command
 * substitution (a backtick, `$(` or `(`) are refused, because the guard cannot know what they expand to.
 */
function reportsOnly(rest: Token[]): boolean {
  let report = false;
  for (const tok of rest) {
    if (tok.kind === 'redirect') continue;
    if (tok.kind === 'op') {
      if (tok.op === '(' || tok.op === '`') return false;
      break;
    }
    if (tok.raw.startsWith('#') || tok.raw.startsWith('<#')) break;
    if (tok.raw.includes('`') || tok.raw.includes('$(')) return false;
    if (tok.text === '--check' || tok.text === '--json') report = true;
  }
  return report;
}

/**
 * True when a shell command runs `buckets update` in a form that can install, that is without `--check` or `--json`
 * among its arguments. Every call in the command must pass, so `buckets update --check; buckets update` is refused.
 */
export function runsInstallingUpdate(command: string): boolean {
  return cliCalls(command, (w) => w.toLowerCase() === 'update').some((call) => !reportsOnly(call.rest));
}

/**
 * 8.3 short names that Windows can give buckets.lock.json or buckets.config.json, such as `BUCKET~1.JSO` or the hashed
 * `BU3F2A~1.JSO`, also with glob characters in them (`BUCKET~?.JSO`). The pattern cannot tell the two files apart.
 */
const SHORT_NAME = /\bbu[a-z0-9?*[\]]{0,6}~[0-9?*[\]]+\.js[o?*[]/i;

/** A piece of a glob: `*`, one character that `test` accepts (a literal, `?` or `[...]`), or `{a,b}`. */
type GlobPart = { kind: 'star' } | { kind: 'one'; test: (ch: string) => boolean } | { kind: 'alt'; options: GlobPart[][] };

/** The test of a `[...]` class body, with ranges such as `a-z` and a leading `!` or `^` that negates it. */
function classTest(body: string): (ch: string) => boolean {
  const negate = body.startsWith('!') || body.startsWith('^');
  const chars = negate ? body.slice(1) : body;
  const ranges: [string, string][] = [];
  for (let k = 0; k < chars.length; k++) {
    if (chars[k + 1] === '-' && k + 2 < chars.length) {
      ranges.push([chars[k]!, chars[k + 2]!]);
      k += 2;
    } else ranges.push([chars[k]!, chars[k]!]);
  }
  return (ch) => ch !== '/' && ranges.some(([lo, hi]) => ch >= lo && ch <= hi) !== negate;
}

/**
 * The pieces of a glob over one path segment: `*`, `?`, `[...]` and `{a,b}` (not nested). A run of `*` is one piece.
 * The text is read once, so a pattern of any length parses in linear time.
 */
function parseGlob(pattern: string, braces = true): GlobPart[] {
  const parts: GlobPart[] = [];
  const literal = (ch: string): GlobPart => ({ kind: 'one', test: (c) => c === ch });
  // The next `]` and `}` at or after a position, cached so that a long run of `[` stays linear.
  let bracket = -2;
  let brace = -2;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (parts[parts.length - 1]?.kind !== 'star') parts.push({ kind: 'star' });
    } else if (ch === '?') parts.push({ kind: 'one', test: (c) => c !== '/' });
    else if (ch === '[') {
      if (bracket !== -1 && bracket < i + 2) bracket = pattern.indexOf(']', i + 2);
      if (bracket === -1) parts.push(literal(ch));
      else {
        parts.push({ kind: 'one', test: classTest(pattern.slice(i + 1, bracket)) });
        i = bracket;
      }
    } else if (ch === '{' && braces) {
      if (brace !== -1 && brace < i) brace = pattern.indexOf('}', i);
      if (brace === -1) parts.push(literal(ch));
      else {
        parts.push({ kind: 'alt', options: pattern.slice(i + 1, brace).split(',').map((option) => parseGlob(option, false)) });
        i = brace;
      }
    } else parts.push(literal(ch));
  }
  return parts;
}

/**
 * The positions of `text` that the pieces can reach from the positions in `from`, as a bit set (bit j is position j).
 * Each piece costs one pass over the text, so matching is linear in the pattern for the short names checked here.
 */
function reach(parts: GlobPart[], text: string, from: number): number {
  let cur = from;
  for (const part of parts) {
    if (cur === 0) return 0;
    let next = 0;
    if (part.kind === 'star') {
      let on = false;
      for (let j = 0; j <= text.length; j++) {
        on = ((cur >>> j) & 1) === 1 || (on && text[j - 1] !== '/');
        if (on) next |= 1 << j;
      }
    } else if (part.kind === 'one') {
      for (let j = 0; j < text.length; j++) if (((cur >>> j) & 1) === 1 && part.test(text[j]!)) next |= 1 << (j + 1);
    } else for (const option of part.options) next |= reach(option, text, cur);
    cur = next;
  }
  return cur;
}

/** True when the glob pieces match all of `text`, ignoring case. `text` must be shorter than 31 characters. */
function globMatch(parts: GlobPart[], text: string): boolean {
  return ((reach(parts, text.toLowerCase(), 1) >>> text.length) & 1) === 1;
}

/**
 * True when a glob in the command can expand to `name` and is specific to it. A pattern counts when its last segment
 * matches `name` but not `package.json`, so `bucket*`, `buckets.lock.js?n`, `*.lock.json`, `*.config.json` and
 * `b[u]ckets.lock.json` count, while `*` and `*.json`, which match every project, do not.
 */
function globMatches(text: string, name: string): boolean {
  for (const token of text.split(/[\s;&|<>()=]+/)) {
    if (!/[*?[{]/.test(token)) continue;
    const last = token.split('/').filter((s) => s !== '').pop() ?? '';
    const parts = parseGlob(last.toLowerCase());
    if (globMatch(parts, name) && !globMatch(parts, 'package.json')) return true;
  }
  return false;
}

/**
 * True when a shell command names `name`: literally after the shell noise is removed, through an 8.3 short name, or
 * through a glob that expands to it. Globs are read twice, with backslashes as path separators (Windows paths) and
 * with backslashes removed (escapes), because either can be what the shell sees.
 */
function mentionsFile(command: string, name: string): boolean {
  const lower = command.toLowerCase();
  const joined = lower.replace(SHELL_NOISE, '');
  if (lower.includes(name) || joined.includes(name)) return true;
  if (SHORT_NAME.test(lower) || SHORT_NAME.test(joined)) return true;
  const slashed = lower.replace(/["'`]/g, '').replace(/\\/g, '/');
  return globMatches(slashed, name) || globMatches(joined, name);
}

/** True when a shell command names buckets.lock.json, as `mentionsFile` reads it. */
export function mentionsLock(command: string): boolean {
  return mentionsFile(command, LOCK_FILE);
}

/** True when a shell command names buckets.config.json, as `mentionsFile` reads it. */
export function mentionsConfig(command: string): boolean {
  return mentionsFile(command, CONFIG_FILE);
}

/**
 * The name a Windows path refers to: without a `:stream` suffix (`buckets.lock.json::$DATA`) and without trailing
 * dots and spaces, which Windows drops (`buckets.lock.json.`). A leading drive (`C:`) is kept out of the base name.
 */
export function normalizeTargetPath(file: string): { dir: string; base: string } {
  let rest = file.replace(/\\/g, '/');
  let drive = '';
  const driveMatch = /^(?:\/\/[?.]\/)?[A-Za-z]:/.exec(rest);
  if (driveMatch) {
    drive = driveMatch[0];
    rest = rest.slice(drive.length);
  }
  const segments = rest.split('/');
  while (segments.length > 1 && segments[segments.length - 1] === '') segments.pop();
  let base = segments.pop() ?? '';
  const colon = base.indexOf(':');
  if (colon !== -1) base = base.slice(0, colon);
  base = base.replace(/[. ]+$/, '');
  return { dir: drive + segments.join('/'), base };
}

export function sameFile(a: string, b: string): boolean {
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Every guarded file of the given project folders, each with what it is. */
function guardedFiles(dirs: Iterable<string>): { file: string; kind: GuardedFile }[] {
  const out: { file: string; kind: GuardedFile }[] = [];
  for (const dir of dirs) for (const kind of ['lock', 'config'] as const) out.push({ file: path.join(dir, GUARDED[kind]), kind });
  return out;
}

/** The folders whose guarded files the target could be: the nearest project's, the session project's and its nested projects'. */
function candidateDirs(projectDir: string, targetDir: string): string[] {
  const dirs = new Set<string>([projectDir]);
  const nearest = findProjectDir(targetDir);
  if (nearest !== null) dirs.add(nearest);
  // Nested projects are listed in the parent's lock, which is cheaper to read than a scan. Two levels are enough
  // for the usual trees, and the list is capped so the hook stays fast.
  const queue = [projectDir];
  for (let depth = 0; depth < 2 && queue.length > 0 && dirs.size < 64; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      const read = readLock(dir);
      if (read.kind !== 'ok') continue;
      for (const nested of read.lock.projects ?? []) {
        if (typeof nested !== 'string' || nested.includes('..')) continue;
        const nestedDir = path.join(dir, nested);
        dirs.add(nestedDir);
        next.push(nestedDir);
      }
    }
    queue.splice(0, queue.length, ...next);
  }
  return [...dirs];
}

/**
 * The guarded file that `file` is by identity, not by name: an 8.3 short name, a hard link, a symbolic link or a path
 * with a linked folder. When the target exists, it is compared with each candidate lock and config by real path and
 * by device and inode. When only its folder exists, the real folder plus the base name is compared by path.
 * Any error counts as "not guarded" (null), so the hook never crashes here.
 */
export function guardedByIdentity(file: string, base: string, projectDir: string): GuardedFile | null {
  try {
    const target = path.join(path.dirname(file), base);
    const candidates = guardedFiles(candidateDirs(projectDir, path.dirname(target)));
    let targetStat: ReturnType<typeof statSync> | undefined;
    try {
      targetStat = statSync(target, { bigint: true });
    } catch {
      targetStat = undefined;
    }
    if (targetStat !== undefined) {
      const realTarget = realpathSync.native(target);
      for (const candidate of candidates) {
        let stat;
        try {
          stat = statSync(candidate.file, { bigint: true });
        } catch {
          continue;
        }
        if (stat.ino === targetStat.ino && stat.dev === targetStat.dev && stat.ino !== 0n) return candidate.kind;
        if (sameFile(realpathSync.native(candidate.file), realTarget)) return candidate.kind;
      }
      return null;
    }
    let realDir: string;
    try {
      realDir = realpathSync.native(path.dirname(target));
    } catch {
      return null;
    }
    const realTarget = path.join(realDir, base);
    for (const candidate of candidates) {
      let realFile: string;
      try {
        realFile = path.join(realpathSync.native(path.dirname(candidate.file)), GUARDED[candidate.kind]);
      } catch {
        continue;
      }
      if (sameFile(realFile, realTarget)) return candidate.kind;
    }
    return null;
  } catch {
    return null;
  }
}

/** Every project folder among the given ones and the projects nested in them, read from their locks two levels deep. */
function projectCandidates(roots: string[]): string[] {
  const dirs = new Set<string>(roots);
  const queue = [...roots];
  for (let depth = 0; depth < 2 && queue.length > 0 && dirs.size < 256; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      const read = readLock(dir);
      if (read.kind !== 'ok') continue;
      for (const nested of read.lock.projects ?? []) {
        if (typeof nested !== 'string' || nested.includes('..')) continue;
        const nestedDir = path.join(dir, nested);
        dirs.add(nestedDir);
        next.push(nestedDir);
      }
    }
    queue.splice(0, queue.length, ...next);
  }
  return [...dirs];
}

/**
 * The file rule of the guard for a session opened outside every project. A target is guarded when its name is
 * buckets.lock.json or buckets.config.json, at the typed path or at its real path, and a project holds it. A target
 * with more than one hard link is also compared, by device and inode, with the locks and configs of the project
 * nearest to it, of the projects this session recorded and of the projects found below the session folder, nested
 * ones included. A file outside every project is allowed. Any error counts as "not guarded" (null), so the hook never
 * crashes here.
 */
export function guardedAboveProjects(file: string, cwd: string, sessionDir: string, recorded: () => string[]): GuardedFile | null {
  try {
    const { dir, base } = normalizeTargetPath(file);
    if (base === '') return null;
    const target = path.resolve(cwd, dir === '' ? '.' : dir, base);
    let targetStat: ReturnType<typeof statSync> | undefined;
    try {
      targetStat = statSync(target, { bigint: true });
    } catch {
      targetStat = undefined;
    }
    let real: string;
    try {
      real = targetStat !== undefined ? realpathSync.native(target) : path.join(realpathSync.native(path.dirname(target)), base);
    } catch {
      real = target;
    }
    const named = (p: string): GuardedFile | null => {
      const kind = guardedName(path.basename(p));
      return kind !== null && findProjectDir(path.dirname(p)) !== null ? kind : null;
    };
    const byName = named(target) ?? named(real);
    if (byName !== null) return byName;
    if (targetStat === undefined || targetStat.nlink <= 1n || targetStat.ino === 0n) return null;
    const roots = [findProjectDir(path.dirname(real)), ...recorded(), ...projectsBelow(sessionDir)].filter((d): d is string => d !== null);
    for (const candidate of guardedFiles(projectCandidates(roots))) {
      try {
        const stat = statSync(candidate.file, { bigint: true });
        if (stat.ino === targetStat.ino && stat.dev === targetStat.dev) return candidate.kind;
      } catch {
        // A project without a lock has nothing to protect there.
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** True when a file target in a session opened outside every project is a lock or a config, as `guardedAboveProjects` reads it. */
export function touchesLockAboveProjects(file: string, cwd: string, sessionDir: string, recorded: () => string[]): boolean {
  return guardedAboveProjects(file, cwd, sessionDir, recorded) !== null;
}
