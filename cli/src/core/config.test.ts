import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../testing/fixture.js';
import { checkProject } from '../testing/harness.js';
import { configHash, DEFAULT_CONFIG, loadConfig, rootCaseOnDisk, validateConfig } from './config.js';

afterEach(cleanupProjects);

describe('validateConfig', () => {
  it('fills in the defaults', () => {
    expect(validateConfig({}).config).toEqual(DEFAULT_CONFIG);
    expect(validateConfig({ $schema: 'x', root: 'src/root', maxDepth: 3 }).config).toEqual({ ...DEFAULT_CONFIG, root: 'src/root', maxDepth: 3 });
  });

  it.each([
    ['unknown field', { foo: 1 }],
    ['adapter outside the enum', { adapter: 'py' }],
    ['empty root', { root: '' }],
    ['absolute root', { root: '/abs' }],
    ['root leaving the project', { root: '../x' }],
    ['root naming the project', { root: '.' }],
    ['empty alias', { alias: '' }],
    ['maxDepth below 1', { maxDepth: 0 }],
    ['maxDepth not an integer', { maxDepth: 1.5 }],
    ['$schema not a string', { $schema: 1 }],
    ['not an object', []],
  ])('rejects %s', (_name, raw) => {
    const result = validateConfig(raw);
    expect(result.config).toBeUndefined();
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations.every((v) => v.rule === 'config-invalid' && v.file === 'buckets.config.json')).toBe(true);
  });
});

describe('loadConfig', () => {
  it('reports a missing config', () => {
    expect(loadConfig(makeProject({}, false)).kind).toBe('missing');
  });

  it('reports invalid JSON as config-invalid', () => {
    const result = loadConfig(makeProject({ 'buckets.config.json': '{ nope' }, false));
    expect(result.kind).toBe('invalid');
  });

  it('hashes the resolved config, ignoring $schema and formatting', () => {
    const a = loadConfig(makeProject({ 'buckets.config.json': '{"$schema":"x"}' }, false));
    const b = loadConfig(makeProject({ 'buckets.config.json': '{\n  "root": "root",\n  "maxDepth": 2\n}\n' }, false));
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('expected valid configs');
    expect(configHash(a.config)).toBe(configHash(b.config));
    expect(configHash({ ...a.config, maxDepth: 3 })).not.toBe(configHash(a.config));
  });
});

describe('check with a bad config', () => {
  it('exits 3 with no-config when the config is missing', async () => {
    const { report } = await checkProject(makeProject({}, false));
    expect(report.exitCode).toBe(3);
    expect(report.environment?.code).toBe('no-config');
  });

  it('exits 1 with config-invalid and does not call the adapter', async () => {
    const dir = makeProject({ 'buckets.config.json': '{"maxDepth": "two"}', 'root/_/a.ts': '' });
    const { report } = await checkProject(dir);
    expect(report.exitCode).toBe(1);
    expect(report.violations.map((v) => v.rule)).toEqual(['config-invalid']);
  });
});

describe('root folder case', () => {
  it('reports one config-invalid violation when "root" differs from the folder on disk only in case', async () => {
    const dir = makeProject({
      'buckets.config.json': '{ "root": "Root" }\n',
      'root/_/main.ts': "import { x } from '@root/a/_/x';\nexport const y = x;\n",
      'root/a/_/x.ts': 'export const x = 1;\n',
    });
    const { report } = await checkProject(dir);
    expect(report.exitCode).toBe(1);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.rule).toBe('config-invalid');
    expect(report.violations[0]!.message).toContain('Field "root" is "Root", but the folder on disk is spelled "root"');
    expect(rootCaseOnDisk(dir, 'root')).toBeNull();
    expect(rootCaseOnDisk(dir, 'missing')).toBeNull();
  });

  it('compares nested root folders segment by segment', () => {
    const dir = makeProject({ 'src/Root/_/main.ts': 'export {};\n' });
    expect(rootCaseOnDisk(dir, 'Src/root')).toBe('src/Root');
    expect(rootCaseOnDisk(dir, 'src/Root')).toBeNull();
  });
});
