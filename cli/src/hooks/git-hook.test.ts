import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, fileExists, makeProject, readFile, writeFile } from '../testing/fixture.js';
import { GIT_BLOCK_END, GIT_BLOCK_START, gitHookBlock, installGitHook } from './git-hook.js';

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
    fake(2);
    const failing = spawnSync('sh', [HOOK], { cwd: dir, env, encoding: 'utf8' });
    expect(failing.status).toBe(2);
    expect(failing.stdout).toContain('fake check check');
    expect(failing.stdout).not.toContain('chained-ran');
    fake(0);
    const passing = spawnSync('sh', [HOOK], { cwd: dir, env, encoding: 'utf8' });
    expect(passing.status).toBe(0);
    expect(passing.stdout).toContain('chained-ran');
    expect(fileExists(dir, HOOK)).toBe(true);
  });
});
