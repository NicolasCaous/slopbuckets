// `buckets check`: every rule of buckets.config.json, in full form, like the stop hook. `--summary` counts them,
// `--format github` and `--format sarif` are for CI, and `--base <ref>` lists what changed in the architecture since a
// git ref, for the review of a pull request.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ADAPTER_ABI, analyze } from '@slopbuckets/adapter-ts';
import { stderrStyle, type Context, type Io } from '../context/index.js';
import {
  CONFIG_FILE,
  EXIT_CODES,
  publicFiles,
  renderCheck,
  renderCheckSummary,
  renderEnvironment,
  renderFull,
  renderSummary,
  RULES,
  violationLocation,
  type CheckResult,
  type Violation,
} from '../contract/index.js';
import { findProjectDir, isRecord, parseJson } from '../files/index.js';
import { skillCopies } from '../hooks/index.js';
import { message } from '../output/index.js';
import { parseCommand } from './io.js';

const USAGE = 'Usage: buckets check [--json | --format text|json|github|sarif] [--summary] [--base <ref>] [--no-recursive]';
const OPTIONS = {
  json: { type: 'boolean' },
  'no-recursive': { type: 'boolean' },
  summary: { type: 'boolean' },
  base: { type: 'string' },
  format: { type: 'string' },
} as const;
const FORMATS = ['text', 'json', 'github', 'sarif'];
const HOMEPAGE = 'https://nicolascaous.github.io/slopbuckets/';

export async function checkCommand(ctx: Context, io: Io, args: string[]): Promise<number> {
  const parsed = parseCommand(io, 'check', USAGE, args, OPTIONS);
  if (typeof parsed === 'number') return parsed;
  const values = parsed.values as { json?: boolean; 'no-recursive'?: boolean; summary?: boolean; base?: string; format?: string };
  const usageError = (text: string): number => {
    io.stderr(`${stderrStyle(io).error('buckets check:')} ${text} ${USAGE}\n`);
    return EXIT_CODES.usage;
  };
  const format = values.format ?? (values.json === true ? 'json' : 'text');
  if (!FORMATS.includes(format)) return usageError(`--format takes ${FORMATS.join(', ')}, not "${format}".`);
  if (values.json === true && format !== 'json') return usageError(`--json and --format ${format} ask for two outputs.`);
  if (values.summary === true && (format === 'json' || format === 'sarif')) return usageError(`--summary prints text, and --format ${format} prints JSON.`);
  if (values.base === '') return usageError('--base needs a git ref, such as `--base origin/main`.');

  const root = findProjectDir(io.cwd, io.env) ?? io.cwd;
  const recursive = values['no-recursive'] !== true;
  const result = await ctx.engine.checkAll(root, { recursive });
  if (format === 'json') io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  else if (format === 'sarif') io.stdout(`${JSON.stringify(sarif(ctx.cliVersion, result, root, io.env), null, 2)}\n`);
  else io.stdout(`${(values.summary === true ? renderCheckSummary : renderCheck)(result.violations, result.environment, result.advice)}\n`);
  // Annotations go to stderr, which the Actions runner reads as well, so stdout stays the same in every format.
  if (format === 'github' || (io.env.GITHUB_ACTIONS === 'true' && format !== 'sarif')) {
    const lines = annotations(result, root, io.env);
    if (lines.length > 0) io.stderr(`${lines.join('\n')}\n`);
  }
  const stale = staleSkillNotice(root, ctx.cliVersion);
  if (stale !== null) io.stderr(`${stale}\n`);

  if (values.base !== undefined) {
    const diff = architectureDiff(root, values.base, recursive);
    const text = diff.problem ?? (diff.sections.length === 0 ? `No architecture changes since ${values.base}.` : diff.sections.map((s) => [s.title, ...s.lines.map((l) => `  ${l}`)].join('\n')).join('\n\n'));
    // Only the CheckResult or the SARIF log goes to stdout with JSON, so the diff goes to stderr then.
    if (format === 'json' || format === 'sarif') io.stderr(`${text}\n`);
    else io.stdout(`\n${text}\n`);
    const summary = io.env.GITHUB_STEP_SUMMARY;
    if (summary !== undefined && summary !== '' && diff.problem === undefined) {
      const markdown = diff.sections.length === 0 ? `No architecture changes since \`${values.base}\`.\n` : diff.sections.map((s) => `### ${s.title.replace(/:$/, '')}\n\n${s.lines.map((l) => `- ${l}`).join('\n')}\n`).join('\n');
      try {
        appendFileSync(summary, `${markdown}\n`);
      } catch (error) {
        io.stderr(`buckets check: could not write to GITHUB_STEP_SUMMARY (${message(error)}).\n`);
      }
    }
  }
  return result.exitCode;
}

/** One line that says which skill copies are not the skill of this CLI, or null when every copy is. */
function staleSkillNotice(root: string, version: string): string | null {
  const stale = skillCopies(root).filter((copy) => copy.version !== version);
  if (stale.length === 0) return null;
  const which = stale.map((c) => `${c.file} (${c.version === null ? 'no version' : c.version})`).join(' and ');
  return `slopbuckets: the skill in ${which} is not the one of slopbuckets ${version}. Run \`buckets init\` to copy the current skill.`;
}

/* ---------- --format github and sarif ---------- */

/** The path of a file of a project, relative to GITHUB_WORKSPACE when it is set, else to `root`, with `/`. */
function reportPath(root: string, env: Record<string, string | undefined>, project: string, file: string): string {
  const base = env.GITHUB_WORKSPACE !== undefined && env.GITHUB_WORKSPACE !== '' ? env.GITHUB_WORKSPACE : root;
  return path.relative(base, path.join(root, project, file)).split(path.sep).join('/');
}

const escapeData = (text: string): string => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (text: string): string => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** One `::error` workflow command per violation and per environment error. */
export function annotations(result: CheckResult, root: string, env: Record<string, string | undefined>): string[] {
  const lines = result.violations.map((v) => {
    const at = violationLocation(v);
    const props = [`file=${escapeProperty(reportPath(root, env, v.project, at.file))}`, ...(at.line !== undefined ? [`line=${at.line}`] : []), `title=${escapeProperty(`slopbuckets ${v.rule}`)}`];
    return `::error ${props.join(',')}::${escapeData(renderSummary(v))}`;
  });
  for (const e of result.environment) lines.push(`::error title=slopbuckets::${escapeData(renderEnvironment(e))}`);
  return lines;
}

/** The check as a SARIF 2.1.0 log, for GitHub code scanning and other SARIF readers. */
export function sarif(version: string, result: CheckResult, root: string, env: Record<string, string | undefined>): object {
  const rules = [...new Set(result.violations.map((v) => v.rule))];
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'slopbuckets', version, informationUri: HOMEPAGE, rules: rules.map((id) => ({ id, shortDescription: { text: RULES[id].detects } })) } },
        invocations: [
          {
            executionSuccessful: result.environment.length === 0,
            toolExecutionNotifications: result.environment.map((e) => ({ level: 'error', message: { text: renderEnvironment(e) } })),
          },
        ],
        results: result.violations.map((v: Violation) => {
          const at = violationLocation(v);
          return {
            ruleId: v.rule,
            level: 'error',
            message: { text: renderFull(v) },
            locations: [{ physicalLocation: { artifactLocation: { uri: reportPath(root, env, v.project, at.file) }, ...(at.line !== undefined ? { region: { startLine: at.line } } : {}) } }],
          };
        }),
      },
    ],
  };
}

/* ---------- --base ---------- */

interface Bucket {
  purpose: string;
  public: string[];
  dependsOn: Record<string, string>;
  packages: Record<string, string>;
}

interface Architecture {
  buckets: Map<string, Bucket>;
  projects: string[];
}

interface DiffSection {
  title: string;
  lines: string[];
}

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { ok: run.status === 0, stdout: run.stdout ?? '', stderr: (run.stderr ?? '').trim() };
}

const strings = (value: unknown): Record<string, string> =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};

/** The parts of a config the diff compares. A config that does not parse counts as empty. */
function architectureOf(text: string | null): Architecture {
  let value: Record<string, unknown> = {};
  try {
    const parsed = text === null ? null : parseJson(text);
    if (isRecord(parsed)) value = parsed;
  } catch {
    // an empty architecture
  }
  const buckets = new Map<string, Bucket>();
  const raw = typeof value.buckets === 'object' && value.buckets !== null ? (value.buckets as Record<string, Record<string, unknown> | null>) : {};
  for (const [name, def] of Object.entries(raw)) {
    if (typeof def !== 'object' || def === null) continue;
    const pub = def.public;
    const list = typeof pub === 'string' || (Array.isArray(pub) && pub.every((p) => typeof p === 'string')) ? publicFiles(pub as string | string[]) : [];
    buckets.set(name, { purpose: typeof def.purpose === 'string' ? def.purpose : '', public: list, dependsOn: strings(def.dependsOn), packages: strings(def.packages) });
  }
  const projects = Array.isArray(value.projects) ? value.projects.filter((p): p is string => typeof p === 'string') : [];
  return { buckets, projects };
}

/** The exported names of each file, from the TypeScript adapter, with `contents` in place of the files on disk. */
function exportsOf(projectDir: string, files: string[], contents?: Record<string, string>): Map<string, Set<string>> | string {
  if (files.length === 0) return new Map();
  const response = analyze(projectDir, { abi: ADAPTER_ABI, files, publicFiles: files, ...(contents !== undefined ? { contents } : {}) });
  if ('error' in response) return response.error.message;
  return new Map(files.map((f) => [f, new Set(response.files[f]?.exports?.names.map((n) => n.name) ?? [])]));
}

const quoted = (text: string): string => JSON.stringify(text);

/** The lines that describe how one bucket map changed into another: added, removed and changed entries with reasons. */
function mapLines(before: Record<string, string>, after: Record<string, string>, added: (k: string, r: string) => string, removed: (k: string, r: string) => string, changed: (k: string) => string): string[] {
  const lines: string[] = [];
  for (const [key, reason] of Object.entries(after)) {
    if (!(key in before)) lines.push(added(key, reason));
    else if (before[key] !== reason) lines.push(`${changed(key)} from ${quoted(before[key]!)} to ${quoted(reason)}`);
  }
  for (const [key, reason] of Object.entries(before)) if (!(key in after)) lines.push(removed(key, reason));
  return lines;
}

/** What changed in one project between its config at `ref` and the working tree. */
function projectLines(root: string, project: string, ref: string, base: Architecture, head: Architecture): string[] {
  const lines: string[] = [];
  const names = [...new Set([...base.buckets.keys(), ...head.buckets.keys()])].sort();
  const none: Bucket = { purpose: '', public: [], dependsOn: {}, packages: {} };
  for (const name of names) {
    const before = base.buckets.get(name);
    const after = head.buckets.get(name);
    if (after === undefined) {
      lines.push(`Removed bucket \`${name}\`: ${before!.purpose}`);
      continue;
    }
    if (before === undefined) lines.push(`Added bucket \`${name}\`: ${after.purpose}`);
    else if (before.purpose !== after.purpose) lines.push(`Changed the purpose of \`${name}\` from ${quoted(before.purpose)} to ${quoted(after.purpose)}`);
    const old = before ?? none;
    lines.push(
      ...mapLines(
        old.dependsOn,
        after.dependsOn,
        (to, reason) => `Added the dependency of \`${name}\` on \`${to}\`: ${reason}`,
        (to, reason) => `Removed the dependency of \`${name}\` on \`${to}\`: ${reason}`,
        (to) => `Changed the reason of the dependency of \`${name}\` on \`${to}\``,
      ),
      ...mapLines(
        old.packages,
        after.packages,
        (pkg, reason) => `Added the package \`${pkg}\` to \`${name}\`: ${reason}`,
        (pkg, reason) => `Removed the package \`${pkg}\` from \`${name}\`: ${reason}`,
        (pkg) => `Changed the reason of the package \`${pkg}\` in \`${name}\``,
      ),
    );
    if (before !== undefined && before.public.join('\n') !== after.public.join('\n')) {
      const list = (files: string[]) => (files.length === 0 ? 'none' : files.join(', '));
      lines.push(`Changed the public files of \`${name}\` from ${list(before.public)} to ${list(after.public)}`);
    }
  }

  // The exports of every public file, at the ref (read from git) and now. A file that was not public counts as empty.
  const owner = (arch: Architecture): Map<string, string> => new Map([...arch.buckets].flatMap(([name, b]) => b.public.map((f) => [f, name] as const)));
  const oldOwner = owner(base);
  const newOwner = owner(head);
  const projectDir = path.join(root, project);
  if (!existsSync(projectDir) || (oldOwner.size === 0 && newOwner.size === 0)) return lines;
  const prefix = project === '.' ? '' : `${project}/`;
  const contents: Record<string, string> = {};
  for (const file of oldOwner.keys()) {
    const shown = git(['show', `${ref}:./${prefix}${file}`], root);
    if (shown.ok) contents[file] = shown.stdout;
  }
  const before = exportsOf(projectDir, Object.keys(contents), contents);
  const after = exportsOf(
    projectDir,
    [...newOwner.keys()].filter((f) => existsSync(path.join(projectDir, f))),
  );
  if (typeof before === 'string' || typeof after === 'string') {
    lines.push(`Could not compare the exports of the public files: ${typeof before === 'string' ? before : after}`);
    return lines;
  }
  for (const file of [...new Set([...oldOwner.keys(), ...newOwner.keys()])].sort()) {
    const was = before.get(file) ?? new Set<string>();
    const now = after.get(file) ?? new Set<string>();
    const bucket = newOwner.get(file) ?? oldOwner.get(file)!;
    for (const name of [...now].sort()) if (!was.has(name)) lines.push(`Added the export \`${name}\` to ${file}, a public file of \`${bucket}\``);
    for (const name of [...was].sort()) if (!now.has(name)) lines.push(`Removed the export \`${name}\` from ${file}, a public file of \`${bucket}\``);
  }
  return lines;
}

/**
 * The architecture diff between the config at `ref` and the working tree, for the root project and, when `recursive`,
 * every nested project listed at either side. `problem` is set when the ref cannot be read.
 */
export function architectureDiff(root: string, ref: string, recursive: boolean): { sections: DiffSection[]; problem?: string } {
  const verified = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root);
  if (!verified.ok) return { sections: [], problem: `buckets check --base: ${ref} is not a commit in the git repository of ${root}, so there is no architecture diff.` };
  const sections: DiffSection[] = [];
  const visit = (project: string): void => {
    const prefix = project === '.' ? '' : `${project}/`;
    const shown = git(['show', `${ref}:./${prefix}${CONFIG_FILE}`], root);
    const file = path.join(root, project, CONFIG_FILE);
    const base = architectureOf(shown.ok ? shown.stdout : null);
    const head = architectureOf(existsSync(file) ? readFileSync(file, 'utf8') : null);
    const lines = projectLines(root, project, ref, base, head);
    if (lines.length > 0) sections.push({ title: project === '.' ? `Architecture changes since ${ref}:` : `Architecture changes in ${project} since ${ref}:`, lines });
    if (!recursive) return;
    for (const nested of [...new Set([...base.projects, ...head.projects])]) visit(path.posix.join(prefix, nested).replace(/\/$/, ''));
  };
  visit('.');
  return { sections };
}
