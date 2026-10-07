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
    ['access not an object', { access: ['** -> **'] }],
    ['access without default', { access: { deny: ['root/a -> root/b'] } }],
    ['access default outside the enum', { access: { default: 'maybe' } }],
    ['unknown field in access', { access: { default: 'deny', only: [] } }],
    ['access deny not an array', { access: { default: 'deny', deny: 'root/a -> root/b' } }],
    ['access line not a string', { access: { default: 'deny', allow: [1] } }],
    ['access line without an arrow', { access: { default: 'deny', allow: ['root/a'] } }],
    ['access line with two arrows', { access: { default: 'deny', allow: ['root/a -> root/b -> root/c'] } }],
    ['access line with an unclosed brace', { access: { default: 'deny', deny: ['root/{a,b -> root/c'] } }],
    ['access line listed twice', { access: { default: 'deny', allow: ['root/a -> root/b', 'root/a->root/b'] } }],
    ['access line in both allow and deny', { access: { default: 'deny', allow: ['root/a -> root/b'], deny: ['root/a->root/b'] } }],
  ])('rejects %s', (_name, raw) => {
    const result = validateConfig(raw);
    expect(result.config).toBeUndefined();
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations.every((v) => v.rule === 'config-invalid' && v.file === 'buckets.config.json')).toBe(true);
  });
});

describe('access', () => {
  it('stores each line in canonical form and fills in the missing list', () => {
    const { config } = validateConfig({ access: { default: 'deny', allow: ['root/api/**->root/log', '  ** ->   root/sql '] } });
    expect(config?.access).toEqual({ default: 'deny', allow: ['root/api/** -> root/log', '** -> root/sql'], deny: [] });
    expect(validateConfig({ access: { default: 'allow', deny: ['root/a -> root/b'] } }).config?.access).toEqual({ default: 'allow', allow: [], deny: ['root/a -> root/b'] });
  });

  it('names the line that is in both allow and deny', () => {
    const { violations } = validateConfig({ access: { default: 'deny', allow: ['root/a->root/b'], deny: ['root/a -> root/b'] } });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain('"root/a -> root/b"');
    expect(violations[0]!.message).toContain('Remove it from one of them');
  });

  it('accepts a deny line that carves an exception out of a broader allow line', () => {
    const { config, violations } = validateConfig({ access: { default: 'deny', allow: ['root/** -> root/log'], deny: ['root/billing -> root/log'] } });
    expect(violations).toEqual([]);
    expect(config?.access).toEqual({ default: 'deny', allow: ['root/** -> root/log'], deny: ['root/billing -> root/log'] });
  });

  it('accepts allow lines under "default": "allow", as exceptions inside deny lines', () => {
    const { config, violations } = validateConfig({ access: { default: 'allow', allow: ['root/web/admin -> root/sql'], deny: ['root/web/** -> root/sql/**'] } });
    expect(violations).toEqual([]);
    expect(config?.access).toEqual({ default: 'allow', allow: ['root/web/admin -> root/sql'], deny: ['root/web/** -> root/sql/**'] });
  });

  it('accepts sides that start with the root path or with **', () => {
    const lines = ['root -> root/log', 'root/** -> **', '**/api -> root/billing/*', '** -> root'];
    expect(validateConfig({ access: { default: 'deny', allow: lines } }).violations).toEqual([]);
    const nested = ['src/root -> src/root/log', 'src/root/** -> **', '** -> src/root/{a,b}'];
    expect(validateConfig({ root: 'src/root', access: { default: 'deny', allow: nested } }).violations).toEqual([]);
  });

  it('rejects a side that does not start with the root path, comparing whole segments', () => {
    const { violations } = validateConfig({ access: { default: 'deny', allow: ['rootx/billing -> root/log'], deny: ['root/api -> log', '* -> root/sql'] } });
    expect(violations.map((v) => v.message)).toEqual([
      'Field "access.allow": the left side "rootx/billing" of "rootx/billing -> root/log" must start with the root path "root" or with "**", because every bucket path starts with "root", such as "root/billing". If the root folder moved, write the new root path at the start of the line.',
      expect.stringContaining('the right side "log" of "root/api -> log" must start with the root path "root"'),
      expect.stringContaining('the left side "*" of "* -> root/sql"'),
    ]);
    expect(violations.every((v) => v.rule === 'config-invalid' && v.file === 'buckets.config.json')).toBe(true);
  });

  it('rejects lines that keep the old root path after the root moved', () => {
    const { violations } = validateConfig({ root: 'src/root', access: { default: 'deny', allow: ['root/api -> src/root/log', 'src/api -> src/root/log', 'src/root/api -> src/rootx'] } });
    expect(violations.map((v) => v.message.slice(0, v.message.indexOf(' must')))).toEqual([
      'Field "access.allow": the left side "root/api" of "root/api -> src/root/log"',
      'Field "access.allow": the left side "src/api" of "src/api -> src/root/log"',
      'Field "access.allow": the right side "src/rootx" of "src/root/api -> src/rootx"',
    ]);
    expect(violations[0]!.message).toContain('must start with the root path "src/root" or with "**"');
  });

  it('leaves the key out of the resolved config when the file has none', () => {
    expect('access' in validateConfig({ root: 'root' }).config!).toBe(false);
  });

  it('keeps the hash of a config without access', () => {
    // The hash of the default config as slopbuckets 1.0.0 computed it. Existing locks store this value.
    expect(configHash(validateConfig({}).config!)).toBe('sha256:1e52c01b7e7348f85ebf85ecd87641bd6907f46ef1dc377ff8795d6f06f63c28');
  });

  it('changes the hash when access changes, but not when only the spelling of a line does', () => {
    const base = configHash(validateConfig({}).config!);
    const a = configHash(validateConfig({ access: { default: 'deny', allow: ['root/a -> root/b'] } }).config!);
    const b = configHash(validateConfig({ access: { default: 'deny', allow: ['root/a->root/b'] } }).config!);
    const c = configHash(validateConfig({ access: { default: 'deny', allow: ['root/a -> root/c'] } }).config!);
    expect(a).not.toBe(base);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
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
