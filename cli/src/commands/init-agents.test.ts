// `buckets init --agent`, the AGENTS.md block and the shared skill, through the init command.
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../hooks/adapters/claude.js';
import { findAdapter, harnesses } from '../hooks/registry.js';
import { BLOCK_START } from '../hooks/instructions.js';
import { cleanupProjects, fileExists, makeProject, readFile } from '../testing/fixture.js';
import { fakeIo, testContext } from '../testing/harness.js';
import { initCommand } from './init.js';

afterEach(cleanupProjects);

function setup(files: Record<string, string> = {}) {
  const dir = makeProject({ 'package.json': '{}', ...files }, false);
  const skill = makeProject({ 'SKILL.md': '# skill\n' }, false);
  return { dir, skill: `${skill}/SKILL.md` };
}

async function init(dir: string, skill: string, args: string[]) {
  const io = fakeIo({ cwd: dir });
  const code = await initCommand(testContext(), io, ['--yes', ...args], { skillSource: skill, random: () => 0 });
  return { code, out: io.out, err: io.err };
}

describe('buckets init and agents', () => {
  it('installs Claude Code, AGENTS.md and both skill copies by default and with --agent claude', async () => {
    for (const args of [[], ['--agent', 'claude'], ['--agent=claude']]) {
      const { dir, skill } = setup();
      const result = await init(dir, skill, args);
      expect(result.code).toBe(0);
      expect(Object.keys((JSON.parse(readFile(dir, '.claude/settings.json')) as { hooks: object }).hooks)).toHaveLength(4);
      expect(readFile(dir, '.claude/skills/slopbuckets/SKILL.md')).toBe('# skill\n');
      expect(readFile(dir, '.agents/skills/slopbuckets/SKILL.md')).toBe('# skill\n');
      expect(readFile(dir, 'AGENTS.md')).toContain(BLOCK_START);
      expect(result.out).toContain('Installed Claude Code hooks in .claude/settings.json (PreToolUse, PostToolUse, Stop, SubagentStop)');
      expect(result.out).toContain('Created AGENTS.md');
    }
  });

  it('is idempotent and keeps user content in AGENTS.md', async () => {
    const { dir, skill } = setup({ 'AGENTS.md': '# House rules\n\nNo tabs.\n' });
    await init(dir, skill, []);
    const files = ['.claude/settings.json', '.claude/skills/slopbuckets/SKILL.md', '.agents/skills/slopbuckets/SKILL.md', 'AGENTS.md'];
    const before = files.map((f) => readFile(dir, f));
    const again = await init(dir, skill, ['--agent', 'claude']);
    expect(files.map((f) => readFile(dir, f))).toEqual(before);
    expect(again.out).not.toContain('Installed');
    expect(again.out).toContain('The slopbuckets rules in AGENTS.md are up to date');
    expect(before[3]!.startsWith('# House rules\n\nNo tabs.\n\n')).toBe(true);
    expect(before[3]!.split(BLOCK_START)).toHaveLength(2);
  });

  it('with --agent auto installs every harness whose folder exists, and notes the ones without hooks', async () => {
    // A harness without an adapter, if any is left, gets a note instead of hooks.
    const without = harnesses().find((h) => findAdapter(h.name) === undefined);
    const markers: Record<string, string> = { '.codex/config.toml': '' };
    if (without !== undefined) markers[`${without.markers[0]!}/.keep`] = '';
    const { dir, skill } = setup(markers);
    const result = await init(dir, skill, ['--agent', 'auto']);
    expect(result.code).toBe(0);
    expect(fileExists(dir, '.claude/settings.json')).toBe(false);
    expect(result.out).toContain('Installed Codex CLI hooks in .codex/hooks.json');
    if (without !== undefined) expect(result.out).toContain(`slopbuckets has no hooks for ${without.title} yet`);
    expect(fileExists(dir, 'AGENTS.md')).toBe(true);

    const both = setup({ '.codex/config.toml': '', '.claude/settings.json': '{ "model": "x" }' });
    await init(both.dir, both.skill, ['--agent', 'auto']);
    expect(JSON.parse(readFile(both.dir, '.claude/settings.json'))).toMatchObject({ model: 'x', hooks: { Stop: expect.any(Array) } });
  });

  it('with --agent auto and no agent folder installs only the shared instructions', async () => {
    const { dir, skill } = setup();
    const result = await init(dir, skill, ['--agent', 'auto']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Found no agent folder here');
    expect(fileExists(dir, '.claude')).toBe(false);
    expect(fileExists(dir, '.agents/skills/slopbuckets/SKILL.md')).toBe(true);
  });

  it('refuses an unknown agent or a missing value before writing anything', async () => {
    const { dir, skill } = setup();
    const unknown = await init(dir, skill, ['--agent', 'claude,vim']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('unknown agent "vim"');
    expect(unknown.err).toContain('Nothing was written');
    expect(fileExists(dir, 'buckets.config.json')).toBe(false);
    const missing = await init(dir, skill, ['--agent']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('--agent needs a value');
    expect((await init(dir, skill, ['--agent', '--git-hook'])).code).toBe(1);
  });

  it('with --git-hook installs the pre-commit hook in the repository and says where', async () => {
    const { dir, skill } = setup();
    spawnSync('git', ['init', '-q'], { cwd: dir });
    const result = await init(dir, skill, ['--git-hook']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Installed a git pre-commit hook in .git/hooks/pre-commit');
    expect(readFile(dir, '.git/hooks/pre-commit')).toContain('buckets check');
  });

  it('accepts --no-git-hook as the default and leaves git alone', async () => {
    const { dir, skill } = setup();
    const result = await init(dir, skill, ['--no-git-hook']);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('pre-commit');
  });

  it('uninstalls the Claude Code hooks and skill but keeps user hooks', async () => {
    const { dir, skill } = setup({ '.claude/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }) });
    await init(dir, skill, []);
    const steps = claudeAdapter.uninstall(dir);
    expect(steps.map((s) => s.status)).toEqual(['done', 'done']);
    expect(JSON.parse(readFile(dir, '.claude/settings.json'))).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
    expect(fileExists(dir, '.claude/skills/slopbuckets/SKILL.md')).toBe(false);
    expect(claudeAdapter.uninstall(dir)).toEqual([{ status: 'kept', text: '.claude/settings.json has no slopbuckets hooks' }]);
  });
});
