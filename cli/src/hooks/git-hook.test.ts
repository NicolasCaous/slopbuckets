import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, fileExists, makeProject, readFile, writeFile } from '../testing/fixture.js';
import { GIT_BLOCK_END, GIT_BLOCK_START, gitHookBlock, installGitHook, uninstallGitHook } from './git-hook.js';

afterEach(cleanupProjects);

const hasGit = spawnSync('git', ['--version']).status === 0;
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

function repo(files: Record<string, string> = {}): string {
  const dir = makeProject({ 'README.md': '# x\n', ...files }, false);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

const HOOK = '.git/hooks/pre-commit';

describe.skipIf(!hasGit)('buckets init --git-hook', () => {
  it('installs a new sh hook, then keeps it', () => {
    const dir = repo();
    expect(installGitHook(dir)).toEqual([{ status: 'done', text: 'Installed a git pre-commit hook in .git/hooks/pre-commit that runs `buckets check`' }]);
    expect(readFile(dir, HOOK)).toBe(`#!/bin/sh\n${gitHookBlock('')}\n`);
    expect(installGitHook(dir)).toEqual([{ status: 'kept', text: 'The git pre-commit hook in .git/hooks/pre-commit already runs `buckets check`' }]);
  });

  it('chains with an existing shell hook: the check goes after the shebang and the hook stays intact', () => {
    const dir = repo({ '.git-placeholder': '' });
    const mine = '#!/usr/bin/env bash\nset -e\nnpm run lint\n';
    writeFile(dir, HOOK, mine);
    expect(installGitHook(dir)[0]!.text).toBe('Added `buckets check` to the start of your git pre-commit hook in .git/hooks/pre-commit. Your hook runs after it, unchanged.');
    const after = readFile(dir, HOOK);
    expect(after).toBe(`#!/usr/bin/env bash\n${gitHookBlock('')}\nset -e\nnpm run lint\n`);
    expect(installGitHook(dir)[0]!.status).toBe('kept');
    expect(after.split(GIT_BLOCK_START).length).toBe(2);
  });

  it('moves a hook in another language aside and runs it after the check', () => {
    const dir = repo();
    writeFile(dir, HOOK, '#!/usr/bin/env python3\nprint("hi")\n');
    expect(installGitHook(dir)[0]!.status).toBe('done');
    expect(readFile(dir, `${HOOK}.chained`)).toBe('#!/usr/bin/env python3\nprint("hi")\n');
    expect(readFile(dir, HOOK)).toContain('exec "$(dirname "$0")/pre-commit.chained" "$@"');
    expect(installGitHook(dir)[0]!.status).toBe('kept');
  });

  it('updates an old block in place and refuses a half block', () => {
    const dir = repo();
    writeFile(dir, HOOK, `#!/bin/sh\necho before\n${GIT_BLOCK_START}\nold\n${GIT_BLOCK_END}\necho after\n`);
    expect(installGitHook(dir)[0]!.status).toBe('done');
    expect(readFile(dir, HOOK)).toBe(`#!/bin/sh\necho before\n${gitHookBlock('')}\necho after\n`);
    writeFile(dir, HOOK, `#!/bin/sh\n${GIT_BLOCK_START}\n`);
    expect(installGitHook(dir)[0]!.status).toBe('todo');
  });

  it('enters the project folder when the project is below the top of the repository, and respects core.hooksPath', () => {
    const top = repo({ 'apps/web/package.json': '{}' });
    spawnSync('git', ['config', 'core.hooksPath', 'tools/hooks'], { cwd: top });
    const project = path.join(top, 'apps', 'web');
    expect(installGitHook(project)[0]!.text).toBe('Installed a git pre-commit hook in ../../tools/hooks/pre-commit that runs `buckets check`');
    expect(readFile(top, 'tools/hooks/pre-commit')).toContain("(cd 'apps/web' && buckets check) || exit $?");
  });

  it("writes husky's own pre-commit script, not the generated one under .husky/_", () => {
    const generated = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n';
    const dir = repo({ '.husky/pre-commit': 'npm test\n', '.husky/_/pre-commit': generated });
    spawnSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: dir });
    expect(installGitHook(dir)[0]!.text).toBe('Added `buckets check` to the start of your git pre-commit hook in .husky/pre-commit. Your hook runs after it, unchanged.');
    expect(readFile(dir, '.husky/pre-commit')).toBe(`${gitHookBlock('')}\nnpm test\n`);
    expect(readFile(dir, '.husky/_/pre-commit')).toBe(generated);
    expect(installGitHook(dir)[0]!.status).toBe('kept');
  });

  it('migrates a 1.x block to the 2.0 text', () => {
    const dir = repo();
    const old = [GIT_BLOCK_START, '# Runs `buckets check` before each commit.', 'buckets check || exit $?', GIT_BLOCK_END].join('\n');
    writeFile(dir, HOOK, `#!/bin/sh\n${old}\n`);
    expect(installGitHook(dir)).toEqual([{ status: 'done', text: 'Updated the `buckets check` lines of the git pre-commit hook in .git/hooks/pre-commit' }]);
    expect(readFile(dir, HOOK)).toBe(`#!/bin/sh\n${gitHookBlock('')}\n`);
    expect(gitHookBlock('')).toContain('(1: violations, 3: cannot check)');
  });

  it('fails outside a git work tree', () => {
    // The fixtures live inside this repository, so use a folder that does not exist: git cannot run there.
    const steps = installGitHook(path.join(makeProject({}, false), 'missing'));
    expect(steps[0]!.status).toBe('failed');
    expect(steps[0]!.text).toContain('not inside a git work tree');
  });

  it.skipIf(!hasSh)('runs: a failing check stops the commit, and a passing one runs the chained hook', () => {
    const dir = repo();
    writeFile(dir, HOOK, '#!/bin/sh\necho chained-ran\n');
    installGitHook(dir);
    const bin = path.join(dir, 'bin');
    const fake = (code: number) => {
      writeFile(dir, 'bin/buckets', `#!/bin/sh\necho "fake check $1"\nexit ${code}\n`);
      chmodSync(path.join(bin, 'buckets'), 0o755);
    };
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
    // 1: violations, 3: the check could not run. Both stop the commit before the chained hook.
    for (const code of [1, 3]) {
      fake(code);
      const failing = spawnSync('sh', [HOOK], { cwd: dir, env, encoding: 'utf8' });
      expect(failing.status).toBe(code);
      expect(failing.stdout).toContain('fake check check');
      expect(failing.stdout).not.toContain('chained-ran');
    }
    fake(0);
    const passing = spawnSync('sh', [HOOK], { cwd: dir, env, encoding: 'utf8' });
    expect(passing.status).toBe(0);
    expect(passing.stdout).toContain('chained-ran');
    expect(fileExists(dir, HOOK)).toBe(true);
  });
});

describe.skipIf(!hasGit)('buckets uninstall of the git hook', () => {
  it('removes a hook that held only the block, and does nothing without a hook', () => {
    const dir = repo();
    expect(uninstallGitHook(dir)).toEqual([]);
    installGitHook(dir);
    expect(uninstallGitHook(dir)).toEqual([{ status: 'done', text: 'Removed .git/hooks/pre-commit, the git pre-commit hook that only ran `buckets check`' }]);
    expect(fileExists(dir, HOOK)).toBe(false);
  });

  it('keeps a shell hook of the user byte for byte, CRLF included', () => {
    for (const mine of ['#!/usr/bin/env bash\nset -e\nnpm run lint\n', '#!/bin/sh\r\nnpm test\r\n', 'npm test\n']) {
      const dir = repo();
      writeFile(dir, HOOK, mine);
      installGitHook(dir);
      expect(uninstallGitHook(dir)[0]!.text).toBe('Removed the `buckets check` lines from your git pre-commit hook in .git/hooks/pre-commit');
      expect(readFile(dir, HOOK)).toBe(mine);
    }
  });

  it('moves a chained hook in another language back', () => {
    const dir = repo();
    writeFile(dir, HOOK, '#!/usr/bin/env python3\nprint("hi")\n');
    installGitHook(dir);
    expect(uninstallGitHook(dir)[0]!.status).toBe('done');
    expect(readFile(dir, HOOK)).toBe('#!/usr/bin/env python3\nprint("hi")\n');
    expect(fileExists(dir, `${HOOK}.chained`)).toBe(false);
  });

  it("restores husky's pre-commit script and leaves .husky/_ alone", () => {
    const generated = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n';
    const dir = repo({ '.husky/pre-commit': 'npm test\n', '.husky/_/pre-commit': generated });
    spawnSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: dir });
    installGitHook(dir);
    expect(uninstallGitHook(dir)[0]!.status).toBe('done');
    expect(readFile(dir, '.husky/pre-commit')).toBe('npm test\n');
    expect(readFile(dir, '.husky/_/pre-commit')).toBe(generated);
  });

  it('leaves a half block for the human', () => {
    const dir = repo();
    writeFile(dir, HOOK, `#!/bin/sh\n${GIT_BLOCK_START}\necho x\n`);
    expect(uninstallGitHook(dir)[0]!.status).toBe('todo');
    expect(readFile(dir, HOOK)).toBe(`#!/bin/sh\n${GIT_BLOCK_START}\necho x\n`);
  });
});

describe.skipIf(!hasGit)('the project copy in the pre-commit hook', () => {
  it('tries the project copy first, by its path from the top folder, then a global buckets', () => {
    const block = gitHookBlock('apps/web', '../../node_modules/slopbuckets/dist/index.js');
    const local = block.indexOf("if [ -f 'node_modules/slopbuckets/dist/index.js' ]; then");
    expect(local).toBeGreaterThan(0);
    expect(block).toContain("(cd 'apps/web' && node '../../node_modules/slopbuckets/dist/index.js' check) || exit $?");
    expect(block.indexOf('elif command -v buckets')).toBeGreaterThan(local);
    expect(gitHookBlock('')).toContain("if [ -f 'node_modules/slopbuckets/dist/index.js' ]; then");
  });

  it.skipIf(!hasSh)('runs the project copy even when a global buckets is on PATH', () => {
    const dir = repo({ 'node_modules/slopbuckets/dist/index.js': 'console.log(`local ${process.argv[2]}`);\n' });
    installGitHook(dir);
    writeFile(dir, 'bin/buckets', '#!/bin/sh\necho global\n');
    chmodSync(path.join(dir, 'bin', 'buckets'), 0o755);
    const env = { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` };
    const run = spawnSync('sh', [HOOK], { cwd: dir, env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('local check\n');
  });
});
