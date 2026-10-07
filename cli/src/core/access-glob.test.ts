import { describe, expect, it } from 'vitest';
import { evaluateAccess, matchesBucket, parseAccessLine, parsePattern, type AccessConfig } from './access-glob.js';

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

  it('lets a deny line win over a matching allow line', () => {
    expect(evaluateAccess(access, 'root/billing/payments', 'root/sql')).toEqual({ allowed: false, by: 'deny', line: 'root/billing/payments/** -> root/sql/**' });
    expect(evaluateAccess(access, 'root/billing/payments', 'root/log')).toEqual({ allowed: true, by: 'allow', line: '** -> root/log' });
  });

  it('fails an edge that no allow line matches under "default": "deny"', () => {
    expect(evaluateAccess(access, 'root/api', 'root/billing')).toEqual({ allowed: false, by: 'default' });
    expect(evaluateAccess(access, 'root/sql', 'root/billing/invoices')).toEqual({ allowed: false, by: 'default' });
  });

  it('passes every edge that no deny line matches under "default": "allow"', () => {
    const open: AccessConfig = { default: 'allow', allow: [], deny: ['root/web/** -> root/sql/**'] };
    expect(evaluateAccess(open, 'root/api', 'root/sql')).toEqual({ allowed: true, by: 'default' });
    expect(evaluateAccess(open, 'root/web/admin', 'root/sql/pg')).toEqual({ allowed: false, by: 'deny', line: 'root/web/** -> root/sql/**' });
  });

  it('reports the first matching line of the list', () => {
    const twice: AccessConfig = { default: 'deny', allow: ['root/a -> root/b', '** -> **'], deny: [] };
    expect(evaluateAccess(twice, 'root/a', 'root/b').line).toBe('root/a -> root/b');
    expect(evaluateAccess(twice, 'root/c', 'root/b').line).toBe('** -> **');
  });
});
