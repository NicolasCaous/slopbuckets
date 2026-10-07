import { isSupportedLockVersion, diffLocks, LockWriteError, serializeLock, writeLockFile } from '../core/lock.js';
import { CONFIG_FILE, LOCK_FILE } from '../core/paths.js';
import { findProjectDir } from '../core/project.js';
import { joinReports, runRecursiveCheck } from '../core/recursive.js';
import type { Context } from '../core/types.js';
import { diffSummary, formatLockDiff, formatOnlyNote, formatReport } from '../output/text.js';
import { stderrStyle, stdoutStyle, type Io } from './io.js';
import { refreshWebCommand, type RefreshWebDeps } from './refresh-web.js';

export async function refreshCommand(ctx: Context, io: Io, args: string[], webDeps?: RefreshWebDeps): Promise<number> {
  const err = stderrStyle(io);
  if (args.length === 1 && args[0] === '--web') return refreshWebCommand(ctx, io, webDeps);
  if (args.length > 0) {
    const unknown = args.find((arg) => arg !== '--web') ?? args[0];
    io.stderr(`${err.error('buckets refresh:')} unknown option "${unknown}". Usage: buckets refresh [--web]\n`);
    return 1;
  }
  if (!io.isInteractive) {
    io.stderr(
      'buckets refresh needs an interactive terminal (stdin and stdout must both be a TTY), because a human must approve the contract changes.\n' +
        'AI agents must not run it. Run `buckets refresh --web` in the background instead, send the link it prints to the human, and wait for it to finish.\n',
    );
    return 1;
  }

  const projectDir = findProjectDir(io.cwd);
  if (projectDir === null) {
    io.stderr(`${err.error(`No ${CONFIG_FILE}`)} in ${io.cwd} or any parent folder. Run \`buckets init\` first.\n`);
    return 3;
  }

  // The project and every project nested in it. Each one has its own lock, and the human approves each one.
  const { runs } = await runRecursiveCheck(ctx, projectDir, { ignoreVersions: true });
  const many = runs.length > 1;
  const chains = runs.flatMap((run) => run.result.orphanChains.map((chain) => ({ ...chain, project: run.path })));
  const joined = joinReports(runs.map((run) => ({ path: run.path, report: { ...run.result.report, lockChanges: [] } })));
  if (joined.environment) {
    io.stderr(formatReport(joined, [], { style: err }));
    return 3;
  }
  if (joined.violations.length > 0 || runs.some((run) => !run.result.lock)) {
    io.stderr(formatReport(joined, chains, { style: err }));

    io.stderr(`\n${err.bold('Nothing to approve yet.')} buckets refresh only approves a state where every rule passes${many ? ' in every project' : ''}. Fix the violations above (or ask the AI to fix them), then run it again.\n`);
    return 1;
  }

  const out = stdoutStyle(io);
  let declined = 0;
  let pending = 0;
  for (const run of runs) {
    const next = run.result.lock!;
    const previous = run.result.previousLock && isSupportedLockVersion(run.result.previousLock.lockVersion) ? run.result.previousLock : null;
    const changes = previous ? diffLocks(previous, next) : [];
    const diff = formatLockDiff(previous, next, changes, out);
    const lockName = run.path === '.' ? LOCK_FILE : `${run.path}/${LOCK_FILE}`;
    if (previous && diff === '' && serializeLock(previous) === serializeLock(next)) {
      if (!many) io.stdout(`${out.tty ? `${out.ok('✓')} ` : ''}${LOCK_FILE} is up to date. Nothing to approve.\n`);
      continue;
    }
    pending++;
    if (many) io.stdout(`${out.bold(out.phos(`== Project ${run.path === '.' ? '.' : run.path}`))}\n\n`);
    if (previous) {
      const body = diff === '' ? `  ${formatOnlyNote(previous, next)}\n` : diff.replace(/^/gm, '  ').replace(/ +$/, '');
      const counts = diffSummary(diff);
      io.stdout(`${out.bold(`Changes since the last approved ${lockName}`)}\n\n${body}\n${counts !== '' ? `${out.dim(`  ${counts}.`)}\n\n` : ''}`);
    } else {
      io.stdout(`${diff}\n`);
    }
    const prompt = io.openPrompt();
    let answer: string;
    try {
      answer = await prompt.ask(`Approve and write ${lockName}? [y/N] `);
    } finally {
      prompt.close();
    }
    if (!/^(y|yes)$/i.test(answer.trim())) {
      io.stdout(`Nothing written. ${lockName} is unchanged.\n${many ? '\n' : ''}`);
      declined++;
      continue;
    }
    try {
      await writeLockFile(run.dir, next);
    } catch (error) {
      if (!(error instanceof LockWriteError)) throw error;
      io.stderr(`${error.message}\n`);
      declined++;
      continue;
    }
    io.stdout(`${out.tty ? `${out.ok('✓')} ` : ''}Wrote ${lockName}. Commit it together with the DMZ changes it approves.\n${many ? '\n' : ''}`);
  }
  if (many && pending === 0) io.stdout(`${out.tty ? `${out.ok('✓')} ` : ''}Every ${LOCK_FILE} is up to date in ${runs.length} projects. Nothing to approve.\n`);
  return declined > 0 ? 1 : 0;
}
