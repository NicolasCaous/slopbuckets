// Globs over bucket paths, as the lock lists them, such as `root/billing`, and the "most specific line decides" rule
// that the `access` and `layout` keys of buckets.config.json share. Hand written so the CLI has no runtime dependency.

/**
 * The values of each script of the config, by script name: the lines the script printed, sorted and without
 * duplicates. A pattern names a script with backticks, as in `` {A,`repos`} ``, and its values join the group.
 */
export type ScriptValues = Readonly<Record<string, readonly string[]>>;

/** No scripts. One shared object, so the compiled lines of a config without scripts are reused. */
export const NO_SCRIPTS: ScriptValues = Object.freeze({});

/** What a script name looks like: a letter or `_`, then letters, digits, `_` and `-`. */
export const SCRIPT_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

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
  /**
   * The pattern in canonical form: the values of each group sorted, and a group that holds only one script name
   * written bare, so `` {b,a}/{`repos`} `` becomes `` {a,b}/`repos` ``. Equivalent spellings get the same text.
   */
  text: string;
  /** True when the pattern has no `*` and no group of alternatives, so it names exactly one bucket. */
  literal: boolean;
  /** One entry per `/` segment: `**`, or a matcher for the whole segment. */
  segments: Array<'**' | NameMatcher>;
  /**
   * The specificity tuple: the number of literal segments, of segments with `*`, a group or a script mixed with other
   * text (such as `team-*`, `{api,web}` or `` `repos` ``), of segments that are exactly `*`, and minus the number of
   * `**` segments.
   */
  specificity: [number, number, number, number];
}

/** A parsed line of `allow` or `deny`: its canonical text and its patterns, one for `layout`, two for `access`. */
export interface GlobLine {
  text: string;
  patterns: BucketPattern[];
}

/**
 * The kinds of groups of alternatives. Each `{a,b}` matches any of its values. Within one segment, the `{{a,b}}` groups
 * match values in non-decreasing order, the `<a,b>` groups match values that differ from each other, and the `<<a,b>>`
 * groups match values in strictly increasing order. Order is plain JavaScript string order, without a locale.
 */
type GroupKind = 'any' | 'sorted' | 'distinct' | 'increasing';

/** The opener and closer of each kind of group, longest opener first. */
const GROUPS: Array<{ kind: GroupKind; open: string; close: string }> = [
  { kind: 'sorted', open: '{{', close: '}}' },
  { kind: 'increasing', open: '<<', close: '>>' },
  { kind: 'any', open: '{', close: '}' },
  { kind: 'distinct', open: '<', close: '>' },
];

/** The kinds whose groups constrain each other within a segment. A segment may hold only one of them. */
const CONSTRAINED: ReadonlySet<GroupKind> = new Set(['sorted', 'distinct', 'increasing']);

/** One piece of a segment: literal text, `*`, or a group of alternatives. */
type Token = { kind: 'text'; text: string } | { kind: 'star' } | { kind: GroupKind; values: string[] };

/**
 * Parses one pattern. `**` as a whole segment matches zero or more bucket names, `*` matches any characters inside a
 * segment, and a group such as `{a,b}` matches one of its alternatives. Every other character is literal, except `|`,
 * which is an error. A segment can hold several groups, such as `{a,b}+{c,d}`. A group needs at least one value, and
 * no value may be empty or appear twice in one group.
 *
 * A script name in backticks, such as `` `repos` ``, stands for the values of that script. Inside a group it is one
 * value between commas, and its values join the group. Outside a group it is a group of its own, so `` `repos` ``
 * means `` {`repos`} ``. `scripts` gives the values of each script. Without it, any well-formed name is accepted with
 * no values, which is enough to check the syntax and to read the canonical text.
 */
export function parsePattern(text: string, scripts?: ScriptValues): { pattern: BucketPattern } | { error: string } {
  if (text === '') return { error: 'is empty. Write a bucket path such as "root/billing", or "**" for every bucket.' };
  const segments: BucketPattern['segments'] = [];
  const specificity: BucketPattern['specificity'] = [0, 0, 0, 0];
  const canonical: string[] = [];
  let literal = true;
  for (const segment of text.split('/')) {
    if (segment === '') return { error: `has an empty segment in "${text}". Remove the extra "/".` };
    if (segment === '**') {
      segments.push('**');
      canonical.push(segment);
      specificity[3]--;
      literal = false;
      continue;
    }
    const parsed = tokenize(segment, scripts);
    if ('error' in parsed) return parsed;
    const { tokens } = parsed;
    const plain = tokens.every((t) => t.kind === 'text');
    if (!plain) literal = false;
    segments.push(segmentMatcher(tokens));
    canonical.push(parsed.canonical);
    specificity[segment === '*' ? 2 : plain ? 0 : 1]++;
  }
  return { pattern: { text: canonical.join('/'), literal, segments, specificity } };
}

/**
 * Splits `text` at each `->` outside every group and every script name, so a group value that ends in `-`, as in
 * `<a,b->`, stays whole. A group or a script name runs from its opener to its closer, or to the end of the text when
 * it has none.
 */
export function splitAtArrows(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let close: string | null = null;
  let i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      i = end === -1 ? text.length : end + 1;
    } else if (close !== null) {
      if (text.startsWith(close, i)) {
        i += close.length;
        close = null;
      } else i++;
    } else if (text.startsWith('->', i)) {
      parts.push(text.slice(start, i));
      i += 2;
      start = i;
    } else {
      const group = groupAt(text, i);
      if (group === undefined) i++;
      else {
        close = group.close;
        i += group.open.length;
      }
    }
  }
  parts.push(text.slice(start));
  return parts;
}

const SCRIPT_EXAMPLE = 'as in "{A,`repos`}"';

/**
 * Reads the script name in backticks that starts at `segment[i]`. Returns the values of the script and the index after
 * the closing backtick, or says what is wrong.
 */
function readScript(segment: string, i: number, scripts: ScriptValues | undefined): { name: string; values: readonly string[]; end: number } | { error: string } {
  const close = segment.indexOf('`', i + 1);
  if (close === -1) return { error: `has a "\`" without a closing "\`" in "${segment}". Write a script name between two backticks, ${SCRIPT_EXAMPLE}.` };
  const name = segment.slice(i + 1, close);
  if (name === '') return { error: `has an empty script name "\`\`" in "${segment}". Write a script name between the backticks, ${SCRIPT_EXAMPLE}.` };
  if (!SCRIPT_NAME.test(name)) {
    return { error: `has "\`${name}\`" in "${segment}", which is not a script name. A script name starts with a letter or "_" and holds only letters, digits, "_" and "-". Backticks hold only a script name.` };
  }
  if (scripts === undefined) return { name, values: [], end: close + 1 };
  // The caller quotes the whole line, so the message quotes only the name.
  if (!Object.hasOwn(scripts, name)) return { error: `uses the script "${name}", which "scripts" does not list. Add it to "scripts" or fix the name.` };
  return { name, values: scripts[name]!, end: close + 1 };
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

/**
 * Splits a segment into tokens, or says what is wrong with it. `canonical` is the segment with the values of each
 * group sorted, and with a group that holds only one script name written bare.
 */
function tokenize(segment: string, scripts: ScriptValues | undefined): { tokens: Token[]; canonical: string } | { error: string } {
  const tokens: Token[] = [];
  let canonical = '';
  let text = '';
  const flush = (): void => {
    if (text !== '') tokens.push({ kind: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < segment.length) {
    const char = segment[i]!;
    if (char === '`') {
      const script = readScript(segment, i, scripts);
      if ('error' in script) return script;
      flush();
      tokens.push({ kind: 'any', values: [...script.values] });
      canonical += `\`${script.name}\``;
      i = script.end;
      continue;
    }
    if (char === '|') return barError(segment);
    const stray = closerAt(segment, i);
    if (stray !== null) return { error: `has a "${stray}" without a "${openerOf(stray)}" in "${segment}".` };
    if (char === '*') {
      flush();
      tokens.push({ kind: 'star' });
      canonical += char;
      i++;
      continue;
    }
    const group = groupAt(segment, i);
    if (group === undefined) {
      text += char;
      canonical += char;
      i++;
      continue;
    }
    flush();
    const { kind, open, close } = group;
    // Each value as written, with the bucket names it stands for: itself, or the values of a script.
    const items: Array<{ written: string; values: readonly string[]; script: boolean }> = [];
    let value = '';
    // The script reference that makes up the current value, or null.
    let script: { name: string; values: readonly string[] } | null = null;
    const mixed = { error: `mixes a script name with other text in one value of "${segment}". A script name in backticks is a whole value between commas, ${SCRIPT_EXAMPLE}.` };
    const endValue = (): { error: string } | null => {
      const ref = script as { name: string; values: readonly string[] } | null;
      const item = ref !== null ? { written: `\`${ref.name}\``, values: ref.values, script: true } : { written: value, values: [value], script: false };
      value = '';
      script = null;
      if (item.written === '') return { error: `has an empty value in "${segment}". Write a value between each pair of commas, as in "${open}A,B${close}".` };
      if (items.some((other) => other.written === item.written)) return { error: `lists "${item.written}" twice in one group of "${segment}". Remove one of them.` };
      items.push(item);
      return null;
    };
    let j = i + open.length;
    if (segment.startsWith(close, j)) return { error: `has the empty group "${open}${close}" in "${segment}". Write at least one value, as in "${open}A,B${close}".` };
    for (;;) {
      if (j >= segment.length) return { error: `has a "${open}" without a "${close}" in "${segment}".` };
      const inner = segment[j]!;
      if (inner === '`') {
        if (value !== '' || script !== null) return mixed;
        const read = readScript(segment, j, scripts);
        if ('error' in read) return read;
        script = read;
        j = read.end;
        continue;
      }
      if (inner === '|') return barError(segment);
      if (inner === '{' || inner === '<') return { error: `nests "${inner}" inside "${open}" in "${segment}". A group of alternatives cannot contain another group.` };
      const end = closerAt(segment, j);
      if (end === close) {
        const problem = endValue();
        if (problem !== null) return problem;
        j += close.length;
        break;
      }
      if (end !== null) return { error: `closes "${open}" with "${end}" in "${segment}". Close it with "${close}".` };
      if (inner === '*' && kind !== 'any') {
        return { error: `has a "*" inside "${open}...${close}" in "${segment}". This group must list exact values, so write each value instead of "*".` };
      }
      if (inner === ',') {
        const problem = endValue();
        if (problem !== null) return problem;
      } else if (script !== null) return mixed;
      else value += inner;
      j++;
    }
    // A script can print a value that the group also lists, so the values are de-duplicated.
    tokens.push({ kind, values: [...new Set(items.flatMap((item) => item.values))] });
    const written = items.map((item) => item.written).sort();
    // The order of the values never changes what a group matches, and `` `repos` `` alone means `` {`repos`} ``.
    canonical += kind === 'any' && items.length === 1 && items[0]!.script ? written[0] : `${open}${written.join(',')}${close}`;
    i = j;
  }
  flush();
  // At most one kind of constrained group per segment, so each one has a single rule to follow.
  const kinds = [...new Set(tokens.filter((t) => CONSTRAINED.has(t.kind as GroupKind)).map((t) => t.kind as GroupKind))];
  if (kinds.length > 1) {
    const names = kinds.map((k) => GROUPS.find((g) => g.kind === k)!).map((g) => `"${g.open}...${g.close}"`);
    return { error: `mixes ${names.join(' and ')} groups in "${segment}". Pick one of them for this segment. "{...}" groups mix with any kind.` };
  }
  return { tokens, canonical };
}

/**
 * The ends of the matches of one `{...}` value at `name[pos]`. The value is split at its `*`, so `pieces` is its text
 * between them. A `*` matches any characters, so each middle piece is taken at its first place, which leaves the most
 * room for the rest, and the last piece may end anywhere it fits.
 */
function valueEnds(pieces: readonly string[], name: string, pos: number): number[] {
  const first = pieces[0]!;
  if (!name.startsWith(first, pos)) return [];
  let at = pos + first.length;
  if (pieces.length === 1) return [at];
  for (let i = 1; i < pieces.length - 1; i++) {
    const found = name.indexOf(pieces[i]!, at);
    if (found === -1) return [];
    at = found + pieces[i]!.length;
  }
  const last = pieces[pieces.length - 1]!;
  const ends: number[] = [];
  for (let q = at; q + last.length <= name.length; q++) if (name.startsWith(last, q)) ends.push(q + last.length);
  return ends;
}

/** True when `value` may follow the values that the earlier groups of the same kind matched (see `nextUsed`). */
function fits(kind: GroupKind, value: string, used: readonly string[]): boolean {
  if (kind === 'distinct') return !used.includes(value);
  if (kind === 'increasing') return used.length === 0 || used[0]! < value;
  if (kind === 'sorted') return used.length === 0 || used[0]! <= value;
  return true;
}

/**
 * What a constrained group needs to know about the groups before it, after it matched `value`: the last value for
 * `{{...}}` and `<<...>>`, and the sorted values so far for `<...>`. Two paths that reach the same state at the same
 * place match the same rest, so the matcher can remember the states that failed.
 */
function nextUsed(kind: GroupKind, used: readonly string[], value: string): readonly string[] {
  return kind === 'distinct' ? [...used, value].sort() : [value];
}

/**
 * The matcher of one segment. It walks the tokens and keeps the state of the constrained groups (see `nextUsed`).
 * A lookahead in a regular expression would compare prefixes, not values, and backtracking over several `*` takes
 * time that grows exponentially with their number. Here a failed token, position and state is remembered and never
 * tried again for the same name, so the time grows with a power of the length of the name instead.
 */
function segmentMatcher(tokens: Token[]): NameMatcher {
  if (tokens.every((t) => t.kind === 'text')) {
    const text = tokens.map((t) => (t as { text: string }).text).join('');
    return { test: (name) => name === text };
  }
  const pieces = tokens.map((t) => (t.kind === 'any' ? t.values.map((v) => v.split('*')) : []));
  return {
    test(name) {
      const failed = new Set<string>();
      const match = (t: number, pos: number, used: readonly string[]): boolean => {
        if (t === tokens.length) return pos === name.length;
        const token = tokens[t]!;
        if (token.kind === 'text') return name.startsWith(token.text, pos) && match(t + 1, pos + token.text.length, used);
        const key = `${t} ${pos} ${JSON.stringify(used)}`;
        if (failed.has(key)) return false;
        let found = false;
        if (token.kind === 'star') {
          for (let end = pos; end <= name.length && !found; end++) found = match(t + 1, end, used);
        } else if (token.kind === 'any') {
          for (const value of pieces[t]!) {
            for (const end of valueEnds(value, name, pos)) {
              found = match(t + 1, end, used);
              if (found) break;
            }
            if (found) break;
          }
        } else {
          const { kind } = token;
          found = token.values.some((value) => name.startsWith(value, pos) && fits(kind, value, used) && match(t + 1, pos + value.length, nextUsed(kind, used, value)));
        }
        if (!found) failed.add(key);
        return found;
      };
      return match(0, 0, []);
    },
  };
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
  const names = bucketPath.split('/');
  const segments = pattern.segments;
  // Each `**` tries every number of names, so a pattern with several of them remembers the places that failed.
  const failed = new Set<number>();
  const match = (p: number, n: number): boolean => {
    if (p === segments.length) return n === names.length;
    const segment = segments[p]!;
    if (segment !== '**') return n < names.length && segment.test(names[n]!) && match(p + 1, n + 1);
    const key = p * (names.length + 1) + n;
    if (failed.has(key)) return false;
    for (let skip = n; skip <= names.length; skip++) if (match(p + 1, skip)) return true;
    failed.add(key);
    return false;
  };
  return match(0, 0);
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
 * Parses every line of `lists` once per config object and set of script values. A resolved config holds only valid
 * lines, so a parse error here is a bug, such as a line that names a script whose values were not passed.
 */
export function compiler<L>(
  parse: (text: string, scripts: ScriptValues) => { line: L } | { error: string },
  key: string,
): (lists: LineLists, scripts: ScriptValues) => { allow: L[]; deny: L[] } {
  const compiled = new WeakMap<LineLists, { scripts: ScriptValues; lines: { allow: L[]; deny: L[] } }>();
  return (lists, scripts) => {
    let entry = compiled.get(lists);
    if (entry === undefined || entry.scripts !== scripts) {
      const each = (list: string[]): L[] =>
        list.map((text) => {
          const result = parse(text, scripts);
          if ('error' in result) throw new Error(`Invalid ${key} line in a resolved config: ${result.error}`);
          return result.line;
        });
      entry = { scripts, lines: { allow: each(lists.allow), deny: each(lists.deny) } };
      compiled.set(lists, entry);
    }
    return entry.lines;
  };
}
