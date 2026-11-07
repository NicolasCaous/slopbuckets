// `buckets doctor`: checks how slopbuckets is installed and wired into the project, and says how to fix each problem.
// The facts it reads (the command the hooks run, the TypeScript in use) are exported for `buckets init`, which warns
// about the same things when it sets a project up.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Context, Io } from '../context/index.js';
import { CONFIG_FILE, configNewerMessage, configVersionStatus, EXIT_CODES, renderEnvironment } from '../contract/index.js';
import { findProjectDir, isRecord, parseJson } from '../files/index.js';
import { harnesses } from '../hooks/agents.js';
import { GIT_BLOCK_END, GIT_BLOCK_START, gitTopLevel, preCommitPath, skillCopies } from '../hooks/index.js';
import { binTarget, detectInstall, envValue, findOnPath, localScript, packageVersion } from '../update/index.js';
import { checklist, parseCommand } from './io.js';

const USAGE = 'Usage: buckets doctor';

/** One result: `ok`, or a problem whose text ends with how to fix it. */
interface Finding {
  ok: boolean;
  text: string;
}

const pass = (text: string): Finding => ({ ok: true, text });
const fail = (text: string): Finding => ({ ok: false, text });

/* ---------- facts shared with init ---------- */

function platformOf(io: Io): NodeJS.Platform {
  return io.updates?.platform ?? process.platform;
}

/**
 * The CLI script of the running copy relative to `projectDir` when that copy is a project dependency, or a copy
 * outside any node_modules inside `projectDir`, such as `node cli/dist/index.js` in a checkout. Else null (the hooks
 * then run `buckets`), and null too when this process does not know its package folder.
 */
export function runningScript(io: Io, projectDir: string): string | null {
  const deps = io.updates;
  if (deps === undefined) return null;
  const install = detectInstall(deps.packageDir, io.cwd, { platform: deps.platform, env: io.env });
  if (install.scope === 'unknown' && !path.resolve(deps.packageDir).split(path.sep).includes('node_modules')) {
    const script = path.relative(path.resolve(projectDir), path.join(deps.packageDir, 'dist', 'index.js'));
    return script.startsWith('..') || path.isAbsolute(script) ? null : `./${script.split(path.sep).join('/')}`;
  }
  return localScript(install, deps.packageDir, projectDir);
}

/**
 * The folder and version of `node_modules/<name>` as Node finds it from `dir`, walking up, but not above the top of
 * the git repository, since the dependencies of a project live inside it. Null when there is none.
 */
function findPackage(dir: string, name: string): { dir: string; version: string | null } | null {
  // ponytail: plain node_modules lookup, no Yarn Plug'n'Play.
  const top = gitTopLevel(dir);
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const candidate = path.join(current, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return { dir: candidate, version: packageVersion(candidate) };
    if (path.dirname(current) === current || (top !== null && path.relative(top, current) === '')) return null;
  }
}

/**
 * Which TypeScript resolves the imports of the project and why. slopbuckets uses the project's own TypeScript 5 or 6,
 * and its own TypeScript 6 for a project without typescript, with TypeScript 7 (no JavaScript API) or older than 5.
 * `warning` is set when the project has a typescript that will not be used.
 */
export function typescriptInUse(projectDir: string): { text: string; warning: boolean } {
  const found = findPackage(projectDir, 'typescript');
  if (found === null) return { text: 'The project has no typescript package, so slopbuckets resolves imports with its own TypeScript 6.', warning: false };
  const version = found.version ?? 'of an unknown version';
  const major = Number(found.version?.split('.')[0]);
  if (major === 5 || major === 6) return { text: `slopbuckets resolves imports with the project's TypeScript ${version}.`, warning: false };
  const why = major >= 7 ? 'TypeScript 7 has no JavaScript API' : 'slopbuckets needs TypeScript 5 or 6';
  return { text: `The project has TypeScript ${version}, which slopbuckets cannot use because ${why}, so it resolves imports with its own TypeScript 6.`, warning: true };
}

/**
 * The `buckets` that the shell of an agent or of git finds. This process's PATH can hold folders that only its own
 * children get: Volta and npm put the folder of the running node first, and npx and npm scripts add node_modules/.bin
 * folders. A `buckets` there would pass the check and still be missing in the agent's shell, so both are left out.
 */
export function findAgentBuckets(env: Record<string, string | undefined>, platform: NodeJS.Platform, execPath: string = process.execPath): string | null {
  const sep = platform === 'win32' ? ';' : ':';
  const norm = (dir: string): string => {
    const resolved = path.resolve(dir.replace(/^"(.*)"$/, '$1')).replace(/[\\/]+$/, '');
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const node = norm(path.dirname(execPath));
  const dirs = (envValue(env, 'PATH', platform) ?? '').split(sep).filter((dir) => dir !== '' && norm(dir) !== node && !/(^|[\\/])node_modules[\\/]\.bin[\\/]*"?$/i.test(dir));
  return findOnPath('buckets', { PATH: dirs.join(sep), PATHEXT: envValue(env, 'PATHEXT', platform) }, platform);
}

/** True when a slopbuckets `copy` version, such as 1.2.1, is older than the config `version`, such as 2.0. */
export function olderThanConfig(copy: string, version: string): boolean {
  const [a = 0, b = 0] = copy.split('.').map(Number);
  const [c = 0, d = 0] = version.split('.').map(Number);
  return a < c || (a === c && b < d);
}

/**
 * What `command` (`buckets` or `node <script>`) runs from `projectDir`: the file it finds and the slopbuckets version
 * of that copy, null when slopbuckets cannot follow the file, such as a Volta shim. Null when it finds nothing.
 */
export function resolveCommand(command: string, projectDir: string, env: Record<string, string | undefined>, platform: NodeJS.Platform): { file: string; version: string | null } | null {
  let file: string | null;
  if (command === 'buckets') file = findAgentBuckets(env, platform);
  else {
    const script = /^node\s+(.+)$/.exec(command)?.[1]?.replace(/^(["'])(.*)\1$/, '$2');
    // A harness variable such as $CLAUDE_PROJECT_DIR names the project folder.
    file = script === undefined ? null : path.resolve(projectDir, script.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, projectDir));
    if (file !== null && !existsSync(file)) file = null;
  }
  if (file === null) return null;
  const target = binTarget(file, platform);
  return { file, version: target.kind === 'package' ? packageVersion(target.dir) : null };
}

/* ---------- the checks ---------- */

function installFindings(ctx: Context, io: Io, root: string): Finding[] {
  const platform = platformOf(io);
  const onPath = findAgentBuckets(io.env, platform);
  const local = findPackage(root, 'slopbuckets');
  const findings: Finding[] = [];
  let globalVersion: string | null = null;
  if (onPath === null) {
    findings.push(
      local !== null
        ? pass(`\`buckets\` is not on PATH. This project has its own slopbuckets ${local.version ?? ''} in ${local.dir}.`)
        : fail('`buckets` is not on PATH, and the project has no slopbuckets in node_modules. Install it with `npm install --save-dev slopbuckets` or `npm install -g slopbuckets`.'),
    );
  } else {
    const target = binTarget(onPath, platform);
    if (target.kind === 'package') globalVersion = packageVersion(target.dir);
    const what = target.kind === 'package' ? `slopbuckets ${globalVersion ?? 'of an unknown version'} in ${target.dir}` : target.kind === 'volta' ? 'a Volta shim' : 'a shim slopbuckets cannot follow';
    findings.push(pass(`\`buckets\` on PATH is ${onPath}, which runs ${what}.`));
  }
  if (local?.version && globalVersion !== null && local.version !== globalVersion) {
    findings.push(
      fail(`The global \`buckets\` is slopbuckets ${globalVersion}, and the project pins ${local.version}. Run \`npm install -g slopbuckets@${local.version}\`, or remove the global copy so every command runs the project's.`),
    );
  }
  findings.push(pass(`This command is slopbuckets ${ctx.cliVersion}${io.updates !== undefined ? ` in ${path.resolve(io.updates.packageDir)}` : ''}.`));
  return findings;
}

/** The config of `root`, read as JSON, or a finding that says why it cannot be read. */
function readConfig(root: string): { config: Record<string, unknown> } | { finding: Finding } {
  const file = path.join(root, CONFIG_FILE);
  if (!existsSync(file)) return { finding: fail(`There is no ${CONFIG_FILE} in this folder or above. Run \`buckets init\`.`) };
  try {
    const value = parseJson(readFileSync(file, 'utf8'));
    if (isRecord(value)) return { config: value };
  } catch {
    // reported below
  }
  return { finding: fail(`${CONFIG_FILE} is not a JSON object. \`buckets check\` shows where it breaks.`) };
}

/**
 * The projects among `missing` that need a tsconfig.json. The engine asks for one only when a source file of the
 * project is neither ignored nor in a nested project, so a root whose code lives in nested projects needs none. A
 * project the snapshot cannot tell about, because it has an environment error or an invalid config, needs one.
 */
async function needTsconfig(ctx: Context, root: string, missing: string[]): Promise<Set<string>> {
  if (missing.length === 0) return new Set();
  const { projects } = await ctx.engine.snapshot(root);
  return new Set(
    missing.filter((project) => {
      const p = projects.find((s) => s.path === project);
      return p === undefined || p.environment !== null || p.violations.some((v) => v.rule === 'config-invalid') || p.files.some((g) => g.owner.state !== 'ignored');
    }),
  );
}

async function configFindings(ctx: Context, root: string, config: Record<string, unknown>): Promise<Finding[]> {
  const findings: Finding[] = [];
  const version = config.version;
  const status = configVersionStatus(version);
  if (status === 'supported') findings.push(pass(`${CONFIG_FILE} has version "${String(version)}", which slopbuckets ${ctx.cliVersion} reads.`));
  else if (status === 'newer') findings.push(fail(configNewerMessage(String(version), ctx.cliVersion)));
  else findings.push(fail(version === undefined ? `${CONFIG_FILE} has no "version". Add "version": "2.0".` : `${CONFIG_FILE} has version ${JSON.stringify(version)}, which is not a version such as "2.0".`));

  const projects = Array.isArray(config.projects) ? config.projects.filter((p): p is string => typeof p === 'string') : [];
  const missing = ['.', ...projects].filter((project) => !existsSync(path.join(root, project, 'tsconfig.json')));
  const needed = await needTsconfig(ctx, root, missing);
  for (const project of ['.', ...projects]) {
    const shown = project === '.' ? 'tsconfig.json' : `${project}/tsconfig.json`;
    findings.push(
      !missing.includes(project)
        ? pass(`${shown} exists.`)
        : !needed.has(project)
          ? pass(`${shown} does not exist. The project needs none, because each of its source files is ignored or belongs to a nested project.`)
          : fail(`${shown} is missing. Every project with code needs one in its own folder. Create it, for example with \`npx -p typescript@6 tsc --init\`.`),
    );
  }
  findings.push(pass(typescriptInUse(root).text));
  return findings;
}

async function engineFindings(ctx: Context, root: string): Promise<Finding[]> {
  const result = await ctx.engine.checkAll(root, { recursive: true });
  const findings = result.environment.map((e) => fail(renderEnvironment(e)));
  const unresolved = result.violations.filter((v) => v.rule === 'import-unresolved');
  if (unresolved.length === 0) {
    if (result.environment.length === 0) findings.push(pass('Every relative, paths and workspace import resolves.'));
    return findings;
  }
  const kinds = (['workspace', 'paths', 'relative'] as const)
    .map((kind) => [kind, unresolved.filter((v) => v.kind === kind).length] as const)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${kind}`);
  findings.push(
    fail(
      `${unresolved.length} ${unresolved.length === 1 ? 'import does' : 'imports do'} not resolve (${kinds.join(', ')}). Run the install of your package manager so workspace packages are linked, and check the "paths" of tsconfig.json. \`buckets check\` lists each one.`,
    ),
  );
  return findings;
}

function skillFindings(ctx: Context, root: string): Finding[] {
  return skillCopies(root).map(({ file, version }) =>
    version === ctx.cliVersion
      ? pass(`The skill in ${file} is the one of slopbuckets ${version}.`)
      : fail(`The skill in ${file} is ${version === null ? 'from a slopbuckets without a version line' : `from slopbuckets ${version}`}, not ${ctx.cliVersion}. Run \`buckets init\` to copy the current one.`),
  );
}

/** Finds `buckets hook` and `node <script> hook` in the harness files, keyed by command, with the files that hold each. */
function installedHookCommands(root: string): Map<string, string[]> {
  // ponytail: a text search of the harness folders, one level of nesting deep in each; a plugin that builds the
  // command from pieces is missed.
  const found = new Map<string, string[]>();
  const places = new Set(['.agents', ...harnesses().flatMap((h) => h.markers)]);
  const scan = (file: string): void => {
    let text: string;
    try {
      if (statSync(file).size > 1_000_000 || file.endsWith('.md')) return;
      text = readFileSync(file, 'utf8').replace(/\\(["\\/])/g, '$1');
    } catch {
      return;
    }
    for (const match of text.matchAll(/(node\s+(?:"[^"]*"|'[^']*'|\S+)|\bbuckets)\s+hook\b/g)) {
      const command = match[1]!;
      const shown = path.relative(root, file).split(path.sep).join('/');
      const files = found.get(command) ?? [];
      if (!files.includes(shown)) files.push(shown);
      found.set(command, files);
    }
  };
  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      try {
        if (statSync(full).isDirectory()) {
          if (depth < 3 && entry !== 'node_modules') walk(full, depth + 1);
        } else scan(full);
      } catch {
        // gone or unreadable
      }
    }
  };
  for (const place of places) {
    const full = path.join(root, place);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(full, 0);
    else scan(full);
  }
  return found;
}

/** The command each hook runs, whether it is installed, and whether its version is the one of this CLI and of the skill. */
function hookFindings(ctx: Context, io: Io, root: string, configVersion: string | null): Finding[] {
  const commands = installedHookCommands(root);
  if (commands.size === 0) return [pass('No agent hooks of slopbuckets are installed here. `buckets init` installs them.')];
  const skills = skillCopies(root);
  const findings: Finding[] = [];
  for (const [command, files] of commands) {
    const where = files.join(', ');
    const found = resolveCommand(command, root, io.env, platformOf(io));
    if (found === null) {
      findings.push(fail(`The agent hooks in ${where} run \`${command}\`, which is not installed, so they fail without a word. Install slopbuckets, then run \`buckets init\` with the copy the project should use.`));
      continue;
    }
    if (found.version === null) {
      findings.push(pass(`The agent hooks in ${where} run \`${command}\`, which is installed.`));
      continue;
    }
    const fix =
      command === 'buckets'
        ? `Install the same version globally with \`npm install -g slopbuckets@${ctx.cliVersion}\`, or add slopbuckets to the devDependencies and run its \`buckets init\`.`
        : 'Run `buckets init` with the copy the project should use.';
    if (configVersion !== null && olderThanConfig(found.version, configVersion)) {
      findings.push(fail(`The agent hooks in ${where} run \`${command}\`, which is slopbuckets ${found.version} in ${found.file}, older than version "${configVersion}" of ${CONFIG_FILE}, so they cannot check the project. ${fix}`));
      continue;
    }
    // The skill copies of another version, grouped by version.
    const skillsByVersion = new Map<string, string[]>();
    for (const s of skills) if (s.version !== null && s.version !== found.version) skillsByVersion.set(s.version, [...(skillsByVersion.get(s.version) ?? []), s.file]);
    const others = [
      ...(found.version === ctx.cliVersion ? [] : [`this command is slopbuckets ${ctx.cliVersion}`]),
      ...[...skillsByVersion].map(([version, list]) => `the skill in ${list.join(' and ')} is from slopbuckets ${version}`),
    ];
    if (others.length === 0) {
      findings.push(pass(`The agent hooks in ${where} run \`${command}\`, which is slopbuckets ${found.version}.`));
      continue;
    }
    findings.push(fail(`The agent hooks in ${where} run \`${command}\`, which is slopbuckets ${found.version} in ${found.file}, but ${others.join(', and ')}. ${fix}`));
  }
  return findings;
}

function gitHookFinding(io: Io, root: string): Finding[] {
  const where = preCommitPath(root);
  if (where === null) return [];
  const text = existsSync(where.file) ? readFileSync(where.file, 'utf8') : '';
  const start = text.indexOf(GIT_BLOCK_START);
  const end = text.indexOf(GIT_BLOCK_END, start);
  if (start < 0 || end < 0) return [pass('There is no slopbuckets git pre-commit hook. `buckets init --git-hook` installs one.')];
  const block = text.slice(start, end);
  const shown = path.relative(root, where.file).split(path.sep).join('/');
  const script = /^if \[ -f '([^']+)' \]/m.exec(block)?.[1];
  if (script !== undefined && existsSync(path.join(where.top, script))) {
    const runs = /node '([^']+)' check/.exec(block)?.[1] ?? script;
    return [pass(`The git pre-commit hook in ${shown} runs \`node ${runs}\`.`)];
  }
  const onPath = /command -v buckets/.test(block) ? findAgentBuckets(io.env, platformOf(io)) : null;
  if (script === undefined && findPackage(root, 'slopbuckets') !== null) {
    return [fail(`The git pre-commit hook in ${shown} runs a global \`buckets\` before the project's own copy. Run \`buckets init --git-hook\` to rewrite it.`)];
  }
  if (onPath !== null) return [pass(`The git pre-commit hook in ${shown} runs \`buckets\` from ${onPath}.`)];
  return [fail(`The git pre-commit hook in ${shown} finds no slopbuckets, so it skips the check. Install slopbuckets in the project or globally.`)];
}

export async function doctorCommand(ctx: Context, io: Io, args: string[]): Promise<number> {
  const parsed = parseCommand(io, 'doctor', USAGE, args, {});
  if (typeof parsed === 'number') return parsed;
  const root = findProjectDir(io.cwd, io.env) ?? io.cwd;
  const read = readConfig(root);
  const findings = [
    ...installFindings(ctx, io, root),
    ...('finding' in read ? [read.finding] : [...(await configFindings(ctx, root, read.config)), ...(await engineFindings(ctx, root))]),
    ...skillFindings(ctx, root),
    ...hookFindings(ctx, io, root, 'config' in read && typeof read.config.version === 'string' ? read.config.version : null),
    ...gitHookFinding(io, root),
  ];
  const say = checklist(io);
  io.stdout(`buckets doctor in ${say.out.path(root)}\n\n`);
  for (const finding of findings) (finding.ok ? say.done : say.todo)(finding.text);
  const problems = findings.filter((f) => !f.ok).length;
  io.stdout(problems === 0 ? '\nEvery check passes.\n' : `\n${problems} ${problems === 1 ? 'problem' : 'problems'}. Fix ${problems === 1 ? 'it' : 'them'} and run \`buckets doctor\` again.\n`);
  return problems === 0 ? EXIT_CODES.ok : EXIT_CODES.violations;
}
