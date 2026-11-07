// Entry of the inspect page. esbuild bundles this file into cli/dist/inspect-page.js and inspect.css into
// inspect-page.css. The server's page is `<div id="app"></div>` plus the script. The page loads the snapshot (embedded
// in a static export as <script type="application/json" id="snapshot">, or GET /snapshot.json plus the /events
// stream), keeps the place it shows in the URL hash and the list options in the query string, and draws the four
// areas: top bar, bucket list, center view and detail panel.
import './inspect.css';
import { renderFull, renderSummary, snapshotFiles, type FileOwner, type SnapshotProject, type SnapshotV2, type Violation } from '../../contract/browser.js';
import { html } from './html.js';
import { createGraphView } from '../graph/index.js';
import type { GraphView, Selection } from '../graph/types.js';
import { code, fmt, plural, rerender, tag, VirtualList, type Ctx } from './dom.js';
import {
  bucketRows,
  buildFileTree,
  copyText,
  diffSnapshots,
  FOCUS_ABOVE,
  focusBucket,
  graphSelection,
  holdInvalid,
  indexProject,
  projectName,
  search,
  searchItems,
  selectionBuckets,
  type Change,
  type DirNode,
  type ProjectIndex,
  type SearchItem,
  type SortKey,
} from './model.js';
import { fillOwned, renderPanel, showMore } from './panel.js';
import { formatHash, formatOptions, parseHash, parseOptions, VIEWS, type UrlState, type View } from './url.js';
import { filesView, matrixView, pendingView, viewOptions, type CenterView } from './views.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const MAX_DEPTH = 9;
/** The folder name of the root project, which the page shell writes on #app. */
const rootName = document.getElementById('app')?.dataset.root || 'root project';

/** The snapshot the page shows: the last one received, with config-invalid projects held at their last valid version. */
let snapshot: SnapshotV2;
const lastGood = new Map<string, SnapshotProject>();
/** The config-invalid violations of each project whose config is broken right now. */
let invalid = new Map<string, Violation[]>();
let version = 0;
/** Changes since the page opened, by project path, then by id. Cleared by Mark changes seen; never stored. */
const changes = new Map<string, Map<string, Change>>();
let changesVersion = 0;

let indexKey = '';
let index: ProjectIndex;
let lazy: { tree?: DirNode; items?: SearchItem[]; owners?: Map<string, FileOwner>; texts: Map<Violation, string> } = { texts: new Map() };
let ctx: Ctx | null = null;

let listKey = '';
let listRows: SnapshotProject['buckets'] = [];
/** Buckets the selection involves, highlighted in the list. */
let involved = new Set<string>();
let lastSelection = '';
let panelSelection = '';
/** Set by a search result: the next render moves the focus to the detail panel. */
let focusDetail = false;
/** The last bucket the graph centered on, by project, so a large graph does not jump to another bucket on its own. */
const lastFocus = new Map<string, string>();

let centerKey = '';
/** The project, view and matrix form that the center shows, to tell a rebuild of the same view from a new view. */
let centerPlace = '';
let centerView: CenterView | null = null;
let graph: GraphView | null = null;

function projectAt(path: string): SnapshotProject | undefined {
  return snapshot.projects.find((p) => p.path === path) ?? snapshot.projects[0];
}

const isBig = (p: SnapshotProject) => p.buckets.length > FOCUS_ABOVE;
const defaultDepth = (p: SnapshotProject) => (isBig(p) ? 1 : 0);
/** Depth 0 shows the whole graph (the graph view's convention). Above FOCUS_ABOVE buckets the graph stays in focus mode. */
const minDepth = (p: SnapshotProject) => (isBig(p) ? 1 : 0);

/** The bucket a graph selection centers on. */
const anchorOf = (s: Selection) => (s.kind === 'bucket' ? s.name : s.kind === 'export' ? s.bucket : s.kind === 'edge' ? s.from : null);

function replaceUrl(search: string, hash: string): void {
  try {
    history.replaceState(history.state, '', `${location.pathname}${search}${hash}`);
  } catch {
    // A file:// page may refuse; the state then stays in memory.
  }
}

// List options in the query string

let optionsSearch: string | null = null;

/** Reads the list options when the query string changed (first load, back and forward). */
function readOptions(): void {
  if (location.search === optionsSearch) return;
  optionsSearch = location.search;
  Object.assign(viewOptions, parseOptions(location.search));
  centerKey = '';
  listKey = '';
  $<HTMLInputElement>('bucket-filter').value = viewOptions.filter;
  $<HTMLSelectElement>('bucket-sort').value = viewOptions.sort;
}

function saveOptions(): void {
  replaceUrl(formatOptions(viewOptions), location.hash);
  optionsSearch = location.search;
}

/** The URL state with the page defaults filled in, or null when the hash is not a route (such as the skip link). */
function resolve(): Ctx['state'] | null {
  const u = parseHash(location.hash);
  if (u === null) return null;
  const p = projectAt(u.project)!;
  const key = `${version}|${p.path}`;
  if (key !== indexKey) {
    index = indexProject(p);
    lazy = { texts: new Map() };
    indexKey = key;
  }
  const view = u.view ?? (p.violations.length > 0 ? 'pending' : 'graph');
  let selection = u.selection;
  let picked = false;
  if (view === 'graph' && isBig(p) && selection.kind === 'none') {
    const kept = lastFocus.get(p.path);
    const top = kept !== undefined && index.buckets.has(kept) ? kept : focusBucket(index);
    if (top !== null) (selection = { kind: 'bucket', name: top }), (picked = true);
  }
  const depth = Math.min(MAX_DEPTH, Math.max(minDepth(p), u.depth ?? defaultDepth(p)));
  const state = { ...u, project: p.path, view, selection, depth };
  // The bucket the page picked goes into the URL, so a reload or a shared link shows the same picture.
  if (picked) replaceUrl(location.search, hashFor(state, {}));
  const anchor = anchorOf(selection);
  if (anchor !== null) lastFocus.set(p.path, anchor);
  return state;
}

function hashFor(state: Ctx['state'], patch: Partial<UrlState>): string {
  const next = { ...state, ...patch };
  const p = index.project;
  return formatHash({ ...next, depth: next.depth === defaultDepth(p) ? null : next.depth });
}

function makeCtx(state: Ctx['state']): Ctx {
  return {
    index,
    state,
    changed: new Set(changes.get(state.project)?.keys()),
    href: (selection: Selection, view?: View) => hashFor(state, { selection, view: view ?? state.view, pair: null }),
    go(patch) {
      const hash = hashFor(state, patch);
      if (hash === location.hash) render();
      else location.hash = hash;
    },
    saveOptions,
    copy,
    tree: () => (lazy.tree ??= buildFileTree(index.project)),
    searchItems: () => (lazy.items ??= searchItems(index.project)),
    text(v) {
      let t = lazy.texts.get(v);
      if (t === undefined) lazy.texts.set(v, (t = renderFull(v)));
      return t;
    },
    owner(path) {
      if (!lazy.owners) {
        lazy.owners = new Map();
        for (const f of snapshotFiles(index.project)) lazy.owners.set(f.path, f.owner);
      }
      return lazy.owners.get(path);
    },
    rootName,
  };
}

// Rendering

function render(): void {
  readOptions();
  const state = resolve();
  if (state === null) return;
  ctx = makeCtx(state);
  const selKey = JSON.stringify([state.project, state.selection, state.pair]);
  const first = panelSelection === '';
  const selectionChanged = selKey !== panelSelection;
  panelSelection = selKey;
  renderTop(ctx);
  renderBanner(ctx);
  renderList(ctx);
  renderTabs(ctx);
  renderCenter(ctx);
  const detail = $('detail');
  renderPanel(detail, ctx, [...(changes.get(state.project)?.values() ?? [])], selectionChanged);
  if (focusDetail) {
    focusDetail = false;
    detail.querySelector('h2')?.focus();
  } else if (selectionChanged && !first && matchMedia('(max-width: 640px)').matches) {
    // A phone stacks the areas; a selection made in the view brings its details into sight.
    const box = detail.getBoundingClientRect();
    if (box.top > innerHeight || box.bottom < 0) detail.scrollIntoView({ block: 'start' });
  }
}

function renderTop(c: Ctx): void {
  const pending = c.index.project.violations.length;
  const link = $<HTMLAnchorElement>('pending-link');
  link.href = hashFor(c.state, { view: 'pending' });
  link.textContent = `${fmt(pending)} pending`;
  link.classList.toggle('has-pending', pending > 0);
  const select = $<HTMLSelectElement>('project');
  $('project-box').hidden = snapshot.projects.length < 2;
  const options = snapshot.projects.map((p) => `${p.path}|${p.violations.length}`).join(',');
  if (select.dataset.options !== options) {
    select.dataset.options = options;
    select.innerHTML = snapshot.projects
      .map((p) => html`<option value="${p.path}">${projectName(p.path, rootName)}${p.violations.length > 0 ? ` (${fmt(p.violations.length)} pending)` : ''}</option>`.value)
      .join('');
  }
  select.value = c.state.project;
  let total = 0;
  for (const m of changes.values()) total += m.size;
  const count = total === 0 ? '' : `${plural(total, 'change')} since you opened the page`;
  if ($('changes-count').textContent !== count) $('changes-count').textContent = count;
  $('seen-top').hidden = total === 0;
}

function renderBanner(c: Ctx): void {
  const errors = invalid.get(c.state.project) ?? [];
  const banner = $('banner');
  banner.hidden = errors.length === 0;
  if (errors.length === 0) return;
  const shown = errors.slice(0, 3).map(renderSummary).join('; ');
  const rest = errors.length > 3 ? `; and ${fmt(errors.length - 3)} more` : '';
  const what = lastGood.has(c.state.project)
    ? 'The page shows the last valid architecture until the config is fixed.'
    : 'There is no valid architecture to show yet; the pending view lists the errors.';
  const text = `The config is invalid: ${shown}${rest}. ${what}`;
  if (banner.textContent !== text) banner.textContent = text;
}

const METRIC: Record<SortKey, string> = { name: 'files', files: 'files', dependencies: 'dependencies', dependents: 'dependents', pending: 'pending' };

function renderList(c: Ctx): void {
  const key = `${indexKey}|${viewOptions.sort}|${viewOptions.filter}|${changesVersion}`;
  const s = c.state.selection;
  const selKey = JSON.stringify(s);
  if (selKey !== lastSelection) involved = new Set(selectionBuckets(s, s.kind === 'file' ? c.owner(s.path) : undefined));
  if (key !== listKey) {
    listKey = key;
    listRows = bucketRows(c.index, viewOptions.sort, viewOptions.filter);
    $('bucket-count').textContent = listRows.length === c.index.project.buckets.length ? fmt(listRows.length) : `${fmt(listRows.length)} of ${fmt(c.index.project.buckets.length)}`;
    $('bucket-empty').hidden = listRows.length > 0;
    $('bucket-empty').textContent = c.index.project.buckets.length === 0 ? 'No buckets yet. Run buckets init or add buckets to buckets.config.json.' : 'No bucket matches the filter.';
    $('list-metric').textContent = METRIC[viewOptions.sort];
    bucketList.setCount(listRows.length);
  } else {
    bucketList.refresh();
  }
  if (selKey !== lastSelection) {
    lastSelection = selKey;
    const i = listRows.findIndex((b) => involved.has(b.name));
    if (i !== -1) {
      bucketList.setActive(i);
      bucketList.scrollTo(i, true);
    }
  }
}

function bucketRow(i: number) {
  const b = listRows[i]!;
  const c = ctx!;
  const s = c.state.selection;
  const current = s.kind === 'bucket' && s.name === b.name;
  const pending = c.index.pending.get(b.name)?.length ?? 0;
  const sort = viewOptions.sort;
  const value = { name: b.fileCount, files: b.fileCount, pending, dependencies: c.index.outEdges.get(b.name)?.length ?? 0, dependents: b.dependents.length }[sort];
  const cls = `brow${!current && involved.has(b.name) ? ' involved' : ''}`;
  return html`<a href="${c.href({ kind: 'bucket', name: b.name })}" class="${cls}"${current ? html` aria-current="true"` : ''} title="${b.name}: ${b.purpose}">
    <span class="mono trunc" translate="no">${b.name}</span>${c.changed.has(b.name) ? tag('new') : ''}
    ${sort !== 'pending' && pending > 0 ? html`<span class="badge">${fmt(pending)}<span class="sr"> pending</span></span>` : ''}<span class="num metric${sort === 'pending' && pending > 0 ? ' bad-text' : ''}">${fmt(value)}<span class="sr"> ${METRIC[sort]}</span></span></a>`;
}

function renderTabs(c: Ctx): void {
  for (const view of VIEWS) {
    const a = $<HTMLAnchorElement>(`tab-${view}`);
    a.href = hashFor(c.state, { view });
    if (view === c.state.view) {
      a.setAttribute('aria-current', 'page');
      $('view-h').textContent = `${view[0]!.toUpperCase()}${view.slice(1)}`;
    } else a.removeAttribute('aria-current');
  }
}

function renderCenter(c: Ctx): void {
  const el = $('view');
  const p = c.index.project;
  const key = `${indexKey}|${c.state.view}|${viewOptions.table}|${changesVersion}`;
  const place = `${p.path}|${c.state.view}|${viewOptions.table}`;
  if (key !== centerKey) {
    // A live update or Mark changes seen rebuilds the same view: it keeps its scroll positions and the focused field.
    // A new view takes the focus to its tab when the focus was in the old one.
    const restore = place === centerPlace ? keepPlace(el) : null;
    const focusTab = place !== centerPlace && el.contains(document.activeElement);
    centerKey = key;
    centerPlace = place;
    centerView?.destroy?.();
    centerView = null;
    if (c.state.view !== 'graph') {
      graph?.destroy();
      graph = null;
    }
    if (p.environment !== null) {
      el.innerHTML = html`<p class="empty bad-text">${p.environment.message}</p>`.value;
    } else if (c.state.view === 'graph') {
      if (graph === null) {
        el.innerHTML = '';
        if (p.buckets.length === 0) {
          el.innerHTML = '<p class="empty">No buckets yet, so there is no graph. Run buckets init or add buckets to buckets.config.json.</p>';
        } else {
          const bar = document.createElement('div');
          bar.id = 'focus-bar';
          bar.className = 'toolbar focus-bar';
          const box = document.createElement('div');
          box.className = 'graph';
          el.append(bar, box);
          graph = createGraphView(box, { onSelect });
        }
      }
    } else {
      el.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'view-box';
      el.append(box);
      centerView = (c.state.view === 'matrix' ? matrixView : c.state.view === 'pending' ? pendingView : filesView)(box, c);
    }
    restore?.();
    if (focusTab) $(`tab-${c.state.view}`).focus();
  }
  if (graph !== null && p.environment === null) {
    const s = c.state.selection;
    const selection = graphSelection(c.index, s, s.kind === 'file' ? c.owner(s.path) : undefined);
    renderFocusBar(c, selection);
    graph.update(p, { selection, focusDepth: c.state.depth, pathPair: c.state.pair, changed: c.changed });
  }
  centerView?.update(c);
}

/** The visible state of focus mode above the graph, with buttons for the depth and the whole graph. */
function renderFocusBar(c: Ctx, s: Selection): void {
  const bar = document.getElementById('focus-bar');
  if (!bar) return;
  const p = c.index.project;
  const depth = c.state.depth;
  const seed = s.kind === 'bucket' ? code(s.name) : s.kind === 'export' ? code(s.bucket) : s.kind === 'edge' ? html`${code(s.from)} and ${code(s.to)}` : null;
  const step = (delta: number, label: string, text: string, off: boolean) =>
    html`<button type="button" data-key="depth${delta}" data-step="${delta}" aria-label="${label}"${off ? html` aria-disabled="true"` : ''}>${text}</button>`;
  const all = isBig(p) ? '' : html`<button type="button" data-key="all" data-depth="0">Show all</button>`;
  const body = c.state.pair
    ? html`<span>Paths between ${code(c.state.pair[0])} and ${code(c.state.pair[1])}</span> <a href="${hashFor(c.state, { pair: null })}" data-key="clear">Clear paths</a>`
    : depth === 0
      ? html`<span>Whole graph</span>${s.kind === 'bucket' ? html` <button type="button" data-key="focus" data-depth="1">Focus on ${code(s.name)}</button>` : ''}`
      : seed === null
        ? html`<span>Focus mode, depth ${depth}. Select a bucket to focus on it.</span> ${all}`
        : html`<span>Focus: ${seed}, depth ${depth}</span> ${step(-1, 'Decrease depth', '−', depth <= minDepth(p))}${step(1, 'Increase depth', '+', depth >= MAX_DEPTH)} ${all}`;
  const markup = body.value;
  if (bar.dataset.markup !== markup) {
    bar.dataset.markup = markup;
    // A button that went away (such as Focus on, after it was pressed) hands the focus to the bar's first control.
    if (!rerender(bar, markup)) bar.querySelector<HTMLElement>('button, a')?.focus();
  }
}

const SCROLLERS = '.vlist, .scroll, .canvas-scroll, .matrix-wrap';

/** Reads the scroll positions and the focused field of a center view; the returned function puts them back on the rebuilt view. */
function keepPlace(el: HTMLElement): () => void {
  const scrolls = [...el.querySelectorAll<HTMLElement>(SCROLLERS)].map((s) => [s.scrollTop, s.scrollLeft]);
  const active = document.activeElement;
  const id = active instanceof HTMLElement && el.contains(active) ? active.id : '';
  const range = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
  return () => {
    el.querySelectorAll<HTMLElement>(SCROLLERS).forEach((s, i) => {
      const [top, left] = scrolls[i] ?? [0, 0];
      s.scrollTop = top!;
      s.scrollLeft = left!;
    });
    const again = id === '' ? null : document.getElementById(id);
    if (!again) return;
    again.focus({ preventScroll: true });
    if (range && again instanceof HTMLInputElement) again.setSelectionRange(range[0]!, range[1]!);
  };
}

function onSelect(selection: Selection, { shift }: { shift: boolean }): void {
  if (!ctx) return;
  const s = ctx.state.selection;
  // A pair keeps its first bucket, and a shift-click replaces the second.
  const first = ctx.state.pair?.[0] ?? (s.kind === 'bucket' ? s.name : null);
  if (shift && selection.kind === 'bucket' && first !== null && first !== selection.name) ctx.go({ selection, pair: [first, selection.name] });
  else ctx.go({ selection, pair: null });
}

// Actions

function copy(text: string): void {
  const done = () => toast(`Copied ${text}`);
  const fail = () => toast('Copy failed. Select the text and copy it by hand.');
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, fail);
  else fail();
}

let toastTimer = 0;
function toast(text: string): void {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 2500);
}

function markSeen(): void {
  const fromTop = document.activeElement?.id === 'seen-top';
  changes.clear();
  changesVersion++;
  render();
  // The button is gone; the view keeps the keyboard in the page instead of on the body.
  if (fromTop) $('main').focus();
}

function changeDepth(c: Ctx, delta: number): void {
  const p = c.index.project;
  const depth = Math.min(MAX_DEPTH, Math.max(minDepth(p), c.state.depth + delta));
  if (depth !== c.state.depth) c.go({ depth });
  toast(depth === 0 ? 'Focus depth 0: the whole graph' : `Focus depth ${depth}`);
}

function applySnapshot(raw: SnapshotV2): void {
  if (raw.snapshotVersion !== 2) return;
  const held = holdInvalid(raw, lastGood);
  invalid = held.invalid;
  const diff = diffSnapshots(snapshot, held.shown);
  for (const [path, list] of diff) {
    const m = changes.get(path) ?? new Map<string, Change>();
    for (const c of list) m.set(c.id, c);
    changes.set(path, m);
  }
  if (diff.size > 0) changesVersion++;
  snapshot = held.shown;
  version++;
  render();
}

// Search

let results: SearchItem[] = [];
let activeResult = -1;

function renderResults(): void {
  const box = $('q-results');
  const input = $<HTMLInputElement>('q');
  const query = input.value;
  results = ctx && query.trim() !== '' ? search(ctx.searchItems(), query) : [];
  activeResult = results.length > 0 ? 0 : -1;
  const open = query.trim() !== '';
  box.hidden = !open;
  input.setAttribute('aria-expanded', String(open));
  box.innerHTML =
    results.length === 0
      ? html`<li class="empty" role="presentation">No bucket, file or export matches.</li>`.value
      : results
          .map(
            (r, i) =>
              html`<li role="option" id="q-opt-${i}" aria-selected="${String(i === activeResult)}"><a href="${ctx!.href(r.selection)}" tabindex="-1"><span class="kind">${r.kind}</span>${code(r.label)}<span class="muted trunc" title="${r.detail}">${r.detail}</span></a></li>`
                .value,
          )
          .join('');
  setActive(activeResult);
}

function setActive(i: number): void {
  activeResult = i;
  const input = $('q');
  $('q-results')
    .querySelectorAll('[role=option]')
    .forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
  if (i >= 0) {
    input.setAttribute('aria-activedescendant', `q-opt-${i}`);
    document.getElementById(`q-opt-${i}`)?.scrollIntoView({ block: 'nearest' });
  } else input.removeAttribute('aria-activedescendant');
}

function closeSearch(clear: boolean): void {
  const input = $<HTMLInputElement>('q');
  if (clear) input.value = '';
  $('q-results').hidden = true;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

// Wiring

let bucketList: VirtualList;

const SHELL = html`<a class="skip" href="#main">Skip to the current view</a>
<header class="top">
  <h1>buckets inspect</h1>
  <div class="search" role="search">
    <label class="sr" for="q">Search buckets, files and exports</label>
    <input id="q" name="q" type="search" autocomplete="off" spellcheck="false" placeholder="Search (/) buckets, files, exports…"
      role="combobox" aria-expanded="false" aria-controls="q-results" aria-autocomplete="list">
    <ul id="q-results" role="listbox" aria-label="Search results" hidden></ul>
  </div>
  <label id="project-box" hidden>Project <select id="project" name="project"></select></label>
  <a id="pending-link" href="#/pending">0 pending</a>
  <span id="changes"><span id="changes-count" aria-live="polite"></span> <button type="button" class="seen" id="seen-top" hidden>Mark changes seen</button></span>
  <span id="live" class="muted" aria-live="polite">Loading…</span>
</header>
<p id="banner" class="banner" role="status" hidden></p>
<nav class="side" aria-labelledby="buckets-h">
  <h2 id="buckets-h">Buckets <span id="bucket-count" class="count"></span></h2>
  <div class="tools">
    <label class="sr" for="bucket-filter">Filter buckets by name or purpose</label>
    <input id="bucket-filter" name="bucket-filter" type="search" autocomplete="off" spellcheck="false" placeholder="Filter…">
    <label>Sort <select id="bucket-sort" name="bucket-sort">
      <option value="name">name</option><option value="files">files</option><option value="dependencies">dependencies</option>
      <option value="dependents">dependents</option><option value="pending">pending</option>
    </select></label>
  </div>
  <div class="list-head" aria-hidden="true"><span>Bucket</span><span id="list-metric">files</span></div>
  <div id="bucket-list" class="fill"></div>
  <p id="bucket-empty" class="empty" hidden></p>
</nav>
<main id="main" tabindex="-1" aria-labelledby="view-h">
  <h2 id="view-h" class="sr">Graph</h2>
  <nav class="tabs" aria-label="Views">${VIEWS.map((v, i) => html`<a id="tab-${v}" href="#/${v}" aria-keyshortcuts="${i + 1}" title="Key ${i + 1}">${v[0]!.toUpperCase() + v.slice(1)}</a>`)}<span class="tab-keys" aria-hidden="true">Keys 1 to ${VIEWS.length}</span></nav>
  <div id="view"><p class="empty">Loading…</p></div>
</main>
<aside id="detail" aria-label="Details"></aside>
<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>`;

function isField(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName));
}

/** Opens a search result and moves the focus to its details. */
function openResult(selection: Selection): void {
  if (!ctx) return;
  const hash = ctx.href(selection);
  focusDetail = true;
  closeSearch(true);
  if (hash === location.hash) render();
  else location.hash = hash;
}

function wire(): void {
  window.addEventListener('hashchange', render);

  const input = $<HTMLInputElement>('q');
  input.addEventListener('input', renderResults);
  input.addEventListener('focus', () => input.value.trim() !== '' && renderResults());
  input.addEventListener('blur', () => setTimeout(() => closeSearch(false), 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length > 0) setActive((activeResult + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
    } else if (e.key === 'Enter' && activeResult >= 0 && ctx) {
      e.preventDefault();
      openResult(results[activeResult]!.selection);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch(true);
      input.blur();
    }
  });
  $('q-results').addEventListener('mousedown', (e) => e.preventDefault());
  $('q-results').addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a');
    const i = Number(a?.closest('li')?.id.replace('q-opt-', '') ?? NaN);
    if (!a || !results[i]) return;
    e.preventDefault();
    openResult(results[i]!.selection);
  });

  $<HTMLSelectElement>('project').addEventListener('change', (e) => {
    location.hash = formatHash({ view: null, selection: { kind: 'none' }, depth: null, pair: null, project: (e.target as HTMLSelectElement).value });
  });

  const filter = $<HTMLInputElement>('bucket-filter');
  filter.addEventListener('input', () => {
    viewOptions.filter = filter.value;
    saveOptions();
    if (ctx) renderList(ctx);
  });
  const sort = $<HTMLSelectElement>('bucket-sort');
  sort.addEventListener('change', () => {
    viewOptions.sort = sort.value as SortKey;
    saveOptions();
    if (ctx) renderList(ctx);
  });

  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const copyEl = t.closest<HTMLElement>('[data-copy]');
    const more = t.closest<HTMLElement>('[data-more]')?.dataset.more;
    const step = t.closest<HTMLElement>('[data-step]');
    const depth = t.closest<HTMLElement>('[data-depth]')?.dataset.depth;
    if (copyEl) copy(copyEl.dataset.copy!);
    else if (t.closest('.seen')) markSeen();
    else if (more !== undefined) {
      showMore(more);
      render();
      document.querySelector<HTMLElement>(`[data-more-at="${CSS.escape(more)}"] :is(a, button)`)?.focus();
    } else if (step && ctx && step.getAttribute('aria-disabled') !== 'true') changeDepth(ctx, Number(step.dataset.step));
    else if (depth !== undefined && ctx) ctx.go({ depth: Number(depth) });
  });
  $('detail').addEventListener('toggle', (e) => ctx && e.target instanceof HTMLDetailsElement && fillOwned(e.target, ctx), true);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !ctx || isField(e.target)) return;
    const c = ctx;
    const p = c.index.project;
    if (e.key === '/') {
      e.preventDefault();
      $('q').focus();
    } else if (e.key >= '1' && e.key <= String(VIEWS.length)) {
      c.go({ view: VIEWS[Number(e.key) - 1]! });
    } else if (e.key === 'Escape') {
      // Escape clears the pair first. A large graph always focuses on a bucket, so there it keeps the current one.
      if (c.state.pair) c.go({ pair: null });
      else if (c.state.view === 'graph' && isBig(p)) {
        const s = c.state.selection;
        const anchor = anchorOf(graphSelection(c.index, s, s.kind === 'file' ? c.owner(s.path) : undefined));
        if (anchor !== null && !(s.kind === 'bucket' && s.name === anchor)) c.go({ selection: { kind: 'bucket', name: anchor } });
      } else c.go({ selection: { kind: 'none' }, pair: null });
    } else if (e.key === '[' || e.key === ']') {
      changeDepth(c, e.key === ']' ? 1 : -1);
    } else if (e.key === 'c') {
      const text = copyText(c.index, c.state.selection);
      if (text === null) toast('Nothing selected to copy.');
      else copy(text);
    }
  });
}

function fail(message: string): void {
  $('view').innerHTML = html`<p class="empty bad-text">${message}</p>`.value;
  $('live').textContent = '';
}

async function start(): Promise<void> {
  const app = document.getElementById('app') ?? document.body;
  app.classList.add('app');
  app.innerHTML = SHELL.value;
  bucketList = new VirtualList($('bucket-list'), 30, bucketRow, 'Buckets');
  wire();
  const embedded = document.getElementById('snapshot');
  let raw: SnapshotV2;
  try {
    raw = embedded ? JSON.parse(embedded.textContent ?? '') : await (await fetch('/snapshot.json', { cache: 'no-store' })).json();
  } catch (err) {
    fail(`Could not load the snapshot (${String(err)}). Run buckets inspect again.`);
    return;
  }
  if (raw?.snapshotVersion !== 2 || raw.projects.length === 0) {
    fail('This snapshot is not version 2. Run buckets inspect from the same slopbuckets version as this page.');
    return;
  }
  const held = holdInvalid(raw, lastGood);
  snapshot = held.shown;
  invalid = held.invalid;
  render();
  const live = $('live');
  if (embedded) {
    live.textContent = 'Static export';
    return;
  }
  const events = new EventSource('/events');
  events.addEventListener('snapshot', (e) => {
    try {
      applySnapshot(JSON.parse((e as MessageEvent<string>).data));
    } catch {
      toast('A live update could not be read. Reload the page.');
    }
  });
  events.onopen = () => (live.textContent = 'Live');
  events.onerror = () => (live.textContent = 'Reconnecting…');
}

void start();
