// The pages of `buckets inspect`, rendered on the server from the snapshot and the state in the URL. Every view
// reads fine without the script: links are real links and the URL holds the selected project, bucket, contract,
// symbol and link. The script (assets/inspect.ts) draws the map on a canvas, swaps pages without reloading and
// applies live updates by fetching the same URL again.
import type { FeedEvent } from '../inspect/events.js';
import type {
  BucketSnapshot,
  ContractSnapshot,
  InspectSnapshot,
  LinkEdge,
  LinkSnapshot,
  LinkSymbol,
  LockChangeSnapshot,
  ProjectSnapshot,
  Situation,
  SymbolSnapshot,
  ViolationSnapshot,
} from '../inspect/snapshot.js';
import { projectSituation } from '../inspect/snapshot.js';
import { layoutConstellation } from '../inspect/constellation-layout.js';
import type { MapBucketData, MapData } from '../inspect/map-svg.js';
import { MAP_LEVEL_THRESHOLD, capList, commonBucket, bucketMatches, isLarge, mapFocus, mapMode, matrixLayout, orphanCounts, subtreeStats, visibleBox, type Focus, type MapMode, type MatrixLayout } from '../inspect/scale.js';
import type { CodeExport } from '../inspect/impact.js';
import type { Timeline } from '../inspect/timeline.js';
import { renderImpactView } from './inspect-impact-page.js';
import { renderApprovalPanel, renderTimelineView } from './inspect-timeline-page.js';
import { plural } from '../output/text.js';
import { html, raw, type SafeHtml } from './html.js';
import { renderPage, type NavItem, type PageOptions } from './layout.js';
import { describeDmzPath } from './refresh-page.js';

export const VIEWS = ['map', 'matrix', 'trace', 'projects', 'approvals', 'timeline', 'impact'] as const;
export type View = (typeof VIEWS)[number];

export const SIMULATIONS = ['bucket', 'path', 'external'] as const;
export type Simulation = (typeof SIMULATIONS)[number];

export const IDLE_MINUTES = 30;
const REFRESH_WEB = 'buckets refresh --web';

export interface InspectState {
  view: View;
  project: string;
  bucket: string | null;
  /** A DMZ file of the project, selected in the matrix. */
  cell: string | null;
  /** A symbol name, with the `_/` file that declares it (or the DMZ file when the chain is broken). */
  symbol: string | null;
  of: string | null;
  q: string;
  /** A link folder of the project, selected in the constellation. */
  link: string | null;
  /** A violation id, highlighted on the map. */
  v: string | null;
  /** The approval shown on the timeline: a commit, or `working` for the lock on disk. The newest when null. */
  at: string | null;
  /** The impact simulation: remove a bucket, route a symbol to a consumer, or change a published symbol. */
  sim: Simulation | null;
  /** The consumer bucket of the `path` simulation. */
  to: string | null;
  /** `all` shows every bucket of a large project at once as a treemap; null shows one level at a time. */
  layout: 'all' | null;
  /** Draws the dependency lines of the selected bucket on the map. */
  deps: boolean;
  /** Filters of the bucket tree of a large project: text, and only buckets with problems or waiting for approval. */
  tq: string;
  tf: Focus | null;
  /** Filters of the matrix: text, and only contracts with problems or waiting for approval. */
  mq: string;
  mf: Focus | null;
  /** A DMZ folder (its owner bucket) the matrix shows as a table although it is too wide for one. */
  table: string | null;
  /** A long list shown in full, by its key, or `all` for every list. */
  all: string | null;
}

/** The two filters of the tree and the matrix. */
export type { Focus };
const FOCUS: readonly Focus[] = ['problems', 'pending'];

export interface PageInput {
  token: string;
  snapshot: InspectSnapshot;
  feed: FeedEvent[];
  version: number;
  state: InspectState;
  /** How the files are watched, for the status line. */
  watch: 'native' | 'polling' | 'off';
  /** The git history of the locks, read only for the timeline view. */
  timeline?: Timeline;
  /** Exports of the `_/` files of the current project, read only for the path simulation. */
  exports?: CodeExport[];
  /** Set for a page of `inspect --export html`: a snapshot in a file, without a server behind it. */
  static?: StaticInfo;
}

/** What a page of `inspect --export html` says about the snapshot it shows. */
export interface StaticInfo {
  /** ISO time of the snapshot. */
  takenAt: string;
  /** The version of buckets that exported it. */
  cli: string;
  /** Views the file cannot show, such as the timeline without git history. They get no window in the top bar. */
  hidden: View[];
}

const VIEW_LABEL: Record<View, string> = { map: 'map', matrix: 'matrix', trace: 'trace', projects: 'projects', approvals: 'approvals', timeline: 'timeline', impact: 'impact' };
export const SITUATION_LABEL: Record<Situation, string> = { ok: 'ok', lock: 'differs from lock', violation: 'violation' };

// ---- state and links ----

export function defaultState(): InspectState {
  return {
    view: 'map',
    project: '.',
    bucket: null,
    cell: null,
    symbol: null,
    of: null,
    q: '',
    link: null,
    v: null,
    at: null,
    sim: null,
    to: null,
    layout: null,
    deps: false,
    tq: '',
    tf: null,
    mq: '',
    mf: null,
    table: null,
    all: null,
  };
}

/** The state in a URL, with anything the snapshot does not know dropped. */
export function parseState(url: URL, snapshot: InspectSnapshot): InspectState {
  const q = url.searchParams;
  const state = defaultState();
  const view = q.get('view');
  if (view !== null && (VIEWS as readonly string[]).includes(view)) state.view = view as View;
  // A pick of the simulation forms names a symbol and its file, and for a published symbol also its project.
  const pick = q.get('pick');
  const parts = pick !== null ? pick.split('::') : [];
  const pickedProject = parts.length === 3 ? parts[0]! : null;
  const project = snapshot.projects.find((p) => p.path === (pickedProject ?? q.get('project'))) ?? snapshot.projects[0]!;
  state.project = project.path;
  const bucket = q.get('bucket');
  if (bucket !== null && project.buckets.some((b) => b.path === bucket)) state.bucket = bucket;
  const cell = q.get('cell');
  if (cell !== null && project.contracts.some((c) => c.file === cell)) state.cell = cell;
  const symbol = q.get('symbol');
  if (symbol !== null && symbol !== '') {
    state.symbol = symbol;
    state.of = q.get('of');
  }
  state.q = (q.get('q') ?? '').slice(0, 200);
  const link = q.get('link');
  if (link !== null && project.links.some((l) => l.path === link)) state.link = link;
  const v = q.get('v');
  if (v !== null && project.violations.some((x) => x.id === v)) state.v = v;
  const at = q.get('at');
  if (at !== null && /^(?:[0-9a-f]{4,64}|working)$/.test(at)) state.at = at;
  const sim = q.get('sim');
  if (sim !== null && (SIMULATIONS as readonly string[]).includes(sim)) state.sim = sim as Simulation;
  const to = q.get('to');
  if (to !== null && project.buckets.some((b) => b.path === to)) state.to = to;
  if (q.get('layout') === 'all') state.layout = 'all';
  state.deps = q.get('deps') === '1';
  state.tq = (q.get('tq') ?? '').slice(0, 100);
  state.mq = (q.get('mq') ?? '').slice(0, 100);
  const tf = q.get('tf');
  if (tf !== null && (FOCUS as readonly string[]).includes(tf)) state.tf = tf as Focus;
  const mf = q.get('mf');
  if (mf !== null && (FOCUS as readonly string[]).includes(mf)) state.mf = mf as Focus;
  const table = q.get('table');
  if (table !== null && project.buckets.some((b) => b.path === table)) state.table = table;
  const all = q.get('all');
  if (all !== null && /^[\w.-]{1,60}$/.test(all)) state.all = all;
  if (parts.length >= 2) {
    const name = parts[parts.length - 1]!;
    const file = parts[parts.length - 2]!;
    if (name !== '' && file !== '') {
      state.symbol = name;
      if (state.sim === 'external') {
        if (project.contracts.some((c) => c.file === file)) state.cell = file;
      } else state.of = file;
    }
  }
  return state;
}

/** A link to a state: `base` with `change` applied. Defaults are left out of the URL. */
export function href(base: InspectState, change: Partial<InspectState> = {}): string {
  const s = { ...base, ...change };
  const params = new URLSearchParams();
  if (s.view !== 'map') params.set('view', s.view);
  if (s.project !== '.') params.set('project', s.project);
  if (s.bucket) params.set('bucket', s.bucket);
  if (s.cell) params.set('cell', s.cell);
  if (s.symbol) {
    params.set('symbol', s.symbol);
    if (s.of) params.set('of', s.of);
  }
  if (s.q) params.set('q', s.q);
  if (s.link) params.set('link', s.link);
  if (s.v) params.set('v', s.v);
  if (s.at) params.set('at', s.at);
  if (s.sim) params.set('sim', s.sim);
  if (s.to) params.set('to', s.to);
  if (s.layout) params.set('layout', s.layout);
  if (s.deps) params.set('deps', '1');
  if (s.tq) params.set('tq', s.tq);
  if (s.tf) params.set('tf', s.tf);
  if (s.mq) params.set('mq', s.mq);
  if (s.mf) params.set('mf', s.mf);
  if (s.table) params.set('table', s.table);
  if (s.all) params.set('all', s.all);
  const query = params.toString();
  return query === '' ? '/' : `/?${query}`;
}

/**
 * A state that only keeps the view, the project and the viewer's display choices (map layout, dependency lines and
 * the filters of the tree and the matrix), so following a link does not undo them.
 */
export function clean(state: InspectState, change: Partial<InspectState>): InspectState {
  const keep = { layout: state.layout, deps: state.deps, tq: state.tq, tf: state.tf, mq: state.mq, mf: state.mf, table: state.table };
  return { ...defaultState(), view: state.view, project: state.project, ...keep, ...change };
}

// ---- small pieces ----

export function code(text: string): SafeHtml {
  return html`<code translate="no">${text}</code>`;
}

export function screen(tty: string, name: string, right: string, body: SafeHtml, options: { id?: string; tone?: 'amber' | 'red'; labelledBy?: string; cls?: string } = {}): SafeHtml {
  return html`<section class="screen${options.cls ? ` ${options.cls}` : ''}"${options.id ? html` id="${options.id}"` : ''}${options.labelledBy ? html` aria-labelledby="${options.labelledBy}"` : ''}>
  <div class="screen-bar${options.tone ? ` ${options.tone}` : ''}" aria-hidden="true"><span>${tty}</span><span>${name}</span><span>${right}</span></div>
  <div class="screen-body">
${body}
  </div>
</section>`;
}

export function badge(situation: Situation, text?: string): SafeHtml {
  return html`<span class="badge s-${situation}">${text ?? SITUATION_LABEL[situation]}</span>`;
}

export function led(situation: Situation, label: string): SafeHtml {
  return html`<span class="led s-${situation}" role="img" aria-label="${label}"></span>`;
}

export function copyButton(id: string, text: string, label = 'Copy message'): SafeHtml {
  return html`<button type="button" class="btn btn-mini" data-copy-id="${id}" aria-label="${label}">Copy</button><span class="visually-hidden" id="${id}">${text}</span>`;
}

export function where(item: { file: string; line?: number }): string {
  return item.line !== undefined ? `${item.file}:${item.line}` : item.file;
}

export function projectLabel(project: ProjectSnapshot): string {
  return project.path === '.' ? project.name : `${project.name} (${project.path})`;
}

function statusText(project: ProjectSnapshot): string {
  switch (project.status) {
    case 'ok':
      return 'every rule passes and the lock matches';
    case 'lock':
      return project.lock === 'missing' ? 'the rules pass, but there is no lock yet' : `the rules pass, but ${plural(project.lockChanges.length, 'lock difference')} wait for approval`;
    case 'violation':
      return `${plural(project.violations.length, 'violation')}`;
    case 'environment':
      return 'the check could not run';
  }
}

export function currentProject(snapshot: InspectSnapshot, state: InspectState): ProjectSnapshot {
  return snapshot.projects.find((p) => p.path === state.project) ?? snapshot.projects[0]!;
}

export function bucketName(project: ProjectSnapshot, path: string): string {
  const root = project.config?.root ?? 'root';
  return path === root ? `${root}/` : path.slice(root.length + 1);
}

// ---- symbols across contracts ----

export interface SymbolGroup {
  key: string;
  project: string;
  name: string;
  origin: string | null;
  declaredIn: string | null;
  signature: string | null;
  typeOnly: boolean;
  /** Each DMZ file that carries the symbol, with its own data. */
  carriers: { contract: ContractSnapshot; symbol: SymbolSnapshot }[];
  importers: { file: string; line: number; bucket: string; used: boolean; via: string }[];
  used: boolean;
  lock: boolean;
}

/** Symbols grouped by declaration: one group for each declared symbol that some DMZ file passes on. */
export function symbolGroups(snapshot: InspectSnapshot): SymbolGroup[] {
  const groups = new Map<string, SymbolGroup>();
  for (const project of snapshot.projects) {
    for (const contract of project.contracts) {
      for (const symbol of contract.symbols) {
        const of = symbol.declaredIn ?? contract.file;
        const key = `${project.path}\0${of}\0${symbol.name}`;
        let group = groups.get(key);
        if (!group) {
          group = {
            key,
            project: project.path,
            name: symbol.name,
            origin: symbol.origin,
            declaredIn: symbol.declaredIn,
            signature: symbol.signature.text,
            typeOnly: symbol.typeOnly,
            carriers: [],
            importers: [],
            used: false,
            lock: false,
          };
          groups.set(key, group);
        }
        group.carriers.push({ contract, symbol });
        for (const imp of symbol.importers) group.importers.push({ ...imp, via: contract.file });
        group.used ||= symbol.used;
        group.lock ||= symbol.lock !== null;
      }
    }
  }
  for (const group of groups.values()) group.importers.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return [...groups.values()].sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.key < b.key ? -1 : 1));
}

function groupOf(group: SymbolGroup): string {
  return group.declaredIn ?? group.carriers[0]!.contract.file;
}

// ---- breadcrumb ----

function ancestors(snapshot: InspectSnapshot, project: ProjectSnapshot): ProjectSnapshot[] {
  const out: ProjectSnapshot[] = [];
  let current: ProjectSnapshot | undefined = project;
  while (current) {
    out.unshift(current);
    current = current.parent === null ? undefined : snapshot.projects.find((p) => p.path === current!.parent);
  }
  return out;
}

export function renderCrumbs(snapshot: InspectSnapshot, state: InspectState): SafeHtml {
  const project = currentProject(snapshot, state);
  const chain = ancestors(snapshot, project);
  const items: SafeHtml[] = chain.map((p, i) => {
    const label = i === 0 ? p.name : p.name;
    const tag = i === 0 ? 'repo' : 'project';
    const current = p.path === project.path && state.bucket === null;
    return html`<li><a href="${href(defaultState(), { view: state.view === 'trace' ? 'map' : state.view, project: p.path })}"${current ? html` aria-current="location"` : ''} data-kind="${tag}" translate="no">${label}</a></li>`;
  });
  if (state.bucket !== null) {
    const root = project.config?.root ?? 'root';
    const rel = state.bucket === root ? [] : state.bucket.slice(root.length + 1).split('/');
    const parts = [root, ...rel];
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      const current = i === parts.length - 1;
      items.push(html`<li><a href="${href(clean(state, {}), { bucket: path })}"${current ? html` aria-current="location"` : ''} data-kind="bucket" translate="no">${part}</a></li>`);
    });
  }
  return html`<nav class="crumbs" id="crumbs" aria-label="Breadcrumb"><span class="ps" aria-hidden="true">$ cd</span><ol>${items}</ol></nav>`;
}

// ---- map ----

/** A cycle or forbidden import the one-level map draws between other boxes than its own buckets, or not at all. */
export interface MapNote {
  id: string;
  kind: 'cycle' | 'forbidden';
  /** The buckets of the violation. */
  buckets: string[];
  /** True when a line is drawn, between the boxes that hold the buckets. */
  drawn: boolean;
  /** Why no line is drawn: every end is inside one box, or an end is outside the level shown. */
  hidden?: 'inside' | 'outside';
  /** The deepest bucket that holds them all: opening it shows them. */
  open: string | null;
}

/** The map data with the notes about violations whose ends are collapsed into another box. */
export interface MapView {
  data: MapData;
  mode: MapMode;
  /** The bucket whose children the one-level map shows. */
  focus: string | null;
  notes: MapNote[];
}

/** The data the map script draws: the buckets of one project and what to draw over them. */
export function mapData(snapshot: InspectSnapshot, state: InspectState, version: number, mode?: MapMode): MapData {
  return mapView(snapshot, state, version, mode).data;
}

/**
 * The map of the current project. A small project gets every bucket, as always. A large one gets one level: the
 * focus bucket and its children as collapsed boxes with their subtree counts, or with `layout=all` every bucket for
 * the treemap. Violation lines whose buckets sit inside a collapsed box are drawn between the boxes that hold them,
 * and each such case gets a note. `force` picks the layout, such as `full` for an export of the whole map.
 */
export function mapView(snapshot: InspectSnapshot, state: InspectState, version: number, force?: MapMode): MapView {
  const project = currentProject(snapshot, state);
  const mode = force ?? mapMode(project, state.layout);
  const nestedInfo = (p: string) => {
    const nested = snapshot.projects.find((x) => x.path === p);
    return { path: p, name: nested?.name ?? p, situation: nested ? projectSituation(nested) : ('ok' as const), status: nested?.status ?? 'ok', buckets: nested?.buckets.length ?? 0 };
  };
  const root = project.config?.root ?? 'root';
  const owned = new Map<string, ContractSnapshot[]>();
  for (const c of project.contracts) {
    if (!owned.has(c.owner)) owned.set(c.owner, []);
    owned.get(c.owner)!.push(c);
  }
  const orphans = orphanCounts(project);
  const stats = subtreeStats(project);
  const focus = mode === 'level' ? mapFocus(project, state.bucket) : null;
  const byPath = new Map(project.buckets.map((b) => [b.path, b]));
  const selectHref = (bucket: string | null) => href(clean(state, { view: 'map' }), { bucket });
  const full = (b: BucketSnapshot, slim: boolean): MapBucketData => {
    const contracts = owned.get(b.path) ?? [];
    return {
      path: b.path,
      name: b.name,
      level: b.level,
      parent: b.parent,
      children: b.children,
      files: b.files,
      situation: b.situation,
      violations: b.violations,
      lockChanges: b.lockChanges,
      orphans: orphans.get(b.path) ?? 0,
      contracts: contracts.length,
      symbols: contracts.reduce((n, c) => n + c.symbols.length, 0),
      dmz: contracts.some((c) => c.situation !== 'ok') ? (contracts.some((c) => c.situation === 'violation') ? ('violation' as const) : ('lock' as const)) : ('ok' as const),
      projects: b.projects.map(nestedInfo),
      // The dependency lines only need the lists of the selected bucket.
      dependsOn: slim && b.path !== state.bucket ? [] : b.dependsOn,
      dependents: slim && b.path !== state.bucket ? [] : b.dependents,
      ins: b.dependents.length,
      outs: b.dependsOn.length,
      cin: b.consumes.length,
      cout: b.offers.length,
      href: selectHref(b.path),
    };
  };
  let buckets: MapBucketData[];
  if (mode === 'level') {
    const f = byPath.get(focus!)!;
    const head = full(f, true);
    // A click on the frame of the focus goes one level up.
    head.href = selectHref(f.parent);
    buckets = [head];
    for (const c of f.children) {
      const child = byPath.get(c);
      if (!child) continue;
      const k = stats.get(c)!;
      const box = full(child, true);
      box.children = [];
      box.inside = k.inside;
      box.situation = k.situation;
      box.violations = k.violations;
      box.orphans = k.orphans;
      box.lockChanges = k.lockChanges;
      buckets.push(box);
    }
  } else {
    buckets = project.buckets.map((b) => full(b, mode === 'treemap'));
    if (mode === 'treemap') {
      // A box too small for its children shows the worst situation below it.
      for (const b of buckets) b.situation = b.children.length > 0 ? (stats.get(b.path)?.situation ?? b.situation) : b.situation;
    }
  }

  // Violations: in the one-level map each end is the box that holds it.
  const box = (bucket: string | null): string | null => (bucket === null ? null : focus === null ? bucket : visibleBox(focus, bucket));
  const notes: MapNote[] = [];
  const cycles: { id: string; buckets: string[] }[] = [];
  const seen = new Set<string>();
  for (const v of project.violations) {
    if (v.kind !== 'cycle' || !v.cycle) continue;
    const key = [...new Set(v.cycle)].sort().join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    if (focus === null) {
      cycles.push({ id: v.id, buckets: v.cycle });
      continue;
    }
    const shown: string[] = [];
    for (const b of v.cycle.map(box)) if (b !== null && shown[shown.length - 1] !== b) shown.push(b);
    const distinct = new Set(shown).size;
    const exact = v.cycle.every((b) => box(b) === b);
    if (distinct >= 2) cycles.push({ id: v.id, buckets: shown[0] === shown[shown.length - 1] ? shown : [...shown, shown[0]!] });
    const outside = v.cycle.some((b) => box(b) === null);
    // A cycle entirely outside the level shown is left to the levels that show it.
    if (!exact && !v.cycle.every((b) => box(b) === null)) {
      notes.push({ id: v.id, kind: 'cycle', buckets: [...new Set(v.cycle)], drawn: distinct >= 2, ...(distinct >= 2 ? {} : { hidden: outside ? ('outside' as const) : ('inside' as const) }), open: commonBucket([...new Set(v.cycle)].map((b) => byPath.get(b)?.parent ?? b)) });
    }
  }
  const orphanLines = focus === null && mode === 'full'
    ? project.violations
        .filter((v) => v.kind === 'orphan' && v.chain)
        .filter((v, i, all) => all.findIndex((w) => w.chain!.symbol === v.chain!.symbol && w.chain!.files.join() === v.chain!.files.join()) === i)
        .map((v) => {
          const files = v.chain!.files;
          const owners = files.map((f) => project.contracts.find((c) => c.file === f)?.owner ?? null).filter((o): o is string => o !== null);
          const tip = project.contracts.find((c) => c.file === files[files.length - 1]);
          return { id: v.id, symbol: v.chain!.symbol, origin: v.chain!.origin, owners, consumer: tip?.consumerBucket ?? null };
        })
    : [];
  const forbidden: MapData['overlays']['forbidden'] = [];
  for (const v of project.violations) {
    if (v.kind !== 'forbidden' || v.bucket === null || !v.target?.bucket || v.target.bucket === v.bucket) continue;
    const from = box(v.bucket);
    const to = box(v.target.bucket);
    const drawn = from !== null && to !== null && from !== to;
    if (drawn) forbidden.push({ id: v.id, from, to, file: where(v) });
    if (focus !== null && (from !== v.bucket || to !== v.target.bucket) && (from !== null || to !== null)) {
      notes.push({ id: v.id, kind: 'forbidden', buckets: [v.bucket, v.target.bucket], drawn, ...(drawn ? {} : { hidden: from === null || to === null ? ('outside' as const) : ('inside' as const) }), open: commonBucket([v.bucket, v.target.bucket].map((b) => byPath.get(b)?.parent ?? b)) });
    }
  }
  const data: MapData = {
    version,
    project: project.path,
    name: project.name,
    root,
    situation: projectSituation(project),
    selected: state.bucket,
    highlight: state.v,
    mode,
    showDeps: state.deps,
    buckets,
    overlays: { cycles, orphans: orphanLines, forbidden },
    projectHref: snapshot.projects.map((p) => ({ path: p.path, href: href(defaultState(), { project: p.path }) })),
  };
  return { data, mode, focus, notes };
}

/**
 * The bucket tree of a large project, the main way around it: collapsible levels, the counts of each subtree, and the
 * filters of the form above it. The path to the selected bucket is open; with a filter, every match and its parents are.
 */
function bucketNav(project: ProjectSnapshot, state: InspectState): SafeHtml {
  const byPath = new Map(project.buckets.map((b) => [b.path, b]));
  const stats = subtreeStats(project);
  const filtering = state.tq.trim() !== '' || state.tf !== null;
  const matches = new Set(project.buckets.filter((b) => bucketMatches(b, state.tq, state.tf)).map((b) => b.path));
  // Buckets to show: every bucket without a filter, else the matches and their parents.
  const keep = new Set<string>();
  if (filtering) {
    for (const m of matches) {
      let p: string | null = m;
      while (p !== null && !keep.has(p)) {
        keep.add(p);
        p = byPath.get(p)?.parent ?? null;
      }
    }
  }
  const openPath = new Set<string>();
  for (let p: string | null = state.bucket; p !== null; p = byPath.get(p)?.parent ?? null) openPath.add(p);
  const root = project.buckets.find((b) => b.parent === null);
  const item = (b: BucketSnapshot): SafeHtml => {
    const k = stats.get(b.path)!;
    const current = state.bucket === b.path;
    const kids = b.children.map((c) => byPath.get(c)!).filter((c) => c !== undefined && (!filtering || keep.has(c.path)));
    const problems = [k.violations > 0 ? plural(k.violations, 'violation') : '', k.lockChanges > 0 ? `${k.lockChanges} pending` : ''].filter((x) => x !== '').join(', ');
    const meta = [b.children.length > 0 ? `${k.inside} inside` : plural(b.files, 'file'), problems].filter((x) => x !== '').join(', ');
    const dim = filtering && !matches.has(b.path) ? ' is-context' : '';
    const row = html`<span class="row${dim}">${led(k.situation, SITUATION_LABEL[k.situation])}<a href="${href(clean(state, { view: 'map' }), { bucket: b.path })}" class="s-${k.situation}"${current ? html` aria-current="true"` : ''} data-nav-item translate="no">${b.name}/</a><span class="meta">${meta}</span></span>`;
    if (kids.length === 0) return html`<li>${row}</li>`;
    const open = b.parent === null || openPath.has(b.path) || filtering;
    return html`<li class="has-kids">${row}<details${open ? html` open` : ''}><summary><span class="visually-hidden">Buckets inside ${b.name}</span></summary><ul>${kids.map(item)}</ul></details></li>`;
  };
  const body = root && (!filtering || keep.has(root.path)) ? html`<ul class="tree-nav" aria-label="Buckets of ${project.name}">${item(root)}</ul>` : html`<p class="empty">No bucket matches.</p>`;
  const count = filtering ? `${plural(matches.size, 'bucket')} of ${project.buckets.length} match` : `${plural(project.buckets.length, 'bucket')}. Open a level with its arrow.`;
  return html`<form class="filters" method="get" action="/" role="search" aria-label="Filter the buckets" data-swap>
  ${hiddenState(state, ['tq', 'tf'])}
  <div class="field"><label for="tq">Find a bucket</label><input type="search" id="tq" name="tq" value="${state.tq}" placeholder="checkout…" autocomplete="off" spellcheck="false" autocapitalize="off" data-live></div>
  <div class="field"><label for="tf">Show</label><select id="tf" name="tf" data-live><option value=""${state.tf === null ? html` selected` : ''}>every bucket</option><option value="problems"${state.tf === 'problems' ? html` selected` : ''}>with problems</option><option value="pending"${state.tf === 'pending' ? html` selected` : ''}>waiting for approval</option></select></div>
  <button type="submit" class="btn btn-mini">Filter</button>
</form>
<p class="dim small" id="tree-count" aria-live="polite">${count}</p>
${body}`;
}

/** Hidden inputs that carry the state through a GET form, leaving out the fields the form itself sets. */
export function hiddenState(state: InspectState, own: (keyof InspectState)[]): SafeHtml {
  const query = new URL(href(clean(state, {}), { bucket: state.bucket, cell: state.cell, symbol: state.symbol, of: state.of }), 'http://x').searchParams;
  const items: SafeHtml[] = [];
  const view = state.view;
  items.push(html`<input type="hidden" name="view" value="${view}">`);
  for (const [key, value] of query) {
    if (key === 'view' || (own as string[]).includes(key)) continue;
    items.push(html`<input type="hidden" name="${key}" value="${value}">`);
  }
  return html`${items}`;
}

function bucketTree(project: ProjectSnapshot, state: InspectState): SafeHtml {
  const byPath = new Map(project.buckets.map((b) => [b.path, b]));
  const lines: SafeHtml[] = [];
  const visit = (bucket: BucketSnapshot, prefix: string, last: boolean, top: boolean): void => {
    const branch = top ? '' : last ? '└─ ' : '├─ ';
    const current = state.bucket === bucket.path;
    const meta = [plural(bucket.files, 'file'), bucket.violations > 0 ? plural(bucket.violations, 'violation') : '', bucket.lockChanges > 0 ? plural(bucket.lockChanges, 'lock difference') : ''].filter((x) => x !== '').join(', ');
    lines.push(
      html`<li><span class="branch" aria-hidden="true">${prefix}${branch}</span>${led(bucket.situation, SITUATION_LABEL[bucket.situation])}<a href="${href(clean(state, { view: 'map' }), { bucket: bucket.path })}" class="s-${bucket.situation}"${current ? html` aria-current="true"` : ''} data-nav-item translate="no">${bucket.name}/</a><span class="meta">${meta}</span></li>`,
    );
    const nextPrefix = top ? '' : `${prefix}${last ? '   ' : '│  '}`;
    const kids = [...bucket.projects.map((p) => ({ kind: 'project' as const, p })), ...bucket.children.map((c) => ({ kind: 'bucket' as const, c }))];
    kids.forEach((kid, i) => {
      const isLast = i === kids.length - 1;
      if (kid.kind === 'project') {
        lines.push(
          html`<li class="project-row"><span class="branch" aria-hidden="true">${nextPrefix}${isLast ? '└─ ' : '├─ '}</span><span class="tag">project</span><a href="${href(defaultState(), { project: kid.p })}" data-zoom="${kid.p}" translate="no">${kid.p}</a></li>`,
        );
      } else {
        const child = byPath.get(kid.c);
        if (child) visit(child, nextPrefix, isLast, false);
      }
    });
  };
  const root = project.buckets[0];
  if (root) visit(root, '', true, true);
  return html`<ul class="tree" aria-label="Buckets of ${project.name}">${lines}</ul>`;
}

function violationItem(v: ViolationSnapshot, state: InspectState, project: ProjectSnapshot): SafeHtml {
  const id = `msg-${v.id}`;
  const extra =
    v.kind === 'cycle' && v.cycle
      ? html`<p class="v-extra">Cycle: ${v.cycle.map((b, i) => html`${i > 0 ? html`<span class="arrow" aria-hidden="true"> -&gt; </span><span class="visually-hidden"> to </span>` : ''}${code(bucketName(project, b))}`)}</p>`
      : v.kind === 'orphan' && v.chain
        ? html`<p class="v-extra">Unused chain of ${code(v.chain.symbol)}: ${v.chain.files.map((f, i) => html`${i > 0 ? html`<span class="arrow" aria-hidden="true"> -&gt; </span>` : ''}${code(f)}`)}</p>`
        : v.kind === 'forbidden' && v.target
          ? html`<p class="v-extra">Points at ${code(v.target.file)}${v.target.bucket ? html` in bucket ${code(bucketName(project, v.target.bucket))}` : ' outside the buckets'}.</p>`
          : '';
  const selected = state.v === v.id;
  return html`<li class="violation k-${v.kind}${selected ? ' is-selected' : ''}">
  <div class="v-head"><span class="rule" translate="no">${v.rule}</span><a href="${href(clean(state, { view: 'map' }), { v: v.id, bucket: v.bucket })}" translate="no"${selected ? html` aria-current="true"` : ''}>${where(v)}</a>${copyButton(id, v.message)}</div>
  ${extra}
  <p class="v-msg">${v.message}</p>
</li>`;
}

/**
 * The map of a large project cut down to the buckets in `keep`, their parents and the root. Each bucket that loses
 * children to the cut gets a line with how many it hides. A small project's map is returned as it is.
 */
export function pruneMap(data: MapData, keep: Iterable<string>): MapData {
  if (data.buckets.length <= MAP_LEVEL_THRESHOLD) return data;
  const byPath = new Map(data.buckets.map((b) => [b.path, b]));
  const shown = new Set<string>();
  const root = data.buckets[0];
  if (root) shown.add(root.path);
  for (const k of keep) {
    for (let p: string | null = k; p !== null && byPath.has(p) && !shown.has(p); p = byPath.get(p)!.parent) shown.add(p);
  }
  const size = new Map<string, number>();
  const count = (path: string): number => {
    if (size.has(path)) return size.get(path)!;
    const n = (byPath.get(path)?.children ?? []).reduce((total, c) => total + 1 + count(c), 0);
    size.set(path, n);
    return n;
  };
  const buckets = data.buckets
    .filter((b) => shown.has(b.path))
    .map((b) => {
      const children = b.children.filter((c) => shown.has(c));
      const hidden = b.children.filter((c) => !shown.has(c)).reduce((n, c) => n + 1 + count(c), 0);
      return hidden === 0 ? { ...b, children } : { ...b, children, lines: [...(b.lines ?? []), { text: `+${hidden} other ${hidden === 1 ? 'bucket' : 'buckets'}`, tone: 'dim' as const }] };
    });
  return { ...data, buckets };
}

/** The nearest bucket of a pruned map that is `path` or holds it. */
export function shownBucket(data: MapData, path: string): string {
  const paths = new Set(data.buckets.map((b) => b.path));
  let p = path;
  while (!paths.has(p) && p.includes('/')) p = p.slice(0, p.lastIndexOf('/'));
  return p;
}

/** A list that shows its first items and keeps the rest for a "Show N more" button (or link, without the script). */
export function cappedList(opts: { items: SafeHtml[]; cap: number; key: string; state: InspectState; tag?: 'ul' | 'ol'; cls?: string; label?: string; noun?: string }): SafeHtml {
  const expanded = opts.state.all === opts.key || opts.state.all === 'all';
  const { shown, rest } = capList(opts.items, opts.cap, expanded);
  const tag = opts.tag ?? 'ul';
  const id = `list-${opts.key}`;
  const attrs = html`${opts.cls ? html` class="${opts.cls}"` : ''}${opts.label ? html` aria-label="${opts.label}"` : ''} id="${id}"`;
  const list = tag === 'ol' ? html`<ol${attrs}>${shown}</ol>` : html`<ul${attrs}>${shown}</ul>`;
  if (rest.length === 0) return list;
  return html`${list}<template id="more-${opts.key}">${rest}</template><p class="more-row"><a class="btn btn-mini" href="${href(opts.state, { all: opts.key })}" data-more="${opts.key}" aria-controls="${id}">Show ${rest.length} more${opts.noun ? ` ${opts.noun}` : ''}</a></p>`;
}

function mapTools(project: ProjectSnapshot, state: InspectState, mode: MapMode): SafeHtml {
  const bucket = state.bucket !== null ? project.buckets.find((b) => b.path === state.bucket) : undefined;
  const hasDeps = bucket !== undefined && bucket.dependsOn.length + bucket.dependents.length > 0;
  const base = clean(state, { view: 'map', bucket: state.bucket, v: state.v });
  const layout =
    mode === 'full'
      ? ''
      : html`<span class="tools-label" id="layout-label">Layout</span><span class="seg" role="group" aria-labelledby="layout-label"><a href="${href(base, { layout: null })}"${mode === 'level' ? html` aria-current="true"` : ''}>One level</a><a href="${href(base, { layout: 'all' })}"${mode === 'treemap' ? html` aria-current="true"` : ''}>Show all</a></span>`;
  const deps = hasDeps
    ? html`<a class="btn btn-mini" href="${href(base, { deps: !state.deps })}" id="deps-toggle">${state.deps ? 'Hide dependencies' : 'Show dependencies'}</a>`
    : '';
  // The script turns the button on; without it the map stays in the page.
  const full = html`<button type="button" class="btn btn-mini" id="map-full" aria-pressed="false" aria-controls="map-stage">Fullscreen</button>`;
  return html`<div class="map-tools">${layout}${deps}${full}</div>`;
}

/** The legend of the labels the map puts on the selected bucket and on the buckets related to it. */
function tagLegend(project: ProjectSnapshot, state: InspectState): SafeHtml {
  const bucket = state.bucket !== null ? project.buckets.find((b) => b.path === state.bucket) : undefined;
  if (!bucket) return html``;
  return html`<ul class="legend tag-legend" aria-label="Labels of the selection">
  <li><span class="t t-sel" aria-hidden="true">● ${bucket.name}/</span>selected</li>
  <li><span class="t t-dep" aria-hidden="true">→</span>depends on <span class="dim">${bucket.dependsOn.length}</span></li>
  <li><span class="t t-use" aria-hidden="true">•</span>used by <span class="dim">${bucket.dependents.length}</span></li>
</ul>`;
}

function mapNotes(project: ProjectSnapshot, state: InspectState, notes: MapNote[]): SafeHtml {
  if (notes.length === 0) return html``;
  const name = (b: string) => bucketName(project, b);
  const items = notes.map((n) => {
    const what = n.kind === 'cycle' ? html`The cycle through ${n.buckets.map((b, i) => html`${i > 0 ? ', ' : ''}${code(name(b))}`)}` : html`The forbidden import from ${code(name(n.buckets[0]!))} to ${code(name(n.buckets[1]!))}`;
    const how = n.drawn ? 'is drawn between the boxes that hold its buckets' : n.hidden === 'outside' ? 'has an end outside this level, so no line is drawn' : 'is inside one box at this level, so no line is drawn';
    const open = n.open !== null ? html` <a href="${href(clean(state, { view: 'map' }), { bucket: n.open, v: n.id })}">Open ${n.open === (project.config?.root ?? 'root') ? 'the root level' : name(n.open)}</a>.` : '';
    return html`<li>${what} ${how}.${open}</li>`;
  });
  return html`<ul class="map-notes small" aria-label="Violations inside collapsed boxes">${items}</ul>`;
}

export function renderMapView(input: PageInput): SafeHtml {
  const { snapshot, state } = input;
  const project = currentProject(snapshot, state);
  if (project.status === 'environment' || project.buckets.length === 0) return environmentScreen(project, 'map');
  const view = mapView(snapshot, state, input.version);
  const large = isLarge(project);
  const legend = html`<ul class="legend" aria-label="Legend">
  <li><span class="swatch s-ok" aria-hidden="true"></span>ok</li>
  <li><span class="swatch s-lock" aria-hidden="true"></span>differs from the lock</li>
  <li><span class="swatch s-violation" aria-hidden="true"></span>violation</li>
  <li><span class="swatch k-project" aria-hidden="true"></span>nested project</li>
  <li><span class="swatch k-cycle" aria-hidden="true"></span>cycle</li>
  ${view.mode === 'full' ? html`<li><span class="swatch k-orphan" aria-hidden="true"></span>orphan chain</li>` : ''}
  <li><span class="swatch k-forbidden" aria-hidden="true"></span>forbidden import</li>
  <li><span class="mark" aria-hidden="true">✗2 ○1 ~3</span>violations, orphans, lock differences</li>
</ul>`;
  const violations = project.violations;
  const right = `${plural(project.buckets.length, 'bucket')}, ${plural(project.contracts.length, 'contract')}`;
  const focusBucket = view.focus !== null ? project.buckets.find((b) => b.path === view.focus) : undefined;
  const shownBuckets = view.mode === 'level' ? view.data.buckets.length - 1 : project.buckets.length;
  const intro =
    view.mode === 'level'
      ? html`<p class="intro">${project.name} has ${plural(project.buckets.length, 'bucket')}, so the map shows one level at a time: the ${plural(shownBuckets, 'bucket')} inside ${code(focusBucket ? `${bucketName(project, focusBucket.path)}` : 'root/')}. The badge of a box counts the problems in everything below it. Hover a box for its files and contracts. Select a box to open it; the breadcrumb goes back up.</p>`
      : view.mode === 'treemap'
        ? html`<p class="intro">Every bucket of ${project.name} at once. The area of a box follows the files in it and below it. Green passes, amber differs from the lock, red breaks a rule. Names show where they fit; the tree below has them all.</p>`
        : html`<p class="intro">Each box is a bucket. Green passes, amber differs from the lock, red breaks a rule. Select a box to see what it offers and consumes${project.nested.length > 0 ? ', or enter a nested project' : ''}.</p>`;
  const label =
    view.mode === 'level'
      ? `Map of the ${plural(shownBuckets, 'bucket')} inside ${focusBucket?.path ?? 'the root bucket'} in ${project.name}. The bucket tree below has every bucket as a link.`
      : `Map of the ${plural(project.buckets.length, 'bucket')} of ${project.name}. The list below has the same buckets as links.`;
  const vItems = violations.map((v) => violationItem(v, state, project));
  return screen(
    'tty1',
    `map ${project.name}`,
    right,
    html`<h1 class="view-title" id="view-title">Map <span class="dim">of ${project.name}</span></h1>
${intro}
<div class="map-stage" id="map-stage" role="region" aria-label="Map of ${project.name}">
${mapTools(project, state, view.mode)}
<div class="map-shell" id="map-shell" data-mode="${view.mode}">
  <p class="map-key" id="map-key" aria-label="Key to the map"><span><b class="tk-bad" aria-hidden="true">✗</b>violations</span><span><b class="tk-bad" aria-hidden="true">○</b>orphans</span><span><b class="tk-lock" aria-hidden="true">~</b>pending</span></p>
  <div class="map-scroll" id="map-scroll" tabindex="0" aria-label="Bucket map, scrollable">
    <div class="map-space" id="map-space"><canvas class="map-canvas" id="map-canvas" role="img" aria-label="${label}"></canvas></div>
  </div>
  <p class="map-hint dim" id="map-hint">${view.mode === 'level' ? 'Click a box to open it, or its outer frame to go up a level. ' : 'Click a box to select it. '}${project.nested.length > 0 ? 'Click a project box to enter it. ' : ''}With the map focused, the arrow keys move between boxes and Enter opens one. Keys: j and k move, u goes up, f shows the map in fullscreen, m opens the matrix.</p>
  <p class="map-hint dim" id="map-skipped" hidden></p>
  <p class="map-hint dim" id="map-tags-note" hidden></p>
  <div class="map-tip" id="map-tip" role="tooltip" hidden></div>
</div>
${tagLegend(project, state)}
${mapNotes(project, state, view.notes)}
${legend}
</div>
${exportRow(project)}
<h2 class="sub" id="tree-title">Buckets</h2>
${large ? bucketNav(project, state) : bucketTree(project, state)}
<h2 class="sub" id="violations-title">Violations <span class="dim">${violations.length}</span></h2>
${
  violations.length === 0
    ? html`<p class="empty">No violations in ${project.name}.</p>`
    : cappedList({ items: vItems, cap: 40, key: 'violations', state, cls: 'violations', label: 'Violations', noun: 'violations' })
}`,
    { id: 'view', labelledBy: 'view-title', cls: 'view view-map' },
  );
}

export function environmentScreen(project: ProjectSnapshot, name: string): SafeHtml {
  return screen(
    'tty1',
    `${name} ${project.name}`,
    'no data',
    html`<h1 class="view-title" id="view-title">${project.name}</h1>
${
  project.environment
    ? html`<div class="callout bad"><p><strong>The check could not run</strong> (${code(project.environment.code)}), so there is nothing to draw.</p><pre class="term wrap" tabindex="0">${project.environment.message}</pre></div>`
    : html`<div class="callout bad"><p>The project has no buckets to show. ${project.violations.length > 0 ? 'Its config or root folder is broken:' : ''}</p>${project.violations.length > 0 ? html`<ul class="violations">${project.violations.map((v) => html`<li class="violation"><div class="v-head"><span class="rule">${v.rule}</span><span>${where(v)}</span></div><p class="v-msg">${v.message}</p></li>`)}</ul>` : ''}</div>`
}`,
    { id: 'view', labelledBy: 'view-title', cls: 'view', tone: 'red' },
  );
}

/** Download links for the exports. The server answers them as attachments, so the page stays where it is. */
export function exportRow(project: ProjectSnapshot, only?: 'mermaid'): SafeHtml {
  const svg = `/export/map.svg${project.path === '.' ? '' : `?project=${encodeURIComponent(project.path)}`}`;
  return html`<div class="export-row" role="group" aria-labelledby="export-label-${only ?? 'all'}">
  <span class="export-label" id="export-label-${only ?? 'all'}">Export</span>
  ${only === undefined ? html`<a class="btn btn-mini" href="${svg}" download data-export="svg">Map as SVG</a>` : ''}
  <a class="btn btn-mini" href="/export/buckets.mmd" download data-export="mermaid">Bucket graph as Mermaid</a>
  <span class="dim small">${only === undefined ? `The SVG draws this map of ${project.name}. ` : ''}The Mermaid flowchart has every project, bucket and contract. Or run <code translate="no">buckets inspect --export svg</code>.</span>
</div>`;
}

// ---- matrix ----

function matrixFor(owner: BucketSnapshot, state: InspectState, layout: MatrixLayout): SafeHtml {
  const { providers, consumers, contracts, removed } = layout;
  const children = owner.children.map((c) => c.slice(c.lastIndexOf('/') + 1));
  const valid = (p: string, c: string): boolean => {
    if (p === '.self' || p === '.parent') return children.includes(c);
    return c !== p;
  };
  const label = (name: string): string => (name === '.self' ? `.self (${owner.name}/_)` : name);
  const cellHref = (file: string) => href(clean(state, { view: 'matrix' }), { cell: file, bucket: state.bucket });
  const id = `mx-${owner.path.replace(/[^\w-]/g, '_')}`;
  const total = [...contracts.values()].reduce((n, c) => n + c.symbols.length, 0);
  const counts = `level ${owner.level}, ${layout.contracts.size === layout.total ? plural(layout.total, 'contract') : `${layout.contracts.size} of ${plural(layout.total, 'contract')}`}, ${plural(total, 'symbol')}`;
  const switchLink = layout.wide
    ? html`<a class="btn btn-mini" href="${href(clean(state, { view: 'matrix', cell: state.cell, bucket: state.bucket }), { table: layout.mode === 'list' ? owner.path : null })}">${layout.mode === 'list' ? 'Show as a table' : 'Show as a list'}</a>`
    : '';
  const head = html`<h2 class="sub" id="${id}"><span translate="no">${owner.path}/dmz/</span> <span class="dim">${counts}</span></h2>`;
  if (contracts.size === 0 && removed.size === 0) {
    return html`<section class="matrix" aria-labelledby="${id}">${head}<p class="empty">No contracts in this folder yet.</p></section>`;
  }
  if (layout.mode === 'list') {
    const rows: SafeHtml[] = [];
    for (const p of providers) {
      const own = consumers.map((c) => ({ c, contract: contracts.get(`${p}\0${c}`), file: `${owner.path}/dmz/${p}/${c}.ts` })).filter((x) => x.contract !== undefined || removed.has(x.file));
      if (own.length === 0) continue;
      own.forEach((x, i) => {
        const providerCell = i === 0 ? html`<th scope="rowgroup" rowspan="${own.length}" translate="no">${label(p)}</th>` : '';
        if (x.contract === undefined) {
          rows.push(html`<tr class="${i === 0 ? 'first' : ''}">${providerCell}<td translate="no">${label(x.c)}</td><td class="num">-</td><td><span class="badge s-lock">deleted</span></td></tr>`);
          return;
        }
        const c = x.contract;
        const selected = state.cell === c.file;
        const status = c.situation === 'violation' ? badge('violation') : c.lock !== null ? badge('lock', c.lock === 'added' ? 'not approved' : 'changed') : html`<span class="dim">ok</span>`;
        rows.push(
          html`<tr class="${i === 0 ? 'first' : ''}${selected ? ' is-selected' : ''}">${providerCell}<td><a href="${cellHref(c.file)}" class="s-${c.situation}" translate="no"${selected ? html` aria-current="true"` : ''} data-nav-item>${label(x.c)}</a></td><td class="num">${c.symbols.length}</td><td>${status}</td></tr>`,
        );
      });
    }
    const listKey = `mx-${owner.path.replace(/[^\w.-]/g, '_')}`;
    const { shown, rest } = capList(rows, 40, state.all === listKey || state.all === 'all');
    const more =
      rest.length > 0
        ? html`<template id="more-${listKey}">${rest}</template><p class="more-row"><a class="btn btn-mini" href="${href(state, { all: listKey })}" data-more="${listKey}" aria-controls="list-${listKey}">Show ${rest.length} more contracts</a></p>`
        : '';
    return html`<section class="matrix is-list" aria-labelledby="${id}">
  ${head}
  <p class="mx-why small dim">${plural(Math.max(providers.length, consumers.length), 'bucket')} take part here, too many for a readable table, so the contracts are listed by provider. ${switchLink}</p>
  <div class="table-scroll" tabindex="0" role="region" aria-label="Contracts of ${owner.path}/dmz">
  <table class="mx-list">
    <thead><tr><th scope="col">Provider</th><th scope="col">Consumer</th><th scope="col">Symbols</th><th scope="col">Status</th></tr></thead>
    <tbody id="list-${listKey}">${shown}</tbody>
  </table>
  </div>
  ${more}
</section>`;
  }
  const rows = providers.map((p) => {
    const cells = consumers.map((c) => {
      if (!valid(p, c)) return html`<td class="cell none"><span aria-hidden="true">·</span><span class="visually-hidden">not a valid contract</span></td>`;
      const contract = contracts.get(`${p}\0${c}`);
      const file = `${owner.path}/dmz/${p}/${c}.ts`;
      if (!contract) {
        if (removed.has(file)) return html`<td class="cell"><span class="count s-lock" title="${file} was deleted since the last approval">del</span></td>`;
        return html`<td class="cell empty"><span aria-hidden="true">-</span><span class="visually-hidden">no contract</span></td>`;
      }
      const selected = state.cell === contract.file;
      return html`<td class="cell"><a class="count s-${contract.situation}" href="${cellHref(contract.file)}" aria-label="${plural(contract.symbols.length, 'symbol')} from ${p} to ${c}${contract.situation !== 'ok' ? `, ${SITUATION_LABEL[contract.situation]}` : ''}"${selected ? html` aria-current="true"` : ''} data-nav-item>${contract.symbols.length}</a></td>`;
    });
    return html`<tr><th scope="row" translate="no">${label(p)}</th>${cells}</tr>`;
  });
  return html`<section class="matrix" aria-labelledby="${id}">
  ${head}
  ${layout.sparse || layout.wide ? html`<p class="mx-why small dim">${layout.sparse ? 'Only the rows and columns with a contract are shown. ' : ''}${switchLink}</p>` : ''}
  <div class="table-scroll" tabindex="0" role="region" aria-label="Contracts of ${owner.path}/dmz">
  <table class="mx">
    <thead><tr><th scope="col" class="corner"><span class="dim">provider</span> \\ <span class="dim">consumer</span></th>${consumers.map((c) => html`<th scope="col" translate="no">${label(c)}</th>`)}</tr></thead>
    <tbody>${rows}</tbody>
  </table>
  </div>
</section>`;
}

export function renderMatrixView(input: PageInput): SafeHtml {
  const { snapshot, state } = input;
  const project = currentProject(snapshot, state);
  if (project.status === 'environment' || project.buckets.length === 0) return environmentScreen(project, 'matrix');
  const owners = project.buckets.filter((b) => b.children.length > 0);
  const filter = { q: state.mq, focus: state.mf };
  const filtering = state.mq.trim() !== '' || state.mf !== null;
  const layouts = owners.map((o) => ({ owner: o, layout: matrixLayout(project, o, filter, state.table === o.path) })).filter((x): x is { owner: BucketSnapshot; layout: MatrixLayout } => x.layout !== null);
  const shownContracts = layouts.reduce((n, x) => n + x.layout.contracts.size, 0);
  const form = html`<form class="filters" method="get" action="/" role="search" aria-label="Filter the contracts" data-swap>
  ${hiddenState(state, ['mq', 'mf', 'cell', 'all'])}
  <div class="field"><label for="mq">Find a contract</label><input type="search" id="mq" name="mq" value="${state.mq}" placeholder="billing or a symbol…" autocomplete="off" spellcheck="false" autocapitalize="off" data-live></div>
  <div class="field"><label for="mf">Show</label><select id="mf" name="mf" data-live><option value=""${state.mf === null ? html` selected` : ''}>every contract</option><option value="problems"${state.mf === 'problems' ? html` selected` : ''}>with problems</option><option value="pending"${state.mf === 'pending' ? html` selected` : ''}>waiting for approval</option></select></div>
  <button type="submit" class="btn btn-mini">Filter</button>
</form>
<p class="dim small" id="matrix-count" aria-live="polite">${filtering ? `${plural(shownContracts, 'contract')} of ${project.contracts.length} match, in ${plural(layouts.length, 'DMZ folder')}.` : `${plural(project.contracts.length, 'contract')} in ${plural(owners.length, 'DMZ folder')}.`}</p>`;
  return screen(
    'tty2',
    `matrix ${project.name}`,
    plural(project.contracts.length, 'contract'),
    html`<h1 class="view-title" id="view-title">DMZ matrix <span class="dim">of ${project.name}</span></h1>
<p class="intro">One table per ${code('dmz/')} folder. Rows provide, columns consume, and each number counts the symbols of that contract file. ${code('.self')} is the bucket's own ${code('_/')}, ${code('.parent')} is the level above and ${code('.external')} publishes to other projects. Select a number to see the symbols with their signatures and chains.</p>
${isLarge(project) || filtering ? form : ''}
${owners.length === 0 ? html`<p class="empty">No bucket of ${project.name} has child buckets, so there is no DMZ yet.</p>` : layouts.length === 0 ? html`<p class="empty">No contract matches.</p>` : layouts.map((x) => matrixFor(x.owner, state, x.layout))}`,
    { id: 'view', labelledBy: 'view-title', cls: 'view view-matrix' },
  );
}

function chainList(symbol: SymbolSnapshot): SafeHtml {
  const steps = [...symbol.chain].reverse();
  return html`<ol class="chain" aria-label="Re-export chain from the declaration">${steps.map((f, i) => html`<li class="hop d${Math.min(i, 11)}${i === 0 ? ' decl' : ''}"><code translate="no">${f}</code></li>`)}</ol>`;
}

export function renderContractPanel(project: ProjectSnapshot, contract: ContractSnapshot, state: InspectState): SafeHtml {
  const about = describeDmzPath(contract.file);
  const symbols = contract.symbols.map(
    (s) => html`<li class="sym${s.used ? '' : ' unused'}">
  <div class="sym-head"><a href="${href(clean(state, { view: 'trace' }), { symbol: s.name, of: s.declaredIn ?? contract.file })}" translate="no">${s.name}</a>${s.typeOnly ? html`<span class="tag">type</span>` : ''}${s.lock ? badge('lock', s.lock === 'added' ? 'new' : 'signature changed') : ''}${s.used ? '' : badge('violation', 'orphan')}<span class="dim">line ${s.line}</span></div>
  ${s.signature.text !== null ? html`<pre class="term sig" translate="no" tabindex="0">${s.signature.text}</pre>` : html`<p class="dim">No declaration found${s.origin === null ? ': the re-export chain is broken' : ''}.</p>`}
  <p class="dim small">Origin ${s.origin !== null ? code(bucketName(project, s.origin)) : 'unknown'}${s.importers.length > 0 ? html`, imported by ${plural(s.importers.length, 'file')}` : ''}.</p>
  ${chainList(s)}
</li>`,
  );
  return screen(
    'tty3',
    'contract',
    `${plural(contract.symbols.length, 'symbol')}`,
    html`<h2 class="panel-title" id="panel-title"><span translate="no">${contract.file.slice(contract.owner.length + 1)}</span></h2>
<p class="path dim" translate="no">${contract.file}</p>
${about !== null ? html`<p>${about}</p>` : ''}
<p class="badges">${badge(contract.situation)}${contract.lock !== null ? badge('lock', contract.lock === 'added' ? 'not in the lock yet' : 'changed since the lock') : ''}</p>
${contract.symbols.length === 0 ? html`<p class="empty">The file re-exports nothing, which makes it an orphan.</p>` : html`<ul class="symbols-list">${symbols}</ul>`}
<p><a href="${href(clean(state, { view: 'matrix' }), { bucket: state.bucket })}">Close</a></p>`,
    { id: 'panel', labelledBy: 'panel-title', cls: 'panel', ...(contract.situation === 'violation' ? { tone: 'red' as const } : contract.situation === 'lock' ? { tone: 'amber' as const } : {}) },
  );
}

// ---- trace ----

function chainTree(group: SymbolGroup): SafeHtml {
  // Merge the chains of every carrier into one tree that starts at the declaration.
  interface Node {
    file: string;
    children: Map<string, Node>;
    carrier?: { contract: ContractSnapshot; symbol: SymbolSnapshot };
  }
  const root: Node = { file: groupOf(group), children: new Map() };
  for (const carrier of group.carriers) {
    const steps = [...carrier.symbol.chain].reverse();
    let node = root;
    for (const step of steps.slice(group.declaredIn !== null ? 1 : 0)) {
      if (step === node.file) continue;
      let next = node.children.get(step);
      if (!next) {
        next = { file: step, children: new Map() };
        node.children.set(step, next);
      }
      node = next;
    }
    node.carrier = carrier;
  }
  const render = (node: Node, depth: number): SafeHtml => {
    const importers = node.carrier ? node.carrier.symbol.importers : [];
    const about = node.carrier ? describeDmzPath(node.file) : null;
    return html`<li class="hop d${Math.min(depth, 11)}${depth === 0 ? ' decl' : ''}">
  <code translate="no">${node.file}</code>${depth === 0 && group.declaredIn !== null ? html`<span class="tag">declared</span>` : ''}${node.carrier && !node.carrier.symbol.used ? badge('violation', 'orphan') : ''}${node.carrier?.symbol.lock ? badge('lock', node.carrier.symbol.lock === 'added' ? 'new' : 'signature changed') : ''}
  ${about !== null ? html`<span class="about dim">${about}</span>` : ''}
  ${importers.length > 0 ? html`<ul class="importers">${importers.map((imp) => html`<li><span class="dim">imported by</span> <code translate="no">${imp.file}:${imp.line}</code>${imp.used ? '' : html` <span class="warn">(never used)</span>`}</li>`)}</ul>` : ''}
  ${node.children.size > 0 ? html`<ol>${[...node.children.values()].map((child) => render(child, depth + 1))}</ol>` : ''}
</li>`;
  };
  return html`<ol class="trace-tree pulse" aria-label="Re-export chain">${render(root, 0)}</ol>`;
}

export function renderTraceView(input: PageInput): SafeHtml {
  const { snapshot, state } = input;
  const groups = symbolGroups(snapshot);
  const query = state.q.trim().toLowerCase();
  const matches = query === '' ? groups : groups.filter((g) => g.name.toLowerCase().includes(query) || (g.origin ?? '').toLowerCase().includes(query));
  const selected = state.symbol !== null ? (groups.find((g) => g.name === state.symbol && g.project === state.project && (state.of === null || groupOf(g) === state.of)) ?? groups.find((g) => g.name === state.symbol)) : undefined;
  const projectOf = (p: string) => snapshot.projects.find((x) => x.path === p)!;
  const results = matches.map((g) => {
    const current = selected?.key === g.key;
    const project = projectOf(g.project);
    return html`<li${current ? html` class="is-selected"` : ''}><a href="${href({ ...defaultState(), view: 'trace', project: g.project, q: state.q }, { symbol: g.name, of: groupOf(g) })}"${current ? html` aria-current="true"` : ''} data-nav-item><span class="name" translate="no">${g.name}</span><span class="meta"><span translate="no">${g.origin !== null ? bucketName(project, g.origin) : 'broken chain'}</span>${snapshot.projects.length > 1 ? html` <span class="tag">${project.name}</span>` : ''}</span><span class="counts">${plural(g.carriers.length, 'file')}, ${plural(g.importers.length, 'import')}</span>${g.used ? '' : html`<span class="badge s-violation">orphan</span>`}${g.lock ? html`<span class="badge s-lock">lock</span>` : ''}</a></li>`;
  });
  let detail: SafeHtml = html`<p class="empty">Select a symbol to see where it is declared, the DMZ files it passes through and every file that imports it.</p>`;
  if (state.symbol !== null && !selected) detail = html`<p class="empty">No DMZ symbol named ${code(state.symbol)}.</p>`;
  if (selected) {
    const project = projectOf(selected.project);
    detail = html`<article class="trace-detail" aria-labelledby="trace-title">
  <h2 class="sub" id="trace-title"><span translate="no">${selected.name}</span>${selected.typeOnly ? html` <span class="tag">type</span>` : ''}</h2>
  <dl class="facts">
    <dt>Origin</dt><dd>${selected.origin !== null ? html`<a href="${href(clean(state, { view: 'map', project: selected.project }), { bucket: selected.origin })}" translate="no">${bucketName(project, selected.origin)}</a>` : 'unknown, the re-export chain is broken'}</dd>
    <dt>Declared in</dt><dd>${selected.declaredIn !== null ? code(selected.declaredIn) : '-'}</dd>
    ${snapshot.projects.length > 1 ? html`<dt>Project</dt><dd translate="no">${projectLabel(project)}</dd>` : ''}
    <dt>Used</dt><dd>${plural(selected.importers.length, 'import')} through ${plural(selected.carriers.length, 'DMZ file')}${selected.used ? '' : html`, <span class="bad">some files are orphans</span>`}</dd>
  </dl>
  ${selected.signature !== null ? html`<pre class="term sig" translate="no" tabindex="0" aria-label="Signature">${selected.signature}</pre>` : html`<p class="dim">No declaration text found.</p>`}
  <h3 class="sub3">Chain</h3>
  ${chainTree(selected)}
</article>`;
  }
  return screen(
    'tty3',
    'trace',
    plural(groups.length, 'symbol'),
    html`<h1 class="view-title" id="view-title">Symbol trace</h1>
<form class="search" method="get" action="/" role="search" id="search-form">
  <input type="hidden" name="view" value="trace">
  ${state.project !== '.' ? html`<input type="hidden" name="project" value="${state.project}">` : ''}
  <label for="q">Symbol name</label>
  <div class="search-row"><span class="ps" aria-hidden="true">/</span><input type="search" id="q" name="q" value="${state.q}" placeholder="logger…" autocomplete="off" spellcheck="false" autocapitalize="off" data-keep><button type="submit" class="btn btn-mini">Search</button></div>
</form>
<div class="trace-grid">
  <div class="results">
    <p class="dim small" id="result-count" aria-live="polite">${query === '' ? `All ${plural(groups.length, 'symbol')}` : `${plural(matches.length, 'match')} for "${state.q}"`}</p>
    ${matches.length > 0 ? cappedList({ items: results, cap: 60, key: 'symbols', state, cls: 'result-list', label: 'Symbols', noun: 'symbols' }) : html`<p class="empty">No symbol matches.</p>`}
  </div>
  <div class="detail">${detail}</div>
</div>`,
    { id: 'view', labelledBy: 'view-title', cls: 'view view-trace' },
  );
}

// ---- projects ----

const LINK_STATE_TEXT: Record<LinkEdge['state'], string> = {
  ok: 'in sync',
  missing: 'missing on disk',
  drift: 'the origin changed since the copy',
  changed: 'changed since the lock',
  added: 'not approved yet',
  removed: 'removed, waiting for approval',
};

/**
 * The constellation as SVG: the visible projects as a tree in a left column, origins outside them in a right column,
 * and each link on its own orthogonal track between the columns (see constellation-layout.ts).
 */
export function constellation(snapshot: InspectSnapshot, state: InspectState): SafeHtml {
  const layout = layoutConstellation(snapshot.projects, snapshot.links);
  const W = layout.width;
  const H = layout.height;
  const byPath = new Map(snapshot.projects.map((p) => [p.path, p]));
  const nest = layout.nests.map((n) => html`<path class="nest" fill="none" d="${n.d}"></path>`);
  const edges = layout.edges.map((e) => {
    const l = snapshot.links[e.index]!;
    const selected = state.project === l.from && state.link === l.link;
    const cls = `edge m-${l.mode} st-${l.state}${selected ? ' is-selected' : ''}`;
    const label = `Link ${l.name}: ${l.from === '.' ? 'repo' : l.from} uses ${l.to === null ? l.origin : l.to === '.' ? 'repo' : l.to}, ${l.mode} mode, ${LINK_STATE_TEXT[l.state]}`;
    return html`<a href="${href(defaultState(), { view: 'projects', project: l.from, link: l.link })}" class="${cls}" aria-label="${label}"${selected ? html` aria-current="true"` : ''} data-nav-item>
  <title>${label}</title>
  <path class="hit" d="${e.d}"></path>
  <path class="line" d="${e.d}" marker-end="url(#arrow-${l.state === 'missing' ? 'red' : l.state === 'ok' ? 'green' : 'amber'})"></path>
  <rect class="edge-label-bg" x="${e.label.x}" y="${e.label.y}" width="${e.label.w}" height="${e.label.h}" rx="3"></rect>
  <text class="edge-label" x="${e.label.x + 5}" y="${e.label.baseline}">${e.label.text}</text>
</a>`;
  });
  const boxes = layout.boxes.map((b) => {
    const project = b.outside ? undefined : byPath.get(b.key.slice(2));
    const where = b.key.slice(2);
    const label = project ? project.name : (where.split('/').filter((s) => s !== '' && s !== '.' && s !== '..').pop() ?? 'outside');
    const sub = project ? (project.path === '.' ? 'repo' : project.path) : where;
    const situation: Situation = project ? projectSituation(project) : 'ok';
    const cy = b.y + b.h / 2;
    const current = project !== undefined && project.path === state.project;
    const body = html`<rect class="frame" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"></rect>
  <rect class="frame inner" x="${b.x + 4}" y="${b.y + 4}" width="${b.w - 8}" height="${b.h - 8}"></rect>
  ${project ? html`<circle class="led s-${situation}" cx="${b.x + 18}" cy="${cy - 6}" r="5"></circle>` : ''}
  <text class="name" x="${b.x + (project ? 30 : 14)}" y="${cy - 2}">${label.length > 18 ? `${label.slice(0, 17)}…` : label}</text>
  <text class="sub" x="${b.x + 14}" y="${cy + 18}">${sub.length > 25 ? `…${sub.slice(-24)}` : sub}</text>`;
    return project
      ? html`<a href="${href(defaultState(), { view: 'projects', project: project.path })}" class="node s-${situation}${current ? ' is-current' : ''}" aria-label="Project ${label} (${sub}), ${SITUATION_LABEL[situation]}"${current ? html` aria-current="true"` : ''}><title>${label}</title>${body}</a>`
      : html`<g class="node outside" role="img" aria-label="Origin outside the visible projects: ${sub}"><title>${sub}</title>${body}</g>`;
  });
  return html`<div class="constellation-scroll" tabindex="0" role="region" aria-label="Constellation of projects, scrollable">
<svg class="constellation" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="group" aria-label="Projects and the links between them">
  <defs>
    <marker id="arrow-green" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="ah ok"></path></marker>
    <marker id="arrow-amber" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="ah lock"></path></marker>
    <marker id="arrow-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="ah bad"></path></marker>
  </defs>
  <g class="nests">${nest}</g>
  <g class="edges">${edges}</g>
  <g class="nodes">${boxes}</g>
</svg>
</div>`;
}

export function renderProjectsView(input: PageInput): SafeHtml {
  const { snapshot, state } = input;
  const surfaces = snapshot.projects.map((p) => {
    const consumed = p.links;
    return html`<article class="surface" aria-labelledby="sf-${p.path.replace(/[^\w-]/g, '_')}">
  <h3 class="sub3" id="sf-${p.path.replace(/[^\w-]/g, '_')}">${led(projectSituation(p), p.status)}<a href="${href(defaultState(), { project: p.path })}" translate="no">${p.name}</a> <span class="dim" translate="no">${p.path === '.' ? 'repo' : p.path}</span></h3>
  ${
    p.external.length === 0
      ? html`<p class="dim small">Publishes nothing (no ${code('.external.ts')}).</p>`
      : html`<ul class="publish">${p.external.map(
          (e) => html`<li><code translate="no">${e.file}</code>
      <p class="small">${e.symbols.length === 0 ? 'No symbols.' : html`Publishes ${e.symbols.map((s, i) => html`${i > 0 ? ', ' : ''}<code translate="no">${s.name}</code>`)}.`} ${e.consumers.length === 0 ? html`<span class="dim">No visible project consumes it.</span>` : html`Consumed by ${e.consumers.map((c, i) => html`${i > 0 ? ', ' : ''}<a href="${href(defaultState(), { view: 'projects', project: c.project, link: c.link })}" translate="no">${c.project === '.' ? 'repo' : c.project}</a>`)}.`}</p></li>`,
        )}</ul>`
  }
  ${consumed.length > 0 ? html`<p class="small">Consumes ${consumed.map((l, i) => html`${i > 0 ? ', ' : ''}<a href="${href(defaultState(), { view: 'projects', project: p.path, link: l.path })}" class="st-${l.state}" translate="no">${l.name}</a> <span class="dim">(${l.mode}, ${LINK_STATE_TEXT[l.state]})</span>`)}.</p>` : ''}
</article>`;
  });
  return screen(
    'tty4',
    'projects',
    `${plural(snapshot.projects.length, 'project')}, ${plural(snapshot.links.length, 'link')}`,
    html`<h1 class="view-title" id="view-title">Projects</h1>
<p class="intro">Each box is a project with its own lock: the repo and the projects nested in its buckets. Arrows are links, from the project that consumes to the project that publishes. A solid line is a link, a dashed line is a copy, amber means drift or a change waiting for approval, red means the link is missing.</p>
${constellation(snapshot, state)}
<ul class="legend" aria-label="Legend">
  <li><span class="swatch e-link" aria-hidden="true"></span>link</li>
  <li><span class="swatch e-copy" aria-hidden="true"></span>copy</li>
  <li><span class="swatch e-drift" aria-hidden="true"></span>drift or not approved</li>
  <li><span class="swatch e-missing" aria-hidden="true"></span>missing</li>
  <li><span class="swatch e-nest" aria-hidden="true"></span>nested in</li>
</ul>
${exportRow(currentProject(snapshot, state), 'mermaid')}
<h2 class="sub">Public surfaces</h2>
<div class="surfaces">${surfaces}</div>`,
    { id: 'view', labelledBy: 'view-title', cls: 'view view-projects' },
  );
}

/** How a published symbol differs from the approved lock, with the sign and words of the approvals page. */
const LINK_SYMBOL_CHANGE: Record<NonNullable<LinkSymbol['change']>, { cls: string; sign: string; note: string }> = {
  added: { cls: 'add', sign: '+', note: 'published, not approved yet' },
  removed: { cls: 'del', sign: '-', note: 'no longer published' },
  changed: { cls: 'chg', sign: '~', note: 'signature changed' },
};

/**
 * The published symbols of a link. A symbol that differs from the approved lock gets the sign, color and words that
 * the approvals page uses, so the color is never the only cue.
 */
function linkSymbolList(link: LinkSnapshot): SafeHtml {
  const changed = link.symbols.filter((s) => s.change !== undefined).length;
  const summary =
    changed === 0
      ? ''
      : html`<p class="small">${plural(changed, 'published symbol')} ${changed === 1 ? 'differs' : 'differ'} from the approved lock. A human approves ${changed === 1 ? 'it' : 'them'} with ${code('buckets refresh')}.</p>`;
  const rows = link.symbols.map((s) => {
    const mark = s.change === undefined ? undefined : LINK_SYMBOL_CHANGE[s.change];
    const from = html`<span class="dim" translate="no">${link.alias === '' ? s.file : `${link.alias}/${s.file.replace(/\.[^./]+$/, '')}`}</span>`;
    const type = s.typeOnly ? html` <span class="tag">type</span>` : '';
    if (mark === undefined) return html`<li><code translate="no">${s.name}</code>${type} ${from}</li>`;
    return html`<li class="${mark.cls}"><span aria-hidden="true">${mark.sign} </span><code translate="no">${s.name}</code>${type} <span class="dim">${mark.note}</span> ${from}</li>`;
  });
  return html`${summary}<ul class="plain">${rows}</ul>`;
}

export function renderLinkPanel(snapshot: InspectSnapshot, project: ProjectSnapshot, link: LinkSnapshot, state: InspectState): SafeHtml {
  const target = link.target ? snapshot.projects.find((p) => p.path === link.target!.project) : undefined;
  const tone = link.state === 'missing' ? 'red' : link.state === 'ok' ? undefined : 'amber';
  return screen(
    'tty5',
    'link',
    `${link.mode} mode`,
    html`<h2 class="panel-title" id="panel-title">Link <span translate="no">${link.name}</span></h2>
<dl class="facts">
  <dt>Folder</dt><dd>${code(link.path)}</dd>
  <dt>Consumer</dt><dd><a href="${href(defaultState(), { project: project.path, bucket: link.bucket })}" translate="no">${bucketName(project, link.bucket)}</a> <span class="dim">in ${project.name}</span></dd>
  <dt>Alias</dt><dd>${link.alias === '' ? html`<span class="dim">none (approved by an older slopbuckets version)</span>` : code(link.alias)}</dd>
  <dt>Origin</dt><dd>${code(link.origin)}${target ? html` <span class="dim">in</span> <a href="${href(defaultState(), { view: 'projects', project: target.path })}" translate="no">${target.name}</a>` : html` <span class="dim">outside the visible projects</span>`}</dd>
  <dt>State</dt><dd>${badge(link.state === 'ok' ? 'ok' : link.state === 'missing' ? 'violation' : 'lock', LINK_STATE_TEXT[link.state])}</dd>
</dl>
<h3 class="sub3">Published symbols <span class="dim">${link.symbols.length}</span></h3>
${link.symbols.length === 0 ? html`<p class="empty">The linked project publishes nothing: it has no .external file, or the link is missing.</p>` : linkSymbolList(link)}
<h3 class="sub3">Used by</h3>
${link.usedBy.length === 0 ? html`<p class="empty">No code imports this link.</p>` : html`<ul class="plain">${link.usedBy.map((u) => html`<li><code translate="no">${u.file}:${u.line}</code> <span class="dim">${u.names.join(', ')}</span></li>`)}</ul>`}
${
  link.drift
    ? html`<h3 class="sub3">Difference from the origin</h3>
<ul class="plain">${[
        ...link.drift.added.map((f) => html`<li class="add"><span aria-hidden="true">+ </span>${code(f)} <span class="dim">only in the origin</span></li>`),
        ...link.drift.removed.map((f) => html`<li class="del"><span aria-hidden="true">- </span>${code(f)} <span class="dim">only in the copy</span></li>`),
        ...link.drift.changed.map((f) => html`<li class="chg"><span aria-hidden="true">~ </span>${code(f)} <span class="dim">differs</span></li>`),
      ]}</ul>
<p class="small">Run ${code(`buckets link update ${link.name}`)} to copy the origin again, then ask for approval.</p>`
    : ''
}
${link.state === 'missing' ? html`<p class="small">Run ${code('buckets link sync')} to recreate it.</p>` : ''}
<p><a href="${href(defaultState(), { view: 'projects', project: state.project })}">Close</a></p>`,
    { id: 'panel', labelledBy: 'panel-title', cls: 'panel', ...(tone ? { tone } : {}) },
  );
}

// ---- approvals ----

export function renderApprovalsView(input: PageInput): SafeHtml {
  const { snapshot } = input;
  const pending = snapshot.projects.filter((p) => p.lockChanges.length > 0);
  const groups = pending.map((p) => {
    const blocked = p.violations.length > 0;
    return html`<article class="approval" aria-labelledby="ap-${p.path.replace(/[^\w-]/g, '_')}">
  <h2 class="sub" id="ap-${p.path.replace(/[^\w-]/g, '_')}">${led(projectSituation(p), p.status)}<a href="${href(defaultState(), { project: p.path })}" translate="no">${p.name}</a> <span class="dim">${p.path === '.' ? 'repo' : p.path}, ${plural(p.lockChanges.length, 'difference')}</span></h2>
  ${blocked ? html`<p class="callout bad small">${p.name} also has ${plural(p.violations.length, 'violation')}. ${code(REFRESH_WEB)} refuses to approve until every rule passes, so fix those first.</p>` : ''}
  ${cappedList({
    items: p.lockChanges.map((c: LockChangeSnapshot) => html`<li><span class="kind" translate="no">${c.kind}</span><code translate="no">${c.path}</code>${c.symbol !== undefined ? html` <code translate="no">${c.symbol}</code>` : ''}<p class="small dim">${c.message}</p></li>`),
    cap: 40,
    key: `ap-${p.path.replace(/[^\w.-]/g, '_')}`,
    state: input.state,
    cls: 'changes',
    noun: 'differences',
  })}
</article>`;
  });
  return screen(
    'tty5',
    'approvals',
    pending.length === 0 ? 'none' : plural(pending.length, 'project'),
    html`<h1 class="view-title" id="view-title">Pending approvals</h1>
<div class="callout${pending.length > 0 ? ' warn' : ''}">
  <p>This page only shows the state. It never approves anything. A human approves with ${code(REFRESH_WEB)}, which opens its own review page and asks for confirmation in a window of the operating system, one project at a time.</p>
  <p class="cmd-copy"><code id="refresh-cmd" translate="no">${REFRESH_WEB}</code>${html`<button type="button" class="btn btn-mini" data-copy-id="refresh-cmd" aria-label="Copy the command">Copy</button>`}</p>
</div>
${pending.length === 0 ? html`<p class="empty">Every ${code('buckets.lock.json')} matches its project. Nothing waits for approval.</p>` : groups}`,
    { id: 'view', labelledBy: 'view-title', cls: 'view view-approvals' },
  );
}

// ---- side panel ----

function bucketLinks(project: ProjectSnapshot, items: string[], state: InspectState, key: string): SafeHtml {
  if (items.length === 0) return html`<p class="dim small">None.</p>`;
  return cappedList({
    items: items.map((b) => html`<li><a href="${href(clean(state, { view: state.view === 'matrix' ? 'matrix' : 'map' }), { bucket: b })}" translate="no">${bucketName(project, b)}</a></li>`),
    cap: 20,
    key,
    state,
    cls: 'plain',
    noun: 'buckets',
  });
}

function contractLinks(project: ProjectSnapshot, files: string[], state: InspectState, key: string): SafeHtml {
  if (files.length === 0) return html`<p class="dim small">None.</p>`;
  const byFile = new Map(project.contracts.map((c) => [c.file, c]));
  return cappedList({
    items: files.map((f) => {
      const c = byFile.get(f)!;
      return html`<li><a href="${href(clean(state, { view: 'matrix' }), { cell: f, bucket: state.bucket })}" class="s-${c.situation}" translate="no">${f.slice(c.owner.length + 1)}</a> <span class="dim">${plural(c.symbols.length, 'symbol')}</span></li>`;
    }),
    cap: 20,
    key,
    state,
    cls: 'plain',
    noun: 'contracts',
  });
}

export function renderBucketPanel(snapshot: InspectSnapshot, project: ProjectSnapshot, bucket: BucketSnapshot, state: InspectState): SafeHtml {
  const violations = project.violations.filter((v) => v.bucket === bucket.path);
  const lockChanges = project.lockChanges.filter((c) => c.bucket === bucket.path);
  const links = project.links.filter((l) => l.bucket === bucket.path);
  const tone = bucket.situation === 'violation' ? 'red' : bucket.situation === 'lock' ? 'amber' : undefined;
  return screen(
    'tty6',
    'bucket',
    SITUATION_LABEL[bucket.situation],
    html`<h2 class="panel-title" id="panel-title"><span translate="no">${bucketName(project, bucket.path)}</span></h2>
<p class="badges">${badge(bucket.situation)}<span class="dim">level ${bucket.level}, ${plural(bucket.files, 'file')} in ${code('_/')}</span></p>
<ul class="tiles cost" aria-label="Rewrite cost">
  <li class="all"><span class="num">${bucket.rewriteCost.symbols}</span><span class="what">contract ${bucket.rewriteCost.symbols === 1 ? 'symbol' : 'symbols'} to honor</span></li>
  <li class="chg"><span class="num">${bucket.rewriteCost.dependents}</span><span class="what">${bucket.rewriteCost.dependents === 1 ? 'bucket depends' : 'buckets depend'} on it</span></li>
</ul>
<p class="small dim">A rewrite from the contracts must keep these symbols with the same signatures. It also keeps ${plural(bucket.rewriteCost.contracts, 'contract file')} where this bucket provides.</p>
<h3 class="sub3">Offers <span class="dim">${bucket.offers.length}</span></h3>
${contractLinks(project, bucket.offers, state, 'offers')}
<h3 class="sub3">Consumes <span class="dim">${bucket.consumes.length}</span></h3>
${contractLinks(project, bucket.consumes, state, 'consumes')}
<h3 class="sub3">Depends on</h3>
${bucketLinks(project, bucket.dependsOn, state, 'depends-on')}
<h3 class="sub3">Dependents</h3>
${bucketLinks(project, bucket.dependents, state, 'dependents')}
${
  links.length > 0
    ? html`<h3 class="sub3">Links in ${code('_/links/')}</h3><ul class="plain">${links.map((l) => html`<li><a href="${href(defaultState(), { view: 'projects', project: project.path, link: l.path })}" class="st-${l.state}" translate="no">${l.name}</a> <span class="dim">${l.mode}, ${LINK_STATE_TEXT[l.state]}</span></li>`)}</ul>`
    : ''
}
${
  bucket.projects.length > 0
    ? html`<h3 class="sub3">Nested projects</h3><ul class="plain">${bucket.projects.map((p) => {
        const nested = snapshot.projects.find((x) => x.path === p);
        return html`<li>${nested ? led(projectSituation(nested), nested.status) : ''}<a href="${href(defaultState(), { project: p })}" data-zoom="${p}" translate="no">${nested?.name ?? p}</a> <span class="dim" translate="no">${p}</span></li>`;
      })}</ul>`
    : ''
}
<h3 class="sub3">Violations <span class="dim">${violations.length}</span></h3>
${violations.length === 0 ? html`<p class="dim small">None.</p>` : cappedList({ items: violations.map((v) => violationItem(v, state, project)), cap: 10, key: 'bucket-violations', state, cls: 'violations compact', noun: 'violations' })}
${lockChanges.length > 0 ? html`<h3 class="sub3">Lock differences <span class="dim">${lockChanges.length}</span></h3><ul class="plain">${lockChanges.map((c) => html`<li><span class="warn" translate="no">${c.kind}</span> <code translate="no">${c.path}</code>${c.symbol !== undefined ? html` <code translate="no">${c.symbol}</code>` : ''}</li>`)}</ul><p class="small"><a href="${href(defaultState(), { view: 'approvals' })}">How to approve</a></p>` : ''}
<p><a href="${href(clean(state, {}))}">Close</a></p>`,
    { id: 'panel', labelledBy: 'panel-title', cls: 'panel', ...(tone ? { tone } : {}) },
  );
}

export function renderSummaryPanel(snapshot: InspectSnapshot, project: ProjectSnapshot): SafeHtml {
  const situation = projectSituation(project);
  const symbols = project.contracts.reduce((n, c) => n + c.symbols.length, 0);
  return screen(
    'tty6',
    'project',
    project.path === '.' ? 'repo' : project.path,
    html`<h2 class="panel-title" id="panel-title"><span translate="no">${project.name}</span></h2>
<p class="badges">${badge(situation, project.status === 'environment' ? 'check failed' : SITUATION_LABEL[situation])}<span class="dim">${statusText(project)}</span></p>
<ul class="tiles small-tiles" aria-label="Counts">
  <li class="add"><span class="num">${project.buckets.length}</span><span class="what">buckets</span></li>
  <li class="all"><span class="num">${project.contracts.length}</span><span class="what">contracts</span></li>
  <li class="all"><span class="num">${symbols}</span><span class="what">symbols</span></li>
  <li class="${project.violations.length > 0 ? 'del' : 'add'}"><span class="num">${project.violations.length}</span><span class="what">violations</span></li>
</ul>
<dl class="facts">
  <dt>Lock</dt><dd>${project.lock === 'current' ? 'matches the project' : project.lock === 'missing' ? html`<span class="warn">no lock yet</span>` : project.lock === 'differs' ? html`<a href="${href(defaultState(), { view: 'approvals' })}" class="warn">${plural(project.lockChanges.length, 'difference')} to approve</a>` : 'unknown'}</dd>
  ${project.config ? html`<dt>Root</dt><dd>${code(`${project.config.root}/`)} <span class="dim">alias</span> ${code(project.config.alias)}</dd>` : ''}
  ${project.parent !== null ? html`<dt>Inside</dt><dd><a href="${href(defaultState(), { project: project.parent, bucket: project.container?.bucket ?? null })}" translate="no">${project.container?.bucket ?? project.parent}</a></dd>` : ''}
  ${project.nested.length > 0 ? html`<dt>Nested</dt><dd>${project.nested.map((p, i) => html`${i > 0 ? ', ' : ''}<a href="${href(defaultState(), { project: p })}" data-zoom="${p}" translate="no">${snapshot.projects.find((x) => x.path === p)?.name ?? p}</a>`)}</dd>` : ''}
  ${project.links.length > 0 ? html`<dt>Links</dt><dd>${plural(project.links.length, 'link')}</dd>` : ''}
</dl>
<p class="small dim">Select a bucket on the map or in the list to see its contracts, dependencies and rewrite cost.</p>`,
    { id: 'panel', labelledBy: 'panel-title', cls: 'panel' },
  );
}

function sidePanel(input: PageInput): SafeHtml {
  const { snapshot, state } = input;
  const project = currentProject(snapshot, state);
  if (state.view === 'timeline' && input.timeline) {
    const panel = renderApprovalPanel(input);
    if (panel !== null) return panel;
  }
  if (state.view === 'matrix' && state.cell !== null) {
    const contract = project.contracts.find((c) => c.file === state.cell);
    if (contract) return renderContractPanel(project, contract, state);
  }
  if (state.view === 'projects' && state.link !== null) {
    const link = project.links.find((l) => l.path === state.link);
    if (link) return renderLinkPanel(snapshot, project, link, state);
  }
  if (state.bucket !== null) {
    const bucket = project.buckets.find((b) => b.path === state.bucket);
    if (bucket) return renderBucketPanel(snapshot, project, bucket, state);
  }
  return renderSummaryPanel(snapshot, project);
}

// ---- feed ----

const FEED_TONE: Record<FeedEvent['kind'], string> = {
  start: 'dim',
  file: 'file',
  'violation-added': 'bad',
  'violation-resolved': 'ok',
  'lock-added': 'warn',
  'lock-resolved': 'ok',
  'project-added': 'ok',
  'project-removed': 'warn',
  link: 'warn',
  error: 'bad',
};

export function renderFeed(input: PageInput): SafeHtml {
  const { feed, snapshot } = input;
  const name = (p: string) => (p === '.' ? snapshot.projects[0]!.name : (snapshot.projects.find((x) => x.path === p)?.name ?? p));
  const live = input.watch === 'off' ? 'not watching' : input.watch === 'polling' ? 'watching by polling' : 'watching';
  return screen(
    'tty7',
    'events',
    live,
    html`<h2 class="panel-title" id="feed-title">Events</h2>
${
  feed.length === 0
    ? html`<p class="empty">No events yet.</p>`
    : html`<ol class="feed" aria-labelledby="feed-title">${feed.map(
        (e) => html`<li class="f-${FEED_TONE[e.kind]}"><time datetime="${e.at}">${e.at.slice(11, 19)}</time><span class="tag" translate="no">${name(e.project)}</span><span class="text">${e.text}</span></li>`,
      )}</ol>`
}`,
    { id: 'feed', labelledBy: 'feed-title', cls: 'panel feed-screen' },
  );
}

// ---- the page ----

function helpDialog(snapshotFile: boolean): SafeHtml {
  return html`<dialog id="help" class="help" aria-labelledby="help-title">
  <div class="screen-bar" aria-hidden="true"><span>tty9</span><span>help</span><span>esc closes</span></div>
  <div class="help-body">
    <h2 id="help-title">Keys</h2>
    <dl class="keys">
      <dt><kbd>/</kbd></dt><dd>search a symbol</dd>
      <dt><kbd>j</kbd> <kbd>k</kbd></dt><dd>next and previous item in the view</dd>
      <dt><kbd>Enter</kbd></dt><dd>open the item</dd>
      <dt><kbd>m</kbd></dt><dd>switch between map and matrix</dd>
      <dt><kbd>g</kbd></dt><dd>projects constellation</dd>
      <dt><kbd>a</kbd></dt><dd>pending approvals</dd>
      <dt><kbd>t</kbd></dt><dd>timeline of approvals</dd>
      <dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>previous and next approval on the timeline</dd>
      <dt><kbd>p</kbd></dt><dd>play or pause the timeline</dd>
      <dt><kbd>i</kbd></dt><dd>impact simulation</dd>
      <dt><kbd>u</kbd></dt><dd>up: parent bucket, then parent project</dd>
      <dt><kbd>f</kbd></dt><dd>map in fullscreen, and back</dd>
      <dt><kbd>Esc</kbd></dt><dd>close the panel or this help</dd>
      <dt><kbd>?</kbd></dt><dd>this help</dd>
    </dl>
    <p class="small dim">On the timeline slider, the arrow keys move between approvals. ${snapshotFile ? 'This file is a snapshot: it shows the project as it was when it was exported and never changes.' : 'The page updates by itself when files change. It never writes to the project.'}</p>
    <form method="dialog"><button class="btn btn-mini" type="submit">Close</button></form>
  </div>
</dialog>`;
}

export function renderMain(input: PageInput): SafeHtml {
  const { state } = input;
  const view =
    state.view === 'matrix'
      ? renderMatrixView(input)
      : state.view === 'trace'
        ? renderTraceView(input)
        : state.view === 'projects'
          ? renderProjectsView(input)
          : state.view === 'approvals'
            ? renderApprovalsView(input)
            : state.view === 'timeline'
              ? renderTimelineView(input)
              : state.view === 'impact'
                ? renderImpactView(input)
                : renderMapView(input);
  // Only the map view draws the canvas, so only it carries the map data.
  const data =
    state.view === 'map'
      ? JSON.stringify(mapData(input.snapshot, state, input.version))
          .replace(/</g, '\\u003c')
          .replace(/[\p{Zl}]/gu, '\\' + 'u2028')
          .replace(/[\p{Zp}]/gu, '\\' + 'u2029')
      : null;
  return html`<div class="inspect" id="app" data-view="${state.view}" data-project="${state.project}" data-version="${input.version}">
${renderCrumbs(input.snapshot, state)}
<div class="layout">
  <div class="main-col">${view}</div>
  <aside class="side" aria-label="Details">
    ${sidePanel(input)}
    ${renderFeed(input)}
  </aside>
</div>
${helpDialog(input.static !== undefined)}
${data !== null ? html`<script type="application/json" id="inspect-data">${raw(data)}</script>` : ''}
</div>`;
}

/** The windows of the top bar. `hidden` views get none. */
export function navItems(snapshot: InspectSnapshot, state: InspectState, hidden: readonly View[] = []): NavItem[] {
  const pending = snapshot.projects.reduce((n, p) => n + (p.lockChanges.length > 0 ? 1 : 0), 0);
  return VIEWS.filter((view) => !hidden.includes(view) || view === state.view).map((view) => ({
    label: view === 'approvals' && pending > 0 ? `${VIEW_LABEL[view]} ${pending}` : VIEW_LABEL[view],
    href: href(defaultState(), { view, project: state.project, ...(view === 'map' || view === 'matrix' || view === 'impact' ? { bucket: state.bucket } : {}) }),
    current: state.view === view,
  }));
}

/** The status at the right of the top bar. A snapshot file says `snapshot` where the live page says `live`. */
export function statusLabel(snapshot: InspectSnapshot, live = true): string {
  const total = snapshot.summary.violations;
  const word = live ? 'live' : 'snapshot';
  return total > 0 ? `${word}, ${plural(total, 'violation')}` : snapshot.summary.lockChanges > 0 ? `${word}, ${plural(snapshot.summary.lockChanges, 'lock difference')}` : word;
}

/** The ISO time as `2026-10-04 12:00 UTC`. The page script shows it in the reader's locale. */
function utcText(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

/**
 * The shell of an inspect page: title, windows, status, content and footer. The live server renders it with
 * `renderInspectPage`; a snapshot file uses the same options, so both show the same page.
 */
export function inspectPageOptions(input: PageInput): PageOptions {
  const { snapshot, state } = input;
  const project = currentProject(snapshot, state);
  const info = input.static;
  const keys = html`<button type="button" class="linkish" id="help-open" aria-haspopup="dialog">Keys</button>`;
  return {
    title: `${VIEW_LABEL[state.view]} · ${project.name} · buckets inspect`,
    token: input.token,
    project: projectLabel(project),
    nav: navItems(snapshot, state, info?.hidden),
    status: info ? { state: 'wait', label: statusLabel(snapshot, false) } : { state: input.watch === 'off' ? 'wait' : 'live', label: statusLabel(snapshot) },
    main: renderMain(input),
    styles: ['/assets/inspect.css'],
    scripts: ['/assets/inspect.js'],
    footer: info
      ? html`Exported by ${code('buckets inspect --export html')}. Read only: a snapshot that shows the project as it was and never changes. ${keys}`
      : html`Served by ${code('buckets inspect')} on this computer only. Read only: it never writes to the project. ${keys}`,
    ...(info
      ? {
          footerEnd: '[static snapshot]',
          banner: html`  <p class="static-banner" role="note">Static snapshot of <strong translate="no">${snapshot.projects[0]!.name}</strong> taken <time datetime="${info.takenAt}" data-when>${utcText(info.takenAt)}</time> by <span translate="no">buckets ${info.cli}</span>.</p>`,
        }
      : {}),
  };
}

export function renderInspectPage(input: PageInput): string {
  return renderPage(inspectPageOptions(input));
}
