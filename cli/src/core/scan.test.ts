import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../testing/fixture.js';
import { DEFAULT_CONFIG } from './config.js';
import { scanProject, withoutEmittedFiles } from './scan.js';

afterEach(cleanupProjects);

const options = { extensions: ['.ts', '.tsx'], dmzExtension: '.ts' };

function scan(files: Record<string, string>, maxDepth = 2) {
  return scanProject(makeProject(files), { ...DEFAULT_CONFIG, maxDepth }, options);
}

function pairs(files: Record<string, string>, maxDepth = 2): string[] {
  return scan(files, maxDepth).violations.map((v) => `${v.rule} ${v.file}`).sort();
}

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

  it('reports buckets deeper than maxDepth and does not descend', () => {
    const files = {
      'root/_/a.ts': '',
      'root/dmz/a/.self.ts': '',
      'root/a/_/a.ts': '',
      'root/a/dmz/b/.self.ts': '',
      'root/a/b/_/a.ts': '',
      'root/a/b/c/_/a.ts': '',
    };
    expect(pairs(files, 2)).toEqual(['folder-max-depth root/a/b/c']);
    expect(pairs(files, 3)).toEqual([]);
    // The too-deep folder still counts as a child for the DMZ rules, so root/a/dmz/b/.self.ts gives no extra error.
    expect(pairs(files, 1)).toEqual(['folder-max-depth root/a/b']);
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
