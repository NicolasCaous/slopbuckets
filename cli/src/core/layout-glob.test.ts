import { describe, expect, it } from 'vitest';
import { matchesBelow, parsePattern } from './bucket-glob.js';
import { evaluateLayout, parseLayoutLine, type LayoutConfig } from './layout-glob.js';

function below(glob: string, bucket: string): boolean {
  const result = parsePattern(glob);
  if ('error' in result) throw new Error(result.error);
  return matchesBelow(result.pattern, bucket);
}

describe('matchesBelow', () => {
  it('is true when the pattern has segments left after the bucket', () => {
    expect(below('root/*/*', 'root')).toBe(true);
    expect(below('root/*/*', 'root/a')).toBe(true);
    expect(below('root/*/*', 'root/a/b')).toBe(false);
    expect(below('root/gpu/*', 'root/gpu')).toBe(true);
    expect(below('root/gpu/*', 'root/cpu')).toBe(false);
    expect(below('root/gpu', 'root/gpu')).toBe(false);
  });

  it('is true once the pattern reaches a **', () => {
    expect(below('root/**', 'root')).toBe(true);
    expect(below('root/**', 'root/a/b/c')).toBe(true);
    expect(below('**', 'root')).toBe(true);
    expect(below('root/a/**/x', 'root/a/b/c')).toBe(true);
    expect(below('root/a/**/x', 'root/b')).toBe(false);
  });
});

describe('parseLayoutLine', () => {
  it('trims the line', () => {
    const result = parseLayoutLine('  root/*/* ');
    expect('line' in result && result.line.text).toBe('root/*/*');
  });

  it.each(['', 'root//a', 'root/{a', 'root/a -> root/b', 'root/{a|b}'])('rejects %j', (text) => {
    expect('error' in parseLayoutLine(text)).toBe(true);
  });
});

describe('evaluateLayout', () => {
  it('lets the ancestors of an allowed bucket exist', () => {
    const layout: LayoutConfig = { default: 'deny', allow: ['root/*/*'], deny: [] };
    expect(evaluateLayout(layout, 'root')).toEqual({ allowed: true, by: 'below', line: 'root/*/*' });
    expect(evaluateLayout(layout, 'root/a')).toEqual({ allowed: true, by: 'below', line: 'root/*/*' });
    expect(evaluateLayout(layout, 'root/a/b')).toEqual({ allowed: true, by: 'allow', line: 'root/*/*' });
    expect(evaluateLayout(layout, 'root/a/b/c')).toEqual({ allowed: false, by: 'default' });
  });

  it('lets root/gpu exist under root/gpu/*, and no other child of root', () => {
    const layout: LayoutConfig = { default: 'deny', allow: ['root/gpu/*'], deny: [] };
    expect(evaluateLayout(layout, 'root').allowed).toBe(true);
    expect(evaluateLayout(layout, 'root/gpu').allowed).toBe(true);
    expect(evaluateLayout(layout, 'root/gpu/cuda')).toEqual({ allowed: true, by: 'allow', line: 'root/gpu/*' });
    expect(evaluateLayout(layout, 'root/cpu')).toEqual({ allowed: false, by: 'default' });
    expect(evaluateLayout(layout, 'root/gpu/cuda/x')).toEqual({ allowed: false, by: 'default' });
  });

  it('does not let an ancestor through when a deny line matches it', () => {
    const layout: LayoutConfig = { default: 'deny', allow: ['root/gpu/*', 'root/*/*'], deny: ['root/legacy/**'] };
    expect(evaluateLayout(layout, 'root/legacy')).toEqual({ allowed: false, by: 'deny', line: 'root/legacy/**' });
    expect(evaluateLayout(layout, 'root/legacy/a')).toEqual({ allowed: false, by: 'deny', line: 'root/legacy/**' });
    expect(evaluateLayout(layout, 'root/api/a')).toEqual({ allowed: true, by: 'allow', line: 'root/*/*' });
    expect(evaluateLayout(layout, 'root/gpu/a')).toEqual({ allowed: true, by: 'allow', line: 'root/gpu/*' });
    const exact: LayoutConfig = { default: 'deny', allow: ['root/old/keep'], deny: ['root/old'] };
    expect(evaluateLayout(exact, 'root/old')).toEqual({ allowed: false, by: 'deny', line: 'root/old' });
  });

  it('lets a more specific line win, whichever list it is in', () => {
    const open: LayoutConfig = { default: 'allow', allow: ['root/legacy/keep'], deny: ['root/legacy/**'] };
    expect(evaluateLayout(open, 'root/legacy/keep')).toEqual({ allowed: true, by: 'allow', line: 'root/legacy/keep' });
    expect(evaluateLayout(open, 'root/legacy/drop')).toEqual({ allowed: false, by: 'deny', line: 'root/legacy/**' });
    expect(evaluateLayout(open, 'root/api/x/y/z')).toEqual({ allowed: true, by: 'default' });
  });

  it('fails as ambiguous when an allow line and a deny line are equally specific', () => {
    const tied: LayoutConfig = { default: 'deny', allow: ['root/*-api'], deny: ['root/team-*'] };
    expect(evaluateLayout(tied, 'root/team-api')).toEqual({ allowed: false, by: 'ambiguous', allowLine: 'root/*-api', denyLine: 'root/team-*' });
    expect(evaluateLayout(tied, 'root/web-api')).toEqual({ allowed: true, by: 'allow', line: 'root/*-api' });
  });

  it('denies the root bucket like any other when no line reaches it', () => {
    expect(evaluateLayout({ default: 'deny', allow: [], deny: [] }, 'root')).toEqual({ allowed: false, by: 'default' });
    expect(evaluateLayout({ default: 'allow', allow: [], deny: ['root'] }, 'root')).toEqual({ allowed: false, by: 'deny', line: 'root' });
  });

  it('works with a root path of several segments', () => {
    const layout: LayoutConfig = { default: 'deny', allow: ['src/root/*'], deny: [] };
    expect(evaluateLayout(layout, 'src/root').allowed).toBe(true);
    expect(evaluateLayout(layout, 'src/root/a').allowed).toBe(true);
    expect(evaluateLayout(layout, 'src/root/a/b').allowed).toBe(false);
  });
});
