import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../testing/fixture.js';
import { DEFAULT_CONFIG } from './config.js';
import type { LayoutConfig } from './layout-glob.js';
import { scanProject, withoutEmittedFiles } from './scan.js';

afterEach(cleanupProjects);

const options = { extensions: ['.ts', '.tsx'], dmzExtension: '.ts' };

function scan(files: Record<string, string>, layout?: LayoutConfig, root = DEFAULT_CONFIG.root) {
  return scanProject(makeProject(files), { ...DEFAULT_CONFIG, root, ...(layout ? { layout } : {}) }, options);
}

function pairs(files: Record<string, string>, layout?: LayoutConfig, root?: string): string[] {
  return scan(files, layout, root).violations.map((v) => `${v.rule} ${v.file}`).sort();
}

/** The layout `buckets init` writes: buckets down to two levels below the root. */
const TWO_LEVELS: LayoutConfig = { default: 'deny', allow: ['root/*/*'], deny: [] };

describe('folder rules', () => {
  it('accepts the SPEC layout', () => {
    const layout = scan({
      'root/_/main.ts': '',
      'root/dmz/log/billing.ts': '',
      'root/log/_/logger.ts': '',
      'root/billing/_/billing.module.ts': '',
      'root/billing/dmz/.parent/invoices.ts': '',
      'root/billing/invoices/_/a.ts': '',
      'root/billing/payments/_/b.ts': '',
    });
    expect(layout.violations).toEqual([]);
    expect([...layout.buckets.keys()].sort()).toEqual(['root', 'root/billing', 'root/billing/invoices', 'root/billing/payments', 'root/log']);
    expect([...layout.dmzFiles.keys()].sort()).toEqual(['root/billing/dmz/.parent/invoices.ts', 'root/dmz/log/billing.ts']);
  });

  it('collects code files by adapter extension only', () => {
    const layout = scan({ 'root/_/a.ts': '', 'root/_/deep/b.tsx': '', 'root/_/c.json': '', 'root/_/d.css': '' });
    expect(layout.codeFiles).toEqual(['root/_/a.ts', 'root/_/deep/b.tsx']);
  });

  it('matches adapter extensions without case and keeps declaration files', () => {
    const layout = scanProject(
      makeProject({ 'root/_/A.TS': '', 'root/_/b.Tsx': '', 'root/_/types.d.ts': '', 'root/_/c.JS': '', 'root/_/d.mjs': '', 'root/_/e.json': '' }),
      DEFAULT_CONFIG,
      { extensions: ['.ts', '.tsx', '.js', '.mjs'], dmzExtension: '.ts' },
    );
    expect(layout.codeFiles).toEqual(['root/_/A.TS', 'root/_/b.Tsx', 'root/_/c.JS', 'root/_/d.mjs', 'root/_/types.d.ts']);
  });

  it('accepts extensions the adapter lists in upper case', () => {
    const layout = scanProject(makeProject({ 'root/_/a.cjs': '', 'root/_/b.ts': '' }), DEFAULT_CONFIG, { extensions: ['.CJS'], dmzExtension: '.ts' });
    expect(layout.codeFiles).toEqual(['root/_/a.cjs']);
  });

  it('reports a loose file in a bucket folder', () => {
    expect(pairs({ 'root/_/a.ts': '', 'root/notes.md': '' })).toEqual(['folder-loose-file root/notes.md']);
  });

  it('reports a bucket without _/', () => {
    expect(pairs({ 'root/_/a.ts': '', 'root/dmz/log/.self.ts': '', 'root/log/README/x.ts': '' })).toContain('folder-missing-code root/log');
  });

  it('reports a missing root folder', () => {
    expect(pairs({})).toEqual(['folder-missing-code root']);
  });

  it('reports dmz/ in a bucket without children, without also flagging its files', () => {
    expect(pairs({ 'root/_/a.ts': '', 'root/dmz/log/.self.ts': '', 'root/log/_/a.ts': '', 'root/log/dmz/x/y.ts': '' })).toEqual([
      'folder-unexpected-dmz root/log/dmz',
    ]);
  });

  it('reports bucket names starting with a dot', () => {
    expect(pairs({ 'root/_/a.ts': '', 'root/.cache/_/a.ts': '' })).toEqual(['folder-invalid-name root/.cache']);
  });

  it('reports the first bucket the layout forbids and does not descend', () => {
    const files = {
      'root/_/a.ts': '',
      'root/dmz/a/.self.ts': '',
      'root/a/_/a.ts': '',
      'root/a/dmz/b/.self.ts': '',
      'root/a/b/_/a.ts': '',
      'root/a/b/dmz/c/.self.ts': '',
      'root/a/b/c/_/a.ts': '',
      'root/a/b/c/d/_/a.ts': '',
    };
    const layout = scan(files, TWO_LEVELS);
    // root/a/b/c/d fails too, but the scan never enters root/a/b/c.
    expect(layout.violations.map((v) => `${v.rule} ${v.file}`)).toEqual(['layout-denied root/a/b/c']);
    expect([...layout.buckets.keys()]).toEqual(['root', 'root/a', 'root/a/b']);
    expect(pairs(files, { default: 'deny', allow: ['root/*/*/*/*'], deny: [] })).toEqual([]);
    // The forbidden folder still counts as a child for the DMZ rules, so root/a/dmz/b/.self.ts gives no extra error.
    expect(pairs(files, { default: 'deny', allow: ['root/*'], deny: [] })).toEqual(['layout-denied root/a/b']);
  });

  it('lets every bucket folder exist when the config has no layout', () => {
    const files = { 'root/_/a.ts': '', 'root/dmz/a/.self.ts': '', 'root/a/_/a.ts': '', 'root/a/dmz/b/.self.ts': '', 'root/a/b/_/a.ts': '', 'root/a/b/dmz/c/.self.ts': '', 'root/a/b/c/_/a.ts': '' };
    expect(pairs(files)).toEqual([]);
    expect(scan(files).buckets.has('root/a/b/c')).toBe(true);
  });

  it('lets the ancestors of an allowed bucket exist, and nothing beside them', () => {
    const files = {
      'root/_/a.ts': '',
      'root/dmz/gpu/.self.ts': '',
      'root/gpu/_/a.ts': '',
      'root/gpu/dmz/cuda/.self.ts': '',
      'root/gpu/cuda/_/a.ts': '',
      'root/cpu/_/a.ts': '',
    };
    const layout = scan(files, { default: 'deny', allow: ['root/gpu/*'], deny: [] });
    expect(layout.violations.map((v) => `${v.rule} ${v.file}`)).toEqual(['layout-denied root/cpu']);
    expect(layout.violations[0]!.message).toBe(
      'Layout denied: root/cpu/ is a bucket folder, but no line in layout.allow of buckets.config.json matches it or a bucket below it, and layout.default is "deny". buckets.config.json belongs to a human, so an AI agent never edits it. Move this folder into root/_/ if it only organizes code, remove it, or stop and ask the human to change "layout" in buckets.config.json, with the exact line you propose, such as "root/cpu" in layout.allow.',
    );
  });

  it('reports a bucket that a deny line matches and names the line', () => {
    const files = { 'root/_/a.ts': '', 'root/dmz/legacy/.self.ts': '', 'root/legacy/_/a.ts': '', 'root/legacy/dmz/old/.self.ts': '', 'root/legacy/old/_/a.ts': '', 'root/api/_/a.ts': '' };
    const layout = scan(files, { default: 'deny', allow: ['root/*/*'], deny: ['root/legacy/**'] });
    expect(layout.violations.map((v) => `${v.rule} ${v.file}`)).toEqual(['layout-denied root/legacy']);
    expect(layout.violations[0]!.message).toContain('but the line "root/legacy/**" in layout.deny of buckets.config.json is the most specific line that matches it.');
  });

  it('reports layout-ambiguous when an allow line and a deny line tie', () => {
    const files = { 'root/_/a.ts': '', 'root/team-api/_/a.ts': '', 'root/web-api/_/a.ts': '' };
    const layout = scan(files, { default: 'deny', allow: ['root/*-api'], deny: ['root/team-*'] });
    expect(layout.violations.map((v) => `${v.rule} ${v.file}`)).toEqual(['layout-ambiguous root/team-api']);
    expect(layout.violations[0]!.message).toBe(
      'Layout ambiguous: root/team-api/ is a bucket folder, and the allow line "root/*-api" and the deny line "root/team-*" in "layout" of buckets.config.json both match it. Neither is more specific than the other, so the check cannot tell which one decides. A human must add a line to "layout" that is more specific than both. buckets.config.json belongs to a human, so an AI agent never edits it. Move this folder into root/_/ if it only organizes code, remove it, or stop and ask the human to change "layout" in buckets.config.json, with the exact line you propose, such as "root/team-api" in layout.allow.',
    );
  });

  it('reports a root bucket the layout forbids and still scans it', () => {
    const files = { 'root/_/a.ts': '', 'root/dmz/a/.self.ts': '', 'root/a/_/a.ts': '' };
    const layout = scan(files, { default: 'allow', allow: [], deny: ['root'] });
    expect(layout.violations.map((v) => `${v.rule} ${v.file}`)).toEqual(['layout-denied root']);
    expect(layout.violations[0]!.message).toContain('The root bucket always exists, so stop and ask the human to change "layout"');
    expect([...layout.buckets.keys()]).toEqual(['root', 'root/a']);
  });

  describe('the change a layout violation proposes', () => {
    const message = (files: Record<string, string>, layout: LayoutConfig): string => {
      const found = scan(files, layout).violations.filter((v) => v.rule.startsWith('layout-'));
      expect(found).toHaveLength(1);
      return found[0]!.message;
    };
    const legacy = { 'root/_/a.ts': '', 'root/dmz/legacy/.self.ts': '', 'root/legacy/_/a.ts': '' };
    const nested = { ...legacy, 'root/legacy/dmz/old/.self.ts': '', 'root/legacy/old/_/a.ts': '', 'root/legacy/old/deep/_/a.ts': '' };

    it('proposes to remove a deny line that names the folder, and the folder passes without it', () => {
      expect(message(legacy, { default: 'allow', allow: [], deny: ['root/legacy'] })).toContain(
        'Move this folder into root/_/ if it only organizes code, remove it, or stop and ask the human to change "layout" in buckets.config.json: propose to remove the line "root/legacy" from layout.deny.',
      );
      expect(pairs(legacy, { default: 'allow', allow: [], deny: [] })).toEqual([]);
      expect(message(nested, { default: 'deny', allow: ['root/*/*/*'], deny: ['root/legacy/**'] })).toContain('propose to remove the line "root/legacy/**" from layout.deny.');
    });

    it('proposes one line for a folder with folders below it, and that line lets all of them pass', () => {
      expect(message(nested, { default: 'deny', allow: ['root/api'], deny: [] })).toContain(
        'with the exact line you propose, such as "root/legacy/**" in layout.allow, which allows root/legacy/ and every folder below it.',
      );
      expect(pairs(nested, { default: 'deny', allow: ['root/api', 'root/legacy/**'], deny: [] })).toEqual([]);
      expect(message(nested, { default: 'deny', allow: ['root/*'], deny: ['root/l*/**'] })).toContain('such as "root/legacy/**" in layout.allow');
      expect(pairs(nested, { default: 'deny', allow: ['root/*', 'root/legacy/**'], deny: ['root/l*/**'] })).toEqual([]);
    });

    it('proposes the folder alone when it has no folders below it, or when the deny line is as specific as the subtree line', () => {
      expect(message(legacy, { default: 'deny', allow: ['root/api'], deny: [] })).toContain('such as "root/legacy" in layout.allow.');
      const tie = message(nested, { default: 'deny', allow: ['root/*/*/*'], deny: ['root/**/legacy'] });
      expect(tie).toContain('such as "root/legacy" in layout.allow.');
      expect(pairs(nested, { default: 'deny', allow: ['root/*/*/*', 'root/legacy'], deny: ['root/**/legacy'] })).toEqual([]);
    });

    it.each([
      ['x{1}', '{'],
      ['a,b', ','],
      ['tick`s', '`'],
      ['v}2', '}'],
    ])('says that no line can name the folder %j and that it needs another name', (name, char) => {
      const files = { 'root/_/a.ts': '', [`root/${name}/_/a.ts`]: '' };
      expect(message(files, { default: 'deny', allow: ['root/api'], deny: [] })).toContain(
        `No layout line can name this folder literally, because "${name}" holds "${char}", which a line reads as glob syntax. Move this folder into root/_/ if it only organizes code, remove it, or rename it without the characters { } < > * \` , and |.`,
      );
    });
  });

  it('matches the layout against bucket paths under a custom root path', () => {
    const files = { 'src/buckets/_/a.ts': '', 'src/buckets/dmz/a/.self.ts': '', 'src/buckets/a/_/a.ts': '', 'src/buckets/a/dmz/b/.self.ts': '', 'src/buckets/a/b/_/a.ts': '' };
    expect(pairs(files, { default: 'deny', allow: ['src/buckets/*/*'], deny: [] }, 'src/buckets')).toEqual([]);
    expect(pairs(files, { default: 'deny', allow: ['src/buckets/*'], deny: [] }, 'src/buckets')).toEqual(['layout-denied src/buckets/a/b']);
  });

  it('reports invalid DMZ paths with dmz-path and leaves them out of the analysis', () => {
    const layout = scan({
      'root/_/a.ts': '',
      'root/dmz/log/billing.ts': '',
      'root/dmz/nope/billing.ts': '',
      'root/dmz/.parent/log.ts': '',
      'root/dmz/readme.md': '',
      'root/log/_/a.ts': '',
      'root/billing/_/a.ts': '',
    });
    expect(layout.violations.map((v) => `${v.rule} ${v.file}`).sort()).toEqual([
      'dmz-path root/dmz/.parent/log.ts',
      'dmz-path root/dmz/nope/billing.ts',
      'dmz-path root/dmz/readme.md',
    ]);
    expect([...layout.dmzFiles.keys()]).toEqual(['root/dmz/log/billing.ts']);
  });
});

describe('compiler output next to its source', () => {
  it('drops .js, .mjs, .cjs, .jsx, .d.ts and their maps when a TypeScript source of the same name sits beside them', () => {
    expect(
      withoutEmittedFiles([
        'a.ts',
        'a.js',
        'a.js.map',
        'a.d.ts',
        'a.d.ts.map',
        'b.mts',
        'b.mjs',
        'b.d.mts',
        'c.cts',
        'c.cjs',
        'v.tsx',
        'v.jsx',
        'v.js',
        'sub/a.js',
        'lone.js',
        'lone.d.ts',
        'UP.TS',
        'UP.JS',
      ]),
    ).toEqual(['a.ts', 'b.mts', 'c.cts', 'v.tsx', 'sub/a.js', 'lone.js', 'lone.d.ts', 'UP.TS']);
  });

  it('the scan skips emitted files in _/ and in dmz/', () => {
    const layout = scanProject(
      makeProject({
        'root/_/main.ts': 'export {};\n',
        'root/_/main.js': 'export {};\n',
        'root/_/legacy.js': 'export {};\n',
        'root/log/_/logger.ts': 'export {};\n',
        'root/dmz/log/.self.ts': "export { logger } from '@root/log/_/logger';\n",
        'root/dmz/log/.self.js': "export { logger } from '@root/log/_/logger';\n",
        'root/dmz/log/.self.d.ts': 'export {};\n',
      }),
      DEFAULT_CONFIG,
      { extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'], dmzExtension: '.ts' },
    );
    expect(layout.codeFiles).toEqual(['root/_/legacy.js', 'root/_/main.ts', 'root/log/_/logger.ts']);
    expect([...layout.dmzFiles.keys()]).toEqual(['root/dmz/log/.self.ts']);
    expect(layout.violations).toEqual([]);
  });
});
