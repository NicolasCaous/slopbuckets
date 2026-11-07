// runUpdate(): installs another version of the slopbuckets CLI, the way the running CLI was installed. In a terminal
// it asks before it installs; elsewhere it installs only with `yes`. After the install it reads the version on disk,
// so a package manager that wrote to another folder does not pass for a success. Then it copies the skill of the new
// version over the skill copies of the project. commands/update.ts parses the command line and calls it.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { stderrStyle, stdoutStyle, type Context, type Io } from '../context/index.js';
import { EXIT_CODES } from '../contract/index.js';
import { findProjectDir, samePath } from '../files/index.js';
import { skillCopies, stampSkill, writeProjectFile } from '../hooks/index.js';
import { message } from '../output/index.js';
import {
  binTarget,
  compareVersions,
  detectInstall,
  fetchVersion,
  findOnPath,
  formatCommand,
  globalLocationQuery,
  installArgs,
  installedPackageDir,
  PACKAGE_NAME,
  packageVersion,
  registryUrl,
  samePackage,
  voltaInUse,
  windowsCommandLine,
  writable,
  writeUpdateCache,
  type Install,
  type UpdateDeps,
} from './index.js';

/** `buckets update` waits longer than the check, because someone asked for it. */
const REGISTRY_TIMEOUT_MS = 10_000;
/** update has no violations: 1 means that nothing was installed, or that the install did not take. */
const FAILED = EXIT_CODES.violations;

export interface UpdateOptions {
  /** Print the versions and the install command, and install nothing. */
  check: boolean;
  /** Print the versions as JSON, and install nothing. */
  json: boolean;
  /** Install without asking. */
  yes: boolean;
  /** The version to install, already checked with isVersion. Undefined installs the latest. */
  wanted: string | undefined;
}

/** What runUpdate installs, and how. */
interface Plan {
  deps: UpdateDeps;
  installed: string;
  target: string;
  install: Install;
  /** The install command as arguments, null when the install is unknown. */
  argv: string[] | null;
  command: string | null;
}

export async function runUpdate(ctx: Context, io: Io, options: UpdateOptions): Promise<number> {
  const err = stderrStyle(io);
  // With --json, a failure is a JSON object with an `error` field on stdout, so a script that parses stdout gets one.
  const fail = (message: string, exitCode: number): number => {
    if (options.json) io.stdout(`${JSON.stringify({ error: message }, null, 2)}\n`);
    else io.stderr(`${err.error('buckets update:')} ${message}\n`);
    return exitCode;
  };
  const deps = io.updates;
  if (deps === undefined) return fail('this process cannot reach the registry or run a package manager.', EXIT_CODES.environment);

  const registry = registryUrl(io.env);
  let latest: string;
  let target: string;
  try {
    [latest, target] = await Promise.all([
      fetchVersion(deps.fetch, registry, 'latest', REGISTRY_TIMEOUT_MS),
      options.wanted === undefined ? Promise.resolve('') : fetchVersion(deps.fetch, registry, options.wanted, REGISTRY_TIMEOUT_MS),
    ]);
  } catch (error) {
    const reason = message(error);
    return fail(`cannot read the versions of ${PACKAGE_NAME}: ${reason}. Check the network, or set npm_config_registry to the registry you use.`, FAILED);
  }
  writeUpdateCache(deps.cacheDir, { registry, checkedAt: deps.now(), latest });
  if (target === '') target = latest;

  const install = detectInstall(deps.packageDir, io.cwd, { platform: deps.platform, env: io.env });
  const argv = installArgs(install, target);
  const plan: Plan = { deps, installed: ctx.cliVersion, target, install, argv, command: argv === null ? null : formatCommand(argv, deps.platform) };
  const reported = report(io, plan, latest, options);
  if (reported !== null) return reported;
  if (!(await confirm(io, plan, options.yes))) return FAILED;
  return installPlan(io, plan);
}

/**
 * Prints the versions and the install command. Returns the exit code when runUpdate stops here: for --json and
 * --check, when there is nothing to install, and when the install cannot run. Null when the install goes on.
 */
function report(io: Io, plan: Plan, latest: string, options: UpdateOptions): number | null {
  const { installed, target, install, argv, command } = plan;
  const updateAvailable = compareVersions(latest, installed) > 0;
  if (options.json) {
    // --json only reports: the output of a package manager would break the JSON.
    const report = { installed, latest, updateAvailable, install: { scope: install.scope, manager: install.manager, command, dir: install.dir, prefix: install.prefix } };
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return EXIT_CODES.ok;
  }

  const out = stdoutStyle(io);
  io.stdout(`Installed: ${PACKAGE_NAME} ${installed}\nLatest:    ${PACKAGE_NAME} ${latest}\n`);
  if (target === installed) {
    io.stdout(`\n${PACKAGE_NAME} ${installed} is already installed. Nothing to do.\n`);
    return EXIT_CODES.ok;
  }
  if (options.wanted === undefined && !updateAvailable) {
    io.stdout(`\nThe installed version is newer than the latest release. Nothing to do.\n`);
    return EXIT_CODES.ok;
  }

  if (argv === null || command === null) {
    io.stdout(`\nCannot tell how this CLI was installed: ${install.reason ?? 'unknown install'}.\nInstall ${PACKAGE_NAME}@${target} the way you installed this one.\n`);
    return options.check ? EXIT_CODES.ok : FAILED;
  }
  const where =
    install.manager === 'volta'
      ? `This CLI is a package that Volta installed, and Volta runs it through its shim.`
      : install.scope === 'global'
        ? `This CLI is a global install of ${install.manager}${install.prefix !== null ? ` in the prefix ${install.prefix}` : ''}.`
        : `This CLI is in the ${install.dev ? 'devDependencies' : 'dependencies'} of ${install.dir}, installed with ${install.manager}.`;
  const older = compareVersions(target, installed) < 0 ? ` ${target} is older than the installed version.` : '';
  const local = install.scope === 'local' && install.dir !== null && path.resolve(install.dir) !== path.resolve(io.cwd) ? ' in that folder' : '';
  io.stdout(`\n${where}${older} To install ${PACKAGE_NAME} ${target}, run${local}:\n\n  ${out.path(command)}\n`);
  if (options.check) return EXIT_CODES.ok;

  if (plan.deps.platform === 'win32' && windowsCommandLine(argv) === null) {
    io.stdout(`\nNothing installed. A path in the command has a %, ! or " character, which cmd.exe would change, so buckets update does not run it. Run the command yourself in PowerShell, with that path in single quotes.\n`);
    return FAILED;
  }
  return null;
}

/** True when the install may run: with --yes, or when the person at the terminal says yes. */
async function confirm(io: Io, plan: Plan, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!io.isInteractive) {
    io.stdout(`\nNothing installed. Without a terminal to ask in, buckets update installs only with --yes.\n`);
    return false;
  }
  const prompt = io.openPrompt();
  let answer: string;
  try {
    answer = await prompt.ask(`\nInstall ${PACKAGE_NAME} ${plan.target}? [y/N] `);
  } finally {
    prompt.close();
  }
  if (!/^(y|yes)$/i.test(answer.trim())) {
    io.stdout(`Nothing installed. ${PACKAGE_NAME} ${plan.installed} stays.\n`);
    return false;
  }
  return true;
}

/** Runs the install command, then checks the version on disk and refreshes the skill copies. */
async function installPlan(io: Io, plan: Plan): Promise<number> {
  const { deps, installed, target, install } = plan;
  const argv = plan.argv ?? [];
  const command = plan.command ?? '';
  const platform = deps.platform;
  const err = stderrStyle(io);
  const out = stdoutStyle(io);
  io.stdout(`\n${out.dim(`$ ${command}`)}\n`);
  const runDir = install.dir ?? io.cwd;
  const tool = toolName(install);
  const result = await deps.run(argv, runDir);
  if (result.exitCode !== 0) {
    const program = argv[0] ?? '';
    if (result.exitCode === 127 && install.manager === 'volta') {
      io.stderr(`${err.error('buckets update:')} Volta installed this CLI, so Volta has to update it, but \`volta\` is not on PATH. ${PACKAGE_NAME} ${installed} is still installed. Install Volta or add it to PATH, then run:\n\n  ${command}\n`);
    } else if (result.exitCode === 127) {
      io.stderr(`${err.error('buckets update:')} \`${program}\` is not on PATH. ${PACKAGE_NAME} ${installed} is still installed. Run the command above in a shell where ${program} is on PATH.\n`);
    } else if (/\b(EACCES|EPERM)\b/.test(result.errorOutput)) {
      const folder = install.prefix ?? install.dir ?? installedPackageDir(install, deps.packageDir);
      io.stderr(`${err.error('buckets update:')} ${tool} has no permission to write to ${folder}, which needs elevated rights. ${PACKAGE_NAME} ${installed} is still installed. ${elevatedAdvice(platform, command)}\n`);
    } else {
      io.stderr(`${err.error('buckets update:')} the install command failed with exit code ${result.exitCode}. ${PACKAGE_NAME} ${installed} is still installed.\n`);
    }
    return FAILED;
  }

  // A package manager can exit with 0 and still leave this copy alone, when it writes to another prefix or folder.
  // The package.json on disk says what the next `buckets` from this folder runs.
  const installedDir = installedPackageDir(install, deps.packageDir);
  const found = packageVersion(installedDir);
  const shell = shellCopy(io.env, platform, installedDir);
  if (found !== target) {
    await explainWrongVersion(io, plan, { installedDir, found, shell, runDir, tool });
    return FAILED;
  }

  io.stdout(`\n${out.tty ? `${out.ok('✓')} ` : ''}Installed ${PACKAGE_NAME} ${target} in ${installedDir}.\n`);
  // A global install is the `buckets` a shell runs. When PATH leads to another copy, the update does not reach it.
  if (install.scope === 'global' && shell?.kind === 'volta' && install.manager !== 'volta') {
    io.stderr(`${err.warn('Warning:')} the shell runs \`buckets\` through the Volta shim ${shell.file}, which runs the copy that Volta installed, not this one. To update that copy, run \`volta install ${PACKAGE_NAME}@${target}\`.\n`);
  } else if (install.scope === 'global' && shell?.kind === 'package') {
    io.stderr(`${err.warn('Warning:')} the shell runs ${shell.file}, which is ${PACKAGE_NAME} ${shell.version ?? 'of an unknown version'} in ${shell.dir}, not the copy this command updated. Remove that copy, or put the folder of this one earlier on PATH.\n`);
  }
  refreshSkills(io, installedDir, target);
  return EXIT_CODES.ok;
}

/** Says why the install command succeeded but the copy that ran this command still holds another version. */
async function explainWrongVersion(
  io: Io,
  plan: Plan,
  facts: { installedDir: string; found: string | null; shell: ShellCopy | null; runDir: string; tool: string },
): Promise<void> {
  const { deps, target, install } = plan;
  const { installedDir, found, shell, runDir, tool } = facts;
  const platform = deps.platform;
  const err = stderrStyle(io);
  const holds = found === null ? 'has no package.json with a version' : `still holds ${PACKAGE_NAME} ${found}`;
  io.stderr(`${err.error('buckets update:')} ${tool} finished without an error, but ${installedDir} ${holds}, not ${target}. That folder is the copy of ${PACKAGE_NAME} that ran this command.\n`);
  let advice = false;
  const query = globalLocationQuery(install, installedDir);
  if (query !== null) {
    const printed = await deps.output(query.argv, runDir);
    if (printed !== null && !samePath(printed, query.expected, platform)) {
      io.stderr(`\`${query.argv.join(' ')}\` prints ${printed}, but this CLI is under ${query.expected}. ${tool} may have installed ${target} there instead.\n`);
    }
  }
  if (install.manager !== 'volta' && voltaInUse(deps.packageDir, io.env)) {
    advice = true;
    io.stderr(`Volta manages Node.js on this machine. When \`buckets\` is a Volta shim, Volta runs the copy it installed itself. To update that copy, run:\n\n  volta install ${PACKAGE_NAME}@${target}\n`);
  }
  if (shell?.kind === 'package') {
    advice = true;
    io.stderr(`The shell runs ${shell.file}, which is ${PACKAGE_NAME} ${shell.version ?? 'of an unknown version'} in ${shell.dir}. Keep one copy of ${PACKAGE_NAME} on PATH and remove the others.\n`);
  }
  if (!writable(installedDir)) {
    advice = true;
    io.stderr(`You cannot write to ${installedDir}. ${elevatedAdvice(platform, plan.command ?? '')}\n`);
  }
  if (!advice) io.stderr(`Install ${PACKAGE_NAME} ${target} the way you installed this copy, or remove this copy and use the one that ${tool} updated.\n`);
}

/**
 * Copies the skill of the version just installed over every skill copy of the project in the current folder, so
 * the agent reads the rules of the CLI that now runs. A copy is only replaced, never created.
 */
function refreshSkills(io: Io, installedDir: string, version: string): void {
  const project = findProjectDir(io.cwd, io.env);
  const source = path.join(installedDir, 'skill', 'SKILL.md');
  if (project === null) return;
  const copies = skillCopies(project).filter((copy) => copy.version !== version);
  if (copies.length === 0) return;
  if (!existsSync(source)) {
    io.stderr(`The new install has no skill in ${source}, so the skill copies of the project stay as they are. Run \`buckets init\` to copy the skill.\n`);
    return;
  }
  const skill = stampSkill(readFileSync(source, 'utf8'), version);
  for (const { file } of copies) {
    try {
      writeProjectFile(project, path.join(project, file), skill);
      io.stdout(`Updated the skill in ${file}.\n`);
    } catch (error) {
      io.stderr(`Could not update the skill in ${file}: ${message(error)}. Run \`buckets init\` to copy it.\n`);
    }
  }
}

/** The program that installs, as messages name it. */
function toolName(install: Install): string {
  return install.manager === 'volta' ? 'Volta' : (install.manager ?? 'the package manager');
}

/** How to run `command` with the rights to write to a folder of root or of the administrators. */
function elevatedAdvice(platform: NodeJS.Platform, command: string): string {
  return platform === 'win32' ? `Run the command from an administrator shell:\n\n  ${command}` : `Run the command with sudo:\n\n  sudo ${command}`;
}

type ShellCopy = { kind: 'volta'; file: string } | { kind: 'package'; file: string; dir: string; version: string | null };

/**
 * The copy of slopbuckets that `buckets` runs in a shell with this PATH, when it is not the one in `installedDir`:
 * a Volta shim or another package folder. Null when it is this copy, when PATH has no `buckets`, or when the file on
 * PATH is a shim slopbuckets cannot follow, such as one of asdf or mise.
 */
function shellCopy(env: Record<string, string | undefined>, platform: NodeJS.Platform, installedDir: string): ShellCopy | null {
  const file = findOnPath('buckets', env, platform);
  if (file === null) return null;
  const target = binTarget(file, platform);
  if (target.kind === 'volta') return { kind: 'volta', file };
  if (target.kind === 'package' && !samePackage(target.dir, installedDir, platform)) return { kind: 'package', file, dir: target.dir, version: packageVersion(target.dir) };
  return null;
}
