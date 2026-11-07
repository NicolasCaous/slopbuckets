import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { compileGlob, MAX_ALTERNATIVES, MAX_GLOBSTARS } from './owners.js';

describe('globs', () => {
  // [glob, matching paths, other paths]. The globs with three or more wildcards take the walk instead of a regex.
  const cases: [string, string[], string[]][] = [
    ['src/**', ['src/a.ts', 'src/a/b.ts'], ['srcx/a.ts', 'lib/src/a.ts']],
    ['src/**/*.ts', ['src/a.ts', 'src/a/b/c.ts'], ['src/a.js', 'src/a/b.tsx']],
    ['**/*.test.ts', ['a.test.ts', 'x/y/a.test.ts'], ['a.ts', 'x/test.ts']],
    ['src/*.ts', ['src/a.ts'], ['src/a/b.ts']],
    ['src/**.ts', ['src/a.ts', 'src/a/b.ts'], ['src/a.js']],
    ['src/?.ts', ['src/a.ts'], ['src/ab.ts', 'src//.ts']],
    ['src/{a,b}/**', ['src/a/x.ts', 'src/b/y/z.ts'], ['src/c/x.ts']],
    ['src/[ab]*.ts', ['src/a.ts', 'src/bx.ts'], ['src/c.ts']],
    ['src/[!ab].ts', ['src/c.ts'], ['src/a.ts']],
    ['src/a+b(1).ts', ['src/a+b(1).ts'], ['src/aab1.ts']],
    ['src/{x.ts', ['src/{x.ts'], ['src/x.ts']],
    ['src/**/a/**/*.ts', ['src/a/x.ts', 'src/q/a/r/x.ts'], ['src/q/b/x.ts']],
    ['**/x/**/y/**/*.ts', ['x/y/a.ts', 'p/x/q/y/r/a.ts'], ['x/a.ts', 'y/x/a.ts']],
    ['src/*a*b*c*.ts', ['src/abc.ts', 'src/xaybzc1.ts'], ['src/acb.ts', 'src/a/bc.ts']],
    ['a**b**c**d', ['abcd', 'a/b/c/d', 'axbxcxd'], ['abdc']],
    ['{src,lib}/**/{a,b}*.ts', ['src/a.ts', 'lib/x/b2.ts'], ['src/c.ts', 'app/a.ts']],
    ['src/***', ['src/a/b.ts'], ['lib/a.ts']],
  ];
  it.each(cases)('%s', (glob, yes, no) => {
    const test = compileGlob(glob);
    for (const f of yes) expect(test(f), f).toBe(true);
    for (const f of no) expect(test(f), f).toBe(false);
  });

  // A matcher that backtracks would take minutes on these paths, so the test would time out.
  it('takes linear time on a path that almost matches many wildcards', () => {
    const glob = `${'**a'.repeat(MAX_GLOBSTARS)}Z`;
    const test = compileGlob(glob);
    expect(test(`${'a'.repeat(200)}.ts`)).toBe(false);
    expect(compileGlob(`src/${'*a'.repeat(20)}Z`)(`src/${'a'.repeat(200)}.ts`)).toBe(false);
  });

  it('reports a glob that cannot compile as config-invalid', () => {
    const config = (files: string[], ignore: string[] = []) =>
      JSON.stringify({ version: '2.0', ignore, buckets: { a: { purpose: 'Does a', files, public: null, dependsOn: {}, packages: {} } } });
    const problems = (text: string) => {
      const r = parseConfig(text);
      return 'problems' in r ? r.problems : [];
    };
    expect(problems(config(['src/[z-a].ts']))).toEqual([{ kind: 'invalid', at: ['buckets', 'a', 'files', 0], expected: 'a glob whose [z-a] is a valid character class' }]);
    expect(problems(config(['src/**'], [`${'**/x/'.repeat(MAX_GLOBSTARS + 1)}*.ts`]))).toEqual([{ kind: 'invalid', at: ['ignore', 0], expected: `a glob with at most ${MAX_GLOBSTARS} **` }]);
    expect(problems(config([`src/${'{a,b}'.repeat(7)}.ts`]))).toEqual([{ kind: 'invalid', at: ['buckets', 'a', 'files', 0], expected: `a glob with at most ${MAX_ALTERNATIVES} {a,b} alternatives` }]);
    expect(problems(config(['!src/[!z-a]/**', 'src/**']))).toHaveLength(1);
    expect(problems(config(['src/**/*.{ts,tsx}']))).toEqual([]);
  });
});
