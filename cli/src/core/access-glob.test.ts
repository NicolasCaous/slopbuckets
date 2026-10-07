import { describe, expect, it } from 'vitest';
import { compareSpecificity, evaluateAccess, matchesBucket, parseAccessLine, parsePattern, type AccessConfig } from './access-glob.js';

function pattern(text: string) {
  const result = parsePattern(text);
  if ('error' in result) throw new Error(result.error);
  return result.pattern;
}

const matches = (glob: string, bucket: string): boolean => matchesBucket(pattern(glob), bucket);

describe('matchesBucket', () => {
  it('matches a literal path only for that bucket', () => {
    expect(matches('root/billing', 'root/billing')).toBe(true);
    expect(matches('root/billing', 'root/billing/payments')).toBe(false);
    expect(matches('root/billing', 'root')).toBe(false);
    expect(matches('root/billing', 'root/billings')).toBe(false);
  });

  it('matches * inside one segment only', () => {
    expect(matches('root/*', 'root/billing')).toBe(true);
    expect(matches('root/*', 'root')).toBe(false);
    expect(matches('root/*', 'root/billing/payments')).toBe(false);
    expect(matches('root/teams/team-*', 'root/teams/team-a')).toBe(true);
    expect(matches('root/teams/team-*', 'root/teams/team-')).toBe(true);
    expect(matches('root/teams/team-*', 'root/teams/other')).toBe(false);
    expect(matches('root/*-api', 'root/web-api')).toBe(true);
  });

  it('matches ** as zero or more segments', () => {
    expect(matches('**', 'root')).toBe(true);
    expect(matches('**', 'root/a/b')).toBe(true);
    expect(matches('root/billing/**', 'root/billing')).toBe(true);
    expect(matches('root/billing/**', 'root/billing/payments')).toBe(true);
    expect(matches('root/billing/**', 'root/billing/payments/stripe')).toBe(true);
    expect(matches('root/billing/**', 'root/billings')).toBe(false);
    expect(matches('root/billing/**', 'root')).toBe(false);
    expect(matches('root/**/log', 'root/log')).toBe(true);
    expect(matches('root/**/log', 'root/a/b/log')).toBe(true);
    expect(matches('root/**/log', 'root/a/b/log/x')).toBe(false);
    expect(matches('**/log', 'root/log')).toBe(true);
    expect(matches('root/billing/*/**', 'root/billing')).toBe(false);
    expect(matches('root/billing/*/**', 'root/billing/payments/stripe')).toBe(true);
  });

  it('matches one of the {a,b} alternatives', () => {
    expect(matches('root/{api,web}/**', 'root/api')).toBe(true);
    expect(matches('root/{api,web}/**', 'root/web/admin')).toBe(true);
    expect(matches('root/{api,web}/**', 'root/apiweb')).toBe(false);
    expect(matches('root/{api,web}/**', 'root/sql')).toBe(false);
    expect(matches('root/svc-{a,b}', 'root/svc-b')).toBe(true);
    expect(matches('root/{svc,lib}-*', 'root/lib-x')).toBe(true);
  });

  it('treats every other character as literal', () => {
    expect(matches('root/a.b', 'root/a.b')).toBe(true);
    expect(matches('root/a.b', 'root/axb')).toBe(false);
    expect(matches('root/a+(b)', 'root/a+(b)')).toBe(true);
    expect(matches('root/x,y', 'root/x,y')).toBe(true);
    expect(matches('root/a?', 'root/ab')).toBe(false);
  });
});

describe('parsePattern', () => {
  it('flags patterns without wildcards as literal', () => {
    expect(pattern('root/billing').literal).toBe(true);
    expect(pattern('root/billing/**').literal).toBe(false);
    expect(pattern('root/{a,b}').literal).toBe(false);
  });

  it.each(['', 'root//x', '/root', 'root/', 'root/{a', 'root/a}', 'root/{a,{b}}'])('rejects %j', (text) => {
    expect('error' in parsePattern(text)).toBe(true);
  });
});

describe('parseAccessLine', () => {
  it('puts the line in canonical form', () => {
    const result = parseAccessLine('  root/api/**->root/log ');
    expect('line' in result && result.line.text).toBe('root/api/** -> root/log');
    const spaced = parseAccessLine('root/api/**   ->   root/log');
    expect('line' in spaced && spaced.line.text).toBe('root/api/** -> root/log');
  });

  it.each(['root/a', 'root/a -> root/b -> root/c', ' -> root/b', 'root/a -> ', 'root//a -> root/b'])('rejects %j', (text) => {
    expect('error' in parseAccessLine(text)).toBe(true);
  });
});

describe('compareSpecificity', () => {
  const more = (a: string, b: string): void => {
    expect(compareSpecificity(pattern(a), pattern(b)), `${a} beats ${b}`).toBeGreaterThan(0);
    expect(compareSpecificity(pattern(b), pattern(a)), `${b} loses to ${a}`).toBeLessThan(0);
  };

  it('ranks a literal segment over a partial wildcard, over *, over **', () => {
    more('root/log', 'root/**');
    more('root/billing', 'root/billing/**');
    more('root/teams/team-*', 'root/teams/*');
    more('root/{api,web}', 'root/*');
    more('root/api', 'root/{api,web}');
    more('root/*', 'root/**');
    more('root/billing/**', '**');
  });

  it('counts literal segments first, then partial wildcards, then *, then fewer **', () => {
    more('root/a/b/**', 'root/*/*/*');
    more('root/team-*/*', 'root/*/*/*');
    more('root/*/*', 'root/*/**');
  });

  it('finds patterns with the same counts equally specific, wherever the segments sit', () => {
    const same = (a: string, b: string): void => {
      expect(compareSpecificity(pattern(a), pattern(b)), `${a} ties ${b}`).toBe(0);
      expect(compareSpecificity(pattern(b), pattern(a)), `${b} ties ${a}`).toBe(0);
    };
    same('root/a', 'root/b');
    same('root/team-*/**', 'root/{a,b}/**');
    same('root/**/payments', 'root/teams/**');
    same('**/log', 'root/**');
    same('root/billing/*', 'root/*/payments');
  });
});

describe('evaluateAccess', () => {
  const access: AccessConfig = {
    default: 'deny',
    allow: ['** -> root/log', 'root/billing/** -> root/sql/**', 'root/{api,web}/** -> root/billing/*/**'],
    deny: ['root/billing/payments/** -> root/sql/**'],
  };

  it('passes an edge that an allow line matches and names the line', () => {
    expect(evaluateAccess(access, 'root/api', 'root/log')).toEqual({ allowed: true, by: 'allow', line: '** -> root/log' });
    expect(evaluateAccess(access, 'root/billing', 'root/sql/pg')).toEqual({ allowed: true, by: 'allow', line: 'root/billing/** -> root/sql/**' });
    expect(evaluateAccess(access, 'root/web', 'root/billing/invoices')).toEqual({ allowed: true, by: 'allow', line: 'root/{api,web}/** -> root/billing/*/**' });
  });

  it('lets a line more specific on one side and equal on the other win', () => {
    // root/billing/payments/** beats root/billing/** on the left, and both have root/sql/** on the right.
    expect(evaluateAccess(access, 'root/billing/payments', 'root/sql')).toEqual({ allowed: false, by: 'deny', line: 'root/billing/payments/** -> root/sql/**' });
    expect(evaluateAccess(access, 'root/billing/payments', 'root/log')).toEqual({ allowed: true, by: 'allow', line: '** -> root/log' });
  });

  it('lets root/log beat root/** whichever list each line is in', () => {
    const allowLog: AccessConfig = { default: 'deny', allow: ['root/api -> root/log'], deny: ['root/api -> root/**'] };
    expect(evaluateAccess(allowLog, 'root/api', 'root/log')).toEqual({ allowed: true, by: 'allow', line: 'root/api -> root/log' });
    expect(evaluateAccess(allowLog, 'root/api', 'root/sql')).toEqual({ allowed: false, by: 'deny', line: 'root/api -> root/**' });
    const denyLog: AccessConfig = { default: 'deny', allow: ['root/api -> root/**'], deny: ['root/api -> root/log'] };
    expect(evaluateAccess(denyLog, 'root/api', 'root/log')).toEqual({ allowed: false, by: 'deny', line: 'root/api -> root/log' });
    expect(evaluateAccess(denyLog, 'root/api', 'root/sql')).toEqual({ allowed: true, by: 'allow', line: 'root/api -> root/**' });
  });

  it('lets root/billing beat root/billing/**', () => {
    const open: AccessConfig = { default: 'allow', allow: ['root/api -> root/billing'], deny: ['root/api -> root/billing/**'] };
    expect(evaluateAccess(open, 'root/api', 'root/billing')).toEqual({ allowed: true, by: 'allow', line: 'root/api -> root/billing' });
    expect(evaluateAccess(open, 'root/api', 'root/billing/payments')).toEqual({ allowed: false, by: 'deny', line: 'root/api -> root/billing/**' });
  });

  it('lets a partial wildcard beat *', () => {
    const teams: AccessConfig = { default: 'deny', allow: ['root/teams/* -> root/log'], deny: ['root/teams/legacy-* -> root/log'] };
    expect(evaluateAccess(teams, 'root/teams/legacy-a', 'root/log')).toEqual({ allowed: false, by: 'deny', line: 'root/teams/legacy-* -> root/log' });
    expect(evaluateAccess(teams, 'root/teams/payments', 'root/log')).toEqual({ allowed: true, by: 'allow', line: 'root/teams/* -> root/log' });
  });

  it('fails as ambiguous when each line is more specific on a different side', () => {
    const crossed: AccessConfig = { default: 'deny', allow: ['root/api -> root/**'], deny: ['root/** -> root/sql'] };
    expect(evaluateAccess(crossed, 'root/api', 'root/sql')).toEqual({ allowed: false, by: 'ambiguous', allowLine: 'root/api -> root/**', denyLine: 'root/** -> root/sql' });
    expect(evaluateAccess(crossed, 'root/api', 'root/log')).toEqual({ allowed: true, by: 'allow', line: 'root/api -> root/**' });
    expect(evaluateAccess(crossed, 'root/web', 'root/sql')).toEqual({ allowed: false, by: 'deny', line: 'root/** -> root/sql' });
  });

  it('fails as ambiguous when root/**/payments and root/teams/** tie', () => {
    const tied: AccessConfig = { default: 'deny', allow: ['root/api -> root/**/payments'], deny: ['root/api -> root/teams/**'] };
    expect(evaluateAccess(tied, 'root/api', 'root/teams/payments')).toEqual({ allowed: false, by: 'ambiguous', allowLine: 'root/api -> root/**/payments', denyLine: 'root/api -> root/teams/**' });
    expect(evaluateAccess(tied, 'root/api', 'root/billing/payments')).toEqual({ allowed: true, by: 'allow', line: 'root/api -> root/**/payments' });
    expect(evaluateAccess(tied, 'root/api', 'root/teams/search')).toEqual({ allowed: false, by: 'deny', line: 'root/api -> root/teams/**' });
  });

  it('fails as ambiguous when **/log and root/** tie', () => {
    const tied: AccessConfig = { default: 'allow', allow: ['**/log -> root/sql'], deny: ['root/** -> root/sql'] };
    expect(evaluateAccess(tied, 'root/log', 'root/sql')).toEqual({ allowed: false, by: 'ambiguous', allowLine: '**/log -> root/sql', denyLine: 'root/** -> root/sql' });
    expect(evaluateAccess(tied, 'root/api', 'root/sql')).toEqual({ allowed: false, by: 'deny', line: 'root/** -> root/sql' });
  });

  it('fails as ambiguous when lines of both lists are equally specific', () => {
    const same: AccessConfig = { default: 'allow', allow: ['root/*-api -> root/sql'], deny: ['root/team-* -> root/sql'] };
    expect(evaluateAccess(same, 'root/team-api', 'root/sql')).toEqual({ allowed: false, by: 'ambiguous', allowLine: 'root/*-api -> root/sql', denyLine: 'root/team-* -> root/sql' });
    expect(evaluateAccess(same, 'root/team-web', 'root/sql')).toEqual({ allowed: false, by: 'deny', line: 'root/team-* -> root/sql' });
  });

  it('lets default decide when no line matches', () => {
    expect(evaluateAccess(access, 'root/api', 'root/billing')).toEqual({ allowed: false, by: 'default' });
    expect(evaluateAccess(access, 'root/sql', 'root/billing/invoices')).toEqual({ allowed: false, by: 'default' });
    const open: AccessConfig = { default: 'allow', allow: [], deny: ['root/web/** -> root/sql/**'] };
    expect(evaluateAccess(open, 'root/api', 'root/sql')).toEqual({ allowed: true, by: 'default' });
    expect(evaluateAccess(open, 'root/web/admin', 'root/sql/pg')).toEqual({ allowed: false, by: 'deny', line: 'root/web/** -> root/sql/**' });
  });

  it('opens an exception inside a deny line under "default": "allow"', () => {
    const open: AccessConfig = { default: 'allow', allow: ['root/web/admin -> root/sql'], deny: ['root/web/** -> root/sql/**'] };
    expect(evaluateAccess(open, 'root/web/admin', 'root/sql')).toEqual({ allowed: true, by: 'allow', line: 'root/web/admin -> root/sql' });
    expect(evaluateAccess(open, 'root/web/admin', 'root/sql/pg')).toEqual({ allowed: false, by: 'deny', line: 'root/web/** -> root/sql/**' });
  });

  it('names the most specific matching line, and the first one when several are left', () => {
    const lines: AccessConfig = { default: 'deny', allow: ['** -> **', 'root/a -> root/b', 'root/* -> root/b', 'root/a -> root/*'], deny: [] };
    expect(evaluateAccess(lines, 'root/a', 'root/b')).toEqual({ allowed: true, by: 'allow', line: 'root/a -> root/b' });
    expect(evaluateAccess(lines, 'root/c', 'root/b')).toEqual({ allowed: true, by: 'allow', line: 'root/* -> root/b' });
    expect(evaluateAccess(lines, 'root/x/y', 'root/z')).toEqual({ allowed: true, by: 'allow', line: '** -> **' });
    const crossed: AccessConfig = { default: 'deny', allow: ['root/* -> root/**', 'root/** -> root/*'], deny: [] };
    expect(evaluateAccess(crossed, 'root/a', 'root/b')).toEqual({ allowed: true, by: 'allow', line: 'root/* -> root/**' });
  });
});
