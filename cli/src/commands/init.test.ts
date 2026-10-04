import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, fileExists, makeProject, readFile, writeFile } from '../testing/fixture.js';
import { fakeIo, testContext } from '../testing/harness.js';
import { initCommand, ALIAS_ALPHABET, generateAlias } from './init.js';
import { HOOKS, mergeHooks } from './settings.js';

afterEach(cleanupProjects);

describe('mergeHooks', () => {
  it('adds the four hooks to empty settings', () => {
    const { settings, added } = mergeHooks({});
    expect(added).toEqual(['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop']);
    expect(settings).toEqual({
      hooks: {
        PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell', hooks: [{ type: 'command', command: 'buckets hook pre-tool-use' }] }],
        PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'buckets hook post-tool-use' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'buckets hook stop' }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command: 'buckets hook subagent-stop' }] }],
      },
    });
  });

  it('keeps existing settings and hooks and never duplicates its own entries', () => {
    const existing = {
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'buckets hook pre-tool-use' }] }],
      },
    };
    const once = mergeHooks(existing);
    expect(once.added).toEqual(['PostToolUse', 'Stop', 'SubagentStop']);
    expect(once.settings.permissions).toEqual({ allow: ['Bash(ls)'] });
    const hooks = once.settings.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toHaveLength(2);
    expect(hooks.PreToolUse).toHaveLength(1);
    const twice = mergeHooks(once.settings);
    expect(twice.added).toEqual([]);
    expect(twice.settings).toEqual(once.settings);
    // The input is not mutated.
    expect(existing.hooks.Stop).toHaveLength(1);
  });

  it('refuses settings it cannot merge safely', () => {
    expect(() => mergeHooks({ hooks: [] })).toThrow();
    expect(() => mergeHooks({ hooks: { Stop: {} } })).toThrow();
    expect(() => mergeHooks('x')).toThrow();
  });

  it('runs `buckets hook <event>` for every hook', () => {
    expect(HOOKS.map((h) => h.command)).toEqual(['buckets hook pre-tool-use', 'buckets hook post-tool-use', 'buckets hook stop', 'buckets hook subagent-stop']);
  });
});

describe('buckets init', () => {
  function setup(files: Record<string, string> = { 'package.json': '{}' }) {
    const dir = makeProject(files, false);
    const skill = makeProject({ 'SKILL.md': '# skill\n' }, false);
    return { dir, skill: `${skill}/SKILL.md` };
  }

  it('with --yes creates the config, root/_/, hooks and skill, calls the adapter, and never writes the lock', async () => {
    const { dir, skill } = setup();
    const ctx = testContext({ initChanged: [{ file: 'tsconfig.json', description: 'alias @root/* and noUnusedLocals' }] });
    const io = fakeIo({ cwd: dir });
    expect(await initCommand(ctx, io, ['--yes'], { skillSource: skill, random: () => 0 })).toBe(0);

    expect(JSON.parse(readFile(dir, 'buckets.config.json'))).toEqual({
      $schema: 'https://nicolascaous.github.io/slopbuckets/schema/v1.json',
      adapter: 'ts',
      root: 'root',
      alias: '@root-aaaaaaaa',
      maxDepth: 2,
    });
    expect(fileExists(dir, 'root/_')).toBe(true);
    expect(ctx.adapter.initCalls).toEqual([{ abi: 1, config: { root: 'root', alias: '@root-aaaaaaaa', maxDepth: 2 } }]);
    expect(io.out).toContain('Updated tsconfig.json');
    const settings = JSON.parse(readFile(dir, '.claude/settings.json')) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(settings.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'Stop', 'SubagentStop']);
    expect(readFile(dir, '.claude/skills/slopbuckets/SKILL.md')).toBe('# skill\n');
    expect(fileExists(dir, 'buckets.lock.json')).toBe(false);
    expect(io.out).toContain('buckets refresh');
  });

  it('never reports a file the adapter did not write as updated', async () => {
    const { dir, skill } = setup();
    const ctx = testContext({
      initChanged: [
        { file: 'tsconfig.json', written: false, description: 'no change written, but the effective "include" does not reach root/. Add "root" to "include" in tsconfig.json' },
        { file: 'nest-cli.json', written: false, description: 'not changed, because a comment sits there; set sourceRoot by hand' },
        // An older adapter that does not send `written`, and a bare description.
        { file: 'tsconfig.app.json', description: 'not changed' },
      ],
    });
    const io = fakeIo({ cwd: dir });
    expect(await initCommand(ctx, io, ['--yes'], { skillSource: skill, random: () => 0 })).toBe(0);
    expect(io.out).not.toContain('Updated');
    expect(io.out).toContain('- tsconfig.json already set, but the effective "include" does not reach root/. Add "root" to "include" in tsconfig.json');
    expect(io.out).toContain('- Did not change nest-cli.json, because a comment sits there; set sourceRoot by hand');
    expect(io.out).toContain('= tsconfig.app.json already set');
  });

  it('generates a different unique alias from unambiguous characters each time', async () => {
    const aliases = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const { dir, skill } = setup();
      await initCommand(testContext(), fakeIo({ cwd: dir }), ['--yes'], { skillSource: skill });
      const alias = (JSON.parse(readFile(dir, 'buckets.config.json')) as { alias: string }).alias;
      expect(alias).toMatch(/^@root-[a-hjkmnp-z2-9]{8}$/);
      aliases.add(alias);
    }
    expect(aliases.size).toBe(20);
    expect(ALIAS_ALPHABET).not.toMatch(/[01oli]/);
    expect(generateAlias('src/My Buckets', [], () => 30)).toBe('@my-buckets-99999999');
    let n = 0;
    expect(generateAlias('root', ['@root-aaaaaaaa'], () => (n++ < 8 ? 0 : 1))).toBe('@root-bbbbbbbb');
  });

  it('keeps the alias of an existing config', async () => {
    const { dir, skill } = setup({ 'package.json': '{}', 'buckets.config.json': '{ "root": "root", "alias": "@root" }\n' });
    expect(await initCommand(testContext(), fakeIo({ cwd: dir }), ['--yes'], { skillSource: skill })).toBe(0);
    expect(JSON.parse(readFile(dir, 'buckets.config.json'))).toEqual({ root: 'root', alias: '@root' });
  });

  it('is idempotent', async () => {
    const { dir, skill } = setup();
    await initCommand(testContext(), fakeIo({ cwd: dir }), ['--yes'], { skillSource: skill });
    const before = ['buckets.config.json', '.claude/settings.json', '.claude/skills/slopbuckets/SKILL.md'].map((f) => readFile(dir, f));
    const io = fakeIo({ cwd: dir });
    expect(await initCommand(testContext(), io, ['--yes'], { skillSource: skill })).toBe(0);
    const after = ['buckets.config.json', '.claude/settings.json', '.claude/skills/slopbuckets/SKILL.md'].map((f) => readFile(dir, f));
    expect(after).toEqual(before);
    expect(io.out).not.toContain('Installed');
  });

  it('asks the questions in an interactive terminal', async () => {
    const { dir, skill } = setup();
    const io = fakeIo({ cwd: dir, interactive: true, answers: ['src/buckets', '', '3'] });
    expect(await initCommand(testContext(), io, [], { skillSource: skill, random: () => 1 })).toBe(0);
    expect(io.questions).toHaveLength(3);
    expect(io.questions[1]).toContain('[@buckets-bbbbbbbb]');
    expect(JSON.parse(readFile(dir, 'buckets.config.json'))).toMatchObject({ root: 'src/buckets', alias: '@buckets-bbbbbbbb', maxDepth: 3 });
    expect(fileExists(dir, 'src/buckets/_')).toBe(true);
  });

  it('lets the human choose another alias', async () => {
    const { dir, skill } = setup();
    const io = fakeIo({ cwd: dir, interactive: true, answers: ['', '@shop', ''] });
    expect(await initCommand(testContext(), io, [], { skillSource: skill })).toBe(0);
    expect(JSON.parse(readFile(dir, 'buckets.config.json'))).toMatchObject({ root: 'root', alias: '@shop' });
  });

  it('rejects an invalid answer without writing anything', async () => {
    const { dir, skill } = setup();
    const io = fakeIo({ cwd: dir, interactive: true, answers: ['../out', '', ''] });
    expect(await initCommand(testContext(), io, [], { skillSource: skill })).toBe(1);
    expect(fileExists(dir, 'buckets.config.json')).toBe(false);
  });

  it('refuses to ask without a terminal and points to --yes', async () => {
    const { dir, skill } = setup();
    const io = fakeIo({ cwd: dir });
    expect(await initCommand(testContext(), io, [], { skillSource: skill })).toBe(1);
    expect(io.err).toContain('--yes');
  });

  it('merges into existing Claude Code settings', async () => {
    const { dir, skill } = setup({ '.claude/settings.json': JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'buckets hook stop' }] }] } }) });
    await initCommand(testContext(), fakeIo({ cwd: dir }), ['--yes'], { skillSource: skill });
    const settings = JSON.parse(readFile(dir, '.claude/settings.json')) as { model: string; hooks: Record<string, unknown[]> };
    expect(settings.model).toBe('x');
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it('exits 3 when the adapter cannot set up the project, after installing the rest', async () => {
    const { dir, skill } = setup();
    const ctx = testContext();
    ctx.adapter.init = async () => {
      throw new Error('no tsconfig');
    };
    const io = fakeIo({ cwd: dir });
    expect(await initCommand(ctx, io, ['--yes'], { skillSource: skill })).toBe(3);
    expect(io.err).toContain('no tsconfig');
    expect(fileExists(dir, '.claude/settings.json')).toBe(true);
  });

  it('keeps an existing config', async () => {
    const { dir, skill } = setup();
    writeFile(dir, 'buckets.config.json', '{ "root": "app" }\n');
    await initCommand(testContext(), fakeIo({ cwd: dir }), [], { skillSource: skill });
    expect(readFile(dir, 'buckets.config.json')).toBe('{ "root": "app" }\n');
    expect(fileExists(dir, 'app/_')).toBe(true);
  });
});
