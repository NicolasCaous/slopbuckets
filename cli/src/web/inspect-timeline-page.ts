// The timeline view of `buckets inspect`: one track per project with a point for each commit that changed its
// buckets.lock.json, a slider over the approvals of the selected project, the map of the contract graph at that
// approval (rebuilt from that version of the lock) and, in the side panel, what the approval changed since the one
// before, in the rows of `buckets refresh --web`.
import { renderMapSvg, type MapEdge } from '../inspect/map-svg.js';
import type { ProjectSnapshot } from '../inspect/snapshot.js';
import { approvalDiff, approvalMapData, lockView, WORKING, type TimelinePoint, type TimelineTrack } from '../inspect/timeline.js';
import { diffLocks } from '../core/lock.js';
import { plural } from '../output/text.js';
import { html, raw, type SafeHtml } from './html.js';
import { clean, code, copyButton, currentProject, defaultState, href, pruneMap, screen, shownBucket, type PageInput } from './inspect-page.js';
import type { DmzFileRow, LockReview } from './lock-review.js';

const MAX_ROWS = 60;

interface Selection {
  track: TimelineTrack;
  index: number;
  point: TimelinePoint;
}

/** The track of the current project and the approval in the URL, or the newest one. */
export function selectedApproval(input: PageInput): Selection | null {
  const timeline = input.timeline;
  if (!timeline) return null;
  const track = timeline.tracks.find((t) => t.project === input.state.project);
  if (!track || track.status !== 'ok' || track.points.length === 0) return null;
  let index = input.state.at !== null ? track.points.findIndex((p) => p.id === input.state.at || (input.state.at!.length >= 7 && p.id.startsWith(input.state.at!))) : -1;
  if (index < 0) index = track.points.length - 1;
  return { track, index, point: track.points[index]! };
}

function when(point: TimelinePoint): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(point.date);
  return m ? `${m[1]} ${m[2]}` : point.date;
}

/** A date the page script shows in the reader's locale; the text is the author's own date and time. */
function stamp(point: TimelinePoint): SafeHtml {
  return html`<time datetime="${point.date}" data-when>${when(point)}</time>`;
}

/** The size of what a point changed, for the color of its dot: red when something went away, amber when something changed. */
function tone(track: TimelineTrack, index: number): 'fresh' | 'add' | 'chg' | 'del' | 'bad' {
  const point = track.points[index]!;
  if (point.lock === null) return 'bad';
  let before = null;
  for (let i = index - 1; i >= 0 && before === null; i--) before = track.points[i]!.lock;
  if (before === null) return 'fresh';
  const changes = diffLocks(before, point.lock);
  if (changes.some((c) => c.kind.endsWith('-removed'))) return 'del';
  if (changes.some((c) => c.kind === 'dmz-changed' || c.kind === 'signature-changed' || c.kind === 'config-changed' || c.kind === 'link-changed')) return 'chg';
  return 'add';
}

const TONE_TEXT = { fresh: 'created the lock', add: 'added things', chg: 'changed contracts', del: 'removed things', bad: 'lock missing or unreadable' } as const;

function pointLabel(point: TimelinePoint, t: keyof typeof TONE_TEXT): string {
  const who = point.author !== '' ? `${point.author}: ` : '';
  return `${when(point)}, ${who}${point.subject}${point.subject.endsWith('.') ? '' : '.'} ${TONE_TEXT[t].charAt(0).toUpperCase()}${TONE_TEXT[t].slice(1)}.`;
}

function trackLabel(track: TimelineTrack): string {
  return track.project === '.' ? 'repo' : track.project;
}

function tracksHtml(input: PageInput, selection: Selection | null): SafeHtml {
  const tracks = input.timeline!.tracks;
  // One shared axis in time order, by rank: points of different projects keep their order without piling up.
  const all: { track: TimelineTrack; index: number; date: string }[] = [];
  for (const track of tracks) if (track.status === 'ok') track.points.forEach((p, index) => all.push({ track, index, date: p.date }));
  all.sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0) || tracks.indexOf(a.track) - tracks.indexOf(b.track) || a.index - b.index);
  const rank = new Map(all.map((p, i) => [`${p.track.project}\0${p.index}`, i]));
  const x = (track: TimelineTrack, index: number): number => (all.length <= 1 ? 50 : Math.round(((rank.get(`${track.project}\0${index}`) ?? 0) / (all.length - 1)) * 100));
  const first = all[0];
  const last = all[all.length - 1];
  const rows = tracks.map((track) => {
    const current = track.project === input.state.project;
    const name = html`<a href="${href({ ...defaultState(), view: 'timeline', project: track.project })}" translate="no"${current ? html` aria-current="true"` : ''}>${track.name}</a>`;
    const meta = track.status === 'ok' ? `${trackLabel(track)}, ${plural(track.points.length, 'approval')}${track.truncated ? ', newest only' : ''}` : trackLabel(track);
    const body =
      track.status !== 'ok'
        ? html`<p class="tl-why">${track.message ?? ''}</p>`
        : html`<ol class="tl-line" aria-label="Approvals of ${track.name}">${track.points.map((point, index) => {
            const t = tone(track, index);
            const isCurrent = selection !== null && selection.track === track && selection.index === index;
            const link = href({ ...defaultState(), view: 'timeline', project: track.project, at: point.id });
            return html`<li class="tl-x-${x(track, index)}"><a class="tl-dot t-${t}${point.id === WORKING ? ' t-working' : ''}" href="${link}" aria-label="${pointLabel(point, t)}" title="${pointLabel(point, t)}"${isCurrent ? html` aria-current="true"` : ''} data-nav-item></a></li>`;
          })}</ol>`;
    return html`<section class="tl-row${current ? ' is-current' : ''}" aria-label="${track.name}">
  <h2 class="tl-name">${name} <span class="dim">${meta}</span></h2>
  ${body}
</section>`;
  });
  return html`<div class="tl-tracks" id="tl-tracks">
${rows}
${first && last && all.length > 1 ? html`<p class="tl-axis" aria-hidden="true"><span></span><span class="dates"><span>${stamp(first.track.points[first.index]!)}</span><span>${stamp(last.track.points[last.index]!)}</span></span></p>` : ''}
</div>`;
}

const LEGEND = html`<ul class="legend" aria-label="Legend">
  <li><span class="swatch t-added" aria-hidden="true"></span>added</li>
  <li><span class="swatch t-changed" aria-hidden="true"></span>changed</li>
  <li><span class="swatch t-removed" aria-hidden="true"></span>removed</li>
  <li><span class="swatch t-same" aria-hidden="true"></span>same as the approval before</li>
  <li><span class="swatch e-contract" aria-hidden="true"></span>contract added or changed</li>
</ul>`;

export function renderTimelineView(input: PageInput): SafeHtml {
  const { snapshot, state } = input;
  const project = currentProject(snapshot, state);
  const timeline = input.timeline;
  const intro = html`<p class="intro">Only a human approval writes ${code('buckets.lock.json')}, so each commit that changed a lock is an approval. Pick a point, drag the slider or use the arrow keys to see the contract graph at that approval and what it changed since the one before. The graph comes from that version of the lock, which records buckets, contracts and symbols but no source code.</p>`;
  const wrap = (body: SafeHtml, right: string, tone?: 'amber' | 'red'): SafeHtml =>
    screen('tty8', `timeline ${project.name}`, right, html`<h1 class="view-title" id="view-title">Timeline <span class="dim">of approvals</span></h1>\n${intro}\n${body}`, { id: 'view', labelledBy: 'view-title', cls: 'view view-timeline', ...(tone ? { tone } : {}) });
  if (!timeline) return wrap(html`<p class="empty">The history of the locks is not loaded.</p>`, 'no data');
  const usable = timeline.tracks.filter((t) => t.status === 'ok');
  if (usable.length === 0) {
    const reasons = timeline.tracks.map((t) => html`<li><strong translate="no">${t.name}</strong> <span class="dim">(${trackLabel(t)})</span>: ${t.message ?? ''}</li>`);
    return wrap(html`<div class="callout warn" role="status"><p>There is no timeline to show.</p><ul class="plain">${reasons}</ul></div>`, 'no history', 'amber');
  }
  const selection = selectedApproval(input);
  const track = timeline.tracks.find((t) => t.project === state.project);
  const total = usable.reduce((n, t) => n + t.points.length, 0);
  if (!selection || !track) {
    const why = track?.message ?? `${project.name} has no approvals in git.`;
    return wrap(html`${tracksHtml(input, null)}<div class="callout warn" role="status"><p>${why}</p><p class="small">Select a project with approvals above.</p></div>`, plural(total, 'approval'));
  }
  const { point, index } = selection;
  const count = selection.track.points.length;
  const base = href(clean(state, { view: 'timeline' }), {});
  const at = (i: number) => href(clean(state, { view: 'timeline' }), { at: selection.track.points[i]!.id });
  const prev = index > 0 ? html`<a class="btn btn-mini" id="tl-prev" href="${at(index - 1)}" rel="prev" aria-label="Previous approval">Previous</a>` : html`<span class="btn btn-mini is-off" id="tl-prev" aria-hidden="true">Previous</span>`;
  const next = index < count - 1 ? html`<a class="btn btn-mini" id="tl-next" href="${at(index + 1)}" rel="next" aria-label="Next approval">Next</a>` : html`<span class="btn btn-mini is-off" id="tl-next" aria-hidden="true">Next</span>`;
  const label = html`<p class="tl-label" id="tl-label"><label for="tl-range">Approval <strong>${index + 1}</strong> of ${count} in <span translate="no">${selection.track.name}</span></label> <span class="dim">${stamp(point)}</span></p>`;
  const scrub = html`<div class="tl-scrub" id="tl-scrub">
  ${label}
  <div class="tl-scrub-row">
    ${prev}
    <input type="range" id="tl-range" class="tl-range" min="0" max="${count - 1}" step="1" value="${index}" aria-valuetext="${pointLabel(point, tone(selection.track, index))}"${count < 2 ? html` disabled` : ''}>
    ${next}
    <button type="button" class="btn btn-mini" id="tl-play" aria-pressed="false"${count < 2 ? html` disabled` : ''}>Play</button>
  </div>
</div>`;
  const map = approvalMapData(project, snapshot, selection.track, index);
  let stage: SafeHtml;
  if (point.lock === null || map === null) {
    stage = html`<div class="tl-stage" id="tl-stage">${commitLine(point)}<div class="callout bad"><p>${point.state === 'deleted' ? `This commit deleted ${point.file}, so there is no graph to show.` : `This version of ${point.file} cannot be read: ${point.problem ?? 'unknown problem'}.`}</p></div></div>`;
  } else {
    // A large project shows the buckets this approval changed, with their parents.
    const changed = map.data.buckets.filter((b) => b.situation !== 'same').map((b) => b.path);
    const ends = map.edges.flatMap((e) => [e.from, e.to].map((a) => ('bucket' in a ? a.bucket : a.strip)));
    const data = pruneMap(map.data, [...changed, ...ends]);
    const anchor = (a: MapEdge['from']): MapEdge['from'] => ('bucket' in a ? { bucket: shownBucket(data, a.bucket) } : { strip: shownBucket(data, a.strip) });
    const svg = renderMapSvg(data, {
      standalone: false,
      idPrefix: 'tl',
      cols: 120,
      overlays: false,
      edges: map.edges.map((e) => ({ ...e, from: anchor(e.from), to: anchor(e.to) })),
      toneClasses: { added: 'tl-added', changed: 'tl-changed', removed: 'tl-removed' },
      title: `Contract graph of ${selection.track.name} at approval ${index + 1}: ${plural(map.view.counts.buckets, 'bucket')}, ${plural(map.view.counts.contracts, 'contract')}`,
    });
    const c = map.view.counts;
    stage = html`<div class="tl-stage" id="tl-stage" data-at="${point.id}">
  ${commitLine(point)}
  <div class="tl-map-scroll" tabindex="0" role="region" aria-label="Contract graph at this approval, scrollable"><div class="tl-map" id="tl-map">${raw(svg.svg)}</div></div>
  ${LEGEND}
  <p class="small dim tl-counts">At this approval ${selection.track.name} had ${plural(c.buckets, 'bucket')}, ${plural(c.contracts, 'contract')} with ${plural(c.symbols, 'symbol')}${c.links > 0 ? `, ${plural(c.links, 'link')}` : ''}${c.projects > 0 ? `, ${plural(c.projects, 'nested project')}` : ''}. Boxes are sized by the symbols each bucket offers, since the lock keeps no file counts.</p>
</div>`;
  }
  const data = JSON.stringify({
    base,
    points: selection.track.points.map((p, i) => ({ id: p.id, label: pointLabel(p, tone(selection.track, i)), when: when(p), date: p.date })),
  })
    .replace(/</g, '\\u003c')
    .replace(/[\p{Zl}]/gu, '\\' + 'u2028')
    .replace(/[\p{Zp}]/gu, '\\' + 'u2029');
  return wrap(
    html`${tracksHtml(input, selection)}
${scrub}
${stage}
<script type="application/json" id="tl-data">${raw(data)}</script>`,
    plural(total, 'approval'),
  );
}

function commitLine(point: TimelinePoint): SafeHtml {
  const id = `tl-sha-${point.short}`;
  return html`<div class="tl-commit">
  <p class="tl-subject" translate="no">${point.subject}</p>
  <p class="tl-meta">${point.id === WORKING ? html`<span class="badge s-lock">not committed</span>` : html`<code translate="no">${point.short}</code>${copyButton(id, point.id, 'Copy the commit hash')}`}<span class="dim">${stamp(point)}${point.author !== '' ? html`, <span translate="no">${point.author}</span>` : ''}</span></p>
</div>`;
}

// ---- side panel: what the approval changed ----

const SIGN_TEXT = { '+': 'added', '-': 'removed', '~': 'changed' } as const;

function signRow(sign: '+' | '-' | '~', label: string, item: SafeHtml, note?: string): SafeHtml {
  const cls = sign === '+' ? 'add' : sign === '-' ? 'del' : 'chg';
  return html`<li class="${cls}"><span class="sign" aria-hidden="true">${sign}</span><span class="visually-hidden">${SIGN_TEXT[sign]}: </span><span class="what">${label}</span> ${item}${note !== undefined ? html` <span class="dim small">${note}</span>` : ''}</li>`;
}

function dmzRow(row: DmzFileRow): SafeHtml[] {
  const sign = row.status === 'created' ? '+' : row.status === 'deleted' ? '-' : '~';
  const label = row.status === 'created' ? 'contract' : row.status === 'deleted' ? 'contract' : row.status === 'edited' ? 'contract text' : 'contract';
  const out = [signRow(sign, label, code(row.path))];
  for (const s of row.symbols) out.push(html`<li class="sym-row ${s.sign === '+' ? 'add' : s.sign === '-' ? 'del' : 'chg'}"><span class="sign" aria-hidden="true">${s.sign}</span><span class="visually-hidden">${SIGN_TEXT[s.sign]}: </span>${code(s.name)}${s.sign === '~' ? html` <span class="dim small">signature</span>` : ''}</li>`);
  return out;
}

function reviewRows(review: LockReview): SafeHtml[] {
  const rows: SafeHtml[] = [];
  for (const v of review.versions) rows.push(signRow('~', v.label, html`<span translate="no">${v.before}</span> <span class="dim">to</span> <span translate="no">${v.after}</span>`));
  if (review.config.changed) rows.push(signRow('~', 'config', code('buckets.config.json')));
  for (const b of review.buckets.added) rows.push(signRow('+', 'bucket', code(b)));
  for (const b of review.buckets.removed) rows.push(signRow('-', 'bucket', code(b)));
  for (const p of review.projects) rows.push(signRow(p.sign, 'nested project', code(p.path)));
  for (const l of review.links) rows.push(signRow(l.sign, 'link', code(l.path), l.detail));
  for (const row of review.dmz) rows.push(...dmzRow(row));
  return rows;
}

export function renderApprovalPanel(input: PageInput): SafeHtml | null {
  const selection = selectedApproval(input);
  if (selection === null) return null;
  const project: ProjectSnapshot | undefined = input.snapshot.projects.find((p) => p.path === selection.track.project);
  const diff = approvalDiff(project, selection.track, selection.index);
  const { point } = selection;
  const title = point.id === WORKING ? 'Approval on disk' : html`Approval <span translate="no">${point.short}</span>`;
  if (diff === null) {
    return screen('tty6', 'approval', point.short, html`<h2 class="panel-title" id="panel-title">${title}</h2><p class="empty">No lock to compare at this point.</p>`, { id: 'panel', labelledBy: 'panel-title', cls: 'panel', tone: 'red' });
  }
  const { review } = diff;
  const rows = reviewRows(review);
  const shown = rows.slice(0, MAX_ROWS);
  const view = point.lock ? lockView(point.lock, project?.config?.root) : null;
  const intro = review.fresh
    ? html`<p class="small">The first approval in git: it created the lock with ${view ? `${plural(view.counts.buckets, 'bucket')} and ${plural(view.counts.contracts, 'contract')}` : 'its first state'}.</p>`
    : review.formatOnly
      ? html`<p class="small">The approved values stayed the same. The file changed only in format.</p>`
      : html`<p class="small">What this approval changed since ${diff.previous ? html`<code translate="no">${diff.previous.short}</code> (${stamp(diff.previous)})` : 'the approval before'}.</p>`;
  return screen(
    'tty6',
    'approval',
    `${selection.index + 1} of ${selection.track.points.length}`,
    html`<h2 class="panel-title" id="panel-title">${title}</h2>
${intro}
<ul class="tiles" aria-label="Change counts">
  <li class="add"><span class="num">${review.counts.added}</span><span class="what">added</span></li>
  <li class="del"><span class="num">${review.counts.removed}</span><span class="what">removed</span></li>
  <li class="chg"><span class="num">${review.counts.changed}</span><span class="what">changed</span></li>
</ul>
${rows.length === 0 ? html`<p class="empty">Nothing to list.</p>` : html`<ul class="tl-diff" aria-label="Changes">${shown}</ul>`}
${rows.length > shown.length ? html`<p class="small dim">And ${rows.length - shown.length} more.</p>` : ''}
<p class="small dim">The same rows ${code('buckets refresh --web')} showed when this was approved, without the file texts.</p>`,
    { id: 'panel', labelledBy: 'panel-title', cls: 'panel' },
  );
}
