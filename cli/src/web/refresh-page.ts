// The review page of `buckets refresh --web`: the diff against the lock in tty boxes, and a decision bar with
// Approve and Cancel. The server renders the whole diff, so the page reads fine before the script loads.
import { formatReport, plural } from '../output/text.js';
import { html, type SafeHtml } from './html.js';
import { renderPage } from './layout.js';
import type { DmzFileRow, ItemRow, LockReview, ReviewState, Sign } from './lock-review.js';


export const IDLE_MINUTES = 30;
/** A review page stops working this long after the command started, even while it is open. */
export const MAX_LIFETIME_MINUTES = 120;

const SIGN_CLASS: Record<Sign, string> = { '+': 'add', '-': 'del', '~': 'chg' };
const COMMAND = 'buckets refresh --web';

interface PageContext {
  token: string;
  projectName: string;
}

function screen(tty: string, name: string, right: string, body: SafeHtml, options: { id?: string; tone?: 'amber' | 'red'; labelledBy?: string } = {}): SafeHtml {
  return html`<section class="screen"${options.id ? html` id="${options.id}"` : ''}${options.labelledBy ? html` aria-labelledby="${options.labelledBy}"` : ''}>
  <div class="screen-bar${options.tone ? ` ${options.tone}` : ''}" aria-hidden="true"><span>${tty}</span><span>${name}</span><span>${right}</span></div>
  <div class="screen-body">
${body}
  </div>
</section>`;
}

function cmdline(text: string): SafeHtml {
  return html`<p class="cmdline" aria-hidden="true"><span class="ps">$</span> <span class="typed" translate="no">${text}</span><span class="cursor"></span></p>`;
}

function code(text: string): SafeHtml {
  return html`<code translate="no">${text}</code>`;
}

/** Explains a DMZ path in words: who uses the file and who provides it. Null when the path has an unexpected shape. */
export function describeDmzPath(file: string): string | null {
  const match = /^(.*)\/dmz\/([^/]+)\/([^/]+)\.[^./]+$/.exec(file);
  if (!match) return null;
  const [, parent, provider, consumer] = match as unknown as [string, string, string, string];
  const label = (name: string): string => (name === '.self' ? `${parent}/_` : `${parent}/${name}`);
  if (consumer === '.parent') return `${label(provider)} provides these symbols to code outside ${parent}.`;
  if (consumer === '.external') return `${label(provider)} publishes these symbols to other projects, which link this project and import this file through its alias.`;
  if (provider === '.parent') return `${label(consumer)} uses these symbols, which come from outside ${parent}.`;
  return `${label(consumer)} uses these symbols from ${label(provider)}.`;
}

const STATUS_TEXT: Record<DmzFileRow['status'], string> = {
  created: 'new file',
  deleted: 'deleted',
  edited: 'edited',
  symbols: 'text unchanged',
};

const STATUS_SIGN: Record<DmzFileRow['status'], Sign> = { created: '+', deleted: '-', edited: '~', symbols: '~' };

function symbolNote(sign: Sign, status: DmzFileRow['status']): string {
  if (sign === '+') return status === 'created' ? 'exported' : 'added';
  if (sign === '-') return status === 'deleted' ? 'was exported' : 'removed';
  return 'signature changed at its declaration in _/ code';
}

function dmzFile(row: DmzFileRow): SafeHtml {
  const sign = STATUS_SIGN[row.status];
  const about = describeDmzPath(row.path);
  const symbols =
    row.symbols.length > 0
      ? html`<ul class="symbols" aria-label="Symbols">
${row.symbols.map((s) => html`<li class="${SIGN_CLASS[s.sign]}"><span class="sign" aria-hidden="true">${s.sign}</span><code translate="no">${s.name}</code><span class="note">${symbolNote(s.sign, row.status)}</span></li>\n`)}</ul>`
      : row.status === 'edited'
        ? html`<p class="note-line dim">The text changed, but the file exports the same symbols with the same signatures.</p>`
        : row.status === 'created'
          ? html`<p class="note-line dim">The file exports no symbols.</p>`
          : '';
  const source =
    row.source === undefined
      ? row.status === 'deleted'
        ? html`<p class="note-line dim">The lock keeps only hashes, so the deleted text cannot be shown.</p>`
        : ''
      : row.status === 'symbols'
        ? html`<details><summary>Show the file</summary><pre class="term" translate="no" tabindex="0">${row.source}</pre></details>`
        : html`<pre class="term" translate="no" tabindex="0" aria-label="Current text of ${row.path}">${row.source}</pre>`;
  return html`<article class="dmz-file ${SIGN_CLASS[sign]}">
  <header><span class="head"><span class="sign" aria-hidden="true">${sign}</span><code class="path" translate="no">${row.path}</code></span><span class="badge">${STATUS_TEXT[row.status]}</span></header>
  ${about !== null ? html`<p class="about">${about}</p>` : ''}
  ${symbols}
  ${source}
</article>`;
}

function tiles(review: LockReview, label = 'Change counts'): SafeHtml {
  const { counts } = review;
  return html`<ul class="tiles" aria-label="${label}">

  <li class="add"><span class="num">${counts.added}</span><span class="what">added</span></li>
  <li class="del"><span class="num">${counts.removed}</span><span class="what">removed</span></li>
  <li class="chg"><span class="num">${counts.changed}</span><span class="what">changed</span></li>
  <li class="all"><span class="num">${counts.total}</span><span class="what">${counts.total === 1 ? 'change' : 'changes'} to approve</span></li>
</ul>`;
}

function itemList(rows: ItemRow[], label: string): SafeHtml {
  return html`<ul class="diff" aria-label="${label}">
${rows.map((row) => html`<li class="${SIGN_CLASS[row.sign]}"><span class="sign" aria-hidden="true">${row.sign}</span><span class="label">${row.label}</span><span class="item"><code translate="no">${row.path}</code>${row.detail !== undefined ? html`<span class="note">${row.detail}</span>` : ''}</span>${row.symbols !== undefined && row.symbols.length > 0 ? linkSymbols(row.symbols) : ''}</li>\n`)}</ul>`;
}

const LINK_SYMBOL_NOTE: Record<Sign, string> = { '+': 'published', '-': 'no longer published', '~': 'signature changed' };

/** The published symbols of a link row, each with the `.external` file of the linked project that publishes it. */
function linkSymbols(symbols: NonNullable<ItemRow['symbols']>): SafeHtml {
  return html`<ul class="symbols" aria-label="Published symbols">
${symbols.map((s) => html`<li class="${SIGN_CLASS[s.sign]}"><span class="sign" aria-hidden="true">${s.sign}</span><code translate="no">${s.name}</code><span class="note">${LINK_SYMBOL_NOTE[s.sign]}${s.file !== '' ? html` in <code translate="no">${s.file}</code>` : ''}</span></li>\n`)}</ul>`;
}

interface ScreenOptions {
  /** Heading level of each screen: 2 on a single-project page, 3 inside a project section. */
  level?: 2 | 3;
  /** Prefix for element ids, so several projects on one page keep them unique. */
  ids?: string;
  /** Shared counter for the tty labels of the screen bars. */
  tty?: { n: number };
}

function reviewScreens(review: LockReview, options: ScreenOptions = {}): SafeHtml[] {
  const screens: SafeHtml[] = [];
  const level = options.level ?? 2;
  const ids = options.ids ?? '';
  const counter = options.tty ?? { n: 1 };
  const next = (): string => `tty${counter.n++}`;

  if (review.versions.length > 0) {
    screens.push(
      screen(
        next(),
        'versions',
        plural(review.versions.length, 'change'),
        html`<h${level} id="${ids}versions-title">Versions</h${level}>
<p class="intro">The lock records the tools that computed its hashes. Approving moves the project to the versions installed now.</p>
<div class="table-scroll"><table class="stack">
  <thead><tr><th scope="col">What</th><th scope="col">Approved</th><th scope="col">Now</th></tr></thead>
  <tbody>
${review.versions.map((v) => html`<tr class="chg"><th scope="row">${v.label}</th><td translate="no" data-label="Approved">${v.before}</td><td translate="no" class="warn" data-label="Now">${v.after}</td></tr>\n`)}  </tbody>
</table></div>`,
        { labelledBy: `${ids}versions-title` },
      ),
    );
  }

  if (review.config.changed) {
    const entries = Object.entries(review.config.current) as [string, string | number][];
    screens.push(
      screen(
        next(),
        'buckets.config.json',
        'changed',
        html`<h${level} id="${ids}config-title">Config</h${level}>
<p class="intro">${code('buckets.config.json')} changed since the last approval. The lock keeps only a hash of the config, so the old values cannot be shown. These are the values approving would record:</p>
<div class="table-scroll"><table>
  <thead><tr><th scope="col">Field</th><th scope="col">Value</th></tr></thead>
  <tbody>
${entries.map(([key, value]) => html`<tr><th scope="row" translate="no">${key}</th><td translate="no">${JSON.stringify(value)}</td></tr>\n`)}  </tbody>
</table></div>`,
        { labelledBy: `${ids}config-title` },
      ),
    );
  }

  const bucketCount = review.buckets.added.length + review.buckets.removed.length;
  if (bucketCount > 0) {
    const rows = [
      ...review.buckets.added.map((b) => html`<li class="add"><span class="sign" aria-hidden="true">+</span><span class="label">${review.fresh ? 'bucket' : 'bucket created'}</span><code translate="no">${b}</code></li>\n`),
      ...review.buckets.removed.map((b) => html`<li class="del"><span class="sign" aria-hidden="true">-</span><span class="label">bucket removed</span><code translate="no">${b}</code></li>\n`),
    ];
    screens.push(
      screen(
        next(),
        'buckets',
        plural(bucketCount, review.fresh ? 'bucket' : 'change'),
        html`<h${level} id="${ids}buckets-title">Buckets</h${level}>
${review.fresh ? html`<p class="intro">The bucket tree the lock will record. A folder at bucket level that is not in this list fails the check until a human approves it.</p>` : html`<p class="intro">Bucket folders created or removed since the last approval.</p>`}
<ul class="diff" aria-label="Bucket changes">
${rows}</ul>`,
        { labelledBy: `${ids}buckets-title` },
      ),
    );
  }

  if (review.projects.length > 0) {
    screens.push(
      screen(
        next(),
        'projects',
        plural(review.projects.length, review.fresh ? 'project' : 'change'),
        html`<h${level} id="${ids}projects-title">Nested projects</h${level}>
<p class="intro">Folders inside a bucket's ${code('_/')} that hold their own ${code('buckets.config.json')}. Each one is a separate project with its own lock, checked together with this one. They never import from this project or this project from them.</p>
${itemList(review.projects, 'Nested project changes')}`,
        { labelledBy: `${ids}projects-title` },
      ),
    );
  }

  if (review.links.length > 0) {
    screens.push(
      screen(
        next(),
        'links',
        plural(review.links.length, review.fresh ? 'link' : 'change'),
        html`<h${level} id="${ids}links-title">Links</h${level}>
<p class="intro">The source of another project, placed in ${code('<bucket>/_/links/<name>/')} as a link to its root folder or as a copy. That bucket imports it through the other project's alias, and only its published ${code('.external.ts')} files. Each symbol below is one the other project publishes: approving accepts its current signature.</p>
${itemList(review.links, 'Link changes')}`,
        { labelledBy: `${ids}links-title` },
      ),
    );
  }

  if (review.dmz.length > 0) {
    screens.push(
      screen(
        next(),
        'dmz',
        plural(review.dmz.length, 'file'),
        html`<h${level} id="${ids}dmz-title">DMZ contracts</h${level}>
<p class="intro">${
          review.fresh
            ? 'Every contract file the lock will record, with the symbols it re-exports. Each symbol is a promise between two buckets.'
            : 'Contract files and symbols that changed since the last approval. A signature change means the type of a re-exported symbol changed where it is declared, even if the DMZ file itself did not.'
        }</p>
<div class="dmz-list">
${review.dmz.map((row) => html`${dmzFile(row)}\n`)}</div>`,
        { labelledBy: `${ids}dmz-title` },
      ),
    );
  } else if (review.fresh) {
    screens.push(screen(next(), 'dmz', '0 files', html`<h${level}>DMZ contracts</h${level}><p class="intro">The project has no DMZ files yet, so no bucket uses another.</p>`));
  }

  if (review.formatOnly) {
    screens.push(
      screen(
        next(),
        'buckets.lock.json',
        'format',
        html`<h${level}>Lock format</h${level}><p class="intro">The approved values are the same, but ${code('buckets.lock.json')} is not in the format the CLI writes, for example after a hand edit. Approving rewrites the file with the same values.</p>`,
      ),
    );
  }
  return screens;
}

/**
 * The confirmation code of the rendered state, which the human types in the native dialog. It is part of the page
 * as rendered: when the project changes, the page keeps this code and shows the stale banner instead.
 */
function codeBox(code: string, ids = ''): SafeHtml {
  return html`<div class="code-box" id="${ids}code-box" data-code="${code}">
  <p class="code-line"><span class="code-label">Confirmation code</span> <strong class="code" translate="no">${code}</strong></p>
  <p class="code-help">After you click Approve, a window of your operating system asks for this code. Type it there to approve exactly the changes on this page.</p>
</div>`;
}

/** Shown by the page script when the state on the server no longer matches what the page renders. */
const STALE_BANNER = html`<div class="stale-banner callout warn" id="stale-banner" role="status" hidden>
  <p><strong>The project changed after this page loaded.</strong> The changes and the confirmation code below describe the old state, so approving them would fail. Reload to review the current changes and get their code.</p>
  <p class="result-actions"><a class="btn btn-solid" href="/">Reload</a></p>
</div>`;

function decisionBar(hash: string, project: string): SafeHtml {
  return html`<div class="decide" id="decide" data-hash="${hash}" data-project="${project}" role="region" aria-label="Decision">
  <p class="decide-msg hint" id="decide-msg">Approve writes ${code('buckets.lock.json')} after you type the confirmation code in a window of your operating system.</p>
  <div class="decide-actions">
    <button type="button" class="btn btn-quiet" id="cancel">Cancel</button>
    <button type="button" class="btn btn-solid" id="approve">Approve</button>
  </div>
  <noscript><p class="decide-msg warn">Turn on JavaScript to approve here, or run ${code('buckets refresh')} in a terminal.</p></noscript>
</div>`;
}

const RESULT_SCREEN = html`<section class="screen result" id="result" hidden aria-labelledby="result-title">
  <div class="screen-bar" aria-hidden="true"><span>tty0</span><span id="result-bar">result</span><span id="result-state">closed</span></div>
  <div class="screen-body">
    <p class="cmdline" aria-hidden="true"><span class="ps">$</span> <span class="typed" id="result-cmd">echo $?</span></p>
    <h1 id="result-title" tabindex="-1"></h1>
    <p class="intro" id="result-text"></p>
    <p class="result-actions" id="result-actions" hidden><a class="btn btn-solid" href="/">Reload</a></p>
  </div>
</section>`;

function footer(): SafeHtml {
  return html`Served by ${code(COMMAND)} on this computer only. The page stops working after ${IDLE_MINUTES} minutes without activity, and ${MAX_LIFETIME_MINUTES / 60} hours after the command started.`;
}

function pageFor(ctx: PageContext, title: string, state: 'live' | 'wait' | 'off', label: string, main: SafeHtml): string {
  return renderPage({
    title,
    token: ctx.token,
    project: ctx.projectName,
    nav: [{ label: 'refresh --web', current: true }],
    status: { state, label },
    main,
    styles: ['/assets/refresh.css'],
    scripts: ['/assets/refresh.js'],
    footer: footer(),
  });
}

export function renderReviewPage(ctx: PageContext, review: LockReview): string {
  const n = review.counts.total;
  const heading = review.fresh ? 'Approve the first lock' : 'Approve contract changes';
  const intro = review.fresh
    ? html`An AI agent asked you to approve the bucket contracts of ${code(review.project.name)}. There is no ${code('buckets.lock.json')} yet. Approving creates it in ${code(review.project.dir)}, and from then on ${code('buckets check')} fails whenever a contract changes without a new approval.`
    : html`An AI agent asked you to approve ${plural(n, 'change')} to the bucket contracts of ${code(review.project.name)}. Approving rewrites ${code('buckets.lock.json')} in ${code(review.project.dir)}. Read the changes below. Ask the agent why a contract changed if this page does not make it clear.`;
  const first = screen(
    'tty0',
    'refresh --web',
    plural(n, review.fresh ? 'item' : 'change'),
    html`${cmdline(COMMAND)}
<h1 id="review-title">${heading}</h1>
<p class="intro">${intro}</p>
${tiles(review)}
${codeBox(review.code)}
<p class="callout">After you click Approve, your operating system opens its own window and asks for the confirmation code above. The agent can open this page, but it cannot type into that window, so only you can approve.</p>`,
    { labelledBy: 'review-title' },
  );
  const main = html`${RESULT_SCREEN}
${STALE_BANNER}
${first}
${reviewScreens(review)}
${decisionBar(review.hash, review.project.path)}`;
  return pageFor(ctx, `Approve changes in ${ctx.projectName}`, 'live', 'waiting for you', main);
}

/** The page when the project no longer passes the rules, so there is nothing to approve. */
export function renderBlockedPage(ctx: PageContext, state: Exclude<ReviewState, { kind: 'review' } | { kind: 'current' }>): string {
  const report = state.kind === 'violations' ? formatReport(state.report, state.chains) : formatReport(state.report);
  const environment = state.kind === 'environment';
  const main = html`${RESULT_SCREEN}
${screen(
  'tty0',
  'refresh --web',
  environment ? 'environment problem' : 'rules broken',
  html`${cmdline('buckets check')}
<h1 id="blocked-title">${environment ? 'The check could not run' : 'Nothing to approve yet'}</h1>
<p class="intro">${
    environment
      ? 'buckets check stopped with an environment problem, so the state cannot be approved. Read the message below.'
      : 'The project breaks bucket rules right now, and a state is approved only when every rule passes. Ask the agent to fix the violations below, then reload this page.'
  }</p>
<pre class="term wrap" translate="no" tabindex="0" aria-label="Check report">${report.trimEnd()}</pre>
<p class="result-actions"><a class="btn btn-solid" href="/">Reload</a> <button type="button" class="btn btn-quiet" id="cancel-only">Cancel</button></p>`,
  { tone: 'red', labelledBy: 'blocked-title' },
)}`;
  return pageFor(ctx, `Nothing to approve in ${ctx.projectName}`, 'wait', 'rules broken', main);
}

/** The page when the lock already matches the project. The command then exits with 0. */
export function renderCurrentPage(ctx: PageContext): string {
  const main = screen(
    'tty0',
    'refresh --web',
    'up to date',
    html`${cmdline('buckets check')}
<h1>Nothing to approve</h1>
<p class="intro">${code('buckets.lock.json')} already matches the project, so there is nothing to approve. The command has finished and this page is closed. You can close this tab.</p>`,
  );
  return pageFor(ctx, `Nothing to approve in ${ctx.projectName}`, 'off', 'closed', main);
}

/** The page after the session ended, for a reload after approve or cancel. */
export function renderClosedPage(ctx: PageContext, outcome: { title: string; text: string }): string {
  const main = screen('tty0', 'refresh --web', 'closed', html`${cmdline('echo $?')}<h1>${outcome.title}</h1><p class="intro">${outcome.text}</p>`);
  return pageFor(ctx, `${outcome.title} in ${ctx.projectName}`, 'off', 'closed', main);
}


/** What a project section shows: its review, why it cannot be approved, or the decision already taken. */
export type SectionState = ReviewState | { kind: 'approved' } | { kind: 'rejected' };

export interface ProjectSection {
  /** Relative to the project where the command started, `.` for that project. */
  path: string;
  dir: string;
  state: SectionState;
}

function projectLabel(path: string): string {
  return path === '.' ? 'the main project' : path;
}

const DONE_TEXT: Record<'approved' | 'rejected' | 'current', { badge: string; text: string; tone: string }> = {
  approved: { badge: 'approved', text: 'Approved. Its buckets.lock.json is written.', tone: 'add' },
  rejected: { badge: 'not approved', text: 'You cancelled in the confirmation window, so its buckets.lock.json is unchanged.', tone: 'del' },
  current: { badge: 'up to date', text: 'Its buckets.lock.json already matches the project. Nothing to approve.', tone: 'add' },
};

function projectSection(section: ProjectSection, index: number, counter: { n: number }): SafeHtml {
  const ids = `p${index}-`;
  const label = projectLabel(section.path);
  const where = html`<p class="about">Folder ${code(section.dir)}${section.path === '.' ? '' : html`, nested at ${code(section.path)}`}.</p>`;
  const state = section.state;
  if (state.kind === 'approved' || state.kind === 'rejected' || state.kind === 'current') {
    const done = DONE_TEXT[state.kind];
    return html`<section class="project-group ${done.tone}" id="${ids}group" aria-labelledby="${ids}title">
${screen(`tty${counter.n++}`, label, done.badge, html`<h2 id="${ids}title"><span translate="no">${label}</span></h2>
${where}
<p class="project-msg ${done.tone === 'add' ? 'ok' : 'bad'}" role="status">${done.text}</p>`)}
</section>`;
  }
  if (state.kind !== 'review') {
    const report = state.kind === 'violations' ? formatReport(state.report, state.chains) : formatReport(state.report);
    return html`<section class="project-group del" id="${ids}group" aria-labelledby="${ids}title">
${screen(
  `tty${counter.n++}`,
  label,
  state.kind === 'environment' ? 'environment problem' : 'rules broken',
  html`<h2 id="${ids}title"><span translate="no">${label}</span></h2>
${where}
<p class="intro">${state.kind === 'environment' ? 'buckets check could not run in this project, so it cannot be approved. Read the message below.' : 'This project breaks bucket rules now, so it cannot be approved. Ask the agent to fix the violations below, then reload this page.'}</p>
<pre class="term wrap" translate="no" tabindex="0" aria-label="Check report of ${label}">${report.trimEnd()}</pre>`,
  { tone: 'red' },
)}
</section>`;
  }
  const review = state.review;
  const head = screen(
    `tty${counter.n++}`,
    label,
    plural(review.counts.total, review.fresh ? 'item' : 'change'),
    html`<h2 id="${ids}title"><span translate="no">${label}</span>${review.project.name !== label ? html` <span class="dim">(${review.project.name})</span>` : ''}</h2>
${where}
<p class="intro">${review.fresh ? html`This project has no ${code('buckets.lock.json')} yet. Approving creates it.` : html`Approving rewrites the ${code('buckets.lock.json')} of this project and of no other.`}</p>
${tiles(review, `Change counts of ${label}`)}
${codeBox(review.code, ids)}
<div class="project-decide">
  <p class="project-msg hint" id="${ids}msg" aria-live="polite">Approve opens a confirmation window of your operating system for this project only.</p>
  <button type="button" class="btn btn-solid approve-project" data-project="${section.path}" data-hash="${review.hash}" aria-describedby="${ids}msg">Approve <span translate="no">${label}</span></button>
</div>`,
    { labelledBy: `${ids}title` },
  );
  return html`<section class="project-group" id="${ids}group">
${head}
${reviewScreens(review, { level: 3, ids, tty: counter })}
</section>`;
}

/** The review page when several projects (the main one and nested ones) have changes to approve. Each has its own Approve. */
export function renderMultiReviewPage(ctx: PageContext, sections: ProjectSection[]): string {
  const pending = sections.filter((s) => s.state.kind === 'review').length;
  const counter = { n: 1 };
  const first = screen(
    'tty0',
    'refresh --web',
    plural(sections.length, 'project'),
    html`${cmdline(COMMAND)}
<h1 id="review-title">Approve contract changes in ${plural(sections.length, 'project')}</h1>
<p class="intro">An AI agent asked you to approve changes to the bucket contracts of ${code(ctx.projectName)} and of the projects nested in it. Every project has its own ${code('buckets.lock.json')}, so you approve each one on its own. Read each section, then use its Approve button.</p>
<p class="callout">Each Approve opens a confirmation window of your operating system, for that project only, which asks for the confirmation code shown in that project's section. The agent can open this page, but it cannot type into that window, so only you can approve.</p>`,
    { labelledBy: 'review-title' },
  );
  const main = html`${RESULT_SCREEN}
${STALE_BANNER}
${first}
${sections.map((section, i) => html`${projectSection(section, i, counter)}\n`)}
<div class="decide" id="decide" data-mode="projects" role="region" aria-label="Decision">
  <p class="decide-msg hint" id="decide-msg" aria-live="polite">${pending === 1 ? '1 project waits' : `${pending} projects wait`} for your decision. Cancel closes this review without approving the rest.</p>
  <div class="decide-actions">
    <button type="button" class="btn btn-quiet" id="cancel">Cancel the rest</button>
  </div>
  <noscript><p class="decide-msg warn">Turn on JavaScript to approve here, or run ${code('buckets refresh')} in a terminal.</p></noscript>
</div>`;
  return pageFor(ctx, `Approve changes in ${ctx.projectName}`, 'live', 'waiting for you', main);
}
