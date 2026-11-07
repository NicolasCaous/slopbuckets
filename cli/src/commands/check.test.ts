import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { helpText, main } from '../cli.js';
import { renderCheck } from '../contract/messages.js';
import { createEngine } from '../engine/engine.js';
import { cleanupProjects, makeProject } from '../testing/fixture.js';
import { fakeIo, testContext } from '../testing/harness.js';

afterEach(cleanupProjects);

/** A project in its own repository: .test-tmp/ is ignored by this one. */
function repo(files: Record<string, string>): string {
  const dir = makeProject(files);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}
const realContext = () => ({ ...testContext(), engine: createEngine({ cliVersion: 'test' }) });
const TSCONFIG = '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler" } }';
const CONFIG = JSON.stringify({ version: '2.0', buckets: { app: { purpose: 'Runs the app and serves its pages', files: ['src/**'], public: null, dependsOn: {}, packages: {} } } });

describe('buckets check', () => {
  it('prints the CheckResult as JSON and exits with its exit code', async () => {
    const dir = repo({ 'buckets.config.json': CONFIG, 'tsconfig.json': TSCONFIG, 'src/main.ts': 'export {};\n', 'lib/stray.ts': 'export {};\n' });
    const io = fakeIo({ cwd: `${dir}/src` });
    const code = await main(realContext(), io, ['check', '--json']);
    const report = JSON.parse(io.out);
    expect(report).toEqual({ exitCode: 1, violations: [{ rule: 'file-unowned', project: '.', file: 'lib/stray.ts' }], environment: [], advice: [], projects: ['.'] });
    expect(code).toBe(report.exitCode);
  });

  it('prints the text of renderCheck, and exits with 0 on a clean project', async () => {
    const dir = repo({ 'buckets.config.json': CONFIG, 'tsconfig.json': TSCONFIG, 'src/main.ts': 'export {};\n' });
    const io = fakeIo({ cwd: dir });
    expect(await main(realContext(), io, ['check'])).toBe(0);
    expect(io.out).toBe(`${renderCheck([], [])}\n`);
  });

  it('exits with 3 without a config, and with 64 on a command line it does not understand', async () => {
    const dir = makeProject({ 'tsconfig.json': TSCONFIG }, false);
    const io = fakeIo({ cwd: dir });
    expect(await main(realContext(), io, ['check', '--json'])).toBe(3);
    expect(JSON.parse(io.out).environment[0].code).toBe('no-config');
    const cases: [string[], string][] = [
      [['--file', 'x'], 'unknown option "--file".'],
      [['--jsno'], 'unknown option "--jsno".'],
      [['src'], 'unexpected argument "src".'],
      [['--format', 'xml'], '--format takes text, json, github, sarif, not "xml".'],
      [['--json', '--format', 'sarif'], '--json and --format sarif ask for two outputs.'],
      [['--summary', '--json'], '--summary prints text'],
      [['--base'], '--base needs a value.'],
    ];
    for (const [args, text] of cases) {
      const bad = fakeIo({ cwd: dir });
      expect(await main(realContext(), bad, ['check', ...args])).toBe(64);
      expect(bad.err).toContain(text);
      expect(bad.err).toContain('Usage: buckets check [--json | --format text|json|github|sarif] [--summary] [--base <ref>] [--no-recursive]');
      expect(bad.out).toBe('');
    }
  });
});

describe('-h and --help after a command', () => {
  it.each(['check', 'init', 'inspect', 'update'])('buckets %s --help prints its usage and exits with 0', async (command) => {
    const dir = makeProject({}, false);
    for (const flag of ['-h', '--help']) {
      const io = fakeIo({ cwd: dir });
      expect(await main(realContext(), io, [command, flag])).toBe(0);
      expect(io.out).toMatch(new RegExp(`^Usage: buckets ${command} `));
      expect(io.err).toBe('');
    }
  });
});

describe('help', () => {
  it('lists the 2.0 commands and the exit codes 0, 1 and 3', () => {
    const help = helpText('2.0.0');
    for (const command of ['init', 'check', 'inspect', 'hook <event>', 'update', 'help', '-v, --version']) expect(help).toContain(`  ${command}`);
    for (const exit of ['0', '1', '3']) expect(help).toMatch(new RegExp(`^ {2}${exit} {2}`, 'm'));
    expect(help).not.toMatch(/^ {2}2 {2}/m);
    expect(help).toContain('buckets.config.json');
    for (const gone of ['lock', 'refresh', 'approve']) expect(help.toLowerCase()).not.toContain(gone);
  });
});
