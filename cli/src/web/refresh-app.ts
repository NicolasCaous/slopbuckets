// The server side of `buckets refresh --web`: the review page, the approve and cancel endpoints, and the rules
// that make an approval count. The page shows a hash of the state it rendered and a confirmation code derived from
// it. Approve recomputes the state, refuses when the hash differs, opens the native dialog, which asks the human to
// type the code from the page, and recomputes once more before it writes the lock: the typed code must be the code
// of the state at that moment. GET requests only read; every decision comes from a token-authenticated POST.
import { LockWriteError, writeLockFile } from '../core/lock.js';
import { configChangeDetail, configChangeLabel, configChangeSign, configRows } from '../core/lock-config.js';
import { LOCK_FILE } from '../core/paths.js';
import type { Context } from '../core/types.js';
import { plural } from '../output/text.js';
import { REFRESH_CSS, REFRESH_JS } from './assets/refresh.js';
import { sanitizeDialogText, type ConfirmDialog, type DialogRequest } from './dialog.js';
import { sharedAssetRoutes } from './layout.js';
import { CODE_LENGTH, evaluateLockState, evaluationCache, normalizeTypedCode, type LockReview, type ReviewState } from './lock-review.js';
import {
  IDLE_MINUTES,
  MAX_LIFETIME_MINUTES,
  renderBlockedPage,
  renderClosedPage,
  renderCurrentPage,
  renderMultiReviewPage,
  renderReviewPage,
  type ProjectSection,
} from './refresh-page.js';
import { asset, htmlPage, json, startWebServer, type WebResponse, type WebServer } from './server.js';

/** `partial`: some projects were approved and the others were not (cancelled, rejected or stopped). */
export type RefreshOutcome = 'approved' | 'rejected' | 'cancelled' | 'timeout' | 'current' | 'interrupted' | 'partial';

export interface RefreshApp {
  server: WebServer;
  /** Resolves once the session has a final outcome and the last response was sent. */
  outcome: Promise<RefreshOutcome>;
  /** Ends the session from outside, for Ctrl+C. */
  interrupt(): void;
}

export interface RefreshAppOptions {
  ctx: Context;
  projectDir: string;
  projectName: string;
  dialog: ConfirmDialog;
  idleTimeoutMs?: number;
  /** The session ends this long after it started, whatever the activity. Defaults to MAX_LIFETIME_MINUTES. */
  maxLifetimeMs?: number;
  /** Time to receive a whole request. Defaults to 10 seconds, so a request held open cannot block approvals. */
  requestTimeoutMs?: number;
  /**
   * The projects with changes to approve, each approved on its own. Defaults to `projectDir` alone. Paths are
   * relative to `projectDir`, `.` for it.
   */
  projects?: { path: string; dir: string }[];
}

const CLOSED_TEXT: Record<RefreshOutcome, { title: string; text: string }> = {
  approved: { title: 'Approved', text: `${LOCK_FILE} is written. You can close this tab.` },
  rejected: { title: 'Not approved', text: `You cancelled in the confirmation window, so ${LOCK_FILE} is unchanged. You can close this tab.` },
  cancelled: { title: 'Cancelled', text: `Nothing was written. ${LOCK_FILE} is unchanged. You can close this tab.` },
  timeout: { title: 'Timed out', text: `No decision in time (${IDLE_MINUTES} minutes without activity, or ${MAX_LIFETIME_MINUTES / 60} hours in all), so this review closed. ${LOCK_FILE} is unchanged.` },
  current: { title: 'Nothing to approve', text: `${LOCK_FILE} already matches the project. You can close this tab.` },
  interrupted: { title: 'Stopped', text: `The command was stopped before a decision. ${LOCK_FILE} is unchanged.` },
  partial: { title: 'Partly approved', text: `Some projects were approved and their ${LOCK_FILE} is written. The others are unchanged. You can close this tab.` },
};

/** How many changed items the native dialog lists before it says how many more the page shows. */
export const DIALOG_ITEMS = 8;

/** The changes of a review as short lines for the native dialog, every name from the project sanitized. */
export function dialogItems(review: LockReview): string[] {
  const name = (text: string): string => sanitizeDialogText(text, 80);
  const lines: string[] = [];
  for (const v of review.versions) lines.push(`~ ${v.label}: ${name(v.before)} to ${name(v.after)}`);
  if (review.config.changed) {
    if (review.config.recorded) {
      lines.push('~ buckets.config.json changed');
      for (const change of review.config.changes) lines.push(`${configChangeSign(change)} config ${configChangeLabel(change)}: ${name(configChangeDetail(change))}`);
    } else {
      lines.push('~ buckets.config.json changed, its old values were not recorded. Approving records:');
      for (const row of configRows(review.config.current)) lines.push(`config ${row.label}: ${name(row.value)}`);
    }
  }
  for (const b of review.buckets.added) lines.push(`+ bucket ${name(b)}`);
  for (const b of review.buckets.removed) lines.push(`- bucket ${name(b)}`);
  for (const row of review.projects) lines.push(`${row.sign} ${row.label} ${name(row.path)}`);
  for (const row of review.links) {
    const symbols = row.symbols ?? [];
    const shown = symbols.slice(0, 4).map((s) => `${s.sign}${name(s.name)}`);
    const more = symbols.length > shown.length ? `, ${symbols.length - shown.length} more` : '';
    lines.push(`${row.sign} ${row.label} ${name(row.path)}${shown.length > 0 ? `: ${shown.join(', ')}${more}` : ''}`);
  }
  for (const row of review.dmz) {
    const sign = row.status === 'created' ? '+' : row.status === 'deleted' ? '-' : '~';
    const what = row.status === 'created' ? 'new DMZ file' : row.status === 'deleted' ? 'DMZ file deleted' : row.status === 'edited' ? 'DMZ file edited' : 'DMZ file';
    const shown = row.symbols.slice(0, 4).map((s) => `${s.sign}${name(s.name)}`);
    const more = row.symbols.length > shown.length ? `, ${row.symbols.length - shown.length} more` : '';
    lines.push(`${sign} ${what} ${name(row.path)}${shown.length > 0 ? `: ${shown.join(', ')}${more}` : ''}`);
  }
  if (review.formatOnly) lines.push(`~ ${LOCK_FILE} format only, same values`);
  return lines.map((line) => sanitizeDialogText(line, 160));
}

/** The text of the native dialog. It never contains the confirmation code, only its length. */
export function dialogRequest(review: LockReview): DialogRequest {
  const folder = sanitizeDialogText(review.project.folder, 60);
  const pkg = sanitizeDialogText(review.project.name, 60);
  const project = `the project "${folder}"${pkg !== folder ? ` (package.json name "${pkg}")` : ''}`;
  const question = review.fresh
    ? `Approve the first lock of ${project}, with ${plural(review.buckets.added.length, 'bucket')} and ${plural(review.dmz.length, 'DMZ file')}?`
    : `Approve ${plural(review.counts.total, 'contract change')} in ${project}?`;
  const where = [`Folder: ${sanitizeDialogText(review.project.dir, 200)}`];
  if (review.project.path !== '.') where.push(`Nested project: ${sanitizeDialogText(review.project.path, 120)}`);
  const items = dialogItems(review);
  const listed = items.slice(0, DIALOG_ITEMS).map((line) => `  ${line}`);
  if (items.length > DIALOG_ITEMS) listed.push(`  and ${items.length - DIALOG_ITEMS} more, listed on the review page`);
  return {
    title: 'slopbuckets approval',
    message: [
      question,
      '',
      ...where,
      '',
      'What this approves:',
      ...listed,
      '',
      `This writes ${LOCK_FILE} in this project and in no other.`,
      '',
      `To approve, type the ${CODE_LENGTH}-character confirmation code shown on the review page in your browser, then click Approve. Click Cancel if you did not review the changes on that page yourself.`,
    ].join('\n'),
  };
}

/** Why the state at approve time cannot be approved with the page's hash, as a response, or null when it can. */
function refusal(state: ReviewState, hash: string): WebResponse | null {
  switch (state.kind) {
    case 'environment':
      return json({ status: 'invalid', message: `buckets check could not run (${state.report.environment?.code ?? 'environment'}), so nothing can be approved. Reload the page to see the message.` }, 409);
    case 'violations':
      return json({ status: 'invalid', message: 'The project now breaks bucket rules, so there is nothing to approve. Reload the page to see the violations.' }, 409);
    case 'current':
      return json({ status: 'stale', message: `${LOCK_FILE} changed after this page loaded and now matches the project. Reload the page.` }, 409);
    case 'review':
      return state.review.hash === hash
        ? null
        : json({ status: 'stale', message: 'The project or the lock changed after this page loaded, so these are not the changes you reviewed. Nothing was written. Reload the page to review the current changes.' }, 409);
  }
}

type Decision = 'approved' | 'rejected' | 'current';

/** The outcome once every project of the session has a decision. */
export function finalOutcome(decisions: Decision[]): RefreshOutcome {
  const approved = decisions.filter((d) => d === 'approved').length;
  const rejected = decisions.filter((d) => d === 'rejected').length;
  if (rejected === 0) return approved > 0 ? 'approved' : 'current';
  return approved > 0 ? 'partial' : 'rejected';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The approve body: the hash the page rendered and, with several projects, which project. */
function parseApproveBody(body: unknown): { hash: string; project: string | null } {
  const value = isObject(body) ? body : {};
  return { hash: typeof value.hash === 'string' ? value.hash : '', project: typeof value.project === 'string' ? value.project : null };
}

/** The state poll body: the hash each project section rendered, by project path. */
function parseStateBody(body: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const value = isObject(body) && isObject(body.projects) ? body.projects : {};
  for (const [project, hash] of Object.entries(value)) if (typeof hash === 'string') out.set(project, hash);
  return out;
}

export const MAX_LIFETIME_MS = MAX_LIFETIME_MINUTES * 60_000;

export async function startRefreshApp(options: RefreshAppOptions): Promise<RefreshApp> {
  const { ctx, dialog } = options;
  const projects = options.projects ?? [{ path: '.', dir: options.projectDir }];
  const multi = projects.length > 1;
  const decisions = new Map<string, Decision>();
  // Analyses and reviews are kept in memory between requests, keyed on the project files and the lock text, so a
  // reload or a state poll does not rerun the adapter and no request writes a cache file.
  const memo = evaluationCache();
  const evaluate = (project: { path: string; dir: string }): Promise<ReviewState> => evaluateLockState(ctx, project.dir, project.path, memo);
  let outcome: RefreshOutcome | undefined;
  let busy = false;
  let dialogAbort: AbortController | undefined;
  let resolveOutcome!: (value: RefreshOutcome) => void;
  const outcomePromise = new Promise<RefreshOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  let server: WebServer;

  /** Records the outcome at once, so later requests see the session as closed, and resolves after the response. */
  function decide(kind: RefreshOutcome, response?: WebResponse): WebResponse | undefined {
    outcome = kind;
    dialogAbort?.abort();
    if (!response) {
      resolveOutcome(kind);
      return undefined;
    }
    return { ...response, onFinish: () => resolveOutcome(kind) };
  }

  const allDecided = (): boolean => projects.every((p) => decisions.has(p.path));
  const finish = (): RefreshOutcome => finalOutcome(projects.map((p) => decisions.get(p.path)!));

  const page = { token: '', projectName: options.projectName };
  const closed = (): WebResponse => json({ status: 'closed', message: CLOSED_TEXT[outcome ?? 'cancelled'].text }, 409);

  async function approve(body: { hash: string; project: string | null }): Promise<WebResponse> {
    const { hash } = body;
    const requested = body.project ?? (multi ? null : projects[0]!.path);
    const project = projects.find((p) => p.path === requested);
    if (project === undefined) {
      return json({ status: 'stale', message: 'This approval does not name a project of this review. Nothing was written. Reload the page.' }, 409);
    }
    if (decisions.has(project.path)) {
      return json({ status: 'stale', message: `${project.path === '.' ? 'This project' : project.path} already has a decision in this review. Nothing was written. Reload the page.` }, 409);
    }
    const before = await evaluate(project);
    if (outcome) return closed();
    const refused = refusal(before, hash);
    if (refused || before.kind !== 'review') return refused!;

    dialogAbort = new AbortController();
    let typed: string | null;
    try {
      typed = await dialog.confirm(dialogRequest(before.review), dialogAbort.signal);
    } catch (error) {
      if (outcome) return closed();
      const detail = error instanceof Error ? error.message : String(error);
      return json({ status: 'error', message: `The confirmation window could not open: ${detail}. Try again, or run buckets refresh in a terminal.` }, 500);
    } finally {
      dialogAbort = undefined;
      server.touch();
    }
    if (outcome) return closed();
    if (typed === null) {
      decisions.set(project.path, 'rejected');
      if (allDecided()) {
        const kind = finish();
        return decide(kind, json({ status: kind === 'partial' ? 'partial' : 'rejected', message: CLOSED_TEXT[kind].text }))!;
      }
      return json({ status: 'project-rejected', project: project.path, message: 'You cancelled in the confirmation window, so the lock of this project is unchanged.' });
    }

    // The dialog can stay open for a while, so the state is checked again right before the write, and the typed
    // code must be the code of that state.
    const after = await evaluate(project);
    if (outcome) return closed();
    const late = refusal(after, hash);
    if (late || after.kind !== 'review') return late!;
    if (normalizeTypedCode(typed) !== after.review.code) {
      return json(
        {
          status: 'wrong-code',
          project: project.path,
          message: `The code typed in the confirmation window is not the code shown on this page, so nothing was written. Approve again and type the ${CODE_LENGTH}-character code exactly as this page shows it.`,
        },
        409,
      );
    }
    try {
      await writeLockFile(project.dir, after.lock);
    } catch (error) {
      if (!(error instanceof LockWriteError)) throw error;
      return json({ status: 'error', message: error.message }, 500);
    }
    decisions.set(project.path, 'approved');
    if (allDecided()) {
      const kind = finish();
      return decide(kind, json({ status: kind === 'partial' ? 'partial' : 'approved', message: CLOSED_TEXT[kind].text }))!;
    }
    return json({ status: 'project-approved', project: project.path, message: `Approved. Wrote ${project.path === '.' ? LOCK_FILE : `${project.path}/${LOCK_FILE}`}.` });
  }

  /** The current state of every project that has no decision yet. Reads only. */
  async function sectionsNow(): Promise<ProjectSection[] | null> {
    const sections: ProjectSection[] = [];
    for (const project of projects) {
      const decision = decisions.get(project.path);
      if (decision !== undefined) {
        sections.push({ ...project, state: { kind: decision } });
        continue;
      }
      const state = await evaluate(project);
      if (outcome) return null;
      sections.push({ ...project, state });
    }
    return sections;
  }

  /** The page for the current state of every project of the session. It changes nothing on the server. */
  async function renderPageNow(): Promise<WebResponse> {
    const sections = await sectionsNow();
    if (sections === null || outcome) return htmlPage(renderClosedPage(page, CLOSED_TEXT[outcome ?? 'cancelled']));
    if (sections.every((s) => s.state.kind === 'approved' || s.state.kind === 'rejected' || s.state.kind === 'current')) {
      // Every project has a decision or an up to date lock. The page's state poll ends the session.
      const kinds = sections.map((s) => s.state.kind as Decision);
      const kind = finalOutcome(kinds);
      return htmlPage(kind === 'current' ? renderCurrentPage(page) : renderClosedPage(page, CLOSED_TEXT[kind]));
    }
    if (!multi) {
      const state = sections[0]!.state as ReviewState;
      return htmlPage(state.kind === 'review' ? renderReviewPage(page, state.review) : renderBlockedPage(page, state as Exclude<ReviewState, { kind: 'review' } | { kind: 'current' }>));
    }
    return htmlPage(renderMultiReviewPage(page, sections));
  }

  /**
   * The page's poll: says whether the state of each project still has the hash the page rendered. The page then
   * shows a banner asking to reload instead of changing what it shows. A project whose lock was approved elsewhere,
   * for example in a terminal, needs nothing more; when every project is decided this way, the session ends.
   */
  async function pollState(rendered: Map<string, string>): Promise<WebResponse> {
    const changed: string[] = [];
    for (const project of projects) {
      if (decisions.has(project.path)) continue;
      const state = await evaluate(project);
      if (outcome) return closed();
      if (state.kind === 'current') {
        decisions.set(project.path, 'current');
        changed.push(project.path);
        continue;
      }
      const hash = state.kind === 'review' ? state.review.hash : null;
      if (hash === null || rendered.get(project.path) !== hash) changed.push(project.path);
    }
    if (allDecided()) {
      const kind = finish();
      return decide(kind, json({ status: kind, message: CLOSED_TEXT[kind].text }))!;
    }
    return json({ status: busy ? 'confirming' : 'waiting', changed });
  }

  server = await startWebServer({
    idleTimeoutMs: options.idleTimeoutMs ?? IDLE_MINUTES * 60_000,
    // Only the page's own requests, which carry the token, count as activity. Anyone who only has the link
    // cannot keep the server alive, and the session ends after MAX_LIFETIME_MINUTES in any case.
    idleResetRequiresToken: true,
    maxLifetimeMs: options.maxLifetimeMs ?? MAX_LIFETIME_MS,
    onIdle: () => {
      if (!outcome) decide('timeout');
    },
    requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
    headersTimeoutMs: options.requestTimeoutMs ?? 10_000,
    keepAliveTimeoutMs: 1_000,
    routes: [
      ...sharedAssetRoutes(),
      { method: 'GET', path: '/assets/refresh.css', handler: asset(REFRESH_CSS, 'text/css; charset=utf-8') },
      { method: 'GET', path: '/assets/refresh.js', handler: asset(REFRESH_JS, 'text/javascript; charset=utf-8') },
      {
        method: 'GET',
        path: '/',
        handler: async () => {
          if (outcome) return htmlPage(renderClosedPage(page, CLOSED_TEXT[outcome]));
          return renderPageNow();
        },
      },
      {
        method: 'POST',
        path: '/api/approve',
        handler: async (req) => {
          if (outcome) return closed();
          // The body is read and checked before the one-dialog lock, so a request that holds its body open cannot
          // block approvals; the server's request timeout disconnects it.
          const body = parseApproveBody(await req.json());
          if (outcome) return closed();
          // One dialog at a time, across every project. The flag is set with no await before it, so two clicks
          // that arrive together cannot both pass this point.
          if (busy) return json({ status: 'busy', message: 'A confirmation window is already open. Answer it first. It can be behind the browser.' }, 409);
          busy = true;
          try {
            return await approve(body);
          } finally {
            busy = false;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/state',
        handler: async (req) => {
          if (outcome) return closed();
          const rendered = parseStateBody(await req.json());
          if (outcome) return closed();
          return pollState(rendered);
        },
      },
      {
        method: 'POST',
        path: '/api/cancel',
        handler: () => {
          if (outcome) return closed();
          const someApproved = [...decisions.values()].includes('approved');
          const kind: RefreshOutcome = someApproved ? 'partial' : 'cancelled';
          return decide(kind, json({ status: 'cancelled', message: CLOSED_TEXT[kind].text }))!;
        },
      },
      {
        method: 'GET',
        path: '/api/status',
        handler: () => json({ status: outcome ?? (busy ? 'confirming' : 'waiting') }),
      },
    ],
  });
  page.token = server.token;

  return {
    server,
    outcome: outcomePromise,
    interrupt() {
      if (!outcome) decide([...decisions.values()].includes('approved') ? 'partial' : 'interrupted');
    },
  };
}
