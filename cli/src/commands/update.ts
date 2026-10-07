// `buckets update`: installs another version of the slopbuckets CLI, the way the running CLI was installed. A human
// runs it. In a terminal it asks before it installs; elsewhere it installs only with --yes.
import path from 'node:path';
import { readLock } from '../core/lock.js';
import { LOCK_FILE } from '../core/paths.js';
import { findProjectDir } from '../core/project.js';
import type { Context } from '../core/types.js';
import { compareVersions, detectInstall, fetchVersion, installCommand, isVersion, PACKAGE_NAME, registryUrl, writeUpdateCache } from '../core/update.js';
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

  const install = detectInstall(deps.packageDir, io.cwd);
  const command = installCommand(install, target);
  const updateAvailable = compareVersions(latest, installed) > 0;
  if (json) {
    // --json only reports: the output of a package manager would break the JSON.
    io.stdout(`${JSON.stringify({ installed, latest, updateAvailable, install: { scope: install.scope, manager: install.manager, command, dir: install.dir } }, null, 2)}\n`);
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

  if (command === null) {
    io.stdout(`\nCannot tell how this CLI was installed: ${install.reason ?? 'unknown install'}.\nInstall ${PACKAGE_NAME}@${target} the way you installed this one.\n`);
    return check ? 0 : 1;
  }
  const where =
    install.scope === 'global'
      ? `This CLI is a global install of ${install.manager}.`
      : `This CLI is in the ${install.dev ? 'devDependencies' : 'dependencies'} of ${install.dir}, installed with ${install.manager}.`;
  const older = compareVersions(target, installed) < 0 ? ` ${target} is older than the installed version.` : '';
  const local = install.scope === 'local' && install.dir !== null && path.resolve(install.dir) !== path.resolve(io.cwd) ? ' in that folder' : '';
  io.stdout(`\n${where}${older} To install ${PACKAGE_NAME} ${target}, run${local}:\n\n  ${out.path(command)}\n`);
  if (check) return 0;

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
  const exit = await deps.run(command, install.dir ?? io.cwd);
  if (exit !== 0) {
    io.stderr(`${err.error('buckets update:')} the install command failed with exit code ${exit}. ${PACKAGE_NAME} ${installed} is still installed.\n`);
    return 1;
  }
  io.stdout(`\n${out.tty ? `${out.ok('✓')} ` : ''}Installed ${PACKAGE_NAME} ${target}.\n`);
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
