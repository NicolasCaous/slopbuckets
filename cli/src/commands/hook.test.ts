import path from 'node:path';
import { existsSync, linkSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AnalyzeResponse } from '@slopbuckets/adapter-ts';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, LOGGER_PROJECT, makeProject } from '../testing/fixture.js';
import { approve, fakeIo, testContext } from '../testing/harness.js';
import type { Context } from '../core/types.js';
import { hookCommand, LOCK_DENY_REASON, mentionsLock, normalizeTargetPath, runsForbiddenRefresh, touchesLock } from './hook.js';
import { UPDATE_DENY_REASON } from '../hooks/core.js';

afterEach(cleanupProjects);

async function runHook(event: string, input: unknown, dir: string, env: Record<string, string> = {}) {
  const io = fakeIo({ cwd: dir, stdin: JSON.stringify(input), env });
  const code = await hookCommand(testContext(), io, [event]);
  return { code, out: io.out, err: io.err };
}

const DENY = JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: LOCK_DENY_REASON },
});

describe('touchesLock', () => {
  it.each([
    [{ tool_name: 'Edit', tool_input: { file_path: '/p/buckets.lock.json' } }, true],
    [{ tool_name: 'Write', tool_input: { file_path: 'C:\\p\\buckets.lock.json' } }, true],
    [{ tool_name: 'MultiEdit', tool_input: { file_path: 'buckets.lock.json' } }, true],
    [{ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/p/buckets.lock.json' } }, true],
    [{ tool_name: 'Bash', tool_input: { command: 'cat buckets.lock.json' } }, true],
    [{ tool_name: 'Bash', tool_input: { command: 'buckets  refresh' } }, true],
    [{ tool_name: 'PowerShell', tool_input: { command: 'Get-Content buckets.lock.json' } }, true],
    [{ tool_name: 'PowerShell', tool_input: { command: 'npx slopbuckets refresh' } }, true],
    [{ tool_name: 'Edit', tool_input: { file_path: '/p/buckets.config.json' } }, true],
    [{ tool_name: 'Write', tool_input: { file_path: '/p/root/api/_/engine/buckets.config.json' } }, true],
    [{ tool_name: 'Bash', tool_input: { command: 'cat buckets.config.json' } }, true],
    [{ tool_name: 'PowerShell', tool_input: { command: 'Set-Content buckets.config.json x' } }, true],
    [{ tool_name: 'Read', tool_input: { file_path: '/p/buckets.config.json' } }, false],
    [{ tool_name: 'Read', tool_input: { file_path: '/p/buckets.lock.json' } }, false],
    [{ tool_name: 'Bash', tool_input: { command: 'buckets check' } }, false],
  ])('%j -> %s', (input, expected) => {
    expect(touchesLock(input)).toBe(expected);
  });
});

describe('buckets hook pre-tool-use', () => {
  it('denies edits to the lock with the exact output shape', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const result = await runHook('pre-tool-use', { cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'buckets.lock.json') } }, dir);
    expect(result).toEqual({ code: 0, out: `${DENY}\n`, err: '' });
  });

  it('allows other calls silently', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    expect(await runHook('pre-tool-use', { cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' } }, dir)).toEqual({ code: 0, out: '', err: '' });
  });

  it('finds the project from CLAUDE_PROJECT_DIR first, walking up to the config', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const outside = makeProject({}, false);
    // A relative lock name resolves against cwd, which is outside every project, so only the session project denies it.
    const input = { cwd: outside, tool_name: 'Edit', tool_input: { file_path: 'buckets.lock.json' } };
    expect((await runHook('pre-tool-use', input, outside, { CLAUDE_PROJECT_DIR: path.join(dir, 'root', 'log') })).out).toBe(`${DENY}\n`);
    expect((await runHook('pre-tool-use', input, outside)).out).toBe('');
  });

  it('does nothing outside a slopbuckets project', async () => {
    const outside = makeProject({}, false);
    const input = { cwd: outside, tool_name: 'Edit', tool_input: { file_path: 'buckets.lock.json' } };
    expect(await runHook('pre-tool-use', input, outside)).toEqual({ code: 0, out: '', err: '' });
  });

  it('survives invalid JSON on stdin', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const io = fakeIo({ cwd: dir, stdin: 'not json' });
    expect(await hookCommand(testContext(), io, ['pre-tool-use'])).toBe(0);
    expect(io.out).toBe('');
  });
});

describe('buckets hook stop / subagent-stop', () => {
  it.each(['stop', 'subagent-stop'])('%s blocks once with the text report when the check fails', async (event) => {
    const dir = makeProject(LOGGER_PROJECT);
    const result = await runHook(event, { cwd: dir, stop_hook_active: false }, dir);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.out) as { decision: string; reason: string };
    expect(output.decision).toBe('block');
    expect(output.reason).toContain('lock-missing');
    expect(output.reason).toContain('buckets refresh');
  });

  it('lets the agent stop when stop_hook_active is true, without running the check', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'buckets.config.json': '{ broken' });
    expect(await runHook('stop', { cwd: dir, stop_hook_active: true }, dir)).toEqual({ code: 0, out: '', err: '' });
  });

  it('writes nothing when the check passes', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    expect(await runHook('subagent-stop', { cwd: dir }, dir)).toEqual({ code: 0, out: '', err: '' });
  });
});

describe('buckets hook post-tool-use', () => {
  it('blocks with the violations of the edited file', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/_/main.ts': "import x from './x';\n", 'root/log/_/logger.ts': "import y from './y';\nexport function logger() {}\n" });
    const result = await runHook('post-tool-use', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'root/_/main.ts') } }, dir);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.out) as { decision: string; reason: string };
    expect(output.decision).toBe('block');
    expect(output.reason).toContain('root/_/main.ts');
    expect(output.reason).toContain('import-relative');
    expect(output.reason).not.toContain('root/log/_/logger.ts');
  });

  it.skipIf(!existsSync(fileURLToPath(import.meta.url).toUpperCase()))('checks a file_path that differs from the disk only in case', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/_/main.ts': "import x from './x';\n" });
    const result = await runHook('post-tool-use', { cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'ROOT/_/Main.ts') } }, dir);
    expect(result.out).not.toBe('');
    expect(JSON.parse(result.out).reason).toContain('buckets check --file root/_/main.ts');
  });

  it('accepts a relative file_path resolved from cwd', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/_/main.ts': "import x from './x';\n" });
    const result = await runHook('post-tool-use', { cwd: dir, tool_name: 'Write', tool_input: { file_path: 'root/_/main.ts' } }, dir);
    expect(JSON.parse(result.out).decision).toBe('block');
  });

  it('ignores clean files, files outside the root bucket and other tools', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/_/main.ts': "import x from './x';\n" });
    const clean = await runHook('post-tool-use', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'root/log/_/logger.ts') } }, dir);
    expect(clean.out).toBe('');
    const outside = await runHook('post-tool-use', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'README.md') } }, dir);
    expect(outside.out).toBe('');
    const read = await runHook('post-tool-use', { cwd: dir, tool_name: 'NotebookEdit', tool_input: { file_path: path.join(dir, 'root/_/main.ts') } }, dir);
    expect(read.out).toBe('');
  });
});

describe('hooks and unexpected errors', () => {
  /** A context whose analyze answers with nothing, so the check throws a TypeError after the adapter call. */
  function brokenContext(): Context {
    const ctx = testContext();
    return { ...ctx, adapter: { ...ctx.adapter, analyze: async () => null as unknown as AnalyzeResponse } };
  }

  async function runBroken(event: string, input: Record<string, unknown>, dir: string) {
    const io = fakeIo({ cwd: dir, stdin: JSON.stringify({ cwd: dir, ...input }) });
    const code = await hookCommand(brokenContext(), io, [event]);
    return { code, out: io.out, err: io.err };
  }

  it.each(['stop', 'subagent-stop'])('%s blocks once with the error and asks the agent to report it', async (event) => {
    const dir = makeProject(LOGGER_PROJECT);
    const result = await runBroken(event, { stop_hook_active: false }, dir);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.out) as { decision: string; reason: string };
    expect(output.decision).toBe('block');
    expect(output.reason).toContain('TypeError');
    expect(output.reason).toContain('Report this error to the human');
    expect(result.err).toContain('unexpected error');

    const again = await runBroken(event, { stop_hook_active: true }, dir);
    expect(again).toEqual({ code: 0, out: '', err: '' });
  });

  it('post-tool-use blocks with the error', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const result = await runBroken('post-tool-use', { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'root/_/main.ts') } }, dir);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.out) as { decision: string; reason: string };
    expect(output.decision).toBe('block');
    expect(output.reason).toContain('TypeError');
    expect(output.reason).toContain('Report this error to the human');
  });

  it('pre-tool-use keeps allowing the call and writes the error to stderr', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const io = fakeIo({ cwd: dir });
    io.readStdin = async () => {
      throw new Error('stdin is closed');
    };
    expect(await hookCommand(testContext(), io, ['pre-tool-use'])).toBe(0);
    expect(io.out).toBe('');
    expect(io.err).toContain('stdin is closed');
    const lockEdit = { cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'buckets.lock.json') } };
    const failing = fakeIo({ cwd: dir, stdin: JSON.stringify(lockEdit) });
    let writes = 0;
    failing.stdout = () => {
      writes++;
      throw new Error('stdout is closed');
    };
    expect(await hookCommand(testContext(), failing, ['pre-tool-use'])).toBe(0);
    expect(writes).toBe(1);
    expect(failing.err).toContain('pre-tool-use: unexpected error');
  });

  it('reads hook input that starts with a BOM', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const input = { cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'buckets.lock.json') } };
    const io = fakeIo({ cwd: dir, stdin: `﻿${JSON.stringify(input)}` });
    expect(await hookCommand(testContext(), io, ['pre-tool-use'])).toBe(0);
    expect(io.out).toBe(`${DENY}\n`);
  });
});

describe('pre-tool-use and buckets refresh --web', () => {
  const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
  const ps = (command: string) => ({ tool_name: 'PowerShell', tool_input: { command } });

  it.each([
    'buckets refresh --web',
    'npx slopbuckets refresh --web',
    'npx slopbuckets@0.1.0 refresh --web',
    'cd /repo && buckets refresh --web',
    'buckets refresh --web 2>&1',
    'buckets refresh --web &',
    'buckets refresh --web; echo done',
    'buckets   refresh\t--web',
    'buckets refresh "--web"',
    'buckets check && buckets refresh --web',
  ])('allows %j', (command) => {
    expect(runsForbiddenRefresh(command)).toBe(false);
    expect(touchesLock(bash(command))).toBe(false);
    expect(touchesLock(ps(command))).toBe(false);
  });

  it.each([
    'buckets refresh',
    'buckets refresh --webx',
    'buckets refresh --web-ui',
    'buckets refresh --WEB',
    'buckets refresh --web --yes',
    'buckets refresh --yes --web',
    'buckets refresh -- --web',
    'buckets refresh --web; buckets refresh',
    'buckets refresh --web && buckets refresh',
    'buckets refresh --web || buckets refresh',
    'buckets refresh --web | buckets refresh',
    'buckets refresh --web & buckets refresh',
    'buckets refresh --web\nbuckets refresh',
    'buckets refresh --web $(buckets refresh)',
    'buckets refresh --web`buckets refresh`',
    'buckets refresh --web#',
    'echo y | buckets refresh',
    'npx slopbuckets refresh',
    'npx slopbuckets@latest refresh',
    'npx slopbuckets@0.1.0 refresh --webx',
    'Buckets Refresh',
    '"buckets" refresh',
    "buckets 'refresh'",
    String.raw`b\uckets refresh`,
    'b^uckets refresh',
    'buckets refreshx --web',
    'buckets refresh --web buckets.lock.json',
    'cat buckets.lock.json',
  ])('denies %j', (command) => {
    expect(touchesLock(bash(command))).toBe(true);
    expect(touchesLock(ps(command))).toBe(true);
  });

  it.each([
    'buckets refresh --web > out.txt',
    'buckets refresh --web > refresh.log 2>&1 &',
    'buckets refresh --web >refresh.log 2>&1 &',
    'buckets refresh --web>refresh.log',
    'buckets refresh --web >> refresh.log 2>> errors.log',
    'buckets refresh --web &> refresh.log &',
    'buckets refresh --web &>> refresh.log',
    'buckets refresh --web >| refresh.log',
    'buckets refresh --web >& refresh.log',
    'buckets refresh --web 2>&1 | tee refresh.log',
    'buckets refresh --web 2>&1 | tee -a refresh.log &',
    'buckets refresh --web > /dev/null 2>&1 &',
    'buckets refresh --web 1>&2',
    'buckets refresh --web 2>&-',
    'nohup buckets refresh --web > refresh.log 2>&1 &',
    'nohup npx slopbuckets refresh --web &',
    '(buckets refresh --web > refresh.log 2>&1 &)',
    'cd /repo && nohup buckets refresh --web > "logs/refresh.log" 2>&1 &',
    String.raw`buckets refresh --web > C:\temp\refresh.log 2>&1`,
    'npx slopbuckets refresh --web 2>&1 > .buckets/refresh.log & echo started',
    'buckets refresh --web; buckets check > check.log',
  ])('allows the output redirection %j', (command) => {
    expect(runsForbiddenRefresh(command)).toBe(false);
    expect(touchesLock(bash(command))).toBe(false);
  });

  it.each([
    'buckets refresh --web *>&1',
    'buckets refresh --web *> refresh.log',
    'buckets refresh --web 2>$null',
    'buckets refresh --web > $null',
    'buckets refresh --web *>&1 | Out-File refresh.log',
    'buckets refresh --web 3>&1 2>&1 > refresh.log',
    '& buckets refresh --web *> refresh.log',
    "& 'npx' slopbuckets refresh --web *>&1 &",
  ])('allows the PowerShell redirection %j', (command) => {
    expect(runsForbiddenRefresh(command)).toBe(false);
    expect(touchesLock(ps(command))).toBe(false);
  });

  it.each([
    'buckets refresh --web > buckets.lock.json',
    'buckets refresh --web >> ./buckets.lock.json',
    'buckets refresh --web 2> buckets.lock.json',
    'buckets refresh --web *> buckets.lock.json',
    'buckets refresh --web > BUCKET~1.JSO',
    'buckets refresh --web > bucket*',
    'buckets refresh --web 2>&1 | tee buckets.lock.json',
    'buckets refresh --web > out.txt --yes',
    'buckets refresh --web 2>&1 --yes',
    'buckets refresh --web > out.txt extra',
    'buckets refresh --web >',
    'buckets refresh --web > out.txt 2>',
    'buckets refresh --web2>&1',
    'buckets refresh --web*>&1',
    'buckets refresh --web < answers.txt',
    'buckets refresh --web 0< answers.txt',
    'buckets refresh --web <<< y',
    'buckets refresh --web > $(buckets refresh)',
    'buckets refresh --web > `buckets refresh`',
    'buckets refresh --web > out.txt; buckets refresh',
    'buckets refresh --web > out.txt 2>&1 & buckets refresh',
    'nohup buckets refresh > refresh.log 2>&1 &',
    'nohup buckets refresh --yes > refresh.log &',
    'buckets refresh > out.txt --web',
    'buckets refresh 2>&1 --web',
  ])('still denies %j', (command) => {
    expect(touchesLock(bash(command))).toBe(true);
    expect(touchesLock(ps(command))).toBe(true);
  });

  it('allows refresh --web through the hook command and keeps denying plain refresh', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    expect(await runHook('pre-tool-use', { cwd: dir, ...bash('buckets refresh --web') }, dir)).toEqual({ code: 0, out: '', err: '' });
    expect((await runHook('pre-tool-use', { cwd: dir, ...bash('buckets refresh --web; buckets refresh') }, dir)).out).toBe(`${DENY}\n`);
    expect((await runHook('pre-tool-use', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'buckets.lock.json') } }, dir)).out).toBe(`${DENY}\n`);
  });

  it('tells the agent to use refresh --web in the deny reason and the exit 2 stop reason', async () => {
    expect(LOCK_DENY_REASON).toContain('buckets refresh --web');
    const dir = makeProject(LOGGER_PROJECT);
    const result = await runHook('stop', { cwd: dir, stop_hook_active: false }, dir);
    const reason = (JSON.parse(result.out) as { reason: string }).reason;
    expect(reason).toContain('Run `buckets refresh --web` in the background');
    expect(reason).toContain('The human can also run `buckets refresh` in a terminal.');
    // Here the lock is missing: the first line must not claim that DMZ contracts changed.
    const intro = reason.split('\n')[0];
    expect(intro).not.toContain('DMZ contracts');
    expect(intro).toContain('differs from its buckets.lock.json');
  });
});

describe('pre-tool-use, third review', () => {
  const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
  const ps = (command: string) => ({ tool_name: 'PowerShell', tool_input: { command } });
  const write = (file_path: string) => ({ tool_name: 'Write', tool_input: { file_path, content: '{}' } });

  it.each([
    ['C:\\p\\buckets.lock.json::$DATA', 'buckets.lock.json'],
    ['buckets.lock.json:stream', 'buckets.lock.json'],
    ['/p/buckets.lock.json.', 'buckets.lock.json'],
    ['/p/buckets.lock.json. . ', 'buckets.lock.json'],
    ['C:buckets.lock.json', 'buckets.lock.json'],
    ['\\\\?\\C:\\p\\BUCKETS.LOCK.JSON', 'BUCKETS.LOCK.JSON'],
    ['/p/root/', 'root'],
  ])('normalizes %j to the base name %j', (file, base) => {
    expect(normalizeTargetPath(file).base).toBe(base);
  });

  it.each([
    'C:\\p\\buckets.lock.json::$DATA',
    'buckets.lock.json:$DATA',
    '/p/buckets.lock.json.',
    '/p/buckets.lock.json ',
    'C:\\p\\BUCKETS.LOCK.JSON. ',
  ])('denies Write to the alternative name %j', (file) => {
    expect(touchesLock(write(file))).toBe(true);
  });

  it('denies a Write to a hard link or a symbolic link of the lock, and to a nested project lock by identity', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/log/_/engine/buckets.config.json': '{ "root": "root" }\n', 'root/log/_/engine/root/_/run.ts': 'export const run = 1;\n' });
    await approve(path.join(dir, 'root/log/_/engine'));
    await approve(dir);
    const where = { projectDir: dir, cwd: dir };
    const hard = path.join(dir, 'root', 'log', '_', 'notes.json');
    linkSync(path.join(dir, 'buckets.lock.json'), hard);
    expect(touchesLock(write(hard), where)).toBe(true);
    expect(touchesLock(write('root/log/_/notes.json'), where)).toBe(true);
    // A hard link to the nested project's lock, placed in the parent project, found through the parent's lock.
    const nestedHard = path.join(dir, 'root', 'log', '_', 'data.json');
    linkSync(path.join(dir, 'root/log/_/engine/buckets.lock.json'), nestedHard);
    expect(touchesLock(write(nestedHard), where)).toBe(true);
    // Other files in the same folders are still allowed.
    expect(touchesLock(write(path.join(dir, 'root', 'log', '_', 'other.json')), where)).toBe(false);
    expect(touchesLock(write(path.join(dir, 'root', 'log', '_', 'logger.ts')), where)).toBe(false);
    try {
      const soft = path.join(dir, 'root', 'log', '_', 'soft.json');
      symlinkSync(path.join(dir, 'buckets.lock.json'), soft, 'file');
      expect(touchesLock(write(soft), where)).toBe(true);
    } catch (error) {
      // Creating file symlinks needs a privilege on Windows; the hard link case above covers the identity check.
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  });

  it('never crashes on odd paths', () => {
    const where = { projectDir: path.join(path.sep, 'does', 'not', 'exist'), cwd: path.join(path.sep, 'nowhere') };
    for (const file of ['', ':', '::$DATA', '\0', 'C:', '\\\\?\\', 'a/'.repeat(500)]) expect(() => touchesLock(write(file), where)).not.toThrow();
  });

  it.each([
    'cat bucket*',
    'cat buckets.lock.js?n',
    'rm ./*.lock.json',
    'cp x b[u]ckets.lock.json',
    'echo {} > bucket[s].lock.json',
    'cat bucket{s,}.lock.json',
    'Get-Content .\\buckets.*.json',
    'Set-Content -Path buckets.lock.js* -Value x',
    'type BUCKET~1.JSO',
    'copy x C:\\p\\BU3F2A~1.JSO',
    'type BUCKET~?.JSO',
    'cat "buckets".lock.json',
    'cat b"ucke"ts.lock.json',
    'cat b^uckets.lock.json',
    'cat b\\uckets.lock.json',
  ])('denies the lock name hidden as %j', (command) => {
    expect(mentionsLock(command)).toBe(true);
    expect(touchesLock(bash(command))).toBe(true);
    expect(touchesLock(ps(command))).toBe(true);
  });

  it.each(['ls *', 'cat *.json', 'prettier --write "**/*.ts"', 'git show bugfix~1', 'ls src/[a-z]*.ts', 'cat package.json', 'buckets check'])('allows %j', (command) => {
    expect(mentionsLock(command)).toBe(false);
    expect(touchesLock(bash(command))).toBe(false);
  });

  it.each([
    'buckets.cmd refresh',
    'buckets.CMD refresh --yes',
    'buckets.ps1 refresh',
    'slopbuckets.cmd refresh',
    'node cli/dist/index.js refresh',
    'node C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\slopbuckets\\dist\\index.js refresh',
    'node "./node_modules/slopbuckets/dist/index.js" refresh --webx',
    'npx tsx cli/src/cli.ts refresh',
    'npm exec slopbuckets -- refresh',
    'npm exec --yes slopbuckets -- refresh',
    'npm exec --package=slopbuckets -- buckets refresh',
    'npx --prefix /tmp/x slopbuckets refresh',
    'npx slopbuckets --cwd /repo refresh',
    'pnpm dlx slopbuckets refresh',
  ])('denies the plain refresh %j', (command) => {
    expect(runsForbiddenRefresh(command)).toBe(true);
    expect(touchesLock(bash(command))).toBe(true);
    expect(touchesLock(ps(command))).toBe(true);
  });

  it.each([
    'buckets.cmd refresh --web',
    'node cli/dist/index.js refresh --web',
    'npm exec slopbuckets -- refresh --web',
    'pnpm dlx slopbuckets refresh --web',
    'node scripts/build.js',
    'npx vitest run refresh-web',
    'npm test -- refresh',
  ])('allows %j', (command) => {
    expect(runsForbiddenRefresh(command)).toBe(false);
    expect(touchesLock(bash(command))).toBe(false);
  });

  it('denies the new forms through the hook command', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    for (const input of [write(path.join(dir, 'buckets.lock.json::$DATA')), write(path.join(dir, 'buckets.lock.json.')), bash('cat bucket*'), bash('buckets.cmd refresh')]) {
      expect((await runHook('pre-tool-use', { cwd: dir, ...input }, dir)).out).toBe(`${DENY}\n`);
    }
  });
});

describe('pre-tool-use and buckets update', () => {
  const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
  const ps = (command: string) => ({ tool_name: 'PowerShell', tool_input: { command } });

  it('denies an update that can install with the update reason, in Bash and PowerShell', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const deny = `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: UPDATE_DENY_REASON } })}\n`;
    for (const command of ['buckets update', 'buckets update 1.2.0', 'buckets update --yes', 'npx slopbuckets update']) {
      expect(touchesLock(bash(command)), command).toBe(true);
      expect((await runHook('pre-tool-use', { cwd: dir, ...bash(command) }, dir)).out).toBe(deny);
      expect((await runHook('pre-tool-use', { cwd: dir, ...ps(command) }, dir)).out).toBe(deny);
    }
  });

  it('allows --check, --json and other commands with the word update', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    for (const command of ['buckets update --check', 'buckets update --json', 'npm update']) {
      expect(touchesLock(bash(command)), command).toBe(false);
      expect((await runHook('pre-tool-use', { cwd: dir, ...bash(command) }, dir)).out).toBe('');
    }
  });
});
