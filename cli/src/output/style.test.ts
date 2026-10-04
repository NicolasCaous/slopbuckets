import { afterEach, describe, expect, it } from 'vitest';
import { main, suggestCommand } from '../cli.js';
import { hookCommand } from '../commands/hook.js';
import { initCommand } from '../commands/init.js';
import { cleanupProjects, LOGGER_PROJECT, makeProject } from '../testing/fixture.js';
import { fakeIo, testContext } from '../testing/harness.js';
import { renderSplash, TAGLINE } from './splash.js';
import { colorLevel, createStyle, PLAIN, stripAnsi, visibleWidth, wrap } from './style.js';

afterEach(cleanupProjects);

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[/;
const TTY = { stdout: true, stderr: true, columns: 80 };

describe('colorLevel', () => {
  it.each([
    [{}, true, 'basic'],
    [{}, false, 'none'],
    [{ NO_COLOR: '1' }, true, 'none'],
    [{ NO_COLOR: '' }, true, 'basic'],
    [{ FORCE_COLOR: '1' }, false, 'basic'],
    [{ FORCE_COLOR: '0' }, true, 'none'],
    [{ FORCE_COLOR: '0', NO_COLOR: '1' }, true, 'none'],
    [{ FORCE_COLOR: '1', NO_COLOR: '1' }, false, 'basic'],
    [{ FORCE_COLOR: '3' }, false, 'truecolor'],
    [{ TERM: 'dumb' }, true, 'none'],
    [{ COLORTERM: 'truecolor' }, true, 'truecolor'],
  ] as const)('%j, tty %s -> %s', (env, tty, level) => {
    expect(colorLevel(env, tty)).toBe(level);
  });
});

describe('wrap', () => {
  it('keeps one line without a width and wraps by words with a width', () => {
    expect(wrap('a b c', undefined, '  ')).toEqual(['  a b c']);
    expect(wrap('one two three four five six seven eight nine ten eleven', 30, '  ')).toEqual([
      '  one two three four five six',
      '  seven eight nine ten eleven',
    ]);
  });

  it('measures colored words by their visible width', () => {
    const style = createStyle('basic');
    const lines = wrap(`${style.error('red')} ${'word '.repeat(10)}`, 30, '');
    expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
  });
});

describe('splash', () => {
  it.each([130, 80, 60, 50, 36])('fits a terminal %i columns wide and shows the tagline and version', (columns) => {
    const text = renderSplash('1.2.3', columns, createStyle('truecolor', { tty: true }));
    const plain = stripAnsi(text);
    for (const line of plain.split('\n')) expect(visibleWidth(line)).toBeLessThan(columns);
    // Narrow layouts split the tagline over two lines.
    expect(plain).toContain('Let the AI write slop.');
    expect(plain).toContain('Keep it in buckets.');
    expect(plain).toContain('1.2.3');
  });

  it('uses the block-letter banner from 60 columns and the bucket at every size from 40', () => {
    expect(renderSplash('1', 80, PLAIN)).toContain('██████╗ ██╗   ██╗ ██████╗██╗  ██╗███████╗████████╗███████╗');
    expect(renderSplash('1', 50, PLAIN)).not.toContain('██╗');
    for (const columns of [130, 80, 50]) expect(renderSplash('1', columns, PLAIN)).toContain('▐█');
  });
});

describe('styled output', () => {
  it('shows the splash above the help only for `buckets` alone on a terminal', async () => {
    const tty = fakeIo({ cwd: '.', terminal: TTY });
    await main(testContext(), tty, []);
    expect(stripAnsi(tty.out)).toContain(TAGLINE);
    expect(stripAnsi(tty.out)).toContain('Usage: buckets');

    for (const [args, terminal] of [[['--help'], TTY], [[], undefined]] as const) {
      const io = fakeIo({ cwd: '.', ...(terminal ? { terminal } : {}) });
      await main(testContext(), io, [...args]);
      expect(io.out).not.toContain(TAGLINE);
      expect(stripAnsi(io.out)).toContain('Usage: buckets');
    }
  });

  it('colors check text on a terminal, and never with NO_COLOR, in a pipe or with --json', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const colored = fakeIo({ cwd: dir, terminal: TTY });
    expect(await main(testContext(), colored, ['check'])).toBe(2);
    expect(colored.out).toMatch(ANSI);

    const noColor = fakeIo({ cwd: dir, terminal: TTY, env: { NO_COLOR: '1' } });
    await main(testContext(), noColor, ['check']);
    expect(noColor.out).not.toMatch(ANSI);

    const piped = fakeIo({ cwd: dir });
    await main(testContext(), piped, ['check']);
    expect(piped.out).not.toMatch(ANSI);
    expect(piped.out).not.toContain(TAGLINE);

    const json = fakeIo({ cwd: dir, terminal: TTY, env: { FORCE_COLOR: '3' } });
    await main(testContext(), json, ['check', '--json']);
    expect(json.out).not.toMatch(ANSI);
    expect(JSON.parse(json.out).exitCode).toBe(2);
  });

  it('keeps hook output plain even when color is forced', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/_/main.ts': "import x from './x';\n" });
    const io = fakeIo({ cwd: dir, stdin: JSON.stringify({ cwd: dir }), terminal: TTY, env: { FORCE_COLOR: '3' } });
    await hookCommand(testContext(), io, ['stop']);
    expect(io.out).not.toMatch(ANSI);
    expect(io.out).not.toContain(TAGLINE);
    expect(JSON.parse(io.out).decision).toBe('block');
  });

  it('shows the splash at the start of init on a terminal and ends with one next step', async () => {
    const dir = makeProject({ 'package.json': '{}' }, false);
    const skill = makeProject({ 'SKILL.md': '# skill\n' }, false);
    const io = fakeIo({ cwd: dir, terminal: TTY });
    expect(await initCommand(testContext(), io, ['--yes'], { skillSource: `${skill}/SKILL.md` })).toBe(0);
    const plain = stripAnsi(io.out);
    expect(plain.indexOf(TAGLINE)).toBeLessThan(plain.indexOf('Created buckets.config.json'));
    expect(plain).toMatch(/\n\nNext step: run buckets refresh[^\n]*\n?[^\n]*buckets\.lock\.json\.\n$/);
  });

  it('suggests a command for a typo', async () => {
    expect(suggestCommand('chek')).toBe('check');
    expect(suggestCommand('refrsh')).toBe('refresh');
    expect(suggestCommand('frobnicate')).toBeUndefined();
    const io = fakeIo({ cwd: '.' });
    expect(await main(testContext(), io, ['chekc'])).toBe(1);
    expect(io.err).toContain('Did you mean `buckets check`?');
  });
});
