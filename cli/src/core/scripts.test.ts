import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, LOGGER_PROJECT, makeProject } from '../testing/fixture.js';
import { checkProject, pairs, testContext } from '../testing/harness.js';
import { DEFAULT_CONFIG, type ResolvedConfig } from './config.js';
import { bucketNameProblem, resolveScripts, scriptValues, type ScriptRun, type ScriptRunner } from './scripts.js';

afterEach(cleanupProjects);

const ok = (stdout: string): ScriptRun => ({ status: 0, stdout, stderr: '', timedOut: false });

/** A fake runner that answers by script file name and records every call. */
function fakeRunner(answers: Record<string, ScriptRun>): ScriptRunner & { calls: string[] } {
  const calls: string[] = [];
  const run = ((file: string, cwd: string) => {
    calls.push(`${path.basename(file)} in ${path.basename(cwd)}`);
    const answer = answers[path.basename(file)];
    if (answer === undefined) throw new Error(`no answer for ${file}`);
    return answer;
  }) as ScriptRunner & { calls: string[] };
  run.calls = calls;
  return run;
}

describe('scriptValues', () => {
  it('reads one value per non-empty line, strips a trailing \\r, sorts and removes duplicates', () => {
    expect(scriptValues(ok('web\r\napi\n\nweb\napi\r\n'))).toEqual({ values: ['api', 'web'] });
    expect(scriptValues(ok('B\na\nA'))).toEqual({ values: ['A', 'B', 'a'] });
  });

  it('fails on a non-zero exit with the first lines of stderr', () => {
    const run: ScriptRun = { status: 2, stdout: 'api\n', stderr: '\nError: ENOENT repos.json\n    at read\n', timedOut: false };
    expect(scriptValues(run)).toEqual({ problem: 'exited with code 2. Its stderr begins with these lines: "Error: ENOENT repos.json", "at read".' });
    expect(scriptValues({ ...run, stderr: '' })).toEqual({ problem: 'exited with code 2. It printed nothing on stderr.' });
  });

  it('fails on a timeout, a failure to start and an empty output', () => {
    expect(scriptValues({ status: null, stdout: '', stderr: 'slow', timedOut: true })).toEqual({
      problem: 'did not finish within 10 seconds and was stopped. Its stderr begins with this line: "slow".',
    });
    expect(scriptValues({ status: null, stdout: '', stderr: '', timedOut: false, error: 'spawn EACCES' })).toEqual({ problem: 'could not start: spawn EACCES.' });
    expect(scriptValues(ok('\n\r\n'))).toEqual({ problem: 'printed no values. It printed nothing on stderr.' });
  });

  it.each(['a/b', 'a\\b', 'api*', '{a}', '<a>', 'a,b', 'a|b', 'a`b', ' api', 'api ', '.hidden', '_', 'dmz', 'a:b', 'a\tb'])('rejects the value %j', (value) => {
    const result = scriptValues(ok(`api\n${value}\n`));
    expect('problem' in result && result.problem).toMatch(new RegExp(`^printed ${JSON.stringify(value).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}, which is not a valid bucket name`));
  });

  it('accepts ordinary bucket names', () => {
    for (const value of ['api', 'team-a', 'svc_2', 'Payments', 'a.b', 'a+b']) expect(bucketNameProblem(value)).toBeNull();
  });
});

describe('resolveScripts', () => {
  const config: ResolvedConfig = { ...DEFAULT_CONFIG, scripts: { repos: 'tools/repos.js', teams: 'tools/teams.js' } };

  it('runs each script in the project folder and returns its values by name', () => {
    const dir = makeProject({});
    const run = fakeRunner({ 'repos.js': ok('web\napi\n'), 'teams.js': ok('a\n') });
    expect(resolveScripts({ runScript: run }, dir, config)).toEqual({ values: { repos: ['api', 'web'], teams: ['a'] } });
    expect(run.calls).toEqual([`repos.js in ${path.basename(dir)}`, `teams.js in ${path.basename(dir)}`]);
  });

  it('runs each script at most once per runner, however often the scripts are resolved', () => {
    const dir = makeProject({});
    const run = fakeRunner({ 'repos.js': ok('api\n'), 'teams.js': ok('a\n') });
    resolveScripts({ runScript: run }, dir, config);
    resolveScripts({ runScript: run }, dir, config);
    expect(run.calls).toHaveLength(2);
  });

  it('reports each failing script as config-invalid, with its name and file', () => {
    const dir = makeProject({});
    const run = fakeRunner({ 'repos.js': { status: 1, stdout: '', stderr: 'boom\n', timedOut: false }, 'teams.js': ok('') });
    const result = resolveScripts({ runScript: run }, dir, config);
    if (!('violations' in result)) throw new Error('expected violations');
    expect(result.violations.map((v) => `${v.rule} ${v.file}`)).toEqual(['config-invalid buckets.config.json', 'config-invalid buckets.config.json']);
    expect(result.violations[0]!.message).toBe(
      'The script "repos" (tools/repos.js) of buckets.config.json exited with code 1. Its stderr begins with this line: "boom". A script prints one bucket name per line on stdout and exits with code 0. Its values join the groups of the access and layout lines that name it in backticks. Fix the script or the files it reads, then run the check again. If the script is right and the config must change, stop and ask the human, because buckets.config.json belongs to a human.',
    );
    expect(result.violations[1]!.message).toContain('The script "teams" (tools/teams.js) of buckets.config.json printed no values.');
  });

  it('runs a real Node script from a folder with a space in its name', () => {
    const dir = makeProject({
      'buckets.config.json': JSON.stringify({ root: 'root', scripts: { repos: 'my tools/repos.js' } }),
      'repos.json': JSON.stringify({ repositories: [{ name: 'web' }, { name: 'api' }, { name: 'web' }] }),
      'my tools/repos.js': "const fs = require('node:fs');\nfor (const r of JSON.parse(fs.readFileSync('repos.json', 'utf8')).repositories) console.log(r.name);\n",
      'my tools/package.json': '{ "type": "commonjs" }\n',
    });
    const real: ResolvedConfig = { ...DEFAULT_CONFIG, scripts: { repos: 'my tools/repos.js' } };
    expect(resolveScripts({}, dir, real)).toEqual({ values: { repos: ['api', 'web'] } });
  });
});

describe('check with scripts', () => {
  function project(config: Record<string, unknown>, extra: Record<string, string> = {}): string {
    return makeProject({ ...LOGGER_PROJECT, 'buckets.config.json': JSON.stringify({ root: 'root', scripts: { areas: 'tools/areas.js' }, ...config }), 'tools/areas.js': '', ...extra });
  }

  it('matches layout lines with the values of the script', async () => {
    const dir = project({ layout: { default: 'deny', allow: ['root/`areas`', 'root/billing/*'] } });
    const ctx = { ...testContext(), runScript: fakeRunner({ 'areas.js': ok('billing\n') }) };
    expect(pairs((await checkProject(dir, {}, ctx)).report.violations)).toEqual(['layout-denied root/log']);
    const both = { ...testContext(), runScript: fakeRunner({ 'areas.js': ok('billing\nlog\n') }) };
    expect(pairs((await checkProject(dir, {}, both)).report.violations)).toEqual([]);
  });

  it('matches access lines with the values of the script', async () => {
    const dir = project({ access: { default: 'deny', allow: ['root/billing/** -> root/{`areas`}'] } });
    const allowed = { ...testContext(), runScript: fakeRunner({ 'areas.js': ok('log\n') }) };
    expect((await checkProject(dir, {}, allowed)).report.violations.filter((v) => v.rule.startsWith('access-'))).toEqual([]);
    const denied = { ...testContext(), runScript: fakeRunner({ 'areas.js': ok('sql\n') }) };
    expect((await checkProject(dir, {}, denied)).report.violations.some((v) => v.rule === 'access-denied')).toBe(true);
  });

  it('exits 1 with config-invalid before the analysis when a script fails', async () => {
    const dir = project({ layout: { default: 'deny', allow: ['root/`areas`'] } });
    const ctx = { ...testContext(), runScript: fakeRunner({ 'areas.js': { status: 1, stdout: '', stderr: 'nope', timedOut: false } }) };
    const { report } = await checkProject(dir, {}, ctx);
    expect(report.exitCode).toBe(1);
    expect(pairs(report.violations)).toEqual(['config-invalid buckets.config.json']);
    expect(ctx.adapter.analyzeCalls).toEqual([]);
  });

  it('runs the scripts for check --file too, once for several checks with the same runner', async () => {
    const dir = project({ layout: { default: 'deny', allow: ['root/`areas`', 'root/billing/*'] } });
    const run = fakeRunner({ 'areas.js': ok('billing\nlog\n') });
    const ctx = { ...testContext(), runScript: run };
    const first = await checkProject(dir, { file: 'root/log/_/logger.ts' }, ctx);
    const second = await checkProject(dir, { file: 'root/_/main.ts' }, ctx);
    expect([first.report.exitCode, second.report.exitCode]).toEqual([0, 0]);
    expect(run.calls).toHaveLength(1);
  });
});
