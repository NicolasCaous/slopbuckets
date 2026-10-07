// Globs over bucket paths, as the lock lists them, such as `root/billing`, and the "most specific line decides" rule
// that the `access` and `layout` keys of buckets.config.json share. Hand written so the CLI has no runtime dependency.

/** A key of the config made of an outcome for what no line matches and two lists of lines: `access` and `layout`. */
export interface LineLists {
  default: 'allow' | 'deny';
  allow: string[];
  deny: string[];
}

/** Matches one bucket name. A regular expression is one. */
export interface NameMatcher {
  test(name: string): boolean;
}

/** A glob over bucket paths. */
export interface BucketPattern {
  /** The pattern as written, without the spaces around it. */
  text: string;
  /** True when the pattern has no `*` and no group of alternatives, so it names exactly one bucket. */
  literal: boolean;
  /** One entry per `/` segment: `**`, or a matcher for the whole segment. */
  segments: Array<'**' | NameMatcher>;
  /**
   * The specificity tuple: the number of literal segments, of segments with `*` or a group mixed with other text (such
   * as `team-*` or `{api,web}`), of segments that are exactly `*`, and minus the number of `**` segments.
   */
  specificity: [number, number, number, number];
}

/** A parsed line of `allow` or `deny`: its canonical text and its patterns, one for `layout`, two for `access`. */
export interface GlobLine {
  text: string;
  patterns: BucketPattern[];
}

/**
 * The kinds of groups of alternatives. Each `{a,b}` matches any of its values. The `<a,b>` groups of one segment match
 * values that differ from each other.
 */
type GroupKind = 'any' | 'distinct';

/** The opener and closer of each kind of group, longest opener first. */
const GROUPS: Array<{ kind: GroupKind; open: string; close: string }> = [
  { kind: 'any', open: '{', close: '}' },
  { kind: 'distinct', open: '<', close: '>' },
];

/** The kinds whose groups constrain each other within a segment. */
const CONSTRAINED: ReadonlySet<GroupKind> = new Set(['distinct']);

/** One piece of a segment: literal text, `*`, or a group of alternatives. */
type Token = { kind: 'text'; text: string } | { kind: 'star' } | { kind: GroupKind; values: string[] };

/**
 * Parses one pattern. `**` as a whole segment matches zero or more bucket names, `*` matches any characters inside a
 * segment, and a group such as `{a,b}` matches one of its alternatives. Every other character is literal, except `|`,
 * which is an error. A segment can hold several groups, such as `{a,b}+{c,d}`.
 */
export function parsePattern(text: string): { pattern: BucketPattern } | { error: string } {
  if (text === '') return { error: 'is empty. Write a bucket path such as "root/billing", or "**" for every bucket.' };
  const segments: BucketPattern['segments'] = [];
  const specificity: BucketPattern['specificity'] = [0, 0, 0, 0];
  let literal = true;
  for (const segment of text.split('/')) {
    if (segment === '') return { error: `has an empty segment in "${text}". Remove the extra "/".` };
    if (segment === '**') {
      segments.push('**');
      specificity[3]--;
      literal = false;
      continue;
    }
    const parsed = tokenize(segment);
    if ('error' in parsed) return parsed;
    const { tokens } = parsed;
    const plain = tokens.every((t) => t.kind === 'text');
    if (!plain) literal = false;
    segments.push(tokens.some((t) => CONSTRAINED.has(t.kind as GroupKind)) ? constrainedMatcher(tokens) : new RegExp(`^${tokens.map(tokenSource).join('')}$`, 'u'));
    specificity[segment === '*' ? 2 : plain ? 0 : 1]++;
  }
  return { pattern: { text, literal, segments, specificity } };
}

/** Users write {a|b} for alternatives, and Windows forbids | in a folder name, so it is never a literal. */
function barError(segment: string): { error: string } {
  return { error: `has a "|" in "${segment}". Separate alternatives with a comma, as in "{A,B,C}".` };
}

/** The group that opens at `segment[i]`, the longest opener first, or undefined. */
function groupAt(segment: string, i: number): (typeof GROUPS)[number] | undefined {
  return GROUPS.find((g) => segment.startsWith(g.open, i));
}

/** The closer at `segment[i]`: `}` or `>`, doubled when the next character is the same, or null. */
function closerAt(segment: string, i: number): string | null {
  const char = segment[i];
  if (char !== '}' && char !== '>') return null;
  return segment[i + 1] === char ? char + char : char;
}

/** The opener that a closer such as `>>` belongs to, for messages. */
function openerOf(close: string): string {
  return close.replace(/\}/g, '{').replace(/>/g, '<');
}

/** Splits a segment into tokens, or says what is wrong with it. */
function tokenize(segment: string): { tokens: Token[] } | { error: string } {
  const tokens: Token[] = [];
  let text = '';
  const flush = (): void => {
    if (text !== '') tokens.push({ kind: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < segment.length) {
    const char = segment[i]!;
    if (char === '|') return barError(segment);
    const stray = closerAt(segment, i);
    if (stray !== null) return { error: `has a "${stray}" without a "${openerOf(stray)}" in "${segment}".` };
    if (char === '*') {
      flush();
      tokens.push({ kind: 'star' });
      i++;
      continue;
    }
    const group = groupAt(segment, i);
    if (group === undefined) {
      text += char;
      i++;
      continue;
    }
    flush();
    const { kind, open, close } = group;
    const values = [''];
    let j = i + open.length;
    for (;;) {
      if (j >= segment.length) return { error: `has a "${open}" without a "${close}" in "${segment}".` };
      const inner = segment[j]!;
      if (inner === '|') return barError(segment);
      if (inner === '{' || inner === '<') return { error: `nests "${inner}" inside "${open}" in "${segment}". A group of alternatives cannot contain another group.` };
      const end = closerAt(segment, j);
      if (end === close) {
        j += close.length;
        break;
      }
      if (end !== null) return { error: `closes "${open}" with "${end}" in "${segment}". Close it with "${close}".` };
      if (inner === '*' && kind !== 'any') {
        return { error: `has a "*" inside "${open}...${close}" in "${segment}". This group must list exact values, so write each value instead of "*".` };
      }
      if (inner === ',') values.push('');
      else values[values.length - 1] += inner;
      j++;
    }
    tokens.push({ kind, values });
    i = j;
  }
  flush();
  // At most one kind of constrained group per segment, so each one has a single rule to follow.
  const kinds = [...new Set(tokens.filter((t) => CONSTRAINED.has(t.kind as GroupKind)).map((t) => t.kind as GroupKind))];
  if (kinds.length > 1) {
    const names = kinds.map((k) => GROUPS.find((g) => g.kind === k)!).map((g) => `"${g.open}...${g.close}"`);
    return { error: `mixes ${names.join(' and ')} groups in "${segment}". Pick one of them for this segment. "{...}" groups mix with any kind.` };
  }
  return { tokens };
}

function escapeText(text: string): string {
  return text.replace(/[\\^$.|?+()[\]{}*]/g, '\\$&');
}

/** The regular expression source of a token. `*` inside a `{...}` value matches any characters. */
function tokenSource(token: Token): string {
  if (token.kind === 'text') return escapeText(token.text);
  if (token.kind === 'star') return '.*';
  return `(?:${token.values.map((v) => v.split('*').map(escapeText).join('.*')).join('|')})`;
}

/** True when `value` may follow the values that the earlier groups of the same kind matched. */
function fits(kind: GroupKind, value: string, used: string[]): boolean {
  if (kind === 'distinct') return !used.includes(value);
  return true;
}

/**
 * A matcher for a segment with constrained groups. A lookahead in a regular expression would compare prefixes, not
 * values, so this backtracks over the tokens and keeps the values that the constrained groups matched so far.
 */
function constrainedMatcher(tokens: Token[]): NameMatcher {
  const free = tokens.map((t) => (t.kind === 'text' || CONSTRAINED.has(t.kind as GroupKind) ? null : new RegExp(`^${tokenSource(t)}$`, 'u')));
  const match = (name: string, t: number, pos: number, used: string[]): boolean => {
    if (t === tokens.length) return pos === name.length;
    const token = tokens[t]!;
    if (token.kind === 'text') return name.startsWith(token.text, pos) && match(name, t + 1, pos + token.text.length, used);
    const re = free[t];
    if (re) {
      for (let end = pos; end <= name.length; end++) {
        if (re.test(name.slice(pos, end)) && match(name, t + 1, end, used)) return true;
      }
      return false;
    }
    const { kind, values } = token as { kind: GroupKind; values: string[] };
    return values.some((v) => name.startsWith(v, pos) && fits(kind, v, used) && match(name, t + 1, pos + v.length, [...used, v]));
  };
  return { test: (name) => match(name, 0, 0, []) };
}

/**
 * What is wrong with a pattern that starts with neither the root path nor `**`, or null. Every bucket path starts with
 * the root path, so such a pattern would match no bucket. The prefix is compared on whole segments.
 */
export function rootPrefixProblem(pattern: string, root: string): string | null {
  const segments = pattern.split('/');
  if (segments[0] === '**' || root.split('/').every((s, i) => segments[i] === s)) return null;
  return `must start with the root path "${root}" or with "**", because every bucket path starts with "${root}", such as "${root}/billing". If the root folder moved, write the new root path at the start of the line.`;
}

/** True when the pattern matches the bucket path, such as `root/billing/payments`. */
export function matchesBucket(pattern: BucketPattern, bucketPath: string): boolean {
  return matchSegments(pattern.segments, 0, bucketPath.split('/'), 0);
}

function matchSegments(pattern: BucketPattern['segments'], p: number, names: string[], n: number): boolean {
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

/**
 * True when the pattern can match a bucket below `bucketPath`: a path that starts with its names and has more of them.
 * Once the pattern reaches a `**`, or still has segments after the last name, it can match some deeper path.
 */
export function matchesBelow(pattern: BucketPattern, bucketPath: string): boolean {
  const names = bucketPath.split('/');
  const segments = pattern.segments;
  for (let i = 0; ; i++) {
    if (i === names.length) return i < segments.length;
    if (i === segments.length) return false;
    const segment = segments[i]!;
    if (segment === '**') return true;
    if (!segment.test(names[i]!)) return false;
  }
}

/**
 * Compares two patterns: positive when `a` is more specific, negative when `b` is, 0 when they are equally specific.
 * The specificity tuples are compared left to right, so where a segment sits in the pattern does not matter.
 */
export function compareSpecificity(a: BucketPattern, b: BucketPattern): number {
  for (let i = 0; i < a.specificity.length; i++) {
    if (a.specificity[i] !== b.specificity[i]) return a.specificity[i]! - b.specificity[i]!;
  }
  return 0;
}

/** True when `a` is at least as specific as `b` on every pattern and more specific on at least one. */
function dominates(a: GlobLine, b: GlobLine): boolean {
  const order = a.patterns.map((pattern, i) => compareSpecificity(pattern, b.patterns[i]!));
  return order.every((o) => o >= 0) && order.some((o) => o > 0);
}

/**
 * The outcome for one case. `line` is the line that decided, absent when `default` decided. An ambiguous case fails,
 * and names the allow line and the deny line that match it with no line more specific than both.
 */
export type Decision =
  | { allowed: boolean; by: 'deny' | 'allow' | 'default'; line?: string }
  | { allowed: false; by: 'ambiguous'; allowLine: string; denyLine: string };

/**
 * Of the lines that `matches` accepts, a line that another matching line dominates drops out. When none is left,
 * `default` decides. When the lines left come from one list, that list decides and the first of them in plain string
 * order is named. When both lists still have a line, the case is ambiguous and fails.
 */
export function decide<L extends GlobLine>(fallback: LineLists['default'], lines: { allow: L[]; deny: L[] }, matches: (line: L) => boolean): Decision {
  const matching = [...lines.allow.filter(matches).map((line) => ({ line, list: 'allow' as const })), ...lines.deny.filter(matches).map((line) => ({ line, list: 'deny' as const }))];
  const left = matching.filter((m) => !matching.some((other) => dominates(other.line, m.line)));
  // The first line in plain string order, so the line a message names does not depend on the order in the file.
  const first = (list: 'allow' | 'deny'): string | undefined =>
    left
      .filter((m) => m.list === list)
      .map((m) => m.line.text)
      .sort()[0];
  const allow = first('allow');
  const deny = first('deny');
  if (allow !== undefined && deny !== undefined) return { allowed: false, by: 'ambiguous', allowLine: allow, denyLine: deny };
  if (allow !== undefined) return { allowed: true, by: 'allow', line: allow };
  if (deny !== undefined) return { allowed: false, by: 'deny', line: deny };
  return { allowed: fallback === 'allow', by: 'default' };
}

/**
 * Parses every line of `lists` once per config object. A resolved config holds only valid lines, so a parse error
 * here is a bug.
 */
export function compiler<L>(parse: (text: string) => { line: L } | { error: string }, key: string): (lists: LineLists) => { allow: L[]; deny: L[] } {
  const compiled = new WeakMap<LineLists, { allow: L[]; deny: L[] }>();
  return (lists) => {
    let lines = compiled.get(lists);
    if (lines === undefined) {
      const each = (list: string[]): L[] =>
        list.map((text) => {
          const result = parse(text);
          if ('error' in result) throw new Error(`Invalid ${key} line in a resolved config: ${result.error}`);
          return result.line;
        });
      lines = { allow: each(lists.allow), deny: each(lists.deny) };
      compiled.set(lists, lines);
    }
    return lines;
  };
}
