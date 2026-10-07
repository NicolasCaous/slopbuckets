// Text rendering of a check report and of the refresh diff. An AI agent reads the plain version (hook reasons,
// piped output), so every section says what is wrong and how to fix it. On a terminal the same text gets color.
import { configChangeDetail, configChangeLabel, configChangeSign, configDiff, configRows } from '../core/lock-config.js';
import { SCRIPT_OUTPUT_CHANGED } from '../core/lock.js';
import type { OrphanChain } from '../core/rules/orphans.js';
import type { CheckReport, Lock, LockChange, Violation } from '../core/types.js';
import { highlightCode, padEnd, PLAIN, wrap, type Style } from './style.js';

export interface ReportOptions {
  style?: Style;
  /** The project-relative file of a `buckets check --file` run. The summary then talks about that file only. */
  file?: string;
  /**
   * The approved lock and the current state of each project, by project path (`.` for the project where the check
   * ran). A `config-changed` row then lists each config change under it, as `buckets refresh` does.
   */
  locks?: Map<string, { previous: Lock; next: Lock }>;
}

const NEXT_STEP: Record<0 | 1 | 2 | 3, string> = {
  0: 'All bucket rules pass and the state matches buckets.lock.json.',
  1: 'Exit code 1: bucket rules are broken. Fix every violation above, then run `buckets check` again. If a violation cannot be fixed, explain why in your final message.',
  2: 'Exit code 2: the rules pass, but the state differs from buckets.lock.json. Do not edit the lock and do not run plain `buckets refresh`. Run `buckets refresh --web` in the background, send the link it prints to the human with a summary of what changed and why, and wait for the command to finish. The human can also run `buckets refresh` in a terminal.',
  3: 'Exit code 3: environment problem. Stop and show this message to the human.',
};

/** The words of the exit 2 step that `formatReport` replaces with what the lock differences name. */
const WHAT_CHANGED = 'what changed and why';

function joinAnd(words: string[]): string {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * What the summary for the human covers, from the kinds of lock differences, such as "which DMZ files and buckets
 * changed and why". The generic words when nothing more specific applies.
 */
export function changedSubjects(changes: LockChange[]): string {
  const others = changes.filter((c) => c.kind !== 'lock-missing');
  if (others.length === 0) return changes.length > 0 ? 'what the first lock approves' : WHAT_CHANGED;
  const has = (test: (kind: LockChange['kind']) => boolean): boolean => others.some((c) => test(c.kind));
  const nouns: string[] = [];
  if (has((k) => k.startsWith('dmz-') || k.startsWith('symbol-') || k === 'signature-changed')) nouns.push('DMZ files');
  if (has((k) => k.startsWith('bucket-'))) nouns.push('buckets');
  const config = others.filter((c) => c.kind === 'config-changed');
  if (config.some((c) => !c.message.startsWith(SCRIPT_OUTPUT_CHANGED))) nouns.push('settings of buckets.config.json');
  else if (config.length > 0) nouns.push('script outputs');
  if (has((k) => k.startsWith('project-'))) nouns.push('nested projects');
  if (has((k) => k.startsWith('link-'))) nouns.push('links');
  return `which ${joinAnd(nouns)} changed and why`;
}

const LOCK_AFTER_RULES = 'Once the rules pass, the lock differences still need a human to approve them, through `buckets refresh --web` or `buckets refresh`.';

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function groupByFile(violations: Violation[]): Map<string, Violation[]> {
  const groups = new Map<string, Violation[]>();
  for (const v of violations) {
    if (!groups.has(v.file)) groups.set(v.file, []);
    groups.get(v.file)!.push(v);
  }
  return groups;
}

/** The sign of a lock change: + something new, - something gone, ~ something edited. */
const SIGNS: Record<LockChange['kind'], '+' | '-' | '~'> = {
  'lock-missing': '+',
  'bucket-added': '+',
  'bucket-removed': '-',
  'config-changed': '~',
  'dmz-added': '+',
  'dmz-removed': '-',
  'dmz-changed': '~',
  'symbol-added': '+',
  'symbol-removed': '-',
  'signature-changed': '~',
  'project-added': '+',
  'project-removed': '-',
  'link-added': '+',
  'link-removed': '-',
  'link-changed': '~',
  'link-drift': '~',
};

/** Lock changes whose message says what to do first, so the report prints it. */
const EXPLAINED = new Set<LockChange['kind']>(['lock-missing', 'link-drift']);

function paintSign(style: Style, sign: string, text: string): string {
  if (sign === '+') return style.ok(text);
  if (sign === '-') return style.error(text);
  return style.warn(text);
}

/** Pads every row of a column to the widest cell, so the next column lines up. */
function columnWidth(cells: string[]): number {
  return cells.reduce((max, cell) => Math.max(max, cell.length), 0);
}

function formatViolations(lines: string[], violations: Violation[], style: Style): void {
  for (const [file, items] of groupByFile(violations)) {
    lines.push(style.bold(style.path(file)));
    for (const v of items) {
      const where = v.line !== undefined ? `${style.dim(`line ${v.line}`)}  ` : '';
      lines.push(`  ${where}${style.error(v.rule)}`);
      lines.push(...wrap(highlightCode(style, v.message), style.width, '    '));
    }
    lines.push('');
  }
}

function formatOrphans(lines: string[], orphans: Violation[], chains: OrphanChain[], style: Style): void {
  lines.push(style.bold('Orphan contracts'), ...wrap('No _/ code imports these DMZ symbols, directly or through another DMZ.', style.width, '  ').map(style.dim));
  const lineOf = new Map<string, number | undefined>();
  for (const v of orphans) {
    const symbol = /`([^`]+)`/.exec(v.message)?.[1];
    if (symbol !== undefined) lineOf.set(`${v.file}\0${symbol}`, v.line);
  }
  const covered = new Set<string>();
  for (const chain of chains) {
    const origin = chain.origin === null ? 'origin unknown' : `origin ${chain.origin}`;
    lines.push(`  ${style.error('dmz-orphan')}  ${style.bold(chain.symbol)}  ${style.dim(`(${origin})`)}`);
    const width = columnWidth(chain.files);
    for (const file of chain.files) {
      const key = `${file}\0${chain.symbol}`;
      covered.add(key);
      const line = lineOf.get(key);
      lines.push(`    ${line !== undefined ? `${padEnd(style.path(file), width)}  ${style.dim(`line ${line}`)}` : style.path(file)}`);
    }
    const tip = chain.files[chain.files.length - 1]!;
    const fix =
      chain.files.length > 1
        ? `To fix, delete \`${chain.symbol}\` from each file above (delete a file once it is empty), or import it by name from ${tip} in the consumer's _/ code.`
        : `To fix, delete \`${chain.symbol}\` from this file (delete the file once it is empty), or import it by name from ${tip} in the consumer's _/ code.`;
    lines.push(...wrap(highlightCode(style, fix), style.width, '    '));
  }
  for (const v of orphans) {
    const symbol = /`([^`]+)`/.exec(v.message)?.[1];
    if (symbol !== undefined && covered.has(`${v.file}\0${symbol}`)) continue;
    lines.push(`  ${style.error(v.rule)}  ${style.path(v.file)}${v.line !== undefined ? `  ${style.dim(`line ${v.line}`)}` : ''}`);
    lines.push(...wrap(highlightCode(style, v.message), style.width, '    '));
  }
  lines.push('');
}

function formatLockChanges(lines: string[], changes: LockChange[], style: Style, locks: ReportOptions['locks']): void {
  lines.push(style.bold('Lock differences'), ...wrap(highlightCode(style, 'Only a human approves these, with `buckets refresh` or `buckets refresh --web`.'), style.width, '  ').map(style.dim));
  const kindWidth = columnWidth(changes.map((c) => c.kind));
  const pathWidth = columnWidth(changes.filter((c) => c.symbol !== undefined).map((c) => c.path));
  for (const change of changes) {
    const sign = SIGNS[change.kind];
    const head = `  ${paintSign(style, sign, `${sign} ${padEnd(change.kind, kindWidth)}`)}  `;
    if (change.symbol !== undefined) lines.push(`${head}${padEnd(style.path(change.path), pathWidth)}  ${style.bold(change.symbol)}`);
    else lines.push(`${head}${style.path(change.path)}`);
    // A missing or unreadable lock has no path to compare, so its message is the explanation. A drifted copy needs
    // `buckets link update` before an approval makes sense.
    if (EXPLAINED.has(change.kind)) lines.push(...wrap(highlightCode(style, change.message), style.width, '    '));
    const pair = change.kind === 'config-changed' ? locks?.get(change.project ?? '.') : undefined;
    if (pair !== undefined) lines.push(...configLines(pair.previous, pair.next, style));
  }
  lines.push('');
}

function summary(report: CheckReport, options: ReportOptions, style: Style): string {
  const parts: string[] = [];
  if (report.violations.length > 0) {
    const files = new Set(report.violations.map((v) => v.file)).size;
    parts.push(style.error(style.bold(plural(report.violations.length, 'violation'))) + (files > 1 ? ` in ${files} files` : ''));
  }
  if (report.lockChanges.length > 0) parts.push(style.warn(style.bold(plural(report.lockChanges.length, 'lock difference'))));
  const failing = (report.projects ?? []).filter((p) => p.exitCode !== 0).length;
  const where = failing > 1 ? ` in ${failing} projects` : '';
  const command = options.file !== undefined ? `buckets check --file ${options.file}` : 'buckets check';
  const mark = style.tty ? `${report.exitCode === 2 ? style.warn('!') : style.error('✗')} ` : '';
  return `${mark}${command}: ${parts.join(', ')}${where}.`;
}

export function formatReport(report: CheckReport, chains: OrphanChain[] = [], options: ReportOptions = {}): string {
  const style = options.style ?? PLAIN;
  const lines: string[] = [];

  if (report.environment) {
    lines.push(style.error(style.bold(`Environment problem (${report.environment.code})`)));
    lines.push(...wrap(highlightCode(style, report.environment.message), style.width, '  '), '');
  }

  const body = (violations: Violation[], changes: LockChange[], projectChains: OrphanChain[]): void => {
    const orphans = violations.filter((v) => v.rule === 'dmz-orphan');
    formatViolations(
      lines,
      violations.filter((v) => v.rule !== 'dmz-orphan'),
      style,
    );
    if (orphans.length > 0) formatOrphans(lines, orphans, projectChains, style);
    if (changes.length > 0) formatLockChanges(lines, changes, style, options.locks);
  };

  const projects = report.projects ?? [];
  if (projects.length <= 1) {
    body(report.violations, report.lockChanges, chains);
  } else {
    // A recursive report: one section per project with problems. Paths in a section are relative to its project.
    for (const project of projects) {
      const of = <T extends { project?: string }>(items: T[]): T[] => items.filter((item) => (item.project ?? '.') === project.path);
      const violations = of(report.violations);
      const changes = of(report.lockChanges);
      if (violations.length === 0 && changes.length === 0) continue;
      const title = project.path === '.' ? 'Project . (where the check ran)' : `Project ${project.path} (nested, paths below are relative to it)`;
      lines.push(style.bold(style.phos(`== ${title}`)), '');
      body(violations, changes, of(chains));
    }
  }

  if (report.exitCode === 0) {
    const mark = style.tty ? `${style.ok('✓')} ` : '';
    const text =
      options.file !== undefined
        ? `${options.file} passes every bucket rule. A single-file check skips the orphan rule and the lock comparison.`
        : NEXT_STEP[0];
    lines.push(mark + style.ok(text));
    return `${lines.join('\n')}\n`;
  }

  if (report.exitCode !== 3) {
    if (style.tty) lines.push(style.dim('─'.repeat(Math.min(style.width ?? 60, 60))));
    lines.push(summary(report, options, style));
  }
  const step = report.exitCode === 2 ? NEXT_STEP[2].replace(WHAT_CHANGED, changedSubjects(report.lockChanges)) : NEXT_STEP[report.exitCode];
  const [label, ...rest] = step.split(': ');
  let next = rest.join(': ');
  if (report.exitCode === 1 && report.lockChanges.length > 0) next += ` ${LOCK_AFTER_RULES}`;
  const paintLabel = report.exitCode === 2 ? style.warn : style.error;
  const wrapped = wrap(highlightCode(style, `${label}: ${next}`), style.width, '');
  wrapped[0] = paintLabel(style.bold(`${label}:`)) + wrapped[0]!.slice(label!.length + 1);
  lines.push(...wrapped);
  return `${lines.join('\n')}\n`;
}

function describeChange(change: LockChange): [label: string, path: string] {
  switch (change.kind) {
    case 'bucket-added':
      return ['bucket created', change.path];
    case 'bucket-removed':
      return ['bucket removed', change.path];
    case 'config-changed':
      return ['config changed', change.path];
    case 'dmz-added':
      return ['DMZ file created', change.path];
    case 'dmz-removed':
      return ['DMZ file deleted', change.path];
    case 'dmz-changed':
      return ['DMZ file edited', change.path];
    case 'symbol-added':
      return ['symbol added', change.path];
    case 'symbol-removed':
      return ['symbol removed', change.path];
    case 'signature-changed':
      return ['signature changed', change.path];
    case 'lock-missing':
      return ['lock created', change.path];
    case 'project-added':
      return ['nested project added', change.path];
    case 'project-removed':
      return ['nested project removed', change.path];
    case 'link-added':
      return ['link added', change.path];
    case 'link-removed':
      return ['link removed', change.path];
    case 'link-changed':
      return [change.symbol !== undefined ? 'linked symbol changed' : 'link changed', change.path];
    case 'link-drift':
      return ['link copy drifted', change.path];
  }
}

/**
 * What `buckets refresh` prints when the approved values stay the same and only the lock file differs: the move to a
 * newer lock format, or formatting only, for example after a hand edit.
 */
export function formatOnlyNote(previous: Lock, next: Lock): string {
  return previous.lockVersion !== next.lockVersion
    ? `(same values, the lock format moves from version ${previous.lockVersion} to ${next.lockVersion})`
    : '(formatting only)';
}

/** Wide enough for the longest label ("nested project removed") plus one space before the path. */
const LABEL_WIDTH = 24;

/**
 * Counts the lines of a refresh diff by sign, for the summary under the diff. Only the rows at the start of a line
 * count: the indented lines under `config changed` detail one change. Colors are removed first.
 */
export function diffSummary(diff: string): string {
  const counts = { '+': 0, '-': 0, '~': 0 };
  for (const line of diff.split('\n')) {
    const sign = line.replace(/\u001b\[[0-9;]*m/g, '')[0];
    if (sign === '+' || sign === '-' || sign === '~') counts[sign]++;
  }
  const parts: string[] = [];
  if (counts['+'] > 0) parts.push(`${counts['+']} added`);
  if (counts['-'] > 0) parts.push(`${counts['-']} removed`);
  if (counts['~'] > 0) parts.push(`${counts['~']} changed`);
  return parts.join(', ');
}

/**
 * Human-readable diff for `buckets refresh`, one line per change: a sign (+ added, - removed, ~ changed),
 * a label, the path and the symbol, in aligned columns. `previous` is null when there is no lock yet.
 */
export function formatLockDiff(previous: Lock | null, next: Lock, changes: LockChange[], style: Style = PLAIN): string {
  const lines: string[] = [];
  if (previous === null) {
    lines.push('No buckets.lock.json yet. Approving creates it with this state:', '');
    lines.push(
      `  CLI ${next.cli}, adapter ${next.adapter.name} ${next.adapter.version}${next.adapter.toolchain !== undefined ? `, ${next.adapter.toolchain}` : ''}`,
    );
    lines.push(`  ${style.bold(plural(next.buckets.length, 'bucket'))}:`);
    for (const bucket of next.buckets) lines.push(`    ${style.path(bucket)}`);
    const files = Object.keys(next.dmz).sort();
    lines.push(`  ${style.bold(plural(files.length, 'DMZ file'))}:`);
    for (const file of files) {
      const symbols = Object.keys(next.dmz[file]!.symbols).sort();
      lines.push(`    ${style.path(file)}${symbols.length > 0 ? `  ${style.dim(`(${symbols.join(', ')})`)}` : ''}`);
    }
    const projects = next.projects ?? [];
    if (projects.length > 0) {
      lines.push(`  ${style.bold(plural(projects.length, 'nested project'))}:`);
      for (const p of projects) lines.push(`    ${style.path(p)}`);
    }
    const links = Object.entries(next.links ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
    if (links.length > 0) {
      lines.push(`  ${style.bold(plural(links.length, 'link'))}:`);
      for (const [p, link] of links) {
        const count = Object.values(link.symbols ?? {}).reduce((n, names) => n + Object.keys(names).length, 0);
        const alias = link.alias !== undefined ? `, alias ${link.alias}` : '';
        lines.push(`    ${style.path(p)}  ${style.dim(`(${link.mode} of ${link.origin}${alias}, ${plural(count, 'published symbol')})`)}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  const row = (sign: '+' | '-' | '~', label: string, rest: string): string => `${paintSign(style, sign, `${sign} ${label.padEnd(LABEL_WIDTH)}`)}${rest}`;
  if (previous.cli !== next.cli) lines.push(row('~', 'CLI version', `${previous.cli} -> ${next.cli}`));
  if (previous.adapter.name !== next.adapter.name || previous.adapter.version !== next.adapter.version) {
    lines.push(row('~', 'adapter version', `${previous.adapter.name} ${previous.adapter.version} -> ${next.adapter.name} ${next.adapter.version}`));
  }
  if (previous.adapter.toolchain !== next.adapter.toolchain) {
    lines.push(row('~', 'toolchain', `${previous.adapter.toolchain ?? 'unknown'} -> ${next.adapter.toolchain ?? 'unknown'}`));
  }
  const pathWidth = columnWidth(changes.filter((c) => c.symbol !== undefined).map((c) => c.path));
  for (const change of changes) {
    const [label, path] = describeChange(change);
    const rest = change.symbol !== undefined ? `${padEnd(style.path(path), pathWidth)}  ${style.bold(change.symbol)}` : style.path(path);
    lines.push(row(SIGNS[change.kind], label, rest));
    if (change.kind === 'config-changed') lines.push(...configLines(previous, next, style));
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * The lines under `config changed`: each access or layout line added or removed, a changed default, every other changed key
 * with its old and new value, and each value a script printed before or prints now. When the approved lock stored only a
 * hash, the config being approved instead.
 */
function configLines(previous: Lock, next: Lock, style: Style): string[] {
  const diff = configDiff(previous.config, next.config, { before: previous.scriptValues, after: next.scriptValues });
  if (diff === null) return [];
  if (diff.recorded) {
    const width = columnWidth(diff.changes.map(configChangeLabel));
    return diff.changes.map((change) => {
      const sign = configChangeSign(change);
      return `    ${paintSign(style, sign, `${sign} ${configChangeLabel(change).padEnd(width)}`)}  ${configChangeDetail(change)}`;
    });
  }
  const note = `The approved lock (version ${previous.lockVersion}) stored only a hash of buckets.config.json, so the old values are unknown.${typeof next.config === 'string' ? '' : ' Approving records these values:'}`;
  const lines = wrap(note, style.width, '    ').map(style.dim);
  if (typeof next.config !== 'string') {
    const rows = configRows(next.config);
    const width = columnWidth(rows.map((r) => r.label));
    for (const r of rows) lines.push(`      ${r.label.padEnd(width)}  ${r.value}`);
  }
  return lines;
}
