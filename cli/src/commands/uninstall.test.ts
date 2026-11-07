// `buckets uninstall`: what init installed goes, and what the user wrote stays.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, fileExists, makeProject, readFile } from '../testing/fixture.js';
import { fakeIo, testContext } from '../testing/harness.js';
import { initCommand } from './init.js';
import { removeBlock, uninstallCommand } from './uninstall.js';

afterEach(cleanupProjects);

const USER = { 'package.json': '{}', 'AGENTS.md': '# House rules\n\nNo tabs.\n', '.gitignore': 'node_modules/\n', 'src/a.ts': 'export const a = 1;\n' };

function files(dir: string, rel = ''): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    return entry.isDirectory() ? files(dir, child) : [child];
  });
}

async function setup(agents = 'claude,codex,opencode') {
  const dir = makeProject(USER, false);
  const skill = makeProject({ 'SKILL.md': '# skill\n' }, false);
  expect(await initCommand(testContext(), fakeIo({ cwd: dir }), ['--agent', agents], { skillSource: `${skill}/SKILL.md` })).toBe(0);
  return dir;
}

async function uninstall(dir: string, args: string[] = []) {
  const io = fakeIo({ cwd: dir });
  return { code: await uninstallCommand(testContext(), io, args), out: io.out, err: io.err };
}

describe('buckets uninstall', () => {
  it('removes everything init installed and keeps the config and every file of the user', async () => {
    const dir = await setup();
    // The hooks ran once, so .buckets/ holds a session.
    mkdirSync(path.join(dir, '.buckets', 'sessions'), { recursive: true });
    writeFileSync(path.join(dir, '.buckets', 'sessions', 's1.json'), '{}');
    const result = await uninstall(dir);
    expect(result).toMatchObject({ code: 0, err: '' });
    expect(result.out).toContain('Removed the slopbuckets rules from AGENTS.md');
    expect(result.out).toContain('buckets.config.json stays');
    expect(files(dir).sort()).toEqual(['.gitignore', 'AGENTS.md', 'buckets.config.json', 'package.json', 'src/a.ts']);
    for (const [file, text] of Object.entries(USER)) expect(readFile(dir, file)).toBe(text);
    expect((await uninstall(dir)).out).toContain('Found nothing that buckets init installed');
  });

  it('removes the git pre-commit block and the merge driver of a git repository', async () => {
    const dir = makeProject(USER, false);
    const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nnpm test\n');
    const skill = makeProject({ 'SKILL.md': '# skill\n' }, false);
    expect(await initCommand(testContext(), fakeIo({ cwd: dir }), ['--agent', 'claude', '--git-hook'], { skillSource: `${skill}/SKILL.md` })).toBe(0);
    expect(git('config', '--get', 'merge.slopbuckets.driver').status).toBe(0);
    const result = await uninstall(dir);
    expect(result).toMatchObject({ code: 0, err: '' });
    expect(readFile(dir, '.git/hooks/pre-commit')).toBe('#!/bin/sh\nnpm test\n');
    expect(git('config', '--get-regexp', '^merge\\.slopbuckets\\.').status).toBe(1);
    expect(fileExists(dir, '.gitattributes')).toBe(false);
  });

  it('deletes the config with --config', async () => {
    const dir = await setup('claude');
    expect((await uninstall(dir, ['--config'])).code).toBe(0);
    expect(fileExists(dir, 'buckets.config.json')).toBe(false);
  });

  it('removes only the named agents with --agent, and keeps what the agents share', async () => {
    const dir = await setup();
    const result = await uninstall(dir, ['--agent', 'codex,opencode']);
    expect(result.code).toBe(0);
    expect(fileExists(dir, '.codex/hooks.json')).toBe(false);
    expect(fileExists(dir, '.opencode/plugins/slopbuckets.ts')).toBe(false);
    expect(fileExists(dir, '.claude/settings.json')).toBe(true);
    expect(fileExists(dir, '.agents/skills/slopbuckets/SKILL.md')).toBe(true);
    expect(readFile(dir, 'AGENTS.md')).toContain('slopbuckets:start');
    expect(result.out).toContain('buckets uninstall --all');
  });

  it('refuses an unknown option or agent with the usage exit code and removes nothing', async () => {
    const dir = await setup('claude');
    const before = files(dir).map((file) => [file, readFileSync(path.join(dir, file), 'utf8')]);
    for (const args of [['--nope'], ['--agent', 'nobody'], ['--agent', 'claude', '--all'], ['extra']]) {
      const result = await uninstall(dir, args);
      expect(result.code).toBe(64);
      expect(result.err).toContain('buckets uninstall:');
    }
    expect(files(dir).map((file) => [file, readFileSync(path.join(dir, file), 'utf8')])).toEqual(before);
  });

  it('removes the AGENTS.md block with the blank line before it', () => {
    expect(removeBlock('# Rules\n\n<!-- slopbuckets:start -->\nx\n<!-- slopbuckets:end -->\n')).toBe('# Rules\n');
    expect(removeBlock('<!-- slopbuckets:start -->\nx\n<!-- slopbuckets:end -->\n')).toBe('');
    expect(removeBlock('no block\n')).toBe('no block\n');
  });
});
