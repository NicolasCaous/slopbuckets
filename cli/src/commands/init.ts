// `buckets init`: an empty buckets.config.json, `.buckets/` in .gitignore, the hooks of each agent harness, AGENTS.md
// and the skill, and an optional git pre-commit hook. It ends with the warnings it cannot fix itself and the prompt
// that hands the project to a coding agent.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { stderrStyle, type Context, type Io } from '../context/index.js';
import { CONFIG_FILE, CONFIG_VERSION, EXIT_CODES, FIRST_ARCHITECTURE_SECTION, SCHEMA_URL, type BucketsConfigV2 } from '../contract/index.js';
import { isRecord, parseJson } from '../files/index.js';
import { DEFAULT_AGENT, findAdapter, harnesses, resolveAgents } from '../hooks/agents.js';
import {
  gitTopLevel,
  installGitHook,
  installInstructions,
  LOCAL_SCRIPT,
  SHARED_SKILL,
  stampSkill,
  typedCommand,
  writeProjectFile,
  type HarnessInfo,
  type InstallOptions,
  type InstallStep,
} from '../hooks/index.js';
import { highlightCode, message, wrap } from '../output/index.js';
import { findSkillSource } from '../skill-source.js';
import { renderSplash } from '../splash.js';
import { cliCommand, packageVersion } from '../update/index.js';
import { olderThanConfig, resolveCommand, runningScript, typescriptInUse } from './doctor.js';
import { checklist, parseCommand } from './io.js';

export interface InitOptions {
  /** Overrides the skill file to copy. Tests use it. */
  skillSource?: string | null;
}

/** Top-level keys that only a 1.x config has. */
const V1_KEYS = ['root', 'alias', 'layout', 'access'];

export const EMPTY_CONFIG: BucketsConfigV2 = { $schema: SCHEMA_URL, version: CONFIG_VERSION, ignore: [], projects: [], buckets: {} };

/** The folder of the cache and the session state. */
const STATE_DIR = '.buckets/';

/** The prompt that installs slopbuckets with a coding agent, in docs/guide/install-with-an-agent.md. init has done that part. */
export const AGENT_PROMPT =
  'Install slopbuckets in this project and build its first architecture. Read https://nicolascaous.github.io/slopbuckets/llms.txt and follow the steps for agents.';

/** The prompt init prints after it set up a project with no buckets yet. `check` is the check command the agent types. */
export function firstArchitecturePrompt(check: string): string {
  return `slopbuckets is set up in this project. Build its first architecture as the section "${FIRST_ARCHITECTURE_SECTION}" of ${SHARED_SKILL.split(path.sep).join('/')} says, and run \`${check}\` until it exits with 0.`;
}

const USAGE = 'Usage: buckets init [--agent <name>[,<name>...] | --agent auto] [--git-hook | --no-git-hook] [--root]';
const OPTIONS = {
  agent: { type: 'string', multiple: true },
  'git-hook': { type: 'boolean' },
  'no-git-hook': { type: 'boolean' },
  // init asks nothing, so --yes changes nothing. It stays accepted for scripts written for 1.x.
  yes: { type: 'boolean', short: 'y' },
  root: { type: 'boolean' },
} as const;

/** init has no violations: 1 means that setup did not finish. */
const FAILED = EXIT_CODES.violations;

export async function initCommand(ctx: Context, io: Io, args: string[], options: InitOptions = {}): Promise<number> {
  const parsed = parseCommand(io, 'init', USAGE, args, OPTIONS);
  if (typeof parsed === 'number') return parsed;
  const usageError = (text: string): number => {
    io.stderr(`${stderrStyle(io).error('buckets init:')} ${text} ${USAGE}\n`);
    return EXIT_CODES.usage;
  };
  const agentValues = (parsed.values.agent as string[] | undefined) ?? [];
  if (agentValues.some((value) => value.trim() === '')) return usageError('--agent needs a value, such as `--agent claude`, `--agent claude,codex` or `--agent auto`.');
  // The last of --git-hook and --no-git-hook wins.
  const gitHook = args.lastIndexOf('--git-hook') > args.lastIndexOf('--no-git-hook');

  const projectDir = io.cwd;
  // The harnesses to install, resolved before anything is written, so an unknown name changes nothing.
  const agents = resolveAgents(agentValues.length > 0 ? agentValues.join(',') : DEFAULT_AGENT, projectDir);
  if (agents.unknown.length > 0) {
    return usageError(
      `unknown agent ${agents.unknown.map((name) => `"${name}"`).join(', ')}. Known agents: ${harnesses().map((h) => h.name).join(', ')}, or auto for every agent whose folder or file is here. Nothing was written.`,
    );
  }

  // A 1.x config stops init before anything is written, since the hooks would deny every edit while it is there.
  const configFile = path.join(projectDir, CONFIG_FILE);
  const existing = existsSync(configFile) ? readFileSync(configFile, 'utf8') : null;
  const v1Keys = existing === null ? [] : v1KeysOf(existing);
  if (v1Keys.length > 0) {
    io.stderr(
      `buckets init: ${CONFIG_FILE} is a slopbuckets 1.x config (it has ${v1Keys.map((k) => `"${k}"`).join(', ')}). ` +
        'slopbuckets 2.0 replaces it: there is no root folder, alias, layout or access anymore, and each bucket declares its files, its public file and its dependencies with a reason. ' +
        'init does not convert a 1.x config. Rename it, for example to buckets.config.1x.json, run `buckets init` again, and let your agent design the buckets from the code. Nothing was written.\n',
    );
    return FAILED;
  }

  const say = checklist(io);
  const { out } = say;
  if (out.tty) io.stdout(renderSplash(ctx.cliVersion, io.terminal?.columns, out));
  io.stdout(`Setting up slopbuckets in ${out.path(projectDir)}\n\n`);

  let exitCode: number = EXIT_CODES.ok;
  const report = (steps: InstallStep[]): void => {
    for (const step of steps) {
      say[step.status](step.text);
      if (step.status === 'failed') exitCode = FAILED;
    }
  };

  // The hooks run slopbuckets the way this copy was installed: `buckets` for a global install, the project's own copy
  // by its path for a project dependency or for a copy run by its path from inside the project, such as a checkout.
  // A project with its own copy in node_modules keeps its hooks on that copy whatever copy runs init.
  const { script, kept } = hookScript(io, projectDir);
  const command = cliCommand(script);
  const check = `${typedCommand(command)} check`;
  const top = gitTopLevel(projectDir);
  const nested = top !== null && path.relative(top, path.resolve(projectDir)) !== '';
  const skillSource = options.skillSource === undefined ? findSkillSource() : options.skillSource;
  const skill = skillSource === null ? null : stampSkill(readFileSync(skillSource, 'utf8'), ctx.cliVersion);

  report([writeConfig(configFile, existing !== null), addToGitignore(projectDir), ...(kept === null ? [] : [kept])]);
  for (const harness of agents.harnesses) report(installHarness(harness, projectDir, { skill, command }));
  if (nested && parsed.values.root === true) {
    // The same hooks at the top folder, where a session opened at the top of the repository reads them.
    const topCommand = cliCommand(hookScript(io, top).script);
    for (const harness of agents.harnesses) report(installHarness(harness, top, { skill, command: topCommand }));
  }
  if (agents.auto && agents.harnesses.length === 0) {
    say.todo('Found no agent folder or file here, such as .codex, .cursor or GEMINI.md, so no hooks were installed. Run `buckets init --agent <name>` to choose an agent.');
  }
  report(installInstructions(projectDir, skill, command));
  if (gitHook) report(installGitHook(projectDir, script ?? undefined));
  // The structural merge driver of buckets.config.json, so parallel branches that add buckets merge cleanly.
  report((await import('./merge-driver.js')).installMergeDriver(projectDir, command));

  for (const warning of setupWarnings(io, projectDir, command, ctx.cliVersion, nested && parsed.values.root !== true ? top : null)) say.todo(warning);

  const closing =
    exitCode !== 0
      ? `${out.bold(out.error('Setup finished with problems.'))} Fix the items marked above and run \`buckets init\` again.`
      : existing === null
        ? `${out.bold('Next:')} let your agent design the buckets in ${CONFIG_FILE}. Every file starts as unowned, and \`${check}\` lists them grouped by folder.`
        : `${out.bold('Next:')} run \`${check}\`.`;
  io.stdout(`\n${wrap(highlightCode(out, closing), out.width, '').join('\n')}\n`);
  if (exitCode === 0 && (existing === null || noBuckets(existing))) io.stdout(`\nPaste this prompt into your coding agent:\n\n  ${firstArchitecturePrompt(check)}\n`);
  return exitCode;
}

/**
 * The CLI script the hooks of `dir` run, relative to `dir`: the running copy when it is the project's own or a copy
 * inside the project, else the project's own copy in node_modules when there is one, so that an init run from a global
 * copy or by npx never swaps a project install for a global `buckets`. `kept` says so then.
 */
function hookScript(io: Io, dir: string): { script: string | null; kept: InstallStep | null } {
  const script = runningScript(io, dir);
  if (script !== null || !existsSync(path.join(dir, LOCAL_SCRIPT))) return { script, kept: null };
  const version = packageVersion(path.join(dir, 'node_modules', 'slopbuckets'));
  return {
    script: LOCAL_SCRIPT,
    kept: { status: 'kept', text: `The hooks run the project's own slopbuckets${version === null ? '' : ` ${version}`} in node_modules (\`${cliCommand(LOCAL_SCRIPT)}\`), not the copy that runs this init` },
  };
}

/** True when the config text has no bucket, or is not a JSON object with buckets. */
function noBuckets(text: string): boolean {
  try {
    const value = parseJson(text);
    return !isRecord(value) || !isRecord(value.buckets) || Object.keys(value.buckets).length === 0;
  } catch {
    return true;
  }
}

/**
 * What init could not fix itself and the human should know: no tsconfig.json, a hook command that will not be found
 * or that runs another slopbuckets version than this one, a
 * TypeScript of the project that slopbuckets will not use, and hooks in a folder below the top of the repository,
 * which an agent session opened at the top does not read (`top` is set then). None of them fails init.
 */
function setupWarnings(io: Io, projectDir: string, command: string, cliVersion: string, top: string | null): string[] {
  const warnings: string[] = [];
  if (!existsSync(path.join(projectDir, 'tsconfig.json'))) {
    warnings.push('There is no tsconfig.json here, and `buckets check` needs one. Create it, for example with `npx -p typescript@6 tsc --init`. The project does not need the typescript package.');
  }
  const found = resolveCommand(command, projectDir, io.env, io.updates?.platform ?? process.platform);
  if (found === null) {
    warnings.push(
      command === 'buckets'
        ? 'The hooks run `buckets`, which is not on PATH here, so they would fail without a word. Install slopbuckets with `npm install -g slopbuckets`, or add it to the devDependencies and run its `buckets init`, which writes the path of the project copy.'
        : `The hooks run \`${command}\`, and that file does not exist, so they would fail without a word. Install the project dependencies, then run \`buckets init\` again.`,
    );
  } else if (found.version !== null && found.version !== cliVersion) {
    const older = olderThanConfig(found.version, CONFIG_VERSION);
    warnings.push(
      `The hooks run \`${command}\`, which is slopbuckets ${found.version} in ${found.file}, not this slopbuckets ${cliVersion}, ${older ? `and older than version "${CONFIG_VERSION}" of ${CONFIG_FILE}, so they cannot check the project` : 'so they would check the project with another version than the skill describes'}. ` +
        (typedCommand(command) === 'npx buckets'
          ? `Run \`npx buckets init\` to copy the skill of that version, or update the project's slopbuckets to ${cliVersion}.`
          : `Install slopbuckets ${cliVersion} globally with \`npm install -g slopbuckets@${cliVersion}\`, or add it to the devDependencies and run its \`buckets init\`.`),
    );
  }
  const typescript = typescriptInUse(projectDir);
  if (typescript.warning) warnings.push(typescript.text);
  if (top !== null) {
    warnings.push(
      `This folder is below the top of its git repository, ${top}. An agent session opened at the top folder does not read the hooks of this folder, such as .claude/settings.json, so they run only in a session opened here. Run \`buckets init --root\` to install the agent hooks at the top folder as well.`,
    );
  }
  return warnings;
}

/** The 1.x keys at the top level of the config text, or none when the text is not a JSON object. */
function v1KeysOf(text: string): string[] {
  try {
    // A byte order mark would make JSON.parse throw, and a 1.x config would then pass as "not JSON".
    const value = parseJson(text);
    if (!isRecord(value)) return [];
    return V1_KEYS.filter((key) => key in value);
  } catch {
    return [];
  }
}

/** Writes the empty v2 config. An existing config is never overwritten. */
function writeConfig(configFile: string, exists: boolean): InstallStep {
  if (exists) {
    return { status: 'kept', text: `${CONFIG_FILE} already exists, so init left it as it is. Edit it, or delete it and run \`buckets init\` again for an empty one.` };
  }
  try {
    writeProjectFile(path.dirname(configFile), configFile, `${JSON.stringify(EMPTY_CONFIG, null, 2)}\n`);
    return { status: 'done', text: `Created ${CONFIG_FILE} with no buckets` };
  } catch (error) {
    return { status: 'failed', text: `Could not write ${CONFIG_FILE}: ${message(error)}` };
  }
}

/** Adds `.buckets/` to .gitignore, creating the file when it is missing. */
function addToGitignore(projectDir: string): InstallStep {
  const file = path.join(projectDir, '.gitignore');
  try {
    const exists = existsSync(file);
    const current = exists ? readFileSync(file, 'utf8') : '';
    const present = current.split(/\r?\n/).some((line) => ['.buckets', '.buckets/', '/.buckets', '/.buckets/'].includes(line.trim()));
    if (present) return { status: 'kept', text: `${STATE_DIR} is already in .gitignore` };
    const eol = current.includes('\r\n') ? '\r\n' : '\n';
    const separator = current === '' || current.endsWith('\n') ? '' : eol;
    writeProjectFile(projectDir, file, `${current}${separator}${STATE_DIR}${eol}`);
    return { status: 'done', text: exists ? `Added ${STATE_DIR} to .gitignore` : `Created .gitignore with ${STATE_DIR}` };
  } catch (error) {
    return { status: 'failed', text: `Could not update .gitignore: ${message(error)}` };
  }
}

/** The hooks of one harness, or a note when slopbuckets has no adapter for it yet. */
function installHarness(harness: HarnessInfo, projectDir: string, options: InstallOptions): InstallStep[] {
  const adapter = findAdapter(harness.name);
  if (adapter !== undefined) return adapter.install(projectDir, options);
  return [
    {
      status: 'todo',
      text: `slopbuckets has no hooks for ${harness.title} yet. It reads the rules from AGENTS.md and the skill. Run \`buckets check\` in CI or in the git hook (\`--git-hook\`) to catch what it breaks.`,
    },
  ];
}
