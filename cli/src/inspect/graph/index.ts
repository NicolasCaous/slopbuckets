// The dependency graph view of the inspect page: a layered SVG with selection, focus mode, paths between two
// buckets, change marks, pan and zoom, and keyboard navigation with a roving tabindex.
//
// The layout runs in a Web Worker started from __INSPECT_WORKER__, the bundled worker.ts that the page build
// (cli/scripts/build-inspect.mjs) defines as a string. When it is empty or undefined (tests), or when the worker fails,
// the layout runs on the main thread in a timeout.
import type { SnapshotProject } from '../../contract/browser.js';
import { NODE_HEIGHT, computeLayout, type Layout, type LayoutEdge, type LayoutInput, type LayoutNode } from './layout.js';
import { adjacency, edgeId, focusNeighborhood, layoutInput, layoutKey, pairBuckets, pathsBetween, pendingCounts, type Adjacency } from './model.js';
import { GRAPH_CSS, MARKER_DEFS, graphMarkup } from './render.js';
import type { CreateGraphView, GraphState, GraphViewOptions } from './types.js';

declare const __INSPECT_WORKER__: string | undefined;

const CACHE_SIZE = 50;
const MARGIN = 24;
/** Fit never zooms out below this scale, where names are still about 10px tall; a larger graph pans instead. */
const MIN_FIT = 0.8;
const HINT = 'Drag or scroll to pan, Ctrl+scroll to zoom, arrows and Enter to select, Shift-click a second bucket for paths, [ and ] for focus depth';

// Dimming uses fill-opacity and stroke-opacity: plain opacity on 1,700 SVG groups took 240 to 420 ms per selection on
// the 500-bucket fixture, these take under 50 ms.
const VIEW_CSS = `
.gv-root { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--gv-text);
  font: 13px system-ui, -apple-system, "Segoe UI", sans-serif; }
.gv-tools { display: flex; gap: 4px; align-items: center; padding: 6px 8px; }
.gv-tools button { font: inherit; font-size: 13px; min-height: 28px; padding: 2px 10px; border: 1px solid var(--gv-line);
  border-radius: 6px; background: var(--gv-surface); color: var(--gv-text); cursor: pointer; touch-action: manipulation; }
.gv-tools button:hover { border-color: var(--gv-muted); }
.gv-tools button:focus-visible { outline: 2px solid var(--gv-accent); outline-offset: 2px; }
.gv-hint { margin-left: auto; min-width: 0; font-size: 12px; color: var(--gv-muted); text-align: right; text-wrap: pretty; overflow-wrap: anywhere; }
.gv-status { position: absolute; top: 48px; left: 0; right: 0; margin: 0 auto; width: fit-content; max-width: 90%; padding: 4px 10px;
  border: 1px solid var(--gv-line); border-radius: 6px; background: var(--gv-surface); text-align: center; font-size: 13px; color: var(--gv-text); pointer-events: none; }
.gv-status:empty { display: none; }
.gv-svg { flex: 1; min-height: 0; width: 100%; display: block; touch-action: none; user-select: none; cursor: grab; }
.gv-svg.gv-dragging { cursor: grabbing; }
.gv-node, .gv-edge { cursor: pointer; outline: none; transition: fill-opacity 0.15s, stroke-opacity 0.15s; }
.gv-hit { fill: none; stroke: transparent; stroke-width: 12; }
.gv-mark { display: none; fill: var(--gv-text); }
.gv-changed .gv-mark { display: inline; }
.gv-dim .gv-node:not(.gv-on), .gv-dim .gv-edge:not(.gv-on) { fill-opacity: 0.25; stroke-opacity: 0.25; }
.gv-dim .gv-edge:not(.gv-on) .gv-line { marker-end: url(#gv-arrow-dim); }
.gv-arrow-dim { fill-opacity: 0.25; }
.gv-node.gv-on .gv-box { stroke: var(--gv-accent); stroke-width: 1.5; }
.gv-edge.gv-on .gv-line { stroke: var(--gv-accent); stroke-width: 2; marker-end: url(#gv-arrow-accent); }
.gv-edge.gv-undeclared.gv-on .gv-line { stroke: var(--gv-pending); stroke-width: 2.5; marker-end: url(#gv-arrow-pending); }
.gv-node.gv-path .gv-box { stroke: var(--gv-accent); stroke-width: 2.5; }
.gv-edge.gv-path .gv-line { stroke-width: 3; }
.gv-node.gv-selected .gv-box { stroke: var(--gv-accent); stroke-width: 2.5; fill: var(--gv-accent-soft); }
.gv-edge.gv-selected .gv-line { stroke-width: 3.5; }
.gv-node:hover .gv-box { stroke: var(--gv-text); stroke-width: 2; }
.gv-edge:hover .gv-line { stroke-width: 3; }
.gv-dim .gv-node:hover, .gv-dim .gv-edge:hover { fill-opacity: 1; stroke-opacity: 1; }
.gv-node:focus-visible .gv-box { stroke: var(--gv-text); stroke-width: 3; }
.gv-edge:focus-visible .gv-hit { stroke: var(--gv-accent); stroke-opacity: 0.3; }
@media (prefers-reduced-motion: reduce) { .gv-node, .gv-edge { transition: none; } }
@media (prefers-color-scheme: dark) {
  .gv { --gv-text: #e6edf3; --gv-muted: #9198a1; --gv-surface: #151b23; --gv-line: #6e7681; --gv-on-pending: #0d1117; }
}
`;

let stylesAdded = false;
/** A constructed style sheet, which keeps the graph styles inside graph/ without a second CSS file to serve and inline. */
function addStyles() {
  if (stylesAdded) return;
  stylesAdded = true;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(GRAPH_CSS + VIEW_CSS);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

function layoutRunner() {
  const waiting = new Map<number, { input: LayoutInput; resolve: (layout: Layout) => void }>();
  const onMainThread = (input: LayoutInput) => new Promise<Layout>((resolve) => setTimeout(() => resolve(computeLayout(input)), 0));
  let nextId = 0;
  let url = '';
  let worker: Worker | null = null;
  try {
    if (typeof __INSPECT_WORKER__ === 'string' && __INSPECT_WORKER__ !== '') {
      url = URL.createObjectURL(new Blob([__INSPECT_WORKER__], { type: 'text/javascript' }));
      worker = new Worker(url);
    }
  } catch {
    worker = null;
  }
  if (worker) {
    worker.onmessage = (event: MessageEvent<{ id: number; layout: Layout }>) => {
      waiting.get(event.data.id)?.resolve(event.data.layout);
      waiting.delete(event.data.id);
    };
    worker.onerror = () => {
      worker?.terminate();
      worker = null;
      for (const { input, resolve } of waiting.values()) void onMainThread(input).then(resolve);
      waiting.clear();
    };
  }
  return {
    run(input: LayoutInput): Promise<Layout> {
      if (!worker) return onMainThread(input);
      const id = nextId++;
      return new Promise((resolve) => {
        waiting.set(id, { input, resolve });
        worker!.postMessage({ id, input });
      });
    },
    stop() {
      worker?.terminate();
      if (url) URL.revokeObjectURL(url);
    },
  };
}

type Item = SVGGElement;
const isItem = (target: EventTarget | null): Item | null =>
  target instanceof Element ? (target.closest('.gv-node, .gv-edge') as Item | null) : null;

export const createGraphView: CreateGraphView = (container, options) => {
  const view = new GraphCanvas(container, options);
  return {
    update: (project, state) => view.update(project, state),
    destroy: () => view.destroy(),
  };
};

const centerOf = (n: LayoutNode) => n.x + n.width / 2;
const nearest = <T>(list: T[], score: (item: T) => number): T | undefined =>
  list.reduce<T | undefined>((best, item) => (best === undefined || score(item) < score(best) ? item : best), undefined);

/** The bucket the selection centers on: the one the graph keeps in place when a new focus redraws it. */
const anchorOf = (s: GraphState | null) =>
  !s ? '' : s.selection.kind === 'bucket' ? s.selection.name : s.selection.kind === 'export' ? s.selection.bucket : s.selection.kind === 'edge' ? s.selection.from : '';

/** The graph view of one container: the drawn layout, the selection marks, pan and zoom, and the keyboard. */
class GraphCanvas {
  private readonly root = document.createElement('div');
  private readonly status: Element;
  private readonly svg: SVGSVGElement;
  private readonly world: SVGGElement;
  private readonly runner = layoutRunner();
  private readonly cache = new Map<string, Layout>();
  private readonly resize: ResizeObserver;

  private project: SnapshotProject | null = null;
  private state: GraphState | null = null;
  private graph: Adjacency = { down: new Map(), up: new Map() };
  private pending = new Map<string, number>();
  private requested = '';
  private destroyed = false;

  // What is drawn.
  private layout: Layout | null = null;
  private shownKey = '';
  private shownProject: SnapshotProject | null = null;
  private shownNodes = '';
  private needFit = false;
  private readonly nodeEls = new Map<string, Item>();
  private readonly edgeEls = new Map<string, Item>();
  private readonly labels = new Map<Item, string>();
  private readonly nodeById = new Map<string, LayoutNode>();
  private readonly edgeById = new Map<string, LayoutEdge>();
  private tabStop: Item | null = null;
  /** Which end of the focused edge the keyboard came from, so left and right walk its siblings. */
  private edgeAnchor: 'from' | 'to' = 'from';
  private readonly view = { x: 0, y: 0, k: 1 };
  private drag: { x: number; y: number } | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: GraphViewOptions,
  ) {
    addStyles();
    const root = this.root;
    root.className = 'gv gv-root';
    root.innerHTML =
      '<div class="gv-tools">' +
      '<button type="button" data-action="fit">Fit</button>' +
      '<button type="button" data-action="in" aria-label="Zoom in">+</button>' +
      '<button type="button" data-action="out" aria-label="Zoom out">−</button>' +
      `<span class="gv-hint">${HINT}</span>` +
      '</div>' +
      '<p class="gv-status" role="status"></p>' +
      `<svg class="gv-svg" role="group" aria-label="Dependency graph">${MARKER_DEFS}<g class="gv-world"></g></svg>`;
    container.replaceChildren(root);
    this.status = root.querySelector('.gv-status')!;
    this.svg = root.querySelector('svg')!;
    this.world = this.svg.querySelector('.gv-world')!;
    this.bindEvents();
    // A view mounted while hidden has no size; fit once it gets one.
    this.resize = new ResizeObserver(() => this.needFit && this.fit());
    this.resize.observe(this.svg);
  }

  update(nextProject: SnapshotProject, nextState: GraphState): void {
    if (nextProject !== this.project) {
      this.project = nextProject;
      this.graph = adjacency(nextProject);
      this.pending = pendingCounts(nextProject);
    }
    const project = nextProject;
    this.state = nextState;
    const empty =
      project.environment !== null
        ? 'This project could not be checked, so it has no graph.'
        : project.buckets.length === 0
          ? 'No buckets yet. Add one to buckets.config.json to see the graph.'
          : '';
    if (empty) {
      this.world.replaceChildren();
      this.layout = null;
      this.shownKey = this.shownNodes = this.requested = '';
      this.setStatus(empty);
      return;
    }
    const input = layoutInput(project, this.visibleBuckets(nextState));
    const key = layoutKey(input);
    const cached = this.cache.get(key);
    if (cached) {
      this.requested = key;
      this.draw(cached, key);
      return;
    }
    this.applyState();
    if (key === this.requested) return;
    this.requested = key;
    this.setStatus('Laying out the graph…');
    void this.runner.run(input).then((result) => {
      this.cache.set(key, result);
      if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
      if (!this.destroyed && key === this.requested) this.draw(result, key);
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.runner.stop();
    this.resize.disconnect();
    this.container.replaceChildren();
  }

  private applyView(): void {
    const { x, y, k } = this.view;
    this.world.setAttribute('transform', `translate(${x} ${y}) scale(${k})`);
  }

  private setStatus(text: string): void {
    if (this.status.textContent !== text) this.status.textContent = text;
  }

  private visibleBuckets(s: GraphState): Set<string> | null {
    // A pair draws only its paths, whatever the focus.
    if (s.pathPair) return pairBuckets(this.graph, ...s.pathPair);
    const sel = s.selection;
    const seeds = sel.kind === 'bucket' ? [sel.name] : sel.kind === 'edge' ? [sel.from, sel.to] : sel.kind === 'export' ? [sel.bucket] : [];
    if (!(s.focusDepth > 0 && Number.isFinite(s.focusDepth)) || seeds.length === 0) return null;
    return focusNeighborhood(this.graph, seeds, s.focusDepth);
  }

  private draw(next: Layout, key: string): void {
    if (key === this.shownKey && this.project === this.shownProject) {
      if (this.needFit) this.fit();
      this.applyState();
      return;
    }
    const { view, svg, nodeById } = this;
    // Where the anchor bucket and the keyboard focus are now, to put them back after the redraw.
    const anchor = anchorOf(this.state);
    const before = nodeById.get(anchor);
    const { w, h } = this.size();
    const screen = before ? { x: before.x * view.k + view.x, y: before.y * view.k + view.y } : null;
    const onScreen = screen !== null && screen.x >= 0 && screen.y >= 0 && screen.x <= w && screen.y <= h;
    const active = document.activeElement;
    const focused = active instanceof Element && svg.contains(active) ? (isItem(active)?.dataset.id ?? '') : null;
    this.layout = next;
    this.shownKey = key;
    this.shownProject = this.project;
    this.drawItems(next);
    const nodes = next.nodes.map((n) => n.id).join(',');
    if (nodes !== this.shownNodes) {
      this.shownNodes = nodes;
      const after = nodeById.get(anchor);
      // A new focus keeps the zoom and moves the picture so the anchor stays where the reader clicked it.
      if (onScreen && after && !this.needFit) {
        view.x = screen.x - after.x * view.k;
        view.y = screen.y - after.y * view.k;
        this.applyView();
      } else this.needFit = true;
    }
    if (this.needFit) this.fit();
    this.applyState();
    if (focused === null) return;
    const el = this.nodeEls.get(focused) ?? this.edgeEls.get(focused) ?? this.tabStop;
    if (el) this.focusItem(el);
  }

  /** The SVG of a layout, and the indexes of its items. */
  private drawItems(next: Layout): void {
    this.world.innerHTML = graphMarkup(next, this.project!, this.pending, true);
    this.nodeEls.clear();
    this.edgeEls.clear();
    this.labels.clear();
    this.nodeById.clear();
    this.edgeById.clear();
    for (const n of next.nodes) this.nodeById.set(n.id, n);
    for (const e of next.edges) this.edgeById.set(edgeId(e.from, e.to), e);
    for (const el of this.world.querySelectorAll<Item>('.gv-node, .gv-edge')) {
      (el.classList.contains('gv-node') ? this.nodeEls : this.edgeEls).set(el.dataset.id!, el);
      this.labels.set(el, el.getAttribute('aria-label')!);
    }
    if (this.tabStop && !this.tabStop.isConnected) this.tabStop = null;
  }

  /** The buckets and edges the selection and the path pair light up. */
  private lit(state: GraphState, layout: Layout): { onNodes: Set<string>; onEdges: Set<string>; selectedNode: string; selectedEdge: string; path: { nodes: Set<string>; edges: Set<string> }; message: string } {
    const sel = state.selection;
    const onNodes = new Set<string>();
    const onEdges = new Set<string>();
    let selectedNode = '';
    let selectedEdge = '';
    const bucket = sel.kind === 'bucket' ? sel.name : sel.kind === 'export' ? sel.bucket : '';
    if (bucket && this.nodeById.has(bucket)) {
      selectedNode = bucket;
      onNodes.add(bucket);
      for (const e of layout.edges) {
        if (e.from === bucket || e.to === bucket) onEdges.add(edgeId(e.from, e.to)), onNodes.add(e.from), onNodes.add(e.to);
      }
    } else if (sel.kind === 'edge' && this.edgeById.has(edgeId(sel.from, sel.to))) {
      selectedEdge = edgeId(sel.from, sel.to);
      onEdges.add(selectedEdge);
      onNodes.add(sel.from).add(sel.to);
    }
    let path = { nodes: new Set<string>(), edges: new Set<string>() };
    let message = '';
    if (state.pathPair) {
      const [a, b] = state.pathPair;
      path = pathsBetween(this.graph, a, b);
      if (path.nodes.size === 0) message = `No dependency path between ${a} and ${b}.`;
      // The pair's paths replace the neighbors of the selection.
      onNodes.clear();
      onEdges.clear();
      for (const name of [a, b, ...path.nodes, selectedNode]) if (name) onNodes.add(name);
      for (const id of [...path.edges, selectedEdge]) if (id) onEdges.add(id);
    }
    return { onNodes, onEdges, selectedNode, selectedEdge, path, message };
  }

  private applyState(): void {
    const { state, layout } = this;
    if (!state || !layout) return;
    const { onNodes, onEdges, selectedNode, selectedEdge, path, message } = this.lit(state, layout);
    this.root.classList.toggle('gv-dim', onNodes.size > 0);
    const mark = (el: Item, id: string, on: boolean, selected: boolean, inPath: boolean) => {
      const changed = state.changed.has(id);
      el.classList.toggle('gv-on', on);
      el.classList.toggle('gv-selected', selected);
      el.classList.toggle('gv-path', inPath);
      el.classList.toggle('gv-changed', changed);
      const label = this.labels.get(el)! + (changed ? ', changed' : '');
      if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label);
      if (selected) el.setAttribute('aria-current', 'true');
      else el.removeAttribute('aria-current');
    };
    for (const [id, el] of this.nodeEls) mark(el, id, onNodes.has(id), id === selectedNode, path.nodes.has(id));
    for (const [id, el] of this.edgeEls) mark(el, id, onEdges.has(id), id === selectedEdge, path.edges.has(id));

    // Roving tabindex: keep the stop where the keyboard is; otherwise put it on the selection.
    const selectedEl = this.nodeEls.get(selectedNode) ?? this.edgeEls.get(selectedEdge) ?? null;
    const keyboardInside = this.tabStop !== null && this.svg.contains(document.activeElement);
    const firstNode = layout.layers.find((l) => l.length > 0)?.[0];
    this.setTabStop(keyboardInside ? this.tabStop : (selectedEl ?? this.tabStop ?? (firstNode ? this.nodeEls.get(firstNode)! : null)));
    if (this.requested === this.shownKey || !this.requested) this.setStatus(message);
  }

  private setTabStop(el: Item | null): void {
    if (this.tabStop && this.tabStop !== el) this.tabStop.setAttribute('tabindex', '-1');
    this.tabStop = el;
    el?.setAttribute('tabindex', '0');
  }

  private focusItem(el: Item): void {
    this.setTabStop(el);
    el.focus({ preventScroll: true });
    this.reveal(el);
  }

  private size(): { w: number; h: number } {
    return { w: this.svg.clientWidth, h: this.svg.clientHeight };
  }

  private fit(): void {
    const { w, h } = this.size();
    const { layout, view } = this;
    if (!layout || w === 0 || h === 0) return;
    this.needFit = false;
    // The badges stick out 9px above the top row.
    const lw = Math.max(layout.width, 1);
    const lh = layout.height + 9;
    const k = Math.min(Math.max(Math.min((w - 2 * MARGIN) / lw, (h - 2 * MARGIN) / lh), MIN_FIT), 1.25);
    view.k = k;
    // A graph that does not fit at MIN_FIT starts at its top and is centered across, and the selection is shown.
    view.x = (w - lw * k) / 2;
    view.y = lh * k <= h - 2 * MARGIN ? (h - lh * k) / 2 + 9 * k : MARGIN + 9 * k;
    this.applyView();
    const selected = this.nodeEls.get(anchorOf(this.state));
    if (selected && (lw * k > w - 2 * MARGIN || lh * k > h - 2 * MARGIN)) this.reveal(selected);
  }

  private zoomAt(factor: number, cx: number, cy: number): void {
    const view = this.view;
    const k = Math.min(Math.max(view.k * factor, 0.05), 4);
    view.x = cx - ((cx - view.x) * k) / view.k;
    view.y = cy - ((cy - view.y) * k) / view.k;
    view.k = k;
    this.applyView();
  }

  private zoomCenter(factor: number): void {
    const { w, h } = this.size();
    this.zoomAt(factor, w / 2, h / 2);
  }

  private select(el: Item, shift: boolean): void {
    this.setTabStop(el);
    const id = el.dataset.id!;
    if (el.classList.contains('gv-node')) this.options.onSelect({ kind: 'bucket', name: id }, { shift });
    else {
      const edge = this.edgeById.get(id)!;
      this.options.onSelect({ kind: 'edge', from: edge.from, to: edge.to }, { shift });
    }
  }

  private centerX(id: string): number {
    return centerOf(this.nodeById.get(id)!);
  }

  /** Up goes toward dependents, down toward dependencies, through the edge between them. */
  private neighbor(el: Item, key: string): Item | undefined {
    const layout = this.layout;
    if (!layout) return undefined;
    const id = el.dataset.id!;
    if (el.classList.contains('gv-node')) {
      const node = this.nodeById.get(id)!;
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const layer = layout.layers[node.layer]!;
        const next = layer[layer.indexOf(id) + (key === 'ArrowLeft' ? -1 : 1)];
        return next === undefined ? undefined : this.nodeEls.get(next);
      }
      const down = key === 'ArrowDown';
      const candidates = layout.edges.filter((e) => (down ? e.from : e.to) === id);
      const edge = nearest(candidates, (e) => Math.abs(this.centerX(down ? e.to : e.from) - this.centerX(id)));
      if (!edge) return undefined;
      this.edgeAnchor = down ? 'from' : 'to';
      return this.edgeEls.get(edgeId(edge.from, edge.to));
    }
    const edge = this.edgeById.get(id)!;
    if (key === 'ArrowDown') return this.nodeEls.get(edge.to);
    if (key === 'ArrowUp') return this.nodeEls.get(edge.from);
    const fromEnd = this.edgeAnchor === 'from';
    const siblings = layout.edges
      .filter((e) => (fromEnd ? e.from === edge.from : e.to === edge.to))
      .sort((a, b) => (fromEnd ? this.centerX(a.to) - this.centerX(b.to) : this.centerX(a.from) - this.centerX(b.from)));
    const next = siblings[siblings.indexOf(edge) + (key === 'ArrowLeft' ? -1 : 1)];
    return next ? this.edgeEls.get(edgeId(next.from, next.to)) : undefined;
  }

  /** Pans the least needed to show the item. */
  private reveal(el: Item): void {
    const { view } = this;
    const id = el.dataset.id!;
    const node = this.nodeById.get(id);
    const points = node
      ? [
          [node.x, node.y],
          [node.x + node.width, node.y + NODE_HEIGHT],
        ]
      : this.edgeById.get(id)!.points;
    const xs = points.map((p) => p[0]! * view.k + view.x);
    const ys = points.map((p) => p[1]! * view.k + view.y);
    const { w, h } = this.size();
    const shift = (low: number, high: number, max: number) => (low < MARGIN ? MARGIN - low : high > max - MARGIN ? Math.max(max - MARGIN - high, MARGIN - low) : 0);
    view.x += shift(Math.min(...xs), Math.max(...xs), w);
    view.y += shift(Math.min(...ys), Math.max(...ys), h);
    this.applyView();
  }

  private onKey(event: KeyboardEvent): void {
    const item = isItem(event.target);
    const { view } = this;
    let handled = true;
    if (item && (event.key === 'Enter' || event.key === ' ')) this.select(item, event.shiftKey);
    else if (event.key.startsWith('Arrow') && event.shiftKey) {
      const step = 80;
      if (event.key === 'ArrowLeft') view.x += step;
      if (event.key === 'ArrowRight') view.x -= step;
      if (event.key === 'ArrowUp') view.y += step;
      if (event.key === 'ArrowDown') view.y -= step;
      this.applyView();
    } else if (item && event.key.startsWith('Arrow')) {
      const next = this.neighbor(item, event.key);
      if (next) this.focusItem(next);
    } else if (event.key === '+' || event.key === '=') this.zoomCenter(1.25);
    else if (event.key === '-') this.zoomCenter(0.8);
    else if (event.key === '0') this.fit();
    else handled = false;
    if (handled) event.preventDefault(), event.stopPropagation();
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.size().h : 1;
    if (event.ctrlKey || event.metaKey) {
      const rect = this.svg.getBoundingClientRect();
      this.zoomAt(Math.exp(-event.deltaY * unit * 0.002), event.clientX - rect.left, event.clientY - rect.top);
    } else {
      this.view.x -= event.deltaX * unit;
      this.view.y -= event.deltaY * unit;
      this.applyView();
    }
  }

  private bindEvents(): void {
    const { root, svg } = this;
    root.querySelector('.gv-tools')!.addEventListener('click', (event) => {
      const action = (event.target as Element).closest('button')?.dataset.action;
      if (action === 'fit') this.fit();
      else if (action === 'in') this.zoomCenter(1.25);
      else if (action === 'out') this.zoomCenter(0.8);
    });
    svg.addEventListener('click', (event) => {
      const item = isItem(event.target);
      if (item) this.select(item, event.shiftKey);
    });
    root.addEventListener('keydown', (event) => this.onKey(event));
    svg.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    svg.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || isItem(event.target)) return;
      this.drag = { x: event.clientX, y: event.clientY };
      svg.setPointerCapture(event.pointerId);
      svg.classList.add('gv-dragging');
    });
    svg.addEventListener('pointermove', (event) => {
      if (!this.drag) return;
      this.view.x += event.clientX - this.drag.x;
      this.view.y += event.clientY - this.drag.y;
      this.drag = { x: event.clientX, y: event.clientY };
      this.applyView();
    });
    const endDrag = () => {
      this.drag = null;
      svg.classList.remove('gv-dragging');
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);
  }
}
