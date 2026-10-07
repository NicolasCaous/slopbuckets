// Access lines of buckets.config.json ("A -> B") and the globs on each side. A glob matches bucket paths as the
// lock lists them, such as `root/billing`. Hand written so the CLI has no runtime dependency.

/** The `access` key of the resolved config. Lines are in canonical form, `A -> B`. */
export interface AccessConfig {
  default: 'allow' | 'deny';
  allow: string[];
  deny: string[];
}

/** One side of an access line. */
export interface AccessPattern {
  /** The pattern as written, without the spaces around it. */
  text: string;
  /** True when the pattern has no `*` and no `{`, so it names exactly one bucket. */
  literal: boolean;
  /** One entry per `/` segment: `**`, or a regular expression for the whole segment. */
  segments: Array<'**' | RegExp>;
}

/** A parsed access line: code in a bucket that `from` matches uses code that originates in a bucket that `to` matches. */
export interface AccessLine {
  /** Canonical form, `A -> B` with one space on each side of the arrow. */
  text: string;
  from: AccessPattern;
  to: AccessPattern;
}

/** Parses `A -> B`. Returns the reason when the line is malformed. */
export function parseAccessLine(text: string): { line: AccessLine } | { error: string } {
  const sides = text.split('->');
  if (sides.length !== 2) {
    return { error: `"${text}" must contain exactly one "->", as in "root/api/** -> root/log".` };
  }
  const from = parsePattern(sides[0]!.trim());
  if ('error' in from) return { error: `The left side of "${text}" ${from.error}` };
  const to = parsePattern(sides[1]!.trim());
  if ('error' in to) return { error: `The right side of "${text}" ${to.error}` };
  return { line: { text: `${from.pattern.text} -> ${to.pattern.text}`, from: from.pattern, to: to.pattern } };
}

/**
 * Parses one side of a line. `**` as a whole segment matches zero or more bucket names, `*` matches any characters
 * inside a segment, `{a,b}` matches one of the alternatives, and every other character is literal.
 */
export function parsePattern(text: string): { pattern: AccessPattern } | { error: string } {
  if (text === '') return { error: 'is empty. Write a bucket path such as "root/billing", or "**" for every bucket.' };
  const segments: AccessPattern['segments'] = [];
  for (const segment of text.split('/')) {
    if (segment === '') return { error: `has an empty segment in "${text}". Remove the extra "/".` };
    if (segment === '**') {
      segments.push('**');
      continue;
    }
    const source = segmentSource(segment);
    if (typeof source !== 'string') return source;
    segments.push(new RegExp(`^${source}$`, 'u'));
  }
  return { pattern: { text, literal: !/[*{]/.test(text), segments } };
}

function segmentSource(segment: string): string | { error: string } {
  let source = '';
  let inBraces = false;
  for (const char of segment) {
    if (char === '*') source += '.*';
    else if (char === '{') {
      if (inBraces) return { error: `nests "{" in "${segment}". Alternatives cannot contain other alternatives.` };
      inBraces = true;
      source += '(?:';
    } else if (char === '}') {
      if (!inBraces) return { error: `has a "}" without a "{" in "${segment}".` };
      inBraces = false;
      source += ')';
    } else if (char === ',' && inBraces) source += '|';
    else source += char.replace(/[\\^$.|?+()[\]{}]/g, '\\$&');
  }
  if (inBraces) return { error: `has a "{" without a "}" in "${segment}".` };
  return source;
}

/** True when the pattern matches the bucket path, such as `root/billing/payments`. */
export function matchesBucket(pattern: AccessPattern, bucketPath: string): boolean {
  return matchSegments(pattern.segments, 0, bucketPath.split('/'), 0);
}

function matchSegments(pattern: AccessPattern['segments'], p: number, names: string[], n: number): boolean {
  if (p === pattern.length) return n === names.length;
  const segment = pattern[p]!;
  if (segment === '**') {
    for (let skip = n; skip <= names.length; skip++) {
      if (matchSegments(pattern, p + 1, names, skip)) return true;
    }
    return false;
  }
  return n < names.length && segment.test(names[n]!) && matchSegments(pattern, p + 1, names, n + 1);
}

/** The outcome for one edge. `line` is the canonical access line that decided, absent when `default` decided. */
export interface AccessDecision {
  allowed: boolean;
  by: 'deny' | 'allow' | 'default';
  line?: string;
}

const compiled = new WeakMap<AccessConfig, { allow: AccessLine[]; deny: AccessLine[] }>();

function compile(access: AccessConfig): { allow: AccessLine[]; deny: AccessLine[] } {
  let lines = compiled.get(access);
  if (lines === undefined) {
    const parse = (list: string[]): AccessLine[] =>
      list.map((text) => {
        const result = parseAccessLine(text);
        if ('error' in result) throw new Error(`Invalid access line in a resolved config: ${result.error}`);
        return result.line;
      });
    lines = { allow: parse(access.allow), deny: parse(access.deny) };
    compiled.set(access, lines);
  }
  return lines;
}

/**
 * Decides whether code in the bucket `from` may use code that originates in the bucket `to`. A matching `deny` line
 * always fails the edge. Otherwise `"default": "allow"` passes it, and `"default": "deny"` passes it only when an
 * `allow` line matches. The first matching line of the list decides.
 */
export function evaluateAccess(access: AccessConfig, from: string, to: string): AccessDecision {
  const lines = compile(access);
  const matches = (line: AccessLine): boolean => matchesBucket(line.from, from) && matchesBucket(line.to, to);
  const denied = lines.deny.find(matches);
  if (denied !== undefined) return { allowed: false, by: 'deny', line: denied.text };
  if (access.default === 'allow') return { allowed: true, by: 'default' };
  const allowed = lines.allow.find(matches);
  if (allowed !== undefined) return { allowed: true, by: 'allow', line: allowed.text };
  return { allowed: false, by: 'default' };
}
