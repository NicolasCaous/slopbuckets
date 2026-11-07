import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, fileExists, makeProject, readFile } from '../testing/fixture.js';
import { fakeIo, testContext } from '../testing/harness.js';
import { EMPTY_CONFIG, initCommand } from './init.js';

afterEach(cleanupProjects);

describe('buckets init', () => {
  function setup(files: Record<string, string> = { 'package.json': '{}' }) {
    const dir = makeProject(files, false);
    const skill = makeProject({ 'SKILL.md': '# skill\n' }, false);
    return { dir, skill: `${skill}/SKILL.md` };
  }

  async function init(dir: string, skill: string, args: string[] = []) {
    const io = fakeIo({ cwd: dir });
    const code = await initCommand(testContext(), io, args, { skillSource: skill });
    return { code, out: io.out, err: io.err };
  }

  it('in a fresh folder writes the empty v2 config, .gitignore, the hooks and the skill, and says what comes next', async () => {
    const { dir, skill } = setup();
    const result = await init(dir, skill, ['--yes']);
    expect(result.code).toBe(0);
    const config = readFile(dir, 'buckets.config.json');
    expect(JSON.parse(config)).toEqual({ $schema: 'https://nicolascaous.github.io/slopbuckets/schema/v2.json', version: '2.0', ignore: [], projects: [], buckets: {} });
    expect(config).toBe(`${JSON.stringify(EMPTY_CONFIG, null, 2)}\n`);
    expect(readFile(dir, '.gitignore')).toBe('.buckets/\n');
    const settings = JSON.parse(readFile(dir, '.claude/settings.json')) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(settings.hooks).length).toBeGreaterThan(0);
    expect(readFile(dir, '.claude/skills/slopbuckets/SKILL.md')).toBe('# skill\n');
    expect(result.out).toContain('Created buckets.config.json with no buckets');
    expect(result.out).toContain('Created .gitignore with .buckets/');
    expect(result.out).toContain('Next: let your agent design the buckets in buckets.config.json. Every file starts as unowned, and `buckets check` lists them grouped by folder.');
    expect(result.out).not.toMatch(/root folder|alias/i);
    expect(fileExists(dir, 'buckets.lock.json')).toBe(false);
  });

  it('is idempotent', async () => {
    const { dir, skill } = setup();
    await init(dir, skill);
    const files = ['buckets.config.json', '.gitignore', '.claude/settings.json', '.claude/skills/slopbuckets/SKILL.md', 'AGENTS.md'];
    const before = files.map((f) => readFile(dir, f));
    const again = await init(dir, skill);
    expect(again.code).toBe(0);
    expect(files.map((f) => readFile(dir, f))).toEqual(before);
    expect(again.out).not.toMatch(/Installed|Created|Added/);
    expect(again.out).toContain('.buckets/ is already in .gitignore');
  });

  it('keeps an existing v2 config, says how to start over, and installs the rest', async () => {
    const config = JSON.stringify({ version: '2.0', buckets: { app: { purpose: 'Starts the app', files: ['src/**'], public: null, dependsOn: {}, packages: {} } } });
    const { dir, skill } = setup({ 'buckets.config.json': config });
    const result = await init(dir, skill);
    expect(result.code).toBe(0);
    expect(readFile(dir, 'buckets.config.json')).toBe(config);
    expect(result.out).toContain('buckets.config.json already exists, so init left it as it is. Edit it, or delete it and run `buckets init` again for an empty one.');
    expect(fileExists(dir, 'AGENTS.md')).toBe(true);
    expect(result.out).toContain('Next: run `buckets check`.');
    expect(result.out).not.toContain('Every file starts as unowned');
  });

  it('keeps an existing config that is not valid JSON, for the check to report', async () => {
    const { dir, skill } = setup({ 'buckets.config.json': '{ "buckets": ' });
    const result = await init(dir, skill);
    expect(result.code).toBe(0);
    expect(readFile(dir, 'buckets.config.json')).toBe('{ "buckets": ');
  });

  it('refuses a 1.x config, explains that 2.0 replaces it, and writes nothing', async () => {
    const config = JSON.stringify({ root: 'root', alias: '@root', access: { default: 'allow' } });
    const { dir, skill } = setup({ 'buckets.config.json': config });
    const result = await init(dir, skill, ['--yes']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('buckets.config.json is a slopbuckets 1.x config (it has "root", "alias", "access")');
    expect(result.err).toContain('2.0 replaces it');
    expect(result.err).toContain('init does not convert a 1.x config');
    expect(result.err).toContain('Nothing was written');
    expect(readFile(dir, 'buckets.config.json')).toBe(config);
    for (const file of ['.gitignore', 'AGENTS.md', '.claude', '.agents']) expect(fileExists(dir, file)).toBe(false);
  });

  it('appends .buckets/ to an existing .gitignore, keeps CRLF, and accepts an entry that is already there', async () => {
    const plain = setup({ '.gitignore': 'node_modules\ndist' });
    await init(plain.dir, plain.skill);
    expect(readFile(plain.dir, '.gitignore')).toBe('node_modules\ndist\n.buckets/\n');

    const crlf = setup({ '.gitignore': 'node_modules\r\n' });
    const result = await init(crlf.dir, crlf.skill);
    expect(readFile(crlf.dir, '.gitignore')).toBe('node_modules\r\n.buckets/\r\n');
    expect(result.out).toContain('Added .buckets/ to .gitignore');

    for (const entry of ['.buckets', '/.buckets/', '  .buckets/  ']) {
      const has = setup({ '.gitignore': `dist\n${entry}\n` });
      await init(has.dir, has.skill);
      expect(readFile(has.dir, '.gitignore')).toBe(`dist\n${entry}\n`);
    }
  });

  it('merges into existing Claude Code settings', async () => {
    const { dir, skill } = setup({ '.claude/settings.json': JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'buckets hook stop' }] }] } }) });
    await initCommand(testContext(), fakeIo({ cwd: dir }), ['--yes'], { skillSource: skill });
    const settings = JSON.parse(readFile(dir, '.claude/settings.json')) as { model: string; hooks: Record<string, unknown[]> };
    expect(settings.model).toBe('x');
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it('refuses an unknown option', async () => {
    const { dir, skill } = setup();
    const io = fakeIo({ cwd: dir });
    expect(await initCommand(testContext(), io, ['--rot'], { skillSource: skill })).toBe(64);
    expect(io.err).toContain('unknown option "--rot". Usage: buckets init');
    expect(fileExists(dir, 'buckets.config.json')).toBe(false);
  });
});
