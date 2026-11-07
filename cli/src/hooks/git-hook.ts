// `buckets init --git-hook`: a git pre-commit hook that runs `buckets check`, for every harness and for humans. It
// chains with an existing hook and never overwrites one. The hook is POSIX sh, which Git for Windows runs through its
// own sh, so the same file works in Git Bash and on Unix.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { message } from '../output/index.js';
import type { InstallStep } from './adapter.js';
import { refuseLinks, writeProjectFile } from './project-file.js';

export const GIT_BLOCK_START = '# slopbuckets:start';
export const GIT_BLOCK_END = '# slopbuckets:end';
/** Where a pre-commit hook that is not a shell script moves, so the new hook can run it after the check. */
export const CHAINED_SUFFIX = '.chained';

function git(args: string[], cwd: string): string | null {
  try {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** A single-quoted sh word. */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** The top folder of the git work tree that holds `dir`, or null outside a work tree or without git. */
export function gitTopLevel(dir: string): string | null {
  const top = git(['rev-parse', '--show-toplevel'], dir);
  return top === null ? null : path.resolve(top);
}

/** The CLI script of a project dependency, relative to the project, where npm, pnpm, yarn and bun link it. */
export const LOCAL_SCRIPT = './node_modules/slopbuckets/dist/index.js';

/**
 * The lines between the markers. Git runs hooks from the top of the work tree, so the block enters the project folder
 * first. It prefers the project's own copy, `script` relative to the project, which is the version the project pins,
 * and falls back to a global `buckets`. The commit stops with the exit code of the check: 1 for violations, 3 for an
 * environment error such as an unreadable config. Without the CLI, the block warns and lets the commit through, like
 * the agent hooks on a machine without it; CI still runs the check.
 */
export function gitHookBlock(relativeProject: string, script: string = LOCAL_SCRIPT): string {
  const project = relativeProject === '' ? '.' : relativeProject;
  const dir = shellQuote(project);
  return [
    GIT_BLOCK_START,
    '# Runs `buckets check` before each commit and stops the commit when it fails (1: violations, 3: cannot check).',
    '# Written by `buckets init --git-hook`, which rewrites only these lines.',
    `if [ -f ${shellQuote(path.posix.join(project, script))} ]; then`,
    `  (cd ${dir} && node ${shellQuote(script)} check) || exit $?`,
    'elif command -v buckets >/dev/null 2>&1; then',
    `  (cd ${dir} && buckets check) || exit $?`,
    'else',
    `  echo "slopbuckets: neither ${script} nor the buckets command is installed, so this pre-commit hook skipped buckets check" >&2`,
    'fi',
    GIT_BLOCK_END,
  ].join('\n');
}

const SHELLS = /^#!.*\b(?:sh|bash|dash|zsh|ksh|ash)\b/;

/** Where the pre-commit hook lives: core.hooksPath and worktrees included, and husky's own script under .husky/. */
export function preCommitPath(projectDir: string): { file: string; top: string } | null {
  const top = git(['rev-parse', '--show-toplevel'], projectDir);
  const hooks = git(['rev-parse', '--git-path', 'hooks'], projectDir);
  if (top === null || hooks === null) return null;
  const hooksDir = path.resolve(projectDir, hooks);
  // Husky points core.hooksPath at .husky/_, whose files it regenerates; the script people edit is .husky/pre-commit.
  if (path.basename(hooksDir) === '_' && path.basename(path.dirname(hooksDir)) === '.husky') {
    return { file: path.join(path.dirname(hooksDir), 'pre-commit'), top: path.resolve(top) };
  }
  return { file: path.join(hooksDir, 'pre-commit'), top: path.resolve(top) };
}

function makeExecutable(file: string): void {
  try {
    chmodSync(file, 0o755);
  } catch {
    // Windows has no executable bit, and git there runs the hook anyway.
  }
}

/**
 * Installs the hook. `script` is the CLI script of the project's own copy, relative to the project. Every step reports
 * the hook file relative to the project folder.
 */
export function installGitHook(projectDir: string, script: string = LOCAL_SCRIPT): InstallStep[] {
  const where = preCommitPath(projectDir);
  if (where === null) {
    return [{ status: 'failed', text: `Could not install the git pre-commit hook: ${projectDir} is not inside a git work tree, or git is not installed` }];
  }
  const { file, top } = where;
  const shown = path.relative(projectDir, file).split(path.sep).join('/');
  const block = gitHookBlock(path.relative(top, path.resolve(projectDir)).split(path.sep).join('/'), script);
  try {
    if (!existsSync(file)) {
      writeProjectFile(top, file, `#!/bin/sh\n${block}\n`);
      makeExecutable(file);
      return [{ status: 'done', text: `Installed a git pre-commit hook in ${shown} that runs \`buckets check\`` }];
    }
    const current = readFileSync(file, 'utf8');
    const eol = current.includes('\r\n') ? '\r\n' : '\n';
    const body = block.split('\n').join(eol);
    const start = current.indexOf(GIT_BLOCK_START);
    const end = current.indexOf(GIT_BLOCK_END, start);
    if (start !== -1 && end !== -1) {
      const next = current.slice(0, start) + body + current.slice(end + GIT_BLOCK_END.length);
      if (next === current) return [{ status: 'kept', text: `The git pre-commit hook in ${shown} already runs \`buckets check\`` }];
      writeProjectFile(top, file, next);
      return [{ status: 'done', text: `Updated the \`buckets check\` lines of the git pre-commit hook in ${shown}` }];
    }
    if (start !== -1 || current.includes(GIT_BLOCK_END)) {
      return [{ status: 'todo', text: `Did not change ${shown}, because it has a slopbuckets marker without its partner. Fix the markers and run \`buckets init --git-hook\` again.` }];
    }
    const firstLine = current.split(/\r?\n/, 1)[0] ?? '';
    if (!firstLine.startsWith('#!') || SHELLS.test(firstLine)) {
      // A shell script: the check goes right after the shebang, so it runs first and your hook runs unchanged after it.
      const next = firstLine.startsWith('#!') ? `${firstLine}${eol}${body}${eol}${current.slice(firstLine.length).replace(/^\r?\n/, '')}` : `${body}${eol}${current}`;
      writeProjectFile(top, file, next);
      return [{ status: 'done', text: `Added \`buckets check\` to the start of your git pre-commit hook in ${shown}. Your hook runs after it, unchanged.` }];
    }
    // Another interpreter: move the hook aside and run it from a new sh hook after the check.
    const chained = `${file}${CHAINED_SUFFIX}`;
    if (existsSync(chained)) {
      return [{ status: 'todo', text: `Did not change ${shown}, because ${shown}${CHAINED_SUFFIX} already exists. Add \`buckets check\` to your hook by hand.` }];
    }
    refuseLinks(top, file);
    renameSync(file, chained);
    writeProjectFile(top, file, `#!/bin/sh\n${block}\nexec "$(dirname "$0")/pre-commit${CHAINED_SUFFIX}" "$@"\n`);
    makeExecutable(file);
    return [{ status: 'done', text: `Moved your git pre-commit hook to ${shown}${CHAINED_SUFFIX} and installed a hook in ${shown} that runs \`buckets check\`, then yours` }];
  } catch (error) {
    return [{ status: 'failed', text: `Could not install the git pre-commit hook in ${shown}: ${message(error)}` }];
  }
}

/**
 * Undoes installGitHook: removes the lines between the markers and keeps the rest of the hook. A hook that held only
 * the block goes, and a hook that installGitHook moved aside comes back.
 */
export function uninstallGitHook(projectDir: string): InstallStep[] {
  const where = preCommitPath(projectDir);
  if (where === null || !existsSync(where.file)) return [];
  const { file, top } = where;
  const shown = path.relative(projectDir, file).split(path.sep).join('/');
  try {
    const current = readFileSync(file, 'utf8');
    const start = current.indexOf(GIT_BLOCK_START);
    const end = current.indexOf(GIT_BLOCK_END, start);
    if (start === -1 && !current.includes(GIT_BLOCK_END)) return [];
    if (start === -1 || end === -1) {
      return [{ status: 'todo', text: `Did not change ${shown}, because it has a slopbuckets marker without its partner. Remove the slopbuckets lines by hand.` }];
    }
    const next = current.slice(0, start) + current.slice(end + GIT_BLOCK_END.length).replace(/^\r?\n/, '');
    const rest = next.split(/\r?\n/).filter((line) => line.trim() !== '');
    const chained = `${file}${CHAINED_SUFFIX}`;
    if (rest.length === 2 && SHELLS.test(rest[0]!) && rest[1] === `exec "$(dirname "$0")/pre-commit${CHAINED_SUFFIX}" "$@"` && existsSync(chained)) {
      refuseLinks(top, chained);
      rmSync(file, { force: true });
      renameSync(chained, file);
      return [{ status: 'done', text: `Removed the git pre-commit hook of slopbuckets and moved your hook back from ${shown}${CHAINED_SUFFIX} to ${shown}` }];
    }
    if (rest.length === 0 || (rest.length === 1 && SHELLS.test(rest[0]!))) {
      rmSync(file, { force: true });
      return [{ status: 'done', text: `Removed ${shown}, the git pre-commit hook that only ran \`buckets check\`` }];
    }
    writeProjectFile(top, file, next);
    return [{ status: 'done', text: `Removed the \`buckets check\` lines from your git pre-commit hook in ${shown}` }];
  } catch (error) {
    return [{ status: 'failed', text: `Could not update the git pre-commit hook in ${shown}: ${message(error)}` }];
  }
}
