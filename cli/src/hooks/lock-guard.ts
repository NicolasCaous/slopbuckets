// The lock guard of the hooks: the text rules for shell commands and the identity rules for file targets. It guards
// buckets.lock.json and buckets.config.json of every project, nested ones included, because a human owns both.
// Nothing here knows about a harness. Every function swallows its errors and answers "not guarded", so a hook never
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

/** A token of a command line: stops at whitespace and at shell operators. */
const ARG = String.raw`[^\s;&|<>()]`;

/** A flag between the program and `refresh`, with an optional value: `--`, `--yes`, `--prefix /tmp/x`. */
const FLAG = String.raw`\s+-${ARG}*(?:\s+[^\s;&|<>()-]${ARG}*)?`;

/**
 * A call that can run the CLI, followed by the `refresh` argument:
 *
 * - `buckets refresh`, also as `slopbuckets`, with a version (`npx slopbuckets@0.1.0 refresh`) or through a
 *   Windows shim (`buckets.cmd refresh`, `buckets.ps1 refresh`)
 * - a script run by node or tsx whose file name says index, cli or buckets, such as `node cli/dist/index.js refresh`
 *
 * Flags may stand between the program and `refresh`, as in `npm exec slopbuckets -- refresh`, so the package
 * runners (`npm exec`, `npx`, `pnpm dlx`) are covered by the program name they run.
 */
const REFRESH_CALL = new RegExp(
  String.raw`(?:buckets(?:\.[a-z0-9]+)?(?:@${ARG}*)?|(?<!${ARG})${ARG}*?(?:index|cli|buckets)[^\s;&|<>()/]*\.[cm]?[jt]s)` +
    String.raw`(?:${FLAG})*\s+refresh`,
  'gi',
);

/**
 * An output redirection after `--web`, so the agent can run the command in the background and keep its log:
 *
 * - to a file: `> log`, `>> log`, `2> log`, `&> log`, `>| log`, `>&log`, PowerShell `*> log`, `2>$null`
 * - to another stream: `2>&1`, `>&2`, `1>&-`, PowerShell `*>&1`
 *
 * A redirection that starts with a stream number or `*` needs whitespace before it, because `--web2>&1` passes
 * the argument `--web2`. The target is one token: it stops at whitespace and at shell operators, so a command
 * substitution such as `> $(buckets refresh)` does not match. Input redirections (`<`) are not allowed.
 */
const REDIRECT = String.raw`(?:[ \t]+[0-9*]|[ \t]*)(?:>>?\||&>>?|>>?&?)[ \t]*${ARG}+`;

/**
 * What may follow an allowed call: exactly the `--web` flag, any number of output redirections, then the end of
 * the command or a command separator (`;`, `&`, `|`, a newline or `)`), which covers a trailing `&` and a pipe to
 * `tee`. Anything else, such as `--webx`, a second flag or an argument after a redirection, is not allowed.
 * A redirection target that names the lock is denied by `mentionsLock`, which reads the whole command.
 */
const WEB_ONLY = new RegExp(String.raw`^[ \t]+--web(?:${REDIRECT})*[ \t]*(?:$|[;&|\r\n)])`);

/**
 * True when a shell command runs `buckets refresh` in any form other than `buckets refresh --web`. Every call in
 * the command must pass, so `buckets refresh --web; buckets refresh` is refused. Quotes, backslashes, backticks
 * and carets are removed first, because shells drop them: `"buckets" refresh` and `b\uckets refresh` run the
 * command too. Removing them only joins text, so a call cannot hide behind them.
 */
export function runsForbiddenRefresh(command: string): boolean {
  const text = command.replace(SHELL_NOISE, '');
  for (const match of text.matchAll(REFRESH_CALL)) {
    const rest = text.slice(match.index + match[0].length);
    if (!WEB_ONLY.test(rest)) return true;
  }
  return false;
}

/**
 * 8.3 short names that Windows can give buckets.lock.json or buckets.config.json, such as `BUCKET~1.JSO` or the hashed
 * `BU3F2A~1.JSO`, also with glob characters in them (`BUCKET~?.JSO`). The pattern cannot tell the two files apart.
 */
const SHORT_NAME = /\bbu[a-z0-9?*[\]]{0,6}~[0-9?*[\]]+\.js[o?*[]/i;

/** A glob pattern as a regular expression over one path segment: `*`, `?`, `[...]` and `{a,b}`. */
function globRegex(pattern: string): RegExp | null {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else if (ch === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end === -1) {
        out += '\\[';
        continue;
      }
      let body = pattern.slice(i + 1, end);
      const negate = body.startsWith('!') || body.startsWith('^');
      if (negate) body = body.slice(1);
      out += `[${negate ? '^' : ''}${body.replace(/[\\\]]/g, '\\$&')}]`;
      i = end;
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        out += '\\{';
        continue;
      }
      out += `(?:${pattern
        .slice(i + 1, end)
        .split(',')
        .map((part) => part.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
        .join('|')})`;
      i = end;
    } else out += ch.replace(/[.+^$()|\\\]]/g, '\\$&');
  }
  try {
    return new RegExp(`^${out}$`, 'i');
  } catch {
    return null;
  }
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
    const regex = globRegex(last);
    if (regex !== null && regex.test(name) && !regex.test('package.json')) return true;
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
