import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../testing/fixture.js';
import { checkProject } from '../testing/harness.js';
import { configHash, DEFAULT_CONFIG, loadConfig, rootCaseOnDisk, validateConfig } from './config.js';

afterEach(cleanupProjects);

describe('validateConfig', () => {
  it('fills in the defaults', () => {
    expect(validateConfig({}).config).toEqual(DEFAULT_CONFIG);
    expect(validateConfig({ $schema: 'x', root: 'src/root' }).config).toEqual({ ...DEFAULT_CONFIG, root: 'src/root' });
  });

  it.each([
    ['unknown field', { foo: 1 }],
    ['adapter outside the enum', { adapter: 'py' }],
    ['empty root', { root: '' }],
    ['absolute root', { root: '/abs' }],
    ['root leaving the project', { root: '../x' }],
    ['root naming the project', { root: '.' }],
    ['empty alias', { alias: '' }],
    ['maxDepth', { maxDepth: 2 }],
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
    ['access line with | between alternatives', { access: { default: 'deny', allow: ['root/{a|b} -> root/c'] } }],
    ['layout not an object', { layout: ['root/*'] }],
    ['layout without default', { layout: { allow: ['root/*'] } }],
    ['layout default outside the enum', { layout: { default: 'maybe' } }],
    ['unknown field in layout', { layout: { default: 'deny', only: [] } }],
    ['layout allow not an array', { layout: { default: 'deny', allow: 'root/*' } }],
    ['layout line not a string', { layout: { default: 'deny', allow: [1] } }],
    ['layout line with an arrow', { layout: { default: 'deny', allow: ['root/a -> root/b'] } }],
    ['layout line with an unclosed brace', { layout: { default: 'deny', deny: ['root/{a,b'] } }],
    ['layout line with | between alternatives', { layout: { default: 'deny', allow: ['root/{a|b}'] } }],
    ['layout line with * inside <...>', { layout: { default: 'deny', allow: ['root/<a,*>'] } }],
    ['access line with an unclosed <', { access: { default: 'deny', allow: ['root/<a,b -> root/c'] } }],
    ['layout line outside the root path', { layout: { default: 'deny', allow: ['src/*'] } }],
    ['layout line listed twice', { layout: { default: 'deny', allow: ['root/*', ' root/* '] } }],
    ['layout line in both allow and deny', { layout: { default: 'deny', allow: ['root/a'], deny: ['root/a'] } }],
    ['scripts not an object', { scripts: ['tools/repos.js'] }],
    ['script name with a space', { scripts: { 're pos': 'tools/repos.js' } }],
    ['script name starting with a digit', { scripts: { '1repos': 'tools/repos.js' } }],
    ['script path not a string', { scripts: { repos: 1 } }],
    ['empty script path', { scripts: { repos: ' ' } }],
    ['absolute script path', { scripts: { repos: '/tools/repos.js' } }],
    ['script path with a drive letter', { scripts: { repos: 'C:\\tools\\repos.js' } }],
    ['line naming an unknown script', { scripts: { repos: 'tools/repos.js' }, layout: { default: 'deny', allow: ['root/`nope`'] } }],
    ['access line naming a script without "scripts"', { access: { default: 'deny', allow: ['root/`repos` -> root/log'] } }],
    ['line mixing a script name with text in a value', { scripts: { repos: 'r.js' }, layout: { default: 'deny', allow: ['root/{a`repos`}'] } }],
  ])('rejects %s', (_name, raw) => {
    const result = validateConfig(raw);
    expect(result.config).toBeUndefined();
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations.every((v) => v.rule === 'config-invalid' && v.file === 'buckets.config.json')).toBe(true);
  });
});

describe('root', () => {
  it.each(['my{app}', 'src/<app>', 'a*b', 'a`b', 'a,b', 'a|b', 'src/x}'])('rejects %j, which no layout or access line could name', (root) => {
    const { config, violations } = validateConfig({ root });
    expect(config).toBeUndefined();
    expect(violations.map((v) => v.message)).toEqual([
      expect.stringMatching(/^Field "root" is ".*", which holds ".". Every layout and access line starts with the root path, and a line reads the characters \{ \} < > \* ` , \| as glob syntax, so no line could name this folder\. Rename the folder without them and set "root" to the new name\.$/),
    ]);
  });

  it('accepts other characters', () => {
    expect(validateConfig({ root: 'src/my-app.v2 (old)+x' }).violations).toEqual([]);
  });
});

describe('equivalent spellings', () => {
  const layout = (lists: Record<string, unknown>, extra: Record<string, unknown> = {}) => validateConfig({ ...extra, layout: { default: 'deny', ...lists } });

  it('stores the lines in canonical form', () => {
    expect(layout({ allow: ['root/{b,a}', 'root/{`s`}/<d,c>'] }, { scripts: { s: 's.js' } }).config?.layout?.allow).toEqual(['root/`s`/<c,d>', 'root/{a,b}']);
  });

  it('finds a line in both lists however its group values are ordered', () => {
    expect(layout({ allow: ['root/{a,b}'], deny: ['root/{b,a}'] }).violations.map((v) => v.message)).toEqual([
      'Fields "layout.allow" and "layout.deny" both list "root/{a,b}". Remove it from one of them. buckets.config.json belongs to a human, so an AI agent does not fix this, but stops and shows this error to the human.',
    ]);
  });

  it('finds a bare script name and the same name in braces in both lists', () => {
    expect(layout({ allow: ['root/`s`'], deny: ['root/{`s`}'] }, { scripts: { s: 's.js' } }).violations.map((v) => v.message)).toEqual([
      'Fields "layout.allow" and "layout.deny" both list "root/`s`". Remove it from one of them. buckets.config.json belongs to a human, so an AI agent does not fix this, but stops and shows this error to the human.',
    ]);
  });

  it('finds a line listed twice in one list under two spellings, in access too', () => {
    expect(layout({ allow: ['root/{x,y}/*', 'root/{y,x}/*'] }).violations.map((v) => v.message)).toEqual(['Field "layout.allow" lists "root/{x,y}/*" twice. Remove one of them. buckets.config.json belongs to a human, so an AI agent does not fix this, but stops and shows this error to the human.']);
    const access = validateConfig({ access: { default: 'deny', allow: ['root/{a,b} -> root/log', 'root/{b,a}->root/log'] } });
    expect(access.violations.map((v) => v.message)).toEqual(['Field "access.allow" lists "root/{a,b} -> root/log" twice. Remove one of them. buckets.config.json belongs to a human, so an AI agent does not fix this, but stops and shows this error to the human.']);
  });

  it.each([
    ['root/{}', 'has the empty group "{}"'],
    ['root/{A,,B}', 'has an empty value in "{A,,B}"'],
    ['root/<A,A>', 'lists "A" twice in one group of "<A,A>"'],
    ['root/x{{B,A,B}}', 'lists "B" twice in one group of "x{{B,A,B}}"'],
  ])('rejects %j', (line, problem) => {
    const { config, violations } = layout({ allow: [line] });
    expect(config).toBeUndefined();
    expect(violations.map((v) => v.message)).toEqual([expect.stringContaining(`"${line}" ${problem}`)]);
  });
});

describe('access', () => {
  it('stores each line in canonical form, sorted, and fills in the missing list', () => {
    const { config } = validateConfig({ access: { default: 'deny', allow: ['root/api/**->root/log', '  ** ->   root/sql '] } });
    expect(config?.access).toEqual({ default: 'deny', allow: ['** -> root/sql', 'root/api/** -> root/log'], deny: [] });
    expect(validateConfig({ access: { default: 'allow', deny: ['root/a -> root/b'] } }).config?.access).toEqual({ default: 'allow', allow: [], deny: ['root/a -> root/b'] });
  });

  it('names the line that is in both allow and deny', () => {
    const { violations } = validateConfig({ access: { default: 'deny', allow: ['root/a->root/b'], deny: ['root/a -> root/b'] } });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain('"root/a -> root/b"');
    expect(violations[0]!.message).toContain('Remove it from one of them');
  });

  it('tells an agent to stop and show every access error to the human', () => {
    const { violations } = validateConfig({
      access: { default: 'maybe', extra: 1, allow: ['root/a', 'root/a -> root/b', 'root/a->root/b', 7], deny: 'root/a -> root/b' },
    });
    expect(violations.length).toBeGreaterThanOrEqual(5);
    for (const v of violations) expect(v.message).toMatch(/^(?:Field|Unknown field) "access[^"]*".*\. buckets\.config\.json belongs to a human, so an AI agent does not fix this, but stops and shows this error to the human\.$/);
    expect(validateConfig({ access: 'all' }).violations[0]!.message).toContain('an AI agent does not fix this');
    expect(validateConfig({ access: { default: 'deny', allow: ['root/a -> root/{b'] } }).violations[0]!.message).toMatch(/^Field "access\.allow" has a line that is not valid\. The right side of "root\/a -> root\/\{b" has a "\{" without a "\}"/);
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
      'Field "access.allow" has a line that is not valid. The left side "rootx/billing" of "rootx/billing -> root/log" must start with the root path "root" or with "**", because every bucket path starts with "root", such as "root/billing". If the root folder moved, write the new root path at the start of the line. buckets.config.json belongs to a human, so an AI agent does not fix this, but stops and shows this error to the human.',
      expect.stringContaining('The right side "log" of "root/api -> log" must start with the root path "root"'),
      expect.stringContaining('The left side "*" of "* -> root/sql"'),
    ]);
    expect(violations.every((v) => v.rule === 'config-invalid' && v.file === 'buckets.config.json')).toBe(true);
  });

  it('rejects lines that keep the old root path after the root moved', () => {
    const { violations } = validateConfig({ root: 'src/root', access: { default: 'deny', allow: ['root/api -> src/root/log', 'src/api -> src/root/log', 'src/root/api -> src/rootx'] } });
    expect(violations.map((v) => v.message.slice(0, v.message.indexOf(' must')))).toEqual([
      'Field "access.allow" has a line that is not valid. The left side "root/api" of "root/api -> src/root/log"',
      'Field "access.allow" has a line that is not valid. The left side "src/api" of "src/api -> src/root/log"',
      'Field "access.allow" has a line that is not valid. The right side "src/rootx" of "src/root/api -> src/rootx"',
    ]);
    expect(violations[0]!.message).toContain('must start with the root path "src/root" or with "**"');
  });

  it('leaves the key out of the resolved config when the file has none', () => {
    expect('access' in validateConfig({ root: 'root' }).config!).toBe(false);
  });

  it('keeps the hash of a config without access or layout', () => {
    // The hash of the default config since maxDepth was removed. Locks of earlier versions store another value.
    expect(configHash(validateConfig({}).config!)).toBe('sha256:2ebdbde24ef44adf88e49a7ecf3538a289b8b738b0335487d588fd311fffc4f8');
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

  it('sorts the access lines, so their order in the file changes neither the resolved config nor the hash', () => {
    const lines = ['root/b -> root/c', 'root/a -> root/c', '** -> root/log'];
    const a = validateConfig({ access: { default: 'deny', allow: lines, deny: ['root/z -> root/c', 'root/y -> root/c'] } }).config!;
    const b = validateConfig({ access: { default: 'deny', allow: [...lines].reverse(), deny: ['root/y -> root/c', 'root/z -> root/c'] } }).config!;
    expect(a.access).toEqual({ default: 'deny', allow: ['** -> root/log', 'root/a -> root/c', 'root/b -> root/c'], deny: ['root/y -> root/c', 'root/z -> root/c'] });
    expect(b.access).toEqual(a.access);
    expect(configHash(b)).toBe(configHash(a));
  });
});

describe('maxDepth', () => {
  it('is config-invalid and gives the layout line that allows the same buckets', () => {
    const { config, violations } = validateConfig({ root: 'src/buckets', maxDepth: 3 });
    expect(config).toBeUndefined();
    expect(violations.map((v) => v.message)).toEqual([
      'Field "maxDepth" was removed, and "layout" replaces it. Replace "maxDepth" with "layout": {"default": "deny", "allow": ["src/buckets/*/*/*"]}. It allows the same bucket folders as "maxDepth": 3. To allow any bucket folder, remove "maxDepth" and leave "layout" out. buckets.config.json belongs to a human, so an AI agent does not fix this, but stops and shows this error to the human.',
    ]);
  });

  it('falls back to the old default of 2 when the value was not valid', () => {
    expect(validateConfig({ maxDepth: 'two' }).violations[0]!.message).toContain('"allow": ["root/*/*"]}. It allows bucket folders down to depth 2, the old default');
  });

  it('says to remove maxDepth when the config already has layout', () => {
    expect(validateConfig({ maxDepth: 3, layout: { default: 'deny', allow: ['root/*'] } }).violations.map((v) => v.message)).toEqual([
      'Field "maxDepth" was removed, and "layout" replaces it. This config already has "layout", so remove "maxDepth". buckets.config.json belongs to a human, so an AI agent does not fix this, but stops and shows this error to the human.',
    ]);
  });
});

describe('layout', () => {
  it('stores each line trimmed, sorted, and fills in the missing list', () => {
    const { config } = validateConfig({ layout: { default: 'deny', allow: [' root/*/* ', 'root/gpu/*'] } });
    expect(config?.layout).toEqual({ default: 'deny', allow: ['root/*/*', 'root/gpu/*'], deny: [] });
    expect(validateConfig({ layout: { default: 'allow', deny: ['root/legacy/**'] } }).config?.layout).toEqual({ default: 'allow', allow: [], deny: ['root/legacy/**'] });
  });

  it('accepts lines that start with the root path or with **', () => {
    expect(validateConfig({ root: 'src/root', layout: { default: 'deny', allow: ['src/root/*', '**/gpu', 'src/root/{a,b}+{c,d}'] } }).violations).toEqual([]);
  });

  it('tells an agent to stop and show every layout error to the human', () => {
    const { violations } = validateConfig({ layout: { default: 'maybe', extra: 1, allow: ['rootx/a', 'root/a -> root/b', 'root/{a|b}', 7], deny: 'root/a' } });
    expect(violations.length).toBeGreaterThanOrEqual(6);
    for (const v of violations) expect(v.message).toMatch(/^(?:Field|Unknown field) "layout[^"]*".*\. buckets\.config\.json belongs to a human, so an AI agent does not fix this, but stops and shows this error to the human\.$/);
    expect(violations.map((v) => v.message)).toContain(
      'Field "layout.allow" has a line that is not valid. The line "rootx/a" must start with the root path "root" or with "**", because every bucket path starts with "root", such as "root/billing". If the root folder moved, write the new root path at the start of the line. buckets.config.json belongs to a human, so an AI agent does not fix this, but stops and shows this error to the human.',
    );
    expect(violations.map((v) => v.message)).toContainEqual(expect.stringContaining('"root/{a|b}" has a "|" in "{a|b}". Separate alternatives with a comma, as in "{A,B,C}".'));
  });

  it('leaves the key out of the resolved config when the file has none', () => {
    expect('layout' in validateConfig({ root: 'root' }).config!).toBe(false);
  });

  it('changes the hash when layout changes, but not when only the order of the lines does', () => {
    const a = configHash(validateConfig({ layout: { default: 'deny', allow: ['root/*/*', 'root/gpu/*'] } }).config!);
    const b = configHash(validateConfig({ layout: { default: 'deny', allow: ['root/gpu/*', 'root/*/*'] } }).config!);
    const c = configHash(validateConfig({ layout: { default: 'deny', allow: ['root/*/*'] } }).config!);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('scripts', () => {
  it('stores each script path with "/" separators and accepts lines that name the scripts', () => {
    const { config, violations } = validateConfig({
      scripts: { repos: 'tools\\repos.js', _teams: './tools/teams.mjs' },
      layout: { default: 'deny', allow: ['root/{A,`repos`}', 'root/`_teams`/*'] },
      access: { default: 'deny', allow: ['root/`repos` -> root/<`_teams`>'] },
    });
    expect(violations).toEqual([]);
    expect(config?.scripts).toEqual({ repos: 'tools/repos.js', _teams: 'tools/teams.mjs' });
    expect(config?.layout?.allow).toEqual(['root/`_teams`/*', 'root/{A,`repos`}']);
    expect(config?.access?.allow).toEqual(['root/`repos` -> root/<`_teams`>']);
  });

  it('says which script a line names that "scripts" does not list', () => {
    const { violations } = validateConfig({ scripts: { repos: 'tools/repos.js' }, layout: { default: 'deny', allow: ['root/`repo`'] } });
    expect(violations.map((v) => v.message)).toEqual([
      'Field "layout.allow" has a line that is not valid. "root/`repo`" uses the script "repo", which "scripts" does not list. Add it to "scripts" or fix the name. buckets.config.json belongs to a human, so an AI agent does not fix this, but stops and shows this error to the human.',
    ]);
  });

  it('does not report the names a second time when "scripts" itself is broken', () => {
    const { violations } = validateConfig({ scripts: 'tools/repos.js', layout: { default: 'deny', allow: ['root/`repos`'] } });
    expect(violations.map((v) => v.message)).toEqual([expect.stringContaining('Field "scripts" must be an object')]);
  });

  it('leaves the key out of the resolved config when the file has none', () => {
    expect('scripts' in validateConfig({ root: 'root' }).config!).toBe(false);
  });

  it.each(['__proto__', 'constructor', 'prototype'])('rejects the script name %j', (name) => {
    const raw = JSON.parse(`{"scripts": {"${name}": "tools/a.js"}, "layout": {"default": "deny", "allow": ["root/\`${name}\`"]}}`);
    expect(validateConfig(raw).violations.map((v) => v.message)).toEqual([
      `Field "scripts" has the script name "${name}", which JavaScript reserves on every object. Pick another name, such as "repos". buckets.config.json belongs to a human, so an AI agent does not fix this, but stops and shows this error to the human.`,
    ]);
  });

  it('reports a script named __proto__ as config-invalid instead of crashing the check', async () => {
    const config = '{"root": "root", "scripts": {"__proto__": "tools/a.js"}, "layout": {"default": "deny", "allow": ["root/`__proto__`"]}}';
    const dir = makeProject({ 'buckets.config.json': config, 'tools/a.js': 'console.log("billing")\n', 'root/_/a.ts': '' });
    const { report } = await checkProject(dir);
    expect(report.exitCode).toBe(1);
    expect(report.violations.map((v) => `${v.rule} ${v.message.slice(0, 50)}`)).toEqual(['config-invalid Field "scripts" has the script name "__proto__", w']);
  });

  it('reports the problems of every script entry at once', () => {
    const config = JSON.stringify({ root: 'root', scripts: { 'bad name': 'a.js', abs: '/x/a.js', gone: 'tools/gone.js', here: 'tools/here.js', missing: 'tools/missing.js' } });
    const result = loadConfig(makeProject({ 'buckets.config.json': config, 'tools/here.js': '' }, false));
    expect(result.kind === 'invalid' && result.violations.map((v) => v.message.slice(0, 40))).toEqual([
      'Field "scripts" has the script name "bad',
      'Field "scripts.abs" is the absolute path',
      'Field "scripts.gone" names the file tool',
      'Field "scripts.missing" names the file t',
    ]);
  });

  it('is config-invalid when a script file does not exist, and accepts one that does', () => {
    const config = JSON.stringify({ root: 'root', scripts: { repos: 'tools/repos.js' } });
    const missing = loadConfig(makeProject({ 'buckets.config.json': config, 'root/_/a.ts': '' }, false));
    expect(missing.kind === 'invalid' && missing.violations.map((v) => v.message)).toEqual([
      'Field "scripts.repos" names the file tools/repos.js, which does not exist or is not a file. The path is relative to the folder of buckets.config.json. Create the script or fix the path. buckets.config.json belongs to a human, so an AI agent does not fix this, but stops and shows this error to the human.',
    ]);
    const folder = loadConfig(makeProject({ 'buckets.config.json': config, 'tools/repos.js/x': '' }, false));
    expect(folder.kind).toBe('invalid');
    const present = loadConfig(makeProject({ 'buckets.config.json': config, 'tools/repos.js': '' }, false));
    expect(present.kind).toBe('ok');
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
    const b = loadConfig(makeProject({ 'buckets.config.json': '{\n  "root": "root",\n  "adapter": "ts"\n}\n' }, false));
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('expected valid configs');
    expect(configHash(a.config)).toBe(configHash(b.config));
    expect(configHash({ ...a.config, alias: '@other' })).not.toBe(configHash(a.config));
  });
});

describe('check with a bad config', () => {
  it('exits 3 with no-config when the config is missing', async () => {
    const { report } = await checkProject(makeProject({}, false));
    expect(report.exitCode).toBe(3);
    expect(report.environment?.code).toBe('no-config');
  });

  it('exits 1 with config-invalid and does not call the adapter', async () => {
    const dir = makeProject({ 'buckets.config.json': '{"alias": 2}', 'root/_/a.ts': '' });
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
