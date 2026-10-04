// `buckets refresh --web`: the approval flow for agent sessions. It needs no TTY. It runs the same check as
// `buckets refresh`, serves the diff on 127.0.0.1, and writes the lock only after the human confirms in a
// native dialog. Exit codes: 0 approved or nothing to approve, 1 cancelled, rejected, timed out, no GUI or
// broken rules, 3 environment problem.
import { CONFIG_FILE, LOCK_FILE } from '../core/paths.js';
import { findProjectDir } from '../core/project.js';
import { joinReports } from '../core/recursive.js';
import type { Context } from '../core/types.js';
import { diffSummary, formatLockDiff, formatReport, plural } from '../output/text.js';
import { detectDialog, type DialogSupport } from '../web/dialog.js';
import { evaluateTree, projectName, type ProjectState, type ReviewState } from '../web/lock-review.js';
import { startRefreshApp, type RefreshOutcome } from '../web/refresh-app.js';
import { IDLE_MINUTES, MAX_LIFETIME_MINUTES } from '../web/refresh-page.js';
import type { WebServer } from '../web/server.js';
import { stderrStyle, stdoutStyle, type Io } from './io.js';

/** Seams for tests. Production code passes nothing, so the real dialog detection always runs. */
export interface RefreshWebDeps {
  detectDialog?: () => DialogSupport;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
  requestTimeoutMs?: number;
  /** Called once the server listens, with the URL the command printed. */
  onListening?: (server: WebServer) => void;
}

const RESULT: Record<RefreshOutcome, { code: 0 | 1; text: string }> = {
  approved: { code: 0, text: `Approved in the browser. Wrote ${LOCK_FILE}. Commit it together with the DMZ changes it approves.` },
  rejected: { code: 1, text: `Not approved. The human cancelled in the confirmation window, so ${LOCK_FILE} is unchanged.` },
  cancelled: { code: 1, text: `Cancelled in the browser. ${LOCK_FILE} is unchanged.` },
  timeout: { code: 1, text: `No decision in time (${IDLE_MINUTES} minutes without activity on the page, or ${MAX_LIFETIME_MINUTES / 60} hours in all), so the review page closed. ${LOCK_FILE} is unchanged.` },
  current: { code: 0, text: `${LOCK_FILE} already matches the project. Nothing to approve.` },
  interrupted: { code: 1, text: `Stopped before a decision. ${LOCK_FILE} is unchanged.` },
  partial: { code: 1, text: `Only some projects were approved. Their ${LOCK_FILE} is written; the others are unchanged. Run \`buckets check\` to see what still needs approval.` },

};

export async function refreshWebCommand(ctx: Context, io: Io, deps: RefreshWebDeps = {}): Promise<number> {
  const err = stderrStyle(io);
  const out = stdoutStyle(io);
  const projectDir = findProjectDir(io.cwd);
  if (projectDir === null) {
    io.stderr(`${err.error(`No ${CONFIG_FILE}`)} in ${io.cwd} or any parent folder. Run \`buckets init\` first.\n`);
    return 3;
  }

  const support = deps.detectDialog ? deps.detectDialog() : detectDialog({ platform: process.platform, env: io.env });
  if (!support.ok) {
    io.stderr(`${err.error('buckets refresh --web:')} cannot ask for approval on this machine. ${support.reason}\n`);
    return 1;
  }

  // The project and every project nested in it, like `buckets check`. Each one has its own lock.
  const tree = await evaluateTree(ctx, projectDir);
  const many = tree.length > 1;
  const blocked = (kind: 'environment' | 'violations') => tree.filter((p) => p.state.kind === kind);
  const reportOf = (projects: ProjectState[]) =>
    joinReports(projects.map((p) => ({ path: p.path, report: p.state.kind === 'environment' || p.state.kind === 'violations' ? p.state.report : { exitCode: 0, violations: [], lockChanges: [] } })));
  const environment = blocked('environment');
  if (environment.length > 0) {
    io.stderr(formatReport(reportOf(tree), [], { style: err }));
    return 3;
  }
  const violations = blocked('violations');
  if (violations.length > 0) {
    const chains = violations.flatMap((p) => (p.state.kind === 'violations' ? p.state.chains.map((c) => ({ ...c, project: p.path })) : []));
    io.stderr(formatReport(reportOf(tree), chains, { style: err }));
    io.stderr(`\n${err.bold('Nothing to approve yet.')} buckets refresh only approves a state where every rule passes${many ? ' in every project' : ''}. Fix the violations above, then run it again.\n`);
    return 1;
  }
  const pending = tree.filter((p) => p.state.kind === 'review');
  if (pending.length === 0) {
    io.stdout(`${out.tty ? `${out.ok('✓')} ` : ''}${many ? `Every ${LOCK_FILE} already matches its project. Nothing to approve.` : RESULT.current.text}\n`);
    return 0;
  }

  const first = pending[0]!.state as Extract<ReviewState, { kind: 'review' }>;
  const app = await startRefreshApp({
    ctx,
    projectDir,
    projectName: pending[0]!.path === '.' ? first.review.project.name : projectName(projectDir),
    dialog: support.dialog,
    projects: pending.map((p) => ({ path: p.path, dir: p.dir })),
    ...(deps.idleTimeoutMs !== undefined ? { idleTimeoutMs: deps.idleTimeoutMs } : {}),
    ...(deps.maxLifetimeMs !== undefined ? { maxLifetimeMs: deps.maxLifetimeMs } : {}),
    ...(deps.requestTimeoutMs !== undefined ? { requestTimeoutMs: deps.requestTimeoutMs } : {}),
  });

  const stop = (): void => app.interrupt();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    // The diff is for the agent's summary and for a human reading the terminal. The last line is the URL alone,
    // so an agent can copy it without parsing.
    for (const project of pending) {
      const state = project.state as Extract<ReviewState, { kind: 'review' }>;
      const { review } = state;
      const diff = formatLockDiff(state.previous, state.lock, state.changes, out);
      const counts = diffSummary(diff);
      const lockName = project.path === '.' ? LOCK_FILE : `${project.path}/${LOCK_FILE}`;
      if (pending.length > 1 || project.path !== '.') io.stdout(`${out.bold(out.phos(`== Project ${project.path}`))}\n\n`);
      if (review.fresh) {
        io.stdout(`${diff}\n`);
      } else {
        const body = diff === '' ? '  (formatting only)\n' : diff.replace(/^/gm, '  ').replace(/ +$/, '');
        io.stdout(`${out.bold(`${plural(review.counts.total, 'change')} since the last approved ${lockName}${counts !== '' ? ` (${counts})` : ''}`)}\n\n${body}\n`);
      }
    }
    const each = pending.length > 1 ? ` The page has one section per project (${pending.length} projects), each approved on its own.` : '';
    io.stdout(`Open this link in a browser to review and approve.${each} This command waits for the decision and stops after ${IDLE_MINUTES} minutes without activity on the page, or after ${MAX_LIFETIME_MINUTES / 60} hours.\n${app.server.url}\n`);
    deps.onListening?.(app.server);
    const outcome = await app.outcome;
    await app.server.close();
    const result = RESULT[outcome];
    if (result.code === 0) io.stdout(`${out.tty ? `${out.ok('✓')} ` : ''}${result.text}\n`);
    else io.stderr(`${err.tty ? `${err.warn('!')} ` : ''}${result.text}\n`);
    return result.code;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await app.server.close();
  }
}
