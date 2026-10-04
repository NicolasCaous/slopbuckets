// `buckets init`: config, root bucket, adapter setup, the hooks of each agent harness, AGENTS.md and the skill, and an
// optional git pre-commit hook. It never writes the lock.
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ABI_VERSION, type InitRequest, type InitResponse } from '@slopbuckets/adapter-ts';
import { toEnvironmentError } from '../core/check.js';
import { DEFAULT_CONFIG, loadConfig, protocolConfig, SCHEMA_URL, validateConfig, type ResolvedConfig } from '../core/config.js';
import { CONFIG_FILE, relativeToProject, splitBucketPath } from '../core/paths.js';
import { enclosingProjects } from '../core/project.js';
import { nestedProjectsOf } from '../core/recursive.js';

import type { Context } from '../core/types.js';
import { renderSplash } from '../output/splash.js';
import { code, highlightCode, wrap, type Style } from '../output/style.js';
import type { HarnessInfo, InstallStep } from '../hooks/adapter.js';
import { installGitHook } from '../hooks/git-hook.js';
import { installInstructions } from '../hooks/instructions.js';
import { DEFAULT_AGENT, findAdapter, harnesses, resolveAgents } from '../hooks/registry.js';
import { findSkillSource } from '../skill-source.js';
import { stderrStyle, stdoutStyle, type Io } from './io.js';

export { enclosingProjects } from '../core/project.js';

export interface InitOptions {
  /** Overrides the skill file to copy. Tests use it. */
  skillSource?: string | null;
  /** A random integer in [0, max), for the generated alias. Tests use it. */
  random?: (max: number) => number;
}

/** Lowercase letters and digits that cannot be mistaken for each other: no 0, o, 1, l or i. */
export const ALIAS_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const ALIAS_SUFFIX_LENGTH = 8;

/**
 * A unique alias for a new project: `@<root folder>-<8 characters>`, such as `@root-k3x9pm2a`. Projects that link each
 * other import through each other's alias, so two projects must never share one. `taken` lists aliases to avoid.
 */
export function generateAlias(root: string, taken: string[] = [], random: (max: number) => number = randomInt): string {
  const last = root.split('/').filter((s) => s !== '').pop() ?? '';
  const base = last.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
  for (;;) {
    let suffix = '';
    for (let i = 0; i < ALIAS_SUFFIX_LENGTH; i++) suffix += ALIAS_ALPHABET[random(ALIAS_ALPHABET.length)];
    const alias = `@${base}-${suffix}`;
    if (!taken.includes(alias)) return alias;
  }
}

async function askConfig(io: Io, style: Style, defaultAlias: (root: string) => string): Promise<unknown> {
  io.stdout('Three questions. Press Enter to keep the default in brackets.\n\n');
  const prompt = io.openPrompt();
  try {
    const ask = async (question: string, fallback: string): Promise<string> => {
      const answer = (await prompt.ask(`  ${question} ${style.dim(`[${fallback}]`)}: `)).trim();
      return answer === '' ? fallback : answer;
    };
    const root = await ask('Root bucket folder', DEFAULT_CONFIG.root);
    const alias = await ask('Import alias for internal imports (unique, so other projects can link this one)', defaultAlias(root));
    const depth = await ask('Maximum bucket depth (the root bucket is depth 0)', String(DEFAULT_CONFIG.maxDepth));
    return { root, alias, maxDepth: /^\d+$/.test(depth) ? Number(depth) : depth };
  } finally {
    prompt.close();
    io.stdout('\n');
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Checklist lines: a mark, then what happened. The marks are Unicode only on a terminal. */
function checklist(io: Io) {
  const out = stdoutStyle(io);
  const err = stderrStyle(io);
  // On a terminal, long items wrap under their text, past the mark.
  const item = (style: Style, mark: string, text: string): string => {
    const lines = wrap(highlightCode(style, text), style.width, '    ');
    lines[0] = `  ${mark} ${lines[0]!.trimStart()}`;
    return `${lines.join('\n')}\n`;
  };
  return {
    out,
    done: (text: string): void => io.stdout(item(out, out.ok(out.tty ? '✓' : '+'), text)),
    kept: (text: string): void => io.stdout(out.dim(item(out, out.tty ? '·' : '=', text))),
    /** Something left to do by hand. Not a failure: setup goes on and exits with 0. */
    todo: (text: string): void => io.stdout(item(out, out.warn(out.tty ? '!' : '-'), text)),
    failed: (text: string): void => io.stderr(item(err, err.error(err.tty ? '✗' : '!'), text)),
  };
}

/**
 * Prints one entry of the adapter's init answer. A file the adapter did not write is never reported as updated: it is
 * either already set, or set with a note about what to change by hand. `where` is the file as the reader sees it.
 */
function reportChange(say: ReturnType<typeof checklist>, change: InitResponse['changed'][number], where: string): void {
  const notWritten = /^not changed, because /;
  const settled = /^no change written, but /;
  const description = change.description.trim();
  if (change.written === false || notWritten.test(description) || settled.test(description) || description === '' || description === 'not changed') {
    if (settled.test(description)) say.todo(`${where} already set, but ${description.replace(settled, '')}`);
    else if (notWritten.test(description)) say.todo(`Did not change ${where}, because ${description.replace(notWritten, '')}`);
    else say.kept(`${where} already set`);
    return;
  }
  say.done(`Updated ${where}: ${description}`);
}

const USAGE = 'Usage: buckets init [--yes] [--agent <name>[,<name>...] | --agent auto] [--git-hook | --no-git-hook]';

export async function initCommand(ctx: Context, io: Io, args: string[], options: InitOptions = {}): Promise<number> {
  let yes = false;
  let agentValue: string | undefined;
  let gitHook = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg === '--git-hook') gitHook = true;
    else if (arg === '--no-git-hook') gitHook = false;
    else if (arg === '--agent' || arg.startsWith('--agent=')) {
      const value = arg === '--agent' ? args[++i] : arg.slice('--agent='.length);
      if (value === undefined || value.trim() === '' || value.startsWith('-')) {
        io.stderr(`buckets init: --agent needs a value, such as \`--agent claude\`, \`--agent claude,codex\` or \`--agent auto\`. ${USAGE}\n`);
        return 1;
      }
      agentValue = agentValue === undefined ? value : `${agentValue},${value}`;
    } else {
      io.stderr(`buckets init: unknown option "${arg}". ${USAGE}\n`);
      return 1;
    }
  }

  const projectDir = io.cwd;
  // The harnesses to install, resolved before anything is written, so an unknown name changes nothing.
  const agents = resolveAgents(agentValue ?? DEFAULT_AGENT, projectDir);
  if (agents.unknown.length > 0) {
    io.stderr(
      `buckets init: unknown agent ${agents.unknown.map((name) => `"${name}"`).join(', ')}. Known agents: ${harnesses().map((h) => h.name).join(', ')}, or auto for every agent whose folder exists here. Nothing was written.\n`,
    );
    return 1;
  }
  const say = checklist(io);
  const { out } = say;
  const existing = loadConfig(projectDir);

  // Inside another project, the new project is nested: it must live in a subfolder of some bucket's _/ folder.
  const enclosing = enclosingProjects(projectDir);
  const parent = enclosing[0];
  let nested = false;
  if (parent?.config) {
    const rel = relativeToProject(parent.dir, projectDir);
    const split = rel === null ? null : splitBucketPath(parent.config.root, rel);
    if (split !== null) {
      if (split.area !== '_' || split.rest === '') {
        io.stderr(
          `buckets init: ${projectDir} is inside the bucket folder ${parent.config.root}/ of the project ${parent.dir}, but not in a subfolder of a bucket's _/ folder. A nested project may live only there, such as ${parent.config.root}/<bucket>/_/<name>/. Nothing was written. Create that folder and run \`buckets init\` in it.\n`,
        );
        return 1;
      }
      nested = true;
    }
  }
  const takenAliases = enclosing.flatMap((p) => (p.config ? [p.config.alias] : []));
  if (existing.kind === 'invalid') {
    io.stderr(`${CONFIG_FILE} already exists but is invalid:\n${existing.violations.map((v) => `  ${v.message}`).join('\n')}\nFix it and run \`buckets init\` again.\n`);
    return 1;
  }
  if (existing.kind === 'missing' && !yes && !io.isInteractive) {
    io.stderr('buckets init asks questions and needs an interactive terminal. Run `buckets init --yes` to accept the defaults.\n');
    return 1;
  }

  if (out.tty) io.stdout(renderSplash(ctx.cliVersion, io.terminal?.columns, out));
  io.stdout(`Setting up slopbuckets in ${out.path(projectDir)}\n\n`);
  if (nested) {
    io.stdout(
      `${wrap(`This folder is inside the project ${parent!.dir}, so the new project is nested in it. It gets its own config, lock and alias, and the enclosing project's hooks and skill already cover it.`, out.width, '').join('\n')}\n\n`,
    );
  }

  let config: ResolvedConfig;
  if (existing.kind === 'ok') {
    config = existing.config;
    say.kept(`Kept the existing ${CONFIG_FILE}`);
  } else {
    const defaultAlias = (root: string): string => generateAlias(root, takenAliases, options.random);
    const answers = yes ? { alias: defaultAlias(DEFAULT_CONFIG.root) } : await askConfig(io, out, defaultAlias);
    const validated = validateConfig(answers);
    if (!validated.config) {
      io.stderr(`Invalid answer:\n${validated.violations.map((v) => `  ${v.message}`).join('\n')}\nNothing was written. Run \`buckets init\` again.\n`);
      return 1;
    }
    if (takenAliases.includes(validated.config.alias)) {
      io.stderr(
        `The alias "${validated.config.alias}" is already the alias of an enclosing project. A nested project needs its own alias, or its imports would resolve into the wrong project. Nothing was written. Run \`buckets init\` again and choose another alias, such as "${generateAlias(validated.config.root, takenAliases, options.random)}".\n`,
      );
      return 1;
    }
    config = validated.config;
    writeJson(path.join(projectDir, CONFIG_FILE), {
      $schema: SCHEMA_URL,
      adapter: config.adapter,
      root: config.root,
      alias: config.alias,
      maxDepth: config.maxDepth,
    });
    say.done(`Created ${CONFIG_FILE} ${out.dim(`(root "${config.root}", alias "${config.alias}", maxDepth ${config.maxDepth})`)}`);
  }

  const codeDir = path.join(projectDir, config.root, '_');
  if (!existsSync(codeDir)) {
    mkdirSync(codeDir, { recursive: true });
    say.done(`Created ${config.root}/_/ for the code of the root bucket`);
  }

  let exitCode = 0;
  try {
    // Projects already nested in this one stay out of its build.
    const request: InitRequest = { abi: ABI_VERSION, config: protocolConfig(config) };
    const inner = nestedProjectsOf(ctx, projectDir);
    if (inner.length > 0) request.nestedProjects = inner;
    const response = await ctx.adapter.init(projectDir, request);
    for (const change of response.changed) reportChange(say, change, change.file);
  } catch (error) {
    const env = toEnvironmentError(error, config.adapter);
    say.failed(`The ${config.adapter} adapter could not set up the project (${env.code}): ${env.message}`);
    exitCode = 3;
  }

  if (nested) {
    // The enclosing project must not build the new project's files with its own settings: its init keeps every
    // project nested in it, this one included, out of its build. Init is idempotent, so its other settings stay.
    const parentConfig = parent!.config!;
    const rel = relativeToProject(parent!.dir, projectDir) ?? '';
    try {
      const response = await ctx.adapter.init(parent!.dir, {
        abi: ABI_VERSION,
        config: protocolConfig(parentConfig),
        nestedProjects: [...new Set([...nestedProjectsOf(ctx, parent!.dir), rel])].sort(),
      });
      for (const change of response.changed) reportChange(say, change, path.join(parent!.dir, change.file));
    } catch (error) {
      const env = toEnvironmentError(error, parentConfig.adapter);
      say.failed(
        `The ${parentConfig.adapter} adapter could not keep this project out of the build of the enclosing project (${env.code}): ${env.message} Add "${rel}" to "exclude" in the tsconfig.json of ${parent!.dir} by hand.`,
      );
      exitCode = exitCode || 3;
    }
  }

  if (nested) {
    say.kept(`Skipped the Claude Code hooks and the skill, the hooks of other agents and AGENTS.md: the enclosing project ${parent!.dir} has them, and they check nested projects too`);
    if (gitHook) say.kept(`Skipped the git hook: run \`buckets init --git-hook\` in the enclosing project ${parent!.dir}, whose check covers nested projects`);
    const last = exitCode === 0
      ? `${out.bold(out.phos('Next step:'))} run ${code(out, 'buckets refresh')} in ${parent!.dir} to approve the new nested project there and create the buckets.lock.json of this one.`
      : `${out.bold(out.error('Setup finished with problems.'))} Fix the items marked above, run ${code(out, 'buckets init')} again, then run ${code(out, 'buckets refresh')} in ${parent!.dir}.`;
    io.stdout(`\n${wrap(last, out.width, '').join('\n')}\n`);
    return exitCode;
  }

  const skillSource = options.skillSource === undefined ? findSkillSource() : options.skillSource;
  const skill = skillSource === null ? null : readFileSync(skillSource, 'utf8');
  const report = (steps: InstallStep[]): void => {
    for (const step of steps) {
      say[step.status](step.text);
      if (step.status === 'failed') exitCode = exitCode || 1;
    }
  };
  for (const harness of agents.harnesses) report(installHarness(harness, projectDir, skill));
  if (agents.auto && agents.harnesses.length === 0) {
    say.todo('Found no agent folder here, such as .claude, .codex or .cursor, so no hooks were installed. Run `buckets init --agent <name>` to choose an agent.');
  }
  report(installInstructions(projectDir, skill));
  if (gitHook) report(installGitHook(projectDir));

  const last =
    exitCode === 0
      ? `${out.bold(out.phos('Next step:'))} run ${code(out, 'buckets refresh')} in your terminal to approve the current state and create buckets.lock.json.`
      : `${out.bold(out.error('Setup finished with problems.'))} Fix the items marked above, run ${code(out, 'buckets init')} again, then run ${code(out, 'buckets refresh')} to create buckets.lock.json.`;
  io.stdout(`\n${wrap(last, out.width, '').join('\n')}\n`);
  return exitCode;
}

/** The hooks of one harness, or a note when slopbuckets has no adapter for it yet. */
function installHarness(harness: HarnessInfo, projectDir: string, skill: string | null): InstallStep[] {
  const adapter = findAdapter(harness.name);
  if (adapter !== undefined) return adapter.install(projectDir, { skill });
  return [
    {
      status: 'todo',
      text: `slopbuckets has no hooks for ${harness.title} yet. It reads the rules from AGENTS.md and the skill, and \`buckets check\` in CI or in the git hook (\`--git-hook\`) holds them.`,
    },
  ];
}
