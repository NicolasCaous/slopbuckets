// `buckets init --git-hook`: a git pre-commit hook that runs `buckets check`, for every harness and for humans. It
// chains with an existing hook and never overwrites one. The hook is POSIX sh, which Git for Windows runs through its
// own sh, so the same file works in Git Bash and on Unix.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { InstallStep } from './adapter.js';

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

/**
 * The lines between the markers. Git runs hooks from the top of the work tree, so the block enters the project folder
 * first. It prefers a global `buckets` and falls back to the project's node_modules. Without either, it warns and lets
 * the commit through, like the agent hooks on a machine without the CLI; CI still runs the check.
 */
export function gitHookBlock(relativeProject: string): string {
  const dir = shellQuote(relativeProject === '' ? '.' : relativeProject);
  return [
    GIT_BLOCK_START,
    '# Runs `buckets check` before each commit. Written by `buckets init --git-hook`, which rewrites only these lines.',
    'if command -v buckets >/dev/null 2>&1; then',
    `  (cd ${dir} && buckets check) || exit $?`,
    `elif [ -x ${dir}/node_modules/.bin/buckets ]; then`,
    `  (cd ${dir} && ./node_modules/.bin/buckets check) || exit $?`,
    'else',
    `  echo "slopbuckets: the buckets command is not installed, so this pre-commit hook skipped buckets check" >&2`,
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

/** Installs the hook. Every step reports the hook file relative to the project folder. */
export function installGitHook(projectDir: string): InstallStep[] {
  const where = preCommitPath(projectDir);
  if (where === null) {
    return [{ status: 'failed', text: `Could not install the git pre-commit hook: ${projectDir} is not inside a git work tree, or git is not installed` }];
  }
  const { file, top } = where;
  const shown = path.relative(projectDir, file).split(path.sep).join('/');
  const block = gitHookBlock(path.relative(top, path.resolve(projectDir)).split(path.sep).join('/'));
  try {
    if (!existsSync(file)) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `#!/bin/sh\n${block}\n`, 'utf8');
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
      writeFileSync(file, next, 'utf8');
      return [{ status: 'done', text: `Updated the \`buckets check\` lines of the git pre-commit hook in ${shown}` }];
    }
    if (start !== -1 || current.includes(GIT_BLOCK_END)) {
      return [{ status: 'todo', text: `Did not change ${shown}, because it has a slopbuckets marker without its partner. Fix the markers and run \`buckets init --git-hook\` again.` }];
    }
    const firstLine = current.split(/\r?\n/, 1)[0] ?? '';
    if (!firstLine.startsWith('#!') || SHELLS.test(firstLine)) {
      // A shell script: the check goes right after the shebang, so it runs first and your hook runs unchanged after it.
      const next = firstLine.startsWith('#!') ? `${firstLine}${eol}${body}${eol}${current.slice(firstLine.length).replace(/^\r?\n/, '')}` : `${body}${eol}${current}`;
      writeFileSync(file, next, 'utf8');
      return [{ status: 'done', text: `Added \`buckets check\` to the start of your git pre-commit hook in ${shown}. Your hook runs after it, unchanged.` }];
    }
    // Another interpreter: move the hook aside and run it from a new sh hook after the check.
    const chained = `${file}${CHAINED_SUFFIX}`;
    if (existsSync(chained)) {
      return [{ status: 'todo', text: `Did not change ${shown}, because ${shown}${CHAINED_SUFFIX} already exists. Add \`buckets check\` to your hook by hand.` }];
    }
    renameSync(file, chained);
    writeFileSync(file, `#!/bin/sh\n${block}\nexec "$(dirname "$0")/pre-commit${CHAINED_SUFFIX}" "$@"\n`, 'utf8');
    makeExecutable(file);
    return [{ status: 'done', text: `Moved your git pre-commit hook to ${shown}${CHAINED_SUFFIX} and installed a hook in ${shown} that runs \`buckets check\`, then yours` }];
  } catch (error) {
    return [{ status: 'failed', text: `Could not install the git pre-commit hook in ${shown}: ${error instanceof Error ? error.message : String(error)}` }];
  }
}
