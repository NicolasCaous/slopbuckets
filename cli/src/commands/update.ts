// `buckets update`: installs another version of the slopbuckets CLI, the way the running CLI was installed. A human
// runs it. In a terminal it asks before it installs; elsewhere it installs only with --yes. After the install it reads
// the version on disk, so a package manager that wrote to another folder does not pass for a success.
import path from 'node:path';
import { readLock } from '../core/lock.js';
import { LOCK_FILE } from '../core/paths.js';
import { findProjectDir } from '../core/project.js';
import type { Context } from '../core/types.js';
import {
  binTarget,
  compareVersions,
  detectInstall,
  fetchVersion,
  findOnPath,
  formatCommand,
  type Install,
  globalLocationQuery,
  installArgs,
  installedPackageDir,
  isVersion,
  PACKAGE_NAME,
  packageVersion,
  registryUrl,
  samePackage,
  samePath,
  voltaInUse,
  windowsCommandLine,
  writable,
  writeUpdateCache,
} from '../core/update.js';
import { stderrStyle, stdoutStyle, type Io } from './io.js';

export const UPDATE_USAGE = 'Usage: buckets update [<version>] [--check] [--json] [--yes]\n';
/** `buckets update` waits longer than the check, because a human asked for it. */
const REGISTRY_TIMEOUT_MS = 10_000;

export async function updateCommand(ctx: Context, io: Io, args: string[]): Promise<number> {
  const err = stderrStyle(io);
  let check = false;
  let json = false;
  let yes = false;
  let wanted: string | undefined;
  for (const arg of args) {
    if (arg === '--check') check = true;
    else if (arg === '--json') json = true;
    else if (arg === '--yes' || arg === '-y') yes = true;
    else if (!arg.startsWith('-') && wanted === undefined) wanted = arg.replace(/^v(?=\d)/, '');
    else {
      io.stderr(`${err.error('buckets update:')} unknown option "${arg}".\n${UPDATE_USAGE}`);
      return 1;
    }
  }
  if (wanted !== undefined && !isVersion(wanted)) {
    io.stderr(`${err.error('buckets update:')} "${wanted}" is not a version. Pass a full version such as 1.1.0.\n${UPDATE_USAGE}`);
    return 1;
  }
  // With --json, a failure is a JSON object with an `error` field on stdout, so a script that parses stdout gets one.
  const fail = (message: string, exitCode: number): number => {
    if (json) io.stdout(`${JSON.stringify({ error: message }, null, 2)}\n`);
    else io.stderr(`${err.error('buckets update:')} ${message}\n`);
    return exitCode;
  };
  const deps = io.updates;
  if (deps === undefined) return fail('this process cannot reach the registry or run a package manager.', 3);

  const installed = ctx.cliVersion;
  const registry = registryUrl(io.env);
  let latest: string;
  let target: string;
  try {
    [latest, target] = await Promise.all([
      fetchVersion(deps.fetch, registry, 'latest', REGISTRY_TIMEOUT_MS),
      wanted === undefined ? Promise.resolve('') : fetchVersion(deps.fetch, registry, wanted, REGISTRY_TIMEOUT_MS),
    ]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(`cannot read the versions of ${PACKAGE_NAME}: ${reason}. Check the network, or set npm_config_registry to the registry you use.`, 1);
  }
  writeUpdateCache(deps.cacheDir, { registry, checkedAt: deps.now(), latest });
  if (target === '') target = latest;

  const platform = deps.platform;
  const install = detectInstall(deps.packageDir, io.cwd, { platform, env: io.env });
  const argv = installArgs(install, target);
  const command = argv === null ? null : formatCommand(argv, platform);
  const updateAvailable = compareVersions(latest, installed) > 0;
  if (json) {
    // --json only reports: the output of a package manager would break the JSON.
    const report = { installed, latest, updateAvailable, install: { scope: install.scope, manager: install.manager, command, dir: install.dir, prefix: install.prefix } };
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  const out = stdoutStyle(io);
  io.stdout(`Installed: ${PACKAGE_NAME} ${installed}\nLatest:    ${PACKAGE_NAME} ${latest}\n`);
  if (target === installed) {
    io.stdout(`\n${PACKAGE_NAME} ${installed} is already installed. Nothing to do.\n`);
    return 0;
  }
  if (wanted === undefined && !updateAvailable) {
    io.stdout(`\nThe installed version is newer than the latest release. Nothing to do.\n`);
    return 0;
  }

  if (argv === null || command === null) {
    io.stdout(`\nCannot tell how this CLI was installed: ${install.reason ?? 'unknown install'}.\nInstall ${PACKAGE_NAME}@${target} the way you installed this one.\n`);
    return check ? 0 : 1;
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
  if (check) return 0;

  if (platform === 'win32' && windowsCommandLine(argv) === null) {
    io.stdout(`\nNothing installed. A path in the command has a %, ! or " character, which cmd.exe would change, so buckets update does not run it. Run the command yourself in PowerShell, with that path in single quotes.\n`);
    return 1;
  }

  if (!yes) {
    if (!io.isInteractive) {
      io.stdout(`\nNothing installed. Without a terminal to ask in, buckets update installs only with --yes.\n`);
      return 1;
    }
    const prompt = io.openPrompt();
    let answer: string;
    try {
      answer = await prompt.ask(`\nInstall ${PACKAGE_NAME} ${target}? [y/N] `);
    } finally {
      prompt.close();
    }
    if (!/^(y|yes)$/i.test(answer.trim())) {
      io.stdout(`Nothing installed. ${PACKAGE_NAME} ${installed} stays.\n`);
      return 1;
    }
  }

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
    return 1;
  }

  // A package manager can exit with 0 and still leave this copy alone, when it writes to another prefix or folder.
  // The package.json on disk says what the next `buckets` from this folder runs.
  const installedDir = installedPackageDir(install, deps.packageDir);
  const found = packageVersion(installedDir);
  const shell = shellCopy(io.env, platform, installedDir);
  if (found !== target) {
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
      io.stderr(`You cannot write to ${installedDir}. ${elevatedAdvice(platform, command)}\n`);
    }
    if (!advice) io.stderr(`Install ${PACKAGE_NAME} ${target} the way you installed this copy, or remove this copy and use the one that ${tool} updated.\n`);
    return 1;
  }

  io.stdout(`\n${out.tty ? `${out.ok('✓')} ` : ''}Installed ${PACKAGE_NAME} ${target} in ${installedDir}.\n`);
  // A global install is the `buckets` a shell runs. When PATH leads to another copy, the update does not reach it.
  if (install.scope === 'global' && shell?.kind === 'volta' && install.manager !== 'volta') {
    io.stderr(`${err.warn('Warning:')} the shell runs \`buckets\` through the Volta shim ${shell.file}, which runs the copy that Volta installed, not this one. To update that copy, run \`volta install ${PACKAGE_NAME}@${target}\`.\n`);
  } else if (install.scope === 'global' && shell?.kind === 'package') {
    io.stderr(`${err.warn('Warning:')} the shell runs ${shell.file}, which is ${PACKAGE_NAME} ${shell.version ?? 'of an unknown version'} in ${shell.dir}, not the copy this command updated. Remove that copy, or put the folder of this one earlier on PATH.\n`);
  }
  // The lock of a project records the CLI version that approved it, and `buckets check` stops with exit code 3
  // (cli-version) while the installed CLI differs. `buckets refresh` ignores that difference and approves the move.
  const projectDir = findProjectDir(io.cwd);
  const read = projectDir !== null ? readLock(projectDir) : null;
  if (read?.kind === 'ok' && read.lock.cli === target) {
    io.stdout(`The ${LOCK_FILE} of this project already names ${target}, so \`buckets check\` runs as before.\n`);
  } else {
    io.stdout(
      `Each ${LOCK_FILE} records the CLI version that approved it, so \`buckets check\` stops with exit code 3 in a project whose lock names another version. ` +
        `To move a project to ${target}, a human runs \`buckets refresh\` there (an agent asks for it with \`buckets refresh --web\`). The diff shows the version change.\n`,
    );
  }
  return 0;
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
