// Stylesheet and script of the `buckets inspect` page, served as /assets/inspect.css and /assets/inspect.js.
//
// The script does four things on top of the server-rendered page:
// - draws the map of buckets as a character grid on a canvas, like the film on the site, with cycles, orphan
//   chains and forbidden imports routed through the gaps between boxes, and an optional WebGL pass that bends the
//   picture like the glass of a CRT tube (clicks are mapped back through the same curve)
// - swaps pages without reloading when a link is followed, keeping the state in the URL
// - listens to the server's event stream and fetches the current URL again when the project changed
// - keyboard shortcuts: / search, j and k move, m map or matrix, g projects, a approvals, u up, ? help
//
// The script is plain ES2020 in a String.raw template, so it must not contain backticks or dollar-brace pairs. The
// layout of the map (assets/map-core.ts) is spliced into it, so the server can lay the map out the same way.
import { MAP_CORE_JS } from './map-core.js';

/** Positions of the points on a timeline track, as classes: a page with a strict CSP cannot set inline styles. */
const TIMELINE_POSITIONS = `${Array.from({ length: 101 }, (_, i) => `.tl-x-${i} { left: ${i}%; }`).join('\n')}\n`;

export const INSPECT_CSS = String.raw`
.inspect { width: min(1640px, calc(100% - 2 * var(--gutter))); margin: 16px auto 0; }
.inspect .screen { width: auto; margin: 0; }
.inspect .screen + .screen { margin-top: 0; }
.inspect .screen-body { padding: clamp(14px, 2vw, 26px); }

/* the line under the top bar of a file of inspect --export html */
.static-banner { width: min(1640px, calc(100% - 2 * var(--gutter))); margin: 12px auto 0; padding: 6px 12px; border: 1px dashed var(--amber); color: var(--amber); font-size: 13px; overflow-wrap: anywhere; }
.static-banner strong { color: var(--phos-hi); font-weight: 600; }

.s-ok { --tone: var(--phos); }
.s-lock { --tone: var(--amber); }
.s-violation { --tone: var(--red); }

/* breadcrumb */
.crumbs { display: flex; align-items: baseline; gap: 10px; font-size: 14px; color: var(--dim); overflow-x: auto; white-space: nowrap; scrollbar-width: none; padding: 2px 0; }
.crumbs::-webkit-scrollbar { display: none; }
.crumbs .ps { color: var(--amber); flex: none; }
.crumbs ol { display: flex; align-items: baseline; list-style: none; margin: 0; padding: 0; min-width: 0; }
.crumbs li + li::before { content: "/"; color: var(--line); margin: 0 0.7ch; }
.crumbs a { color: var(--text); text-decoration: none; padding: 2px 4px; }
.crumbs a:hover { background: var(--phos); color: var(--ink); }
.crumbs a[aria-current] { color: var(--phos-hi); text-decoration: underline; text-decoration-color: var(--amber); }
.crumbs a[data-kind="project"]::before { content: "[project] "; color: var(--cyan); font-size: 12px; }

/* columns */
.layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 410px); gap: 22px; align-items: start; margin-top: 12px; }
.main-col { min-width: 0; }
.side { display: grid; gap: 22px; min-width: 0; position: sticky; top: calc(var(--bar-h) + 12px); max-height: calc(100vh - var(--bar-h) - 24px); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--line) transparent; padding-bottom: 2px; }
@media (max-width: 1100px) {
  .layout { grid-template-columns: minmax(0, 1fr); }
  .side { position: static; max-height: none; overflow: visible; }
}

.view-title { font-size: clamp(2rem, 3.4vw, 2.9rem); margin-bottom: 10px; overflow-wrap: anywhere; }
.view-title .dim, .sub .dim, .sub3 .dim { color: var(--dim); text-shadow: none; text-transform: none; }
.panel-title { font-size: clamp(1.7rem, 2.6vw, 2.2rem); margin-bottom: 6px; overflow-wrap: anywhere; text-transform: none; }
.inspect .intro { font-size: 14.5px; color: var(--text); }
.sub { font-family: var(--display); font-size: 1.75rem; line-height: 1; margin: 26px 0 10px; overflow-wrap: anywhere; text-transform: none; }
.sub3 { font-family: var(--display); font-size: 1.4rem; line-height: 1; margin: 18px 0 6px; color: var(--phos); text-transform: uppercase; font-weight: 400; }
.small { font-size: 13px; }
.sub3 code, .sub code { text-transform: none; font-size: 0.62em; vertical-align: 0.15em; }
.path { font-size: 12.5px; overflow-wrap: anywhere; margin: 0 0 8px; }
.empty { color: var(--dim); border: 1px dashed var(--faint); padding: 10px 14px; margin: 6px 0 0; font-size: 14px; }
.badges { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 4px 0 10px; font-size: 13px; }
.badge { display: inline-block; font-size: 11px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; padding: 0 6px; background: var(--tone, var(--phos)); color: var(--ink); text-shadow: none; white-space: nowrap; }
.badge.s-violation { color: #1a0402; }
.tag { display: inline-block; font-size: 11px; color: var(--cyan); border: 1px solid rgba(142, 249, 255, 0.45); padding: 0 5px; margin: 0 6px; line-height: 1.5; white-space: nowrap; }
.led { display: inline-block; flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--tone, var(--phos)); box-shadow: 0 0 8px var(--tone, var(--phos)); margin-right: 8px; vertical-align: 0.05em; }
a.s-lock, a.s-violation, a.st-drift, a.st-changed, a.st-added, a.st-removed { color: var(--tone, var(--amber)); }
a.st-missing { color: var(--red); }
a.s-lock:hover, a.s-violation:hover { background: var(--tone); color: var(--ink); }
.btn-mini { min-height: 32px; padding: 0 10px; font-size: 11px; letter-spacing: 0.06em; }
@media (pointer: coarse) { .btn-mini { min-height: 44px; } }
.linkish { font: inherit; color: var(--phos); background: none; border: 0; padding: 0; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.linkish:hover { background: var(--phos); color: var(--ink); }
.no-js .linkish { display: none; }
ul.plain { list-style: none; margin: 0 0 6px; padding: 0; font-size: 14px; }
ul.plain li { padding: 3px 0; overflow-wrap: anywhere; }
ul.plain li.add { color: var(--phos); }
ul.plain li.del { color: var(--red); }
ul.plain li.chg { color: var(--amber); }
dl.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 14px; font-size: 14px; margin: 8px 0 12px; }
dl.facts dt { color: var(--dim); }
dl.facts dd { margin: 0; overflow-wrap: anywhere; min-width: 0; }

/* the map */
.map-shell { margin: 4px 0 0; }
.map-scroll {
  position: relative; max-height: min(74vh, 860px); overflow: auto; overscroll-behavior: contain;
  border: 1px solid var(--faint); border-radius: 10px / 12px; background: #010603;
  box-shadow: inset 0 0 40px rgba(0, 0, 0, 0.8), 0 0 0 4px rgba(0, 0, 0, 0.6), 0 0 30px rgba(61, 255, 116, 0.06);
  scrollbar-width: thin; scrollbar-color: var(--line) transparent;
}
.map-scroll:focus-visible { outline-offset: 2px; }
.map-space { position: relative; min-height: 120px; }
.map-canvas { display: block; position: sticky; top: 0; width: 100%; height: 120px; cursor: default; }
.map-canvas.pointer { cursor: pointer; }
.map-hint { font-size: 12.5px; margin: 8px 0 0; }
.no-js .map-shell { display: none; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; list-style: none; margin: 12px 0 0; padding: 0; font-size: 12.5px; color: var(--dim); }
.legend li { display: inline-flex; align-items: center; gap: 8px; }
.swatch { display: inline-block; width: 22px; height: 10px; border: 2px solid var(--tone, var(--phos)); }
.swatch.s-ok, .swatch.s-lock, .swatch.s-violation { border-style: double; border-width: 4px; height: 12px; }
.swatch.k-project { border: 4px double var(--cyan); height: 12px; }
.swatch.k-cycle { border: 0; height: 0; border-top: 3px solid var(--red); }
.swatch.k-orphan { border: 0; height: 0; border-top: 2px dotted var(--dim); }
.swatch.k-forbidden { border: 0; height: 0; border-top: 2px dashed var(--red); }
.swatch.e-link { border: 0; height: 0; border-top: 2px solid var(--phos); }
.swatch.e-copy { border: 0; height: 0; border-top: 2px dashed var(--phos); }
.swatch.e-drift { border: 0; height: 0; border-top: 2px solid var(--amber); }
.swatch.e-missing { border: 0; height: 0; border-top: 2px solid var(--red); }
.swatch.e-nest { border: 0; height: 0; border-top: 2px dotted var(--line); }

ul.tree { list-style: none; margin: 0; padding: 10px 14px; font-size: 14px; line-height: 1.95; background: rgba(0, 0, 0, 0.38); border: 1px solid var(--faint); overflow-x: auto; white-space: nowrap; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
ul.tree li { display: flex; align-items: center; min-width: max-content; }
ul.tree .branch { color: var(--line); white-space: pre; font-variant-ligatures: none; }
ul.tree a { color: var(--phos-hi); text-decoration: none; padding: 0 4px; }
ul.tree a.s-lock, ul.tree a.s-violation { color: var(--tone); }
ul.tree a:hover { background: var(--phos); color: var(--ink); }
ul.tree a[aria-current] { background: var(--phos); color: var(--ink); text-shadow: none; }
ul.tree .meta { color: var(--dim); margin-left: 1.5ch; font-size: 12.5px; }
ul.tree .project-row a { color: var(--cyan); }
ul.tree .project-row .tag { margin-left: 0; }

/* map options and notes */
.map-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin: 0 0 10px; font-size: 13px; }
.tools-label { color: var(--dim); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
.seg { display: inline-flex; border: 1px solid var(--line); }
.seg a { padding: 6px 12px; min-height: 32px; display: inline-flex; align-items: center; color: var(--text); text-decoration: none; touch-action: manipulation; }
.seg a + a { border-left: 1px solid var(--line); }
.seg a:hover { background: rgba(61, 255, 116, 0.12); color: var(--phos-hi); }
.seg a[aria-current] { background: var(--phos); color: var(--ink); text-shadow: none; }
@media (pointer: coarse) { .seg a { min-height: 44px; } }
.map-shell { position: relative; }
.no-js #map-full { display: none; }
#map-full[aria-pressed="true"] { background: var(--amber); border-color: var(--amber); color: var(--ink); text-shadow: none; }
/* the map in fullscreen: the whole viewport, in the browser's fullscreen mode when it allows it */
html.map-full, html.map-full body { overflow: hidden; }
html.map-full .map-stage {
  position: fixed; inset: 0; z-index: 85; display: flex; flex-direction: column; gap: 8px; margin: 0;
  padding: max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
  background: var(--bg); overflow-y: auto; overscroll-behavior: contain;
}
html.map-full .map-stage > * { flex: none; margin: 0; }
html.map-full .map-stage > .map-shell { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
html.map-full .map-stage .map-scroll { flex: 1 1 auto; min-height: 220px; max-height: none; }
html.map-full .map-stage .map-hint { flex: none; }
/* a map shorter than the screen keeps its own height, with the legend right under it */
html.map-full .map-stage > .map-shell:not([data-mode="treemap"]), html.map-full .map-shell:not([data-mode="treemap"]) .map-scroll { flex: 0 1 auto; }
@media (max-width: 640px) { html.map-full .map-stage #map-hint { display: none; } }
.map-tip { position: absolute; z-index: 5; max-width: min(420px, calc(100% - 8px)); padding: 6px 10px; background: #021007; border: 1px solid var(--line); box-shadow: 0 0 18px rgba(0, 0, 0, 0.7); font-size: 12.5px; line-height: 1.45; pointer-events: none; overflow-wrap: anywhere; }
.map-tip strong { display: block; color: var(--phos-hi); font-weight: 600; }
.map-tip span { color: var(--dim); }
.tk-bad { color: var(--red); }
.tk-lock { color: var(--amber); }
.tk-dim { color: var(--dim); }
/* the key at the top right of the map frame, in its own strip so it never covers a box */
.map-key {
  display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 2px 14px; margin: 0; padding: 4px 12px;
  font-size: 12px; line-height: 1.5; color: var(--dim); background: #010603;
  border: 1px solid var(--faint); border-bottom: 0; border-radius: 10px 10px 0 0 / 12px 12px 0 0;
}
.map-key span { white-space: nowrap; }
.map-key b { font-weight: 800; margin-right: 4px; }
.map-key + .map-scroll { border-top-left-radius: 0; border-top-right-radius: 0; }
.tag-legend .t { display: inline-block; font-size: 11px; font-weight: 700; padding: 0 6px; line-height: 1.6; }
.tag-legend .t-sel { background: var(--phos-hi); color: var(--ink); }
.tag-legend .t-dep { background: var(--cyan); color: var(--ink); }
.tag-legend .t-use { color: var(--text); border: 1px dashed var(--text); }
ul.map-notes { list-style: none; margin: 10px 0 0; padding: 8px 12px; border-left: 3px solid var(--red); background: rgba(0, 0, 0, 0.35); }
ul.map-notes li { padding: 3px 0; overflow-wrap: anywhere; }
.legend .mark { color: var(--ink); background: var(--amber); font-size: 11px; font-weight: 800; padding: 0 5px; }

/* the bucket tree of a large project: collapsible levels with the counts of each subtree */
.filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 12px; margin: 0 0 8px; }
.filters .field { flex: 1 1 200px; max-width: 360px; }
.filters input[type="search"] { width: 100%; min-height: 40px; padding: 8px 10px; font: inherit; font-size: 16px; color: var(--phos-hi); background: rgba(0, 0, 0, 0.6); border: 1px solid var(--line); border-radius: 0; }
.filters input[type="search"]::placeholder { color: var(--faint); }
.filters input:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
.filters .btn { min-height: 40px; }
.js .filters .btn { display: none; }
ul.tree-nav, ul.tree-nav ul { list-style: none; margin: 0; padding: 0; }
ul.tree-nav { padding: 8px 12px; font-size: 14px; background: rgba(0, 0, 0, 0.38); border: 1px solid var(--faint); overflow-x: auto; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
ul.tree-nav ul { margin-left: 1.1ch; padding-left: 1.6ch; border-left: 1px dashed var(--faint); }
ul.tree-nav li { position: relative; padding-left: 2.6ch; }
ul.tree-nav .row { display: flex; align-items: center; min-height: 30px; min-width: max-content; }
ul.tree-nav .row.is-context { opacity: 0.6; }
ul.tree-nav a { color: var(--phos-hi); text-decoration: none; padding: 0 4px; }
ul.tree-nav a.s-lock, ul.tree-nav a.s-violation { color: var(--tone); }
ul.tree-nav a:hover { background: var(--phos); color: var(--ink); }
ul.tree-nav a[aria-current] { background: var(--phos); color: var(--ink); text-shadow: none; }
ul.tree-nav .meta { color: var(--dim); margin-left: 1.5ch; font-size: 12.5px; white-space: nowrap; }
ul.tree-nav details > summary { position: absolute; left: 0; top: 3px; width: 2.2ch; height: 24px; list-style: none; cursor: pointer; color: var(--amber); text-align: center; line-height: 24px; touch-action: manipulation; }
ul.tree-nav details > summary::-webkit-details-marker { display: none; }
ul.tree-nav details > summary::before { content: "+"; }
ul.tree-nav details[open] > summary::before { content: "-"; }
ul.tree-nav details > summary:hover { background: rgba(255, 192, 77, 0.18); }
ul.tree-nav details > summary:focus-visible { outline: 2px solid var(--amber); outline-offset: 1px; }
@media (pointer: coarse) { ul.tree-nav details > summary { width: 4ch; height: 36px; line-height: 36px; top: -3px; left: -1ch; } ul.tree-nav .row { min-height: 40px; } }

/* long lists: the rest waits in a template until "Show N more" */
.more-row { margin: 8px 0 0; }
ul.violations > li, .result-list > li, ul.plain > li, ul.changes > li { content-visibility: auto; contain-intrinsic-size: auto 40px; }
.matrix { content-visibility: auto; contain-intrinsic-size: auto 420px; }

/* matrix as a list grouped by provider */
.mx-why { margin: -4px 0 8px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
table.mx-list { width: 100%; font-size: 13.5px; border-collapse: collapse; }
table.mx-list th, table.mx-list td { text-align: left; padding: 5px 10px; border-bottom: 1px dashed var(--faint); vertical-align: middle; white-space: nowrap; }
table.mx-list thead th { font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 400; border-bottom: 1px solid var(--line); }
table.mx-list tbody th { color: var(--text); font-weight: 600; text-transform: none; letter-spacing: 0; vertical-align: top; border-right: 1px dashed var(--faint); }
table.mx-list tr.first > * { border-top: 1px solid var(--line); }
table.mx-list td.num { font-variant-numeric: tabular-nums; text-align: right; }
table.mx-list a { color: var(--phos-hi); }
table.mx-list a.s-lock, table.mx-list a.s-violation { color: var(--tone); }
table.mx-list tr.is-selected td { background: rgba(61, 255, 116, 0.1); }
table.mx-list a[aria-current] { background: var(--phos); color: var(--ink); text-shadow: none; }

ul.violations { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.violation { border: 1px solid var(--faint); border-left: 3px solid var(--red); padding: 10px 14px; background: rgba(0, 0, 0, 0.38); min-width: 0; }
.violation.k-orphan { border-left-color: var(--dim); }
.violation.is-selected { border-color: var(--amber); box-shadow: 0 0 18px rgba(255, 192, 77, 0.18); }
.v-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.v-head .rule { color: var(--red); font-weight: 800; font-size: 13px; }
.violation.k-orphan .rule { color: var(--dim); }
.v-head a { overflow-wrap: anywhere; min-width: 0; font-size: 13.5px; }
.v-head .btn-mini { margin-left: auto; }
.v-extra { margin: 6px 0 0; font-size: 13px; overflow-wrap: anywhere; }
.v-extra .arrow { color: var(--red); }
.v-msg { margin: 6px 0 0; font-size: 13px; color: var(--text); overflow-wrap: anywhere; }
ul.violations.compact .v-msg { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }

/* matrix */
.matrix + .matrix { margin-top: 8px; }
/* position: relative keeps the hidden cell labels (absolutely positioned) inside the scroll pane, so a wide table
   scrolls on its own instead of widening the page */
.matrix .table-scroll { position: relative; border: 1px solid var(--faint); background: rgba(0, 0, 0, 0.35); }
table.mx td.cell { position: relative; }
table.mx { width: auto; min-width: 100%; font-size: 13.5px; }
table.mx th, table.mx td { text-align: center; vertical-align: middle; padding: 6px 10px; border: 1px dashed var(--faint); white-space: nowrap; }
table.mx thead th { text-transform: none; letter-spacing: 0; font-size: 12.5px; color: var(--text); font-weight: 600; border-bottom: 1px solid var(--line); }
table.mx thead th.corner { color: var(--line); font-weight: 400; }
table.mx tbody th { text-align: left; color: var(--text); font-weight: 600; text-transform: none; letter-spacing: 0; font-size: 13px; }
table.mx tbody tr:hover { background: rgba(61, 255, 116, 0.04); }
.cell.none, .cell.empty { color: var(--faint); }
.count {
  display: inline-flex; align-items: center; justify-content: center; min-width: 3.2ch; min-height: 34px; padding: 0 6px;
  font-family: var(--display); font-size: 1.7rem; line-height: 1; font-variant-numeric: tabular-nums;
  color: var(--tone); border: 1px solid var(--tone); text-decoration: none; background: rgba(0, 0, 0, 0.3);
}
a.count:hover { background: var(--tone); color: var(--ink); text-shadow: none; box-shadow: 0 0 14px var(--tone); }
a.count[aria-current] { background: var(--tone); color: var(--ink); text-shadow: none; box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--tone); }
span.count { font-size: 1rem; font-family: var(--mono); }

/* contracts and symbols */
ul.symbols-list { list-style: none; margin: 8px 0 0; padding: 0; }
.sym { border-top: 1px dashed var(--faint); padding: 10px 0 12px; min-width: 0; }
.sym-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.sym-head a { font-weight: 800; color: var(--phos-hi); }
.sym-head .tag { margin: 0; }
.sym.unused .sym-head a { color: var(--dim); text-decoration: line-through; }
pre.term.sig { margin: 8px 0; font-size: 12.5px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--phos-hi); }
ol.chain { list-style: none; margin: 6px 0 0; padding: 0; font-size: 12.5px; }
ol.chain li { position: relative; padding: 3px 0 3px 22px; overflow-wrap: anywhere; }
ol.chain li::before { content: ""; position: absolute; left: 7px; top: 0; bottom: 0; border-left: 1px solid rgba(142, 249, 255, 0.55); }
ol.chain li:first-child::before { top: 50%; }
ol.chain li:last-child::before { bottom: 50%; }
ol.chain li::after { content: ""; position: absolute; left: 4px; top: calc(50% - 3px); width: 7px; height: 7px; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 6px var(--cyan); }
ol.chain li.decl::after { background: var(--amber); box-shadow: 0 0 6px var(--amber); }
ol.chain code, .trace-tree code { background: none; border: 0; padding: 1px 4px; }

/* the pulse: each hop lights up in turn, from the declaration to the tips, like the film's contract tags */
.motion .pulse .hop > code, .motion ol.chain .hop > code { animation: hop-flash 3.2s steps(1) infinite; }
.motion .d1 > code { animation-delay: 0.35s !important; }
.motion .d2 > code { animation-delay: 0.7s !important; }
.motion .d3 > code { animation-delay: 1.05s !important; }
.motion .d4 > code { animation-delay: 1.4s !important; }
.motion .d5 > code { animation-delay: 1.75s !important; }
.motion .d6 > code, .motion .d7 > code, .motion .d8 > code, .motion .d9 > code, .motion .d10 > code, .motion .d11 > code { animation-delay: 2.1s !important; }
@keyframes hop-flash {
  0% { background: var(--cyan); color: var(--ink); text-shadow: none; box-shadow: 0 0 12px var(--cyan); }
  11% { background: transparent; color: inherit; box-shadow: none; }
}

/* trace */
.search { margin: 0 0 16px; max-width: 640px; }
.search label { display: block; color: var(--dim); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 4px; }
.search-row { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); background: rgba(0, 0, 0, 0.5); padding: 0 6px 0 12px; }
.search-row:focus-within { outline: 2px solid var(--amber); outline-offset: 2px; }
.search-row .ps { color: var(--amber); }
.search-row input { flex: 1 1 auto; min-width: 0; background: transparent; border: 0; color: var(--phos-hi); font: inherit; font-size: 16px; padding: 10px 4px; outline: none; }
.search-row input::placeholder { color: var(--faint); }
.search-row input::-webkit-search-cancel-button { filter: hue-rotate(80deg); }
.trace-grid { display: grid; grid-template-columns: minmax(220px, 320px) minmax(0, 1fr); gap: 22px; align-items: start; }
.result-list { list-style: none; margin: 0; padding: 0; max-height: 62vh; overflow-y: auto; border: 1px solid var(--faint); background: rgba(0, 0, 0, 0.35); overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
.result-list a { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 8px; padding: 8px 12px; color: var(--text); text-decoration: none; border-bottom: 1px dashed var(--faint); }
.result-list a:hover { background: rgba(61, 255, 116, 0.1); color: var(--phos-hi); }
.result-list a[aria-current] { background: var(--phos); color: var(--ink); text-shadow: none; }
.result-list a[aria-current] .meta, .result-list a[aria-current] .counts, .result-list a[aria-current] .tag { color: var(--ink); border-color: var(--ink); }
.result-list .name { font-weight: 800; color: inherit; overflow-wrap: anywhere; }
.result-list a:not([aria-current]) .name { color: var(--phos-hi); }
.result-list .meta, .result-list .counts { font-size: 12px; color: var(--dim); }
.result-list .meta { grid-column: 1; overflow-wrap: anywhere; }
.result-list .counts { grid-column: 1 / -1; }
.result-list .badge { grid-row: 1; grid-column: 2; justify-self: end; align-self: center; }
.trace-detail h2 { margin-top: 0; }
.trace-tree, .trace-tree ol { list-style: none; margin: 0; padding: 0; }
.trace-tree ol { margin-left: 10px; padding-left: 16px; border-left: 1px solid rgba(142, 249, 255, 0.5); }
.trace-tree .hop { padding: 6px 0 2px; font-size: 13.5px; min-width: 0; overflow-wrap: anywhere; }
.trace-tree .hop > .badge, .trace-tree .hop > .tag { margin-left: 8px; }
.trace-tree .hop > code::before { content: "└─ "; color: var(--cyan); }
.trace-tree > .hop > code::before { content: "● "; color: var(--amber); }
.trace-tree .about { display: block; font-size: 12.5px; margin: 2px 0 0 3ch; }
.trace-tree .importers { list-style: none; margin: 4px 0 2px 3ch; padding: 0; font-size: 12.5px; }
.trace-tree .importers li::before { content: "<- "; color: var(--phos); }
@media (max-width: 760px) { .trace-grid { grid-template-columns: minmax(0, 1fr); } .result-list { max-height: 40vh; } }

/* projects */
.constellation-scroll { overflow: auto; border: 1px solid var(--faint); border-radius: 10px / 12px; background: #010603; box-shadow: inset 0 0 40px rgba(0, 0, 0, 0.8); scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
/* drawn at its own size (the width and height attributes), shrunk to fit on wide screens and scrolled on phones */
svg.constellation { display: block; max-width: 100%; height: auto; margin: 0 auto; }
@media (max-width: 640px) { svg.constellation { max-width: none; } }
.constellation .frame { fill: rgba(2, 14, 7, 0.95); stroke: var(--tone, var(--phos)); stroke-width: 1.5; }
.constellation .frame.inner { fill: none; stroke-width: 1; opacity: 0.55; }
.constellation .node.outside .frame { stroke: var(--line); stroke-dasharray: 4 4; }
.constellation .node.is-current .frame { stroke: var(--phos-hi); stroke-width: 2.5; filter: drop-shadow(0 0 6px var(--glow)); }
.constellation a.node:hover .frame, .constellation a.node:focus-visible .frame { stroke-width: 3; filter: drop-shadow(0 0 8px var(--glow)); }
.constellation a:focus-visible { outline: none; }
.constellation a.node:focus-visible .frame.inner { stroke: var(--amber); opacity: 1; stroke-width: 2; }
.constellation circle.led { fill: var(--tone); filter: drop-shadow(0 0 4px var(--tone)); }
.constellation .name { fill: var(--phos-hi); font: 600 15px var(--mono); }
.constellation .sub { fill: var(--dim); font: 12px var(--mono); }
.constellation .nest { stroke: var(--line); stroke-width: 1.5; stroke-dasharray: 2 6; }
.constellation .edge .hit { fill: none; stroke: transparent; stroke-width: 20; pointer-events: stroke; }
.constellation .edge .line { fill: none; stroke: var(--phos); stroke-width: 2; }
.constellation .edge.m-copy .line { stroke-dasharray: 9 6; }
.constellation .edge.st-drift .line, .constellation .edge.st-changed .line, .constellation .edge.st-added .line, .constellation .edge.st-removed .line { stroke: var(--amber); }
.constellation .edge.st-missing .line { stroke: var(--red); }
.constellation .edge:hover .line, .constellation .edge:focus-visible .line, .constellation .edge.is-selected .line { stroke-width: 4; filter: drop-shadow(0 0 5px currentColor); }
.constellation .edge:focus-visible .edge-label, .constellation .edge.is-selected .edge-label { fill: var(--amber); }
.constellation .edge-label { fill: var(--text); font: 12px var(--mono); paint-order: stroke; stroke: #010603; stroke-width: 4px; }
.constellation .edge-label-bg { fill: #010603; stroke: var(--faint); stroke-width: 1; }
.constellation .edge:hover .edge-label-bg, .constellation .edge:focus-visible .edge-label-bg, .constellation .edge.is-selected .edge-label-bg { stroke: var(--amber); }
.constellation .ah.ok { fill: var(--phos); }
.constellation .ah.lock { fill: var(--amber); }
.constellation .ah.bad { fill: var(--red); }
.motion .constellation .edge.m-link .line { stroke-dasharray: 3 7; stroke-dashoffset: 0; animation: flow 1.6s linear infinite; }
.motion .constellation .edge.m-link.st-ok .line { stroke-dasharray: none; animation: none; }
@keyframes flow { to { stroke-dashoffset: -20; } }
.surfaces { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 14px; }
.surface { border: 1px solid var(--faint); padding: 10px 14px; background: rgba(0, 0, 0, 0.35); min-width: 0; }
.surface h3 { margin-top: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 0 8px; overflow-wrap: anywhere; }
.surface h3 .led { margin-right: 0; }
.surface h3 > * { min-width: 0; }
.surface ul.publish { list-style: none; margin: 0; padding: 0; font-size: 13.5px; }
.surface ul.publish li { padding: 4px 0; overflow-wrap: anywhere; }
.surface p { overflow-wrap: anywhere; }

/* approvals */
.approval { margin-top: 22px; border-left: 3px solid var(--amber); padding-left: 14px; }
.approval h2 { margin-top: 0; }
ul.changes { list-style: none; margin: 0; padding: 0; }
ul.changes li { padding: 8px 0; border-bottom: 1px dashed var(--faint); overflow-wrap: anywhere; }
ul.changes .kind { color: var(--amber); font-weight: 800; margin-right: 10px; font-size: 13px; }
ul.changes p { margin: 4px 0 0; }
.cmd-copy { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0; }

/* side panels */
.panel .tiles { margin: 12px 0 6px; gap: 10px; }
.tiles.cost, .tiles.small-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.panel .tiles .num { font-size: 2.6rem; }
.panel .tiles .what { font-size: 12.5px; }
.feed-screen .screen-body { padding-top: 14px; }
ol.feed { list-style: none; margin: 0; padding: 0; font-size: 13px; max-height: 42vh; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
ol.feed li { display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: baseline; gap: 0 8px; padding: 5px 0; border-bottom: 1px dashed var(--faint); }
ol.feed time { color: var(--dim); font-variant-numeric: tabular-nums; font-size: 12px; }
ol.feed .tag { margin: 0; max-width: 14ch; overflow: hidden; text-overflow: ellipsis; }
ol.feed .text { overflow-wrap: anywhere; min-width: 0; }
ol.feed .f-bad .text { color: var(--red); }
ol.feed .f-ok .text { color: var(--phos); }
ol.feed .f-warn .text { color: var(--amber); }
ol.feed .f-dim .text { color: var(--dim); }
.motion ol.feed li.fresh { animation: fresh 1.8s ease-out; }
@keyframes fresh { from { background: rgba(61, 255, 116, 0.22); } to { background: transparent; } }
@media (max-width: 1100px) { ol.feed { max-height: 50vh; } }

/* help */
dialog.help { padding: 0; width: min(480px, calc(100% - 32px)); background: var(--bg-2); color: var(--text); border: 1px solid var(--line); box-shadow: 0 0 60px rgba(61, 255, 116, 0.15); overscroll-behavior: contain; }
dialog.help::backdrop { background: rgba(0, 0, 0, 0.65); }
.help-body { padding: 18px 22px 20px; }
.help-body h2 { font-size: 2.2rem; }
dl.keys { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 7px 18px; margin: 0 0 14px; font-size: 14px; }
dl.keys dt { white-space: nowrap; }
dl.keys dd { margin: 0; color: var(--text); }
kbd { display: inline-block; min-width: 2.2ch; text-align: center; border: 1px solid var(--line); border-bottom-width: 2px; padding: 0 6px; color: var(--phos-hi); background: rgba(61, 255, 116, 0.08); font-size: 13px; }

/* export links */
.export-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 16px 0 0; padding: 10px 12px; border: 1px dashed var(--faint); background: rgba(0, 0, 0, 0.3); }
.export-label { color: var(--amber); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
.export-row .small { flex: 1 1 260px; min-width: 0; overflow-wrap: anywhere; }
.export-row code { white-space: nowrap; }
.btn.is-off { opacity: 0.35; pointer-events: none; }

/* the maps drawn as SVG on the server: timeline and impact */
.tl-map-scroll {
  position: relative; overflow: auto; overscroll-behavior: contain; border: 1px solid var(--faint); border-radius: 10px / 12px; background: #010603;
  box-shadow: inset 0 0 40px rgba(0, 0, 0, 0.8), 0 0 0 4px rgba(0, 0, 0, 0.6), 0 0 30px rgba(61, 255, 116, 0.06); scrollbar-width: thin; scrollbar-color: var(--line) transparent;
}
.tl-map { position: relative; }
.tl-map svg { display: block; width: 100%; height: auto; }
.tl-map .tl-removed { opacity: 0.55; }
@media (max-width: 640px) { .tl-map svg { width: 760px; max-width: none; } }
.swatch.t-added { border: 4px double var(--phos); height: 12px; }
.swatch.t-changed { border: 4px double var(--amber); height: 12px; }
.swatch.t-removed { border: 4px double var(--red); height: 12px; opacity: 0.7; }
.swatch.t-same { border: 4px double var(--dim); height: 12px; }
.swatch.e-contract { border: 0; height: 0; border-top: 2px solid var(--phos); }

/* the film: a change types itself in, blinks or flickers out, under a passing scan line */
.motion .tl-anim::after {
  content: ""; position: absolute; left: 0; right: 0; top: 0; height: 18%; pointer-events: none;
  background: linear-gradient(to bottom, transparent, rgba(61, 255, 116, 0.16) 60%, rgba(184, 255, 204, 0.28), transparent);
  animation: tl-sweep 0.9s steps(12) both;
}
@keyframes tl-sweep { from { transform: translateY(-100%); opacity: 1; } 90% { opacity: 1; } to { transform: translateY(560%); opacity: 0; } }
.motion .tl-anim .tl-added { animation: tl-in 0.9s steps(6, end) both; }
.motion .tl-anim .tl-changed { animation: tl-blink 0.6s steps(1) 3; }
.motion .tl-anim .tl-removed { animation: tl-out 1s steps(5) both; }
.motion .tl-anim .map-edge path[pathLength] { stroke-dasharray: 100; animation: tl-draw 1.1s steps(14) both; }
@keyframes tl-in { 0% { opacity: 0; } 30% { opacity: 1; } 45% { opacity: 0.2; } 60%, 100% { opacity: 1; } }
@keyframes tl-blink { 0% { opacity: 1; } 50% { opacity: 0.25; } }
@keyframes tl-out { 0% { opacity: 1; } 40% { opacity: 0.1; } 60% { opacity: 0.9; } 100% { opacity: 0.55; } }
@keyframes tl-draw { from { stroke-dashoffset: 100; } to { stroke-dashoffset: 0; } }

/* timeline: tracks */
.tl-tracks { border: 1px solid var(--faint); background: rgba(0, 0, 0, 0.38); padding: 2px 14px; }
.tl-row, .tl-axis { display: grid; grid-template-columns: minmax(140px, 210px) minmax(0, 1fr); align-items: center; gap: 4px 18px; }
.tl-row { padding: 10px 0; border-bottom: 1px dashed var(--faint); }
.tl-name { font-family: var(--mono); font-size: 14px; font-weight: 600; margin: 0; line-height: 1.35; text-transform: none; letter-spacing: 0; overflow-wrap: anywhere; color: var(--text); text-shadow: none; }
.tl-name .dim { display: block; font-size: 12px; font-weight: 400; }
.tl-name a { color: var(--phos-hi); }
.tl-name a[aria-current] { color: var(--ink); background: var(--phos); text-decoration: none; padding: 0 4px; text-shadow: none; }
.tl-line { position: relative; list-style: none; margin: 0 12px; padding: 0; height: 30px; }
.tl-line::before { content: ""; position: absolute; left: -12px; right: -12px; top: 50%; border-top: 1px solid var(--line); }
.tl-row.is-current .tl-line::before { border-top: 2px solid var(--phos); box-shadow: 0 0 10px var(--glow); }
.tl-line li { position: absolute; top: 50%; transform: translate(-50%, -50%); }
.tl-dot { position: relative; display: block; width: 26px; height: 26px; border-radius: 50%; text-decoration: none; touch-action: manipulation; }
.tl-dot::after { content: ""; position: absolute; inset: 8px; border-radius: 50%; background: var(--tone, var(--phos)); box-shadow: 0 0 8px var(--tone, var(--phos)); transition: inset 0.12s; }
.tl-dot.t-fresh { --tone: var(--cyan); }
.tl-dot.t-add { --tone: var(--phos); }
.tl-dot.t-chg { --tone: var(--amber); }
.tl-dot.t-del { --tone: var(--red); }
.tl-dot.t-bad { --tone: var(--dim); }
.tl-dot.t-working::after { background: transparent; border: 2px dashed var(--tone); box-shadow: none; }
.tl-dot:hover { background: none; }
.tl-dot:hover::after, .tl-dot:focus-visible::after { inset: 5px; }
.tl-dot:focus-visible { outline: 2px solid var(--amber); outline-offset: 1px; }
.tl-dot[aria-current]::before { content: ""; position: absolute; inset: 0; border: 2px solid var(--phos-hi); border-radius: 50%; box-shadow: 0 0 12px var(--glow); }
.tl-why { margin: 0; font-size: 13px; color: var(--dim); overflow-wrap: anywhere; }
.tl-axis { margin: 0; padding: 6px 0 4px; font-size: 12px; color: var(--dim); }
.tl-axis .dates { display: flex; justify-content: space-between; gap: 12px; margin: 0 4px; }

/* timeline: slider */
.tl-scrub { margin: 16px 0 0; padding: 12px 14px; border: 1px solid var(--line); background: rgba(0, 0, 0, 0.45); }
.tl-label { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; margin: 0 0 8px; font-size: 14px; }
.tl-label strong { color: var(--amber); font-variant-numeric: tabular-nums; }
.tl-scrub-row { display: flex; align-items: center; gap: 10px; }
.tl-range { flex: 1 1 auto; min-width: 0; height: 36px; touch-action: manipulation; margin: 0; background: transparent; -webkit-appearance: none; appearance: none; cursor: pointer; }
.tl-range::-webkit-slider-runnable-track { height: 4px; background: var(--line); }
.tl-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 16px; height: 28px; margin-top: -12px; background: var(--phos); border: 0; box-shadow: 0 0 12px var(--glow); }
.tl-range::-moz-range-track { height: 4px; background: var(--line); }
.tl-range::-moz-range-thumb { width: 16px; height: 28px; border: 0; border-radius: 0; background: var(--phos); box-shadow: 0 0 12px var(--glow); }
.tl-range:focus-visible { outline: 2px solid var(--amber); outline-offset: 4px; }
.tl-range:disabled { opacity: 0.4; cursor: default; }
#tl-play[aria-pressed="true"] { background: var(--amber); border-color: var(--amber); color: var(--ink); text-shadow: none; }
.no-js #tl-play, .no-js .tl-range { display: none; }

/* timeline: the approval */
.tl-stage { margin-top: 16px; }
.tl-commit { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; margin-bottom: 10px; }
.tl-subject { margin: 0; font-weight: 800; font-size: 15px; color: var(--phos-hi); overflow-wrap: anywhere; min-width: 0; }
.tl-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 0; font-size: 13px; }
.tl-counts { margin-top: 8px; }
ul.tl-diff { list-style: none; margin: 10px 0 0; padding: 0; font-size: 13.5px; }
ul.tl-diff li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; padding: 5px 0; border-bottom: 1px dashed var(--faint); overflow-wrap: anywhere; min-width: 0; }
ul.tl-diff li.sym-row { padding: 1px 0 1px 3ch; border-bottom: 0; }
ul.tl-diff li code { overflow-wrap: anywhere; min-width: 0; }
ul.tl-diff + p, ul.tl-diff + p + p { margin-top: 12px; }
.tl-diff .add { --tone: var(--phos); }
.tl-diff .del { --tone: var(--red); }
.tl-diff .chg { --tone: var(--amber); }
.tl-diff .sign { flex: none; width: 1.5ch; color: var(--tone); font-weight: 800; }
.tl-diff .what { color: var(--tone); }
.panel .tiles:not(.cost):not(.small-tiles) { grid-template-columns: repeat(3, minmax(0, 1fr)); }

/* impact */
.sim-tabs { display: flex; flex-wrap: wrap; gap: 0; margin: 4px 0 16px; border-bottom: 1px solid var(--line); }
.sim-tabs a { padding: 9px 14px; color: var(--text); text-decoration: none; font-size: 14px; border: 1px solid transparent; border-bottom: 0; }
.sim-tabs a:hover { background: rgba(61, 255, 116, 0.12); color: var(--phos-hi); }
.sim-tabs a[aria-current] { background: var(--phos); color: var(--ink); text-shadow: none; }
.sim-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 14px; margin: 0 0 16px; }
.field { display: grid; gap: 4px; flex: 1 1 220px; max-width: 440px; min-width: 0; }
.field label { color: var(--dim); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
.field select { width: 100%; min-height: 42px; padding: 8px 10px; font: inherit; font-size: 15px; color: var(--phos-hi); background: rgba(0, 0, 0, 0.6); border: 1px solid var(--line); border-radius: 0; }
.field select:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
.field option, .field optgroup { background: #021007; color: var(--text); }
.sim-form .btn { min-height: 42px; }
.sim-result h2 { margin-top: 6px; }
.sim-result .tiles { margin-bottom: 16px; }
.sim-result .tl-map-scroll { margin-top: 4px; }
ol.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.step { border: 1px solid var(--faint); border-left: 3px solid var(--tone, var(--line)); padding: 10px 14px; background: rgba(0, 0, 0, 0.35); min-width: 0; }
.step.st-create, .step.st-add { --tone: var(--amber); }
.step.st-present { --tone: var(--phos); }
.step.st-conflict { --tone: var(--red); }
.step-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; overflow-wrap: anywhere; }
.step-head code { overflow-wrap: anywhere; min-width: 0; }
.step-head .lvl { color: var(--amber); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
.step p { margin: 6px 0 0; }
.copy-block { display: flex; align-items: flex-start; gap: 8px; margin: 8px 0 0; }
.copy-block pre.term { flex: 1 1 auto; min-width: 0; margin: 0; padding: 8px 12px; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--phos-hi); }
ul.plain.nested { margin: 4px 0 0 2ch; }
p.cmd-copy + p.note, .copy-block + p.note { margin-top: 12px; }
.note code { white-space: nowrap; }
.sim-result > .cmd-copy { margin-top: 10px; }
ul.consumers > li { padding: 8px 0; border-bottom: 1px dashed var(--faint); }
ul.consumers p { margin: 4px 0 0; }
@media (max-width: 760px) {
  .tl-row, .tl-axis { grid-template-columns: minmax(0, 1fr); }
  .tl-axis > span:first-child { display: none; }
  .sim-tabs a { flex: 1 1 auto; text-align: center; padding: 9px 8px; }
  .field { max-width: none; flex-basis: 100%; }
  .sim-form .btn { width: 100%; }
}
@media (max-width: 480px) {
  .tl-scrub-row { flex-wrap: wrap; }
  .tl-range { order: -1; flex-basis: 100%; }
  .panel .tiles:not(.cost):not(.small-tiles) { gap: 6px; }
}

@media (max-width: 480px) {
  .inspect .screen-bar span:last-child { display: none; }
  .inspect .screen-bar span:first-child { flex: none; }
}
@media (max-width: 640px) {
  .inspect { margin-top: 10px; }
  .inspect .screen-body { padding: 14px; }
  .layout, .side { gap: 16px; }
  .view-title { font-size: 2.1rem; }
  .map-scroll { max-height: 64vh; }
  dl.facts { grid-template-columns: minmax(0, 1fr); gap: 0; }
  dl.facts dd { margin-bottom: 6px; }
  .v-head .btn-mini { margin-left: 0; }
}
` + TIMELINE_POSITIONS;

export const INSPECT_JS = String.raw`(() => {
  'use strict';
  const B = window.buckets || { announce: () => {}, events: null };
  const doc = document.documentElement;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  /* in a file of inspect --export html there is no server: bucketsStatic renders a page from the data in the file, and
     the state lives in the URL hash (#view=matrix) where the live page has the query (/?view=matrix). Pages and links
     inside this script always use the live form; only the address bar and the href of links use the hash. */
  const S = window.bucketsStatic || null;
  function fromHash(hash) {
    const q = hash.replace(/^#\??/, '');
    return q ? '/?' + q : '/';
  }
  /* a hash link of the file holds a state (#, #view=matrix); any other hash (#main) is an anchor in the page */
  function isStateHash(hash) { return hash === '#' || hash === '' || hash.indexOf('=') >= 0; }
  function here() {
    if (!S) return location.pathname + location.search;
    return isStateHash(location.hash) ? fromHash(location.hash) : '/';
  }
  function shown(url) {
    if (!S) return url;
    const q = url.indexOf('?');
    return q < 0 ? location.pathname + location.search : '#' + url.slice(q + 1);
  }
  async function loadPage(url) {
    if (S) return S.page(url);
    const res = await fetch(url, { headers: { accept: 'text/html' }, cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) throw new Error('status ' + res.status);
    return res.text();
  }
  /* ======================= map: a character grid on a canvas ======================= */
` +
  MAP_CORE_JS +
  String.raw`

  /* ---- curved tube: a WebGL pass like the site's film, a little flatter so a large map stays readable ---- */

  const TUBE = { kx: 8.5, ky: 7.0, sx: 1.018, sy: 1.026 };
  function warp(u, v) {
    /* the same curve as the shader: a point on the screen (0..1) to the point of the picture it shows */
    let cx = u * 2 - 1, cy = v * 2 - 1;
    const ox = Math.abs(cy) / TUBE.kx, oy = Math.abs(cx) / TUBE.ky;
    cx = (cx + cx * ox * ox) * TUBE.sx;
    cy = (cy + cy * oy * oy) * TUBE.sy;
    return [cx * 0.5 + 0.5, cy * 0.5 + 0.5];
  }
  const CRT = (() => {
    let cv = null, gl = null, uRes = null, uDpr = null, ok = null;
    const VS = 'attribute vec2 p;varying vec2 v;void main(){v=p*0.5+0.5;gl_Position=vec4(p,0.0,1.0);}';
    const FS = [
      'precision mediump float;',
      'uniform sampler2D t;uniform vec2 res;uniform float dpr;varying vec2 v;',
      'void main(){',
      '  vec2 c=v*2.0-1.0;',
      '  vec2 off=abs(c.yx)/vec2(' + TUBE.kx.toFixed(2) + ',' + TUBE.ky.toFixed(2) + ');',
      '  c=(c+c*off*off)*vec2(' + TUBE.sx.toFixed(3) + ',' + TUBE.sy.toFixed(3) + ');',
      '  vec2 uv=c*0.5+0.5;',
      '  vec2 px=abs(c)*res*0.5;',
      '  float rad=min(res.x,res.y)*0.03;',
      '  vec2 q=px-(res*0.5-vec2(rad));',
      '  float d=length(max(q,0.0))+min(max(q.x,q.y),0.0)-rad;',
      '  float mask=1.0-smoothstep(-1.5*dpr,0.5*dpr,d);',
      '  vec4 s=texture2D(t,clamp(uv,0.0,1.0));',
      '  vec3 bg=mix(vec3(0.016,0.07,0.035),vec3(0.004,0.022,0.012),clamp(length(c)*0.8,0.0,1.0));',
      '  vec3 col=s.rgb*s.a+bg*(1.0-s.a);',
      '  float sl=0.92+0.08*cos(uv.y*res.y/dpr*2.0944);',
      '  float vig=pow(clamp(16.0*uv.x*uv.y*(1.0-uv.x)*(1.0-uv.y),0.0,1.0),0.09);',
      '  float hl=smoothstep(0.75,0.0,length((uv-vec2(0.3,0.75))*vec2(1.0,1.4)))*0.035;',
      '  gl_FragColor=vec4((col*sl*vig+hl)*mask,1.0);',
      '}'
    ].join('\n');
    function init() {
      if (ok !== null) return ok;
      ok = false;
      try {
        cv = document.createElement('canvas');
        gl = cv.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
        if (!gl) return ok;
        const sh = (type, src) => {
          const s = gl.createShader(type);
          gl.shaderSource(s, src);
          gl.compileShader(s);
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader');
          return s;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
        gl.useProgram(prog);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, 'p');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        uRes = gl.getUniformLocation(prog, 'res');
        uDpr = gl.getUniformLocation(prog, 'dpr');
        gl.uniform1i(gl.getUniformLocation(prog, 't'), 0);
        cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); ok = false; });
        ok = true;
      } catch (e) {
        ok = false;
      }
      return ok;
    }
    function apply(canvas, ctx, dpr) {
      if (!init()) return false;
      const w = canvas.width, h = canvas.height;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      gl.viewport(0, 0, w, h);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.uniform2f(uRes, w, h);
      gl.uniform1f(uDpr, dpr);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(cv, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      return true;
    }
    return { apply };
  })();

  /* ---- rasterizer: cells to pixels (the film's renderer, with the shapes the map uses) ---- */

  const canFilter = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;

  function rasterGrid(bctx, g, cw, chh, y0, y1) {
    const C = g.cols;
    const fs = cw / 0.6;
    const r0 = Math.max(0, Math.floor(y0 / chh)), r1 = Math.min(g.rows - 1, Math.ceil(y1 / chh));
    for (let y = r0; y <= r1; y++) for (let x = 0; x < C; x++) {
      const i = y * C + x;
      if (!g.bg[i]) continue;
      bctx.globalAlpha = g.al[i] || 1;
      bctx.fillStyle = g.bg[i];
      /* whole pixels with no overlap, so a translucent fill has no seams between cells */
      const px = Math.round(x * cw), py = Math.round(y * chh);
      bctx.fillRect(px, py, Math.round((x + 1) * cw) - px, Math.round((y + 1) * chh) - py);
    }
    const lw = markWidths(cw);
    bctx.lineCap = 'square';
    for (let y = r0; y <= r1; y++) for (let x = 0; x < C; x++) {
      const i = y * C + x;
      const m = g.mk[i];
      if (!m) continue;
      const st = g.st[i];
      bctx.globalAlpha = g.al[i];
      bctx.strokeStyle = g.fg[i];
      bctx.lineWidth = st === 3 ? lw.thick : lw.thin;
      if (st === 4) bctx.setLineDash([cw * 0.32, cw * 0.32]);
      bctx.beginPath();
      markPath(bctx, m, st, x * cw, y * chh, cw, chh);
      bctx.stroke();
      if (st === 4) bctx.setLineDash([]);
    }
    bctx.font = '400 ' + fs.toFixed(2) + 'px ' + FONT;
    bctx.textAlign = 'center';
    bctx.textBaseline = 'middle';
    for (let y = r0; y <= r1; y++) for (let x = 0; x < C; x++) {
      const i = y * C + x;
      const c = g.ch[i];
      if (!c || c === ' ') continue;
      glyph(bctx, c, x * cw, y * chh, cw, chh, g.fg[i], g.al[i]);
    }
  }

  function glyph(bctx, c, x0, y0, cw, chh, fg, al) {
    bctx.globalAlpha = al;
    bctx.fillStyle = fg;
    const cx = x0 + cw / 2, cy = y0 + chh / 2;
    if (c === '●') { bctx.beginPath(); bctx.arc(cx, cy, cw * 0.36, 0, Math.PI * 2); bctx.fill(); return; }
    if (c === '·') { bctx.beginPath(); bctx.arc(cx, cy, Math.max(1, cw * 0.14), 0, Math.PI * 2); bctx.fill(); return; }
    if (c === '✗') {
      bctx.strokeStyle = fg; bctx.lineWidth = Math.max(1.8, cw * 0.3); bctx.beginPath();
      bctx.moveTo(x0 + cw * 0.12, cy - cw * 0.5); bctx.lineTo(x0 + cw * 0.88, cy + cw * 0.5);
      bctx.moveTo(x0 + cw * 0.88, cy - cw * 0.5); bctx.lineTo(x0 + cw * 0.12, cy + cw * 0.5); bctx.stroke(); return;
    }
    bctx.fillText(c, cx, cy + chh * 0.03);
  }

  /* ---- the map view: sticky canvas in a scroll pane, redrawn for the visible rows ---- */

  let mapView = null;

  function readData() {
    const el = document.getElementById('inspect-data');
    if (!el) return null;
    try { return JSON.parse(el.textContent || 'null'); } catch (e) { return null; }
  }

  function cellSize(width) {
    const cw = width >= 720 ? 8 : Math.max(6.2, Math.min(8, width / 50));
    return { cw, chh: Math.round(cw * 2) };
  }

  function setupMap(data, keep) {
    if (mapView) mapView.destroy();
    mapView = null;
    const scroll = document.getElementById('map-scroll');
    const space = document.getElementById('map-space');
    const canvas = document.getElementById('map-canvas');
    if (!scroll || !space || !canvas || !data || !data.buckets || !data.buckets.length) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const buf = document.createElement('canvas');
    const bctx = buf.getContext('2d');
    const ui = { hover: null };
    let L = null, g = null, ov = null, cw = 8, chh = 16, W = 0, H = 0, dpr = 1;
    let raf = 0, pulseRaf = 0, alive = true, staticKey = '';
    let tags = [];
    let kbd = null;
    const tip = document.getElementById('map-tip');
    const shell = document.getElementById('map-shell');

    /* ---- labels of the selection: the selected bucket, what it depends on and what uses it ---- */

    const TAG = {
      selected: { glyph: '●', bg: PAL.hi, fg: PAL.ink, line: PAL.hi, dash: null },
      dep: { glyph: '→', bg: PAL.cyan, fg: PAL.ink, line: PAL.cyan, dash: null },
      user: { glyph: '•', bg: 'rgba(1, 6, 3, 0.95)', fg: PAL.text, line: PAL.text, dash: [3, 3] }
    };
    function computeTags() {
      const out = [];
      let outside = 0;
      const sel = data.selected ? data.buckets.find((b) => b.path === data.selected) : null;
      if (sel) {
        const roles = [[sel.path, 'selected']].concat(sel.dependsOn.map((p) => [p, 'dep']), sel.dependents.map((p) => [p, 'user']));
        const groups = new Map();
        for (const [path, role] of roles) {
          const R = boxOf(L, path);
          if (!R) { outside++; continue; }
          const key = R.b.path + '\0' + role;
          if (!groups.has(key)) groups.set(key, { R, role, paths: [] });
          groups.get(key).paths.push(path);
        }
        const placed = [];
        const clash = (x, y, w) => placed.some((q) => q.y === y && x <= q.x + q.w && q.x <= x + w);
        const inPlace = new Set();
        const list = Array.from(groups.values());
        /* a whole name already on the map is lit where it is; any other gets a tag beside its box */
        for (const t of list) {
          const R = t.R;
          if (t.paths.length !== 1 || t.paths[0] !== R.b.path || !R.nameAt || inPlace.has(R)) continue;
          inPlace.add(R);
          const n = R.nameAt;
          const text = n.bare ? R.b.name + (n.len > R.b.name.length ? '/' : '') : TAG[t.role].glyph + R.b.name + '/';
          t.at = { x: n.x, y: n.y, w: n.len, text: (text + ' '.repeat(n.len)).slice(0, n.len), lead: false };
          placed.push(t.at);
        }
        for (const t of list) {
          if (t.at) continue;
          const R = t.R;
          const exact = t.paths.length === 1 && t.paths[0] === R.b.path;
          const text = ' ' + TAG[t.role].glyph + ' ' + R.b.name + '/' + (exact ? '' : ' (' + t.paths.length + ' inside)') + ' ';
          const w = text.length;
          const spots = [[R.x + 1, R.y], [R.x + 1, R.y + 1]];
          for (let d = 0; d <= 10; d++) {
            spots.push([R.x + 1, R.y - 1 - d], [R.x + 1, R.y + R.h + d], [R.x + R.w - w, R.y - 1 - d], [R.x + R.w - w, R.y + R.h + d], [R.x + R.w + 1 + d * 4, R.y], [R.x - w - 1 - d * 4, R.y]);
          }
          let best = null;
          for (const [sx, sy] of spots) {
            const x = clamp(sx, 0, Math.max(0, L.cols - w)), y = clamp(sy, 0, L.rows - 1);
            if (clash(x, y, w)) continue;
            const touch = y >= R.y - 1 && y <= R.y + R.h && x <= R.x + R.w - 1 && x + w - 1 >= R.x;
            const dy = y < R.y ? R.y - y : y >= R.y + R.h ? y - R.y - R.h + 1 : 0;
            const dx = x + w - 1 < R.x ? R.x - x - w + 1 : x > R.x + R.w - 1 ? x - R.x - R.w + 1 : 0;
            let cost = (touch ? 0 : 4) + dy * 3 + dx;
            for (let k = 0; k < w; k++) {
              const i = g.idx(x + k, y);
              if (i < 0) continue;
              /* covering the box's own cut name is fine; covering another name is not */
              const own = y === R.y && x + k >= R.x && x + k < R.x + R.w;
              if (g.ch[i] && !own) cost += 4;
              else if (g.mk[i]) cost += 0.3;
            }
            if (!best || cost < best.cost) best = { x, y, cost, touch };
          }
          if (!best) continue;
          t.at = { x: best.x, y: best.y, w, text, lead: !best.touch };
          placed.push(t.at);
        }
        for (const t of list) if (t.at) out.push(t);
      }
      const note = document.getElementById('map-tags-note');
      if (note) {
        note.hidden = !outside;
        note.textContent = outside ? outside + (outside === 1 ? ' related bucket is' : ' related buckets are') + ' outside this level. The panel lists them all.' : '';
      }
      return out;
    }
    function drawTags(c2) {
      const fs = cw / 0.6;
      for (const t of tags) {
        const st = TAG[t.role], a = t.at, R = t.R;
        const x0 = a.x * cw, y0 = a.y * chh + chh * 0.06, w = a.w * cw, h = chh * 0.88;
        c2.save();
        if (a.lead) {
          /* a short leader from the tag to the nearest point of its box */
          const bx0 = R.x * cw, by0 = R.y * chh, bx1 = (R.x + R.w) * cw, by1 = (R.y + R.h) * chh;
          const cx = x0 + w / 2, cy = y0 + h / 2;
          const px = clamp(cx, bx0, bx1), py = clamp(cy, by0, by1);
          const qx = clamp(px, x0, x0 + w), qy = clamp(py, y0, y0 + h);
          c2.strokeStyle = st.line; c2.lineWidth = 1.2;
          if (st.dash) c2.setLineDash(st.dash);
          c2.beginPath(); c2.moveTo(qx, qy); c2.lineTo(px, py); c2.stroke();
          c2.setLineDash([]);
          c2.fillStyle = st.line;
          c2.beginPath(); c2.arc(px, py, Math.max(1.6, cw * 0.22), 0, Math.PI * 2); c2.fill();
        }
        c2.fillStyle = st.bg;
        c2.fillRect(x0, y0, w, h);
        if (st.dash) {
          c2.strokeStyle = st.line; c2.lineWidth = 1; c2.setLineDash(st.dash);
          c2.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
          c2.setLineDash([]);
        }
        c2.fillStyle = st.fg;
        c2.font = '600 ' + fs.toFixed(2) + 'px ' + FONT;
        c2.textAlign = 'center';
        c2.textBaseline = 'middle';
        for (let k = 0; k < a.text.length; k++) if (a.text[k] !== ' ') c2.fillText(a.text[k], (a.x + k) * cw + cw / 2, a.y * chh + chh / 2 + chh * 0.03);
        c2.restore();
      }
    }

    /* ---- the full path of a box: a tooltip on hover, and the same for the box picked with the arrow keys ---- */

    function describe(R) {
      if (R.kind === 'project') return { title: 'project ' + R.p.name + ' (' + R.p.path + ')', sub: R.p.buckets + (R.p.buckets === 1 ? ' bucket. Enter it.' : ' buckets. Enter it.') };
      const b = R.b;
      const parts = [b.files + (b.files === 1 ? ' file' : ' files')];
      if (b.cin !== undefined) parts.push(b.cin + (b.cin === 1 ? ' contract in, ' : ' contracts in, ') + b.cout + ' out');
      const ins = insOf(b), outs = outsOf(b);
      if (ins) parts.push('used by ' + ins + (ins === 1 ? ' bucket' : ' buckets'));
      if (outs) parts.push('depends on ' + outs + (outs === 1 ? ' bucket' : ' buckets'));
      const inside = b.inside || (R.hidden || 0);
      if (inside) parts.push(inside + (inside === 1 ? ' bucket inside' : ' buckets inside'));
      if (b.violations) parts.push(b.violations + (b.violations === 1 ? ' violation' : ' violations'));
      if (b.lockChanges) parts.push(b.lockChanges + (b.lockChanges === 1 ? ' lock difference' : ' lock differences'));
      return { title: b.path + '/', sub: parts.join(', ') };
    }
    function showTip(R, px, py) {
      if (!tip || !shell) return;
      const d = describe(R);
      const strong = document.createElement('strong');
      strong.textContent = d.title;
      strong.setAttribute('translate', 'no');
      const span = document.createElement('span');
      span.textContent = d.sub;
      tip.replaceChildren(strong, span);
      tip.hidden = false;
      const s = shell.getBoundingClientRect(), c = canvas.getBoundingClientRect();
      const x = px + c.left - s.left, y = py + c.top - s.top;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      const left = clamp(x + 12, 0, Math.max(0, s.width - tw));
      const top = y + 18 + th > c.bottom - s.top ? y - th - 10 : y + 18;
      tip.style.left = left + 'px';
      tip.style.top = Math.max(0, top) + 'px';
    }
    function hideTip() { if (tip) tip.hidden = true; }
    function boxCenter(R) { return { x: (R.x + R.w / 2) * cw, y: (R.y + R.h / 2) * chh }; }
    function kbdRect() {
      if (!kbd) return null;
      return kbd.kind === 'project' ? L.projects.find((x) => x.p.path === kbd.path) || null : L.boxes.find((x) => x.b.path === kbd.path) || null;
    }
    function pickBox(R) {
      kbd = R ? { kind: R.kind, path: R.kind === 'project' ? R.p.path : R.b.path } : null;
      if (!R) { hideTip(); request(); return; }
      const top = R.y * chh, bottom = (R.y + Math.min(R.h, 4)) * chh;
      if (top < scroll.scrollTop) scroll.scrollTop = Math.max(0, top - chh);
      else if (bottom > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = bottom - scroll.clientHeight + chh;
      const c = boxCenter(R);
      showTip(R, Math.min(c.x, (R.x + 2) * cw), R.y * chh - scroll.scrollTop);
      const d = describe(R);
      B.announce(d.title + ' ' + d.sub);
      request();
    }
    function onKey(ev) {
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      const all = L.boxes.concat(L.projects);
      const cur = kbdRect();
      if (ev.key === 'Enter' || ev.key === ' ') {
        if (!cur) return;
        ev.preventDefault();
        if (cur.kind === 'project') {
          const target = (data.projectHref.find((p) => p.path === cur.p.path) || {}).href;
          if (target) navigate(target, { push: true });
        } else if (cur.b.href) navigate(cur.b.href, { push: true });
        return;
      }
      if (ev.key === 'Escape' && cur) { ev.preventDefault(); ev.stopPropagation(); pickBox(null); return; }
      const dirs = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
      const dir = dirs[ev.key];
      if (ev.key === 'Home') { ev.preventDefault(); pickBox(all.find((R) => R.kind === 'bucket' && R.b.path === data.selected) || all[0]); return; }
      if (!dir) return;
      ev.preventDefault();
      if (!cur) { pickBox(all.find((R) => R.kind === 'bucket' && R.b.path === data.selected) || all[1] || all[0]); return; }
      const a = boxCenter(cur);
      let best = null;
      for (const R of all) {
        /* a box that holds the current one is not a neighbour: arrows move across a level and into boxes */
        if (R === cur || (R.x <= cur.x && R.y <= cur.y && R.x + R.w >= cur.x + cur.w && R.y + R.h >= cur.y + cur.h)) continue;
        const b = boxCenter(R);
        const along = (b.x - a.x) * dir[0] + (b.y - a.y) * dir[1];
        if (along <= 1) continue;
        const across = Math.abs((b.x - a.x) * dir[1]) + Math.abs((b.y - a.y) * dir[0]);
        const score = along + across * 2;
        if (!best || score < best.score) best = { R, score };
      }
      if (best) pickBox(best.R);
    }

    function relayout() {
      W = Math.max(200, Math.floor(scroll.clientWidth));
      const size = cellSize(W);
      cw = size.cw; chh = size.chh;
      const cols = Math.max(24, Math.floor(W / cw));
      cw = W / cols;
      const full = doc.classList.contains('map-full');
      /* in fullscreen the treemap fills the height it has; the other layouts keep their own height and scroll */
      L = layoutFor(data, cols);
      if (full && L.treemap) {
        const fit = Math.floor((scroll.clientHeight - 4) / chh);
        if (fit > L.rows) L = layoutTreemap(Object.assign({}, data), cols, fit);
      }
      g = drawMap(L, data, ui);
      ov = overlays(L, g, data);
      tags = computeTags();
      const skipped = document.getElementById('map-skipped');
      if (skipped) {
        skipped.hidden = !ov.skipped;
        skipped.textContent = ov.skipped ? ov.skipped + (ov.skipped === 1 ? ' violation line is' : ' violation lines are') + ' not drawn: a bucket at one end is too small to show here. The list below has every violation.' : '';
      }
      const total = L.rows * chh;
      space.style.height = total + 'px';
      H = Math.min(total, Math.max(160, Math.floor(scroll.clientHeight || total)));
      const maxH = full ? scroll.clientHeight : parseFloat(getComputedStyle(scroll).maxHeight) || total;
      H = Math.min(total, Math.floor(maxH) - 2);
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      buf.width = canvas.width; buf.height = canvas.height;
      staticKey = '';
    }

    function redrawStatic(top) {
      const key = top + ':' + W + ':' + H;
      if (key === staticKey) return;
      staticKey = key;
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.clearRect(0, 0, W, H);
      bctx.save();
      bctx.translate(0, -top);
      rasterGrid(bctx, g, cw, chh, top, top + H);
      bctx.restore();
    }

    function cellPt(c) { return [c[0] * cw + cw / 2, c[1] * chh + chh / 2]; }
    function strokeCells(c2, cells, color, width, alpha, dash, glow) {
      if (!cells || cells.length < 2) return;
      c2.save();
      c2.globalAlpha = alpha;
      c2.strokeStyle = color;
      c2.lineWidth = width;
      c2.lineJoin = 'round';
      c2.lineCap = 'round';
      if (dash) c2.setLineDash(dash);
      if (glow) { c2.shadowColor = color; c2.shadowBlur = glow; }
      c2.beginPath();
      cells.forEach((c, i) => { const p = cellPt(c); if (i === 0) c2.moveTo(p[0], p[1]); else c2.lineTo(p[0], p[1]); });
      c2.stroke();
      c2.restore();
    }
    function arrow(c2, cells, color, alpha) {
      if (!cells || cells.length < 2) return;
      const a = cellPt(cells[cells.length - 2]), b = cellPt(cells[cells.length - 1]);
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const s = Math.max(5, cw * 0.75);
      c2.save();
      c2.globalAlpha = alpha;
      c2.fillStyle = color;
      c2.beginPath();
      c2.moveTo(b[0] + Math.cos(ang) * s * 0.4, b[1] + Math.sin(ang) * s * 0.4);
      c2.lineTo(b[0] - Math.cos(ang - 0.5) * s, b[1] - Math.sin(ang - 0.5) * s);
      c2.lineTo(b[0] - Math.cos(ang + 0.5) * s, b[1] - Math.sin(ang + 0.5) * s);
      c2.closePath();
      c2.fill();
      c2.restore();
    }
    function label(c2, cell, text, color, alpha) {
      if (!cell) return;
      const fs = Math.max(10, cw / 0.66);
      c2.save();
      c2.globalAlpha = alpha;
      c2.font = '600 ' + fs.toFixed(1) + 'px ' + FONT;
      c2.textBaseline = 'middle';
      const w = c2.measureText(text).width + 8;
      const span = Math.ceil(w / cw);
      /* try beside, below and above the point, and keep the spot that covers the fewest letters and walls */
      const spots = [[1, 0], [-span - 1, 0], [1, 1], [1, -1], [-span - 1, 1], [-span - 1, -1], [-Math.floor(span / 2), 1], [-Math.floor(span / 2), -1]];
      let best = null;
      for (const [dx, dy] of spots) {
        const x0 = cell[0] + dx, y = cell[1] + dy;
        if (x0 < 0 || x0 + span >= g.cols || y < 0 || y >= g.rows) continue;
        let score = 0;
        for (let x = x0; x < x0 + span; x++) { const i = g.idx(x, y); if (g.ch[i]) score += 3; else if (g.mk[i]) score += 1; }
        if (!best || score < best.score) best = { x0, y, score };
      }
      if (!best) best = { x0: Math.max(0, Math.min(g.cols - span - 1, cell[0] + 1)), y: cell[1] };
      const x = best.x0 * cw + 1, cy = best.y * chh + chh / 2;
      c2.fillStyle = 'rgba(1, 6, 3, 0.94)';
      c2.fillRect(x - 1, cy - chh * 0.48, w, chh * 0.96);
      c2.strokeStyle = color;
      c2.lineWidth = 1;
      c2.strokeRect(x - 1 + 0.5, cy - chh * 0.48 + 0.5, w - 1, chh * 0.96 - 1);
      c2.fillStyle = color;
      c2.fillText(text, x + 3, cy + 1);
      c2.restore();
    }

    function drawOverlays(c2, t) {
      const hl = data.highlight;
      const dimOf = (id) => (hl && hl !== id ? 0.3 : 1);
      const thick = Math.max(2, cw * 0.3);
      /* dependency lines in the colors of the labels: cyan to what it depends on, dashed green from what uses it */
      for (const d of ov.deps) {
        strokeCells(c2, d.seg, d.out ? PAL.cyan : PAL.text, Math.max(1.2, cw * 0.16), d.out ? 0.85 : 0.7, d.out ? null : [cw * 0.5, cw * 0.4], 0);
        arrow(c2, d.seg, d.out ? PAL.cyan : PAL.text, 0.85);
      }
      for (const o of ov.orphans) {
        const a = dimOf(o.id) * (hl === o.id ? 1 : 0.75);
        o.segs.forEach((seg) => strokeCells(c2, seg, PAL.dim, Math.max(1.4, cw * 0.18), a, [1, cw * 0.55], 0));
        const last = o.segs.length ? o.segs[o.segs.length - 1] : null;
        if (last) label(c2, last[last.length - 1], 'orphan ' + o.symbol, PAL.dim, a);
      }
      for (const f of ov.forbidden) {
        const a = dimOf(f.id);
        strokeCells(c2, f.seg, PAL.red, Math.max(1.6, cw * 0.22), a, [cw * 0.55, cw * 0.4], hl === f.id ? 10 : 4);
        arrow(c2, f.seg, PAL.red, a);
        if (f.cross) {
          const blink = reduced || hl !== f.id || Math.floor(t / 280) % 2 === 0;
          if (blink) {
            const p = cellPt(f.cross);
            c2.save();
            c2.globalAlpha = a;
            c2.fillStyle = 'rgba(1, 6, 3, 0.95)';
            c2.fillRect(p[0] - cw * 0.7, p[1] - chh * 0.45, cw * 1.4, chh * 0.9);
            glyph(c2, '✗', p[0] - cw / 2, p[1] - chh / 2, cw, chh, PAL.red, a);
            c2.restore();
          }
          label(c2, f.cross, 'import-forbidden', PAL.red, a);
        }
      }
      for (const c of ov.cycles) {
        const a = dimOf(c.id);
        c.segs.forEach((seg) => { strokeCells(c2, seg, PAL.red, thick, a, null, hl === c.id ? 14 : 7); arrow(c2, seg, PAL.red, a); });
        if (!reduced && c.all.length > 3) {
          const n = c.all.length;
          const idx = Math.floor((t / 1000) * 16) % n;
          for (let k = 4; k >= 1; k--) {
            const cell = c.all[(idx - k + n) % n];
            const p = cellPt(cell);
            c2.save();
            c2.globalAlpha = a * (1 - k * 0.2);
            c2.fillStyle = PAL.amber;
            c2.beginPath(); c2.arc(p[0], p[1], Math.max(1.2, cw * 0.14), 0, Math.PI * 2); c2.fill();
            c2.restore();
          }
          const p = cellPt(c.all[idx]);
          c2.save();
          c2.globalAlpha = a;
          c2.fillStyle = PAL.amber;
          c2.shadowColor = PAL.amber; c2.shadowBlur = 10;
          c2.beginPath(); c2.arc(p[0], p[1], Math.max(2.4, cw * 0.38), 0, Math.PI * 2); c2.fill();
          c2.restore();
        }
        label(c2, c.segs[0] && c.segs[0][0], 'cycle', PAL.red, a);
      }
    }

    function frame(t) {
      raf = 0;
      if (!alive) return;
      const top = Math.round(scroll.scrollTop);
      redrawStatic(top);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const crt = doc.dataset.crt !== 'off';
      if (canFilter && crt) {
        ctx.filter = 'blur(' + Math.max(2, cw * 0.5 * dpr).toFixed(1) + 'px)';
        ctx.globalAlpha = 0.7;
        ctx.drawImage(buf, 0, 0);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
      }
      ctx.drawImage(buf, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, -top * dpr);
      drawOverlays(ctx, t || performance.now());
      drawTags(ctx);
      const k = document.activeElement === scroll ? kbdRect() : null;
      if (k) {
        ctx.save();
        ctx.strokeStyle = PAL.amber;
        ctx.lineWidth = 2.5;
        ctx.strokeRect(k.x * cw + 1.5, k.y * chh + 1.5, k.w * cw - 3, k.h * chh - 3);
        ctx.restore();
      }
      const curved = crt && CRT.apply(canvas, ctx, dpr);
      canvas.dataset.curved = curved ? 'on' : 'off';
    }
    function request() { if (!raf && alive) raf = requestAnimationFrame(frame); }

    function animate() {
      pulseRaf = 0;
      if (!alive) return;
      if (!document.hidden && (ov.cycles.length || (data.highlight && ov.forbidden.length))) {
        request();
        pulseRaf = window.setTimeout(() => requestAnimationFrame(animate), 60);
      }
    }

    function hit(ev) {
      const r = canvas.getBoundingClientRect();
      let u = (ev.clientX - r.left) / r.width, v = (ev.clientY - r.top) / r.height;
      if (canvas.dataset.curved === 'on') { const w = warp(u, v); u = w[0]; v = w[1]; }
      if (u < 0 || v < 0 || u > 1 || v > 1) return null;
      const x = Math.floor((u * W) / cw), y = Math.floor((v * H + scroll.scrollTop) / chh);
      const inside = (R) => x >= R.x && x < R.x + R.w && y >= R.y && y < R.y + R.h;
      for (let i = L.projects.length - 1; i >= 0; i--) if (inside(L.projects[i])) return L.projects[i];
      let best = null;
      for (const R of L.boxes) if (inside(R) && (!best || R.b.level > best.b.level)) best = R;
      return best;
    }
    function onMove(ev) {
      const R = hit(ev);
      const same = (ui.hover === null && R === null) || (ui.hover && R && ui.hover.kind === R.kind && (ui.hover.b === R.b && ui.hover.p === R.p));
      canvas.classList.toggle('pointer', !!R);
      if (R) showTip(R, ev.clientX - canvas.getBoundingClientRect().left, ev.clientY - canvas.getBoundingClientRect().top);
      else hideTip();
      if (same) return;
      ui.hover = R ? { kind: R.kind, b: R.b, p: R.p } : null;
      g = drawMap(L, data, ui);
      staticKey = '';
      request();
    }
    function onLeave() { hideTip(); if (ui.hover) { ui.hover = null; g = drawMap(L, data, ui); staticKey = ''; request(); } canvas.classList.remove('pointer'); }
    function onClick(ev) {
      const R = hit(ev);
      if (!R) return;
      if (R.kind === 'project') {
        const target = (data.projectHref.find((p) => p.path === R.p.path) || {}).href;
        if (target) zoomInto(target, { x: (R.x + R.w / 2) * cw, y: (R.y + R.h / 2) * chh - scroll.scrollTop });
        return;
      }
      /* the full map toggles the selection; one level and the treemap follow the box link (open it, or go up) */
      const href = data.mode && data.mode !== 'full' ? R.b.href : R.b.path === data.selected ? here().replace(/([?&])bucket=[^&]*&?/, '$1').replace(/[?&]$/, '') : R.b.href;
      navigate(href || '/', { push: true });
    }
    const onScroll = () => request();
    let lastH = 0;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      const w = Math.floor(scroll.clientWidth), h = Math.floor(scroll.clientHeight);
      /* the height only matters in fullscreen, where the pane has a fixed size */
      if (w !== W || (doc.classList.contains('map-full') && h !== lastH)) { lastH = h; relayout(); request(); }
    }) : null;

    relayout();
    if (keep && keep.project === data.project) scroll.scrollTop = keep.scroll;
    else if (data.selected) {
      const R = L.boxes.find((x) => x.b.path === data.selected);
      if (R) scroll.scrollTop = Math.max(0, R.y * chh - 24);
    }
    request();
    animate();
    scroll.addEventListener('scroll', onScroll, { passive: true });
    scroll.addEventListener('keydown', onKey);
    const onBlur = () => { hideTip(); request(); };
    const onFocus = () => request();
    scroll.addEventListener('blur', onBlur);
    scroll.addEventListener('focus', onFocus);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('click', onClick);
    if (ro) ro.observe(scroll);
    const onCrt = () => { staticKey = ''; request(); };
    const crtBtn = document.getElementById('crt-toggle');
    if (crtBtn) crtBtn.addEventListener('click', onCrt);
    const onVis = () => { if (!document.hidden) animate(); };
    document.addEventListener('visibilitychange', onVis);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (alive) { staticKey = ''; request(); } });

    mapView = {
      canvas, scroll, project: data.project,
      refit() {
        relayout();
        /* the new size moves every box: bring the selected one back into view */
        const R = data.selected ? L.boxes.find((x) => x.b.path === data.selected) : null;
        if (R && (R.y * chh < scroll.scrollTop || R.y * chh > scroll.scrollTop + scroll.clientHeight - chh * 3)) scroll.scrollTop = Math.max(0, R.y * chh - chh * 2);
        request();
      },
      destroy() {
        alive = false;
        if (raf) cancelAnimationFrame(raf);
        if (pulseRaf) clearTimeout(pulseRaf);
        scroll.removeEventListener('scroll', onScroll);
        scroll.removeEventListener('keydown', onKey);
        scroll.removeEventListener('blur', onBlur);
        scroll.removeEventListener('focus', onFocus);
        hideTip();
        if (ro) ro.disconnect();
        if (crtBtn) crtBtn.removeEventListener('click', onCrt);
        document.removeEventListener('visibilitychange', onVis);
      },
      boxRect(bucketPath) {
        const R = L.boxes.find((x) => x.b.path === bucketPath);
        return R ? { x: (R.x + R.w / 2) * cw, y: (R.y + R.h / 2) * chh - scroll.scrollTop } : null;
      },
      projectRect(projectPath) {
        const R = L.projects.find((x) => x.p.path === projectPath);
        return R ? { x: (R.x + R.w / 2) * cw, y: (R.y + R.h / 2) * chh - scroll.scrollTop } : null;
      }
    };
  }

  /* ======================= page swaps ======================= */

  let navSeq = 0;
  let navBusy = false;
  let liveQueued = false;
  let pendingZoom = null;

  function focusKey() {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    return { id: el.id || '', href: el.getAttribute && el.getAttribute('href'), tag: el.tagName, value: el.value, start: el.selectionStart, end: el.selectionEnd };
  }

  function restoreFocus(key, fallbackHref) {
    let el = null;
    if (key && key.id) el = document.getElementById(key.id);
    if (!el && key && key.href) el = $$('main ' + key.tag.toLowerCase()).find((x) => x.getAttribute('href') === key.href) || null;
    if (!el && fallbackHref) el = $$('main [data-nav-item]').find((x) => x.getAttribute('href') === fallbackHref) || null;
    if (!el) return false;
    el.focus({ preventScroll: true });
    if (key && el.tagName === 'INPUT' && typeof key.value === 'string') {
      el.value = key.value;
      try { el.setSelectionRange(key.start, key.end); } catch (e) { /* not a text input */ }
    }
    return true;
  }

  function swap(parsed, opts) {
    const main = document.getElementById('main');
    const next = parsed.getElementById('main');
    if (!main || !next) return false;
    const key = focusKey();
    const oldView = (document.getElementById('app') || {}).dataset ? document.getElementById('app').dataset.view : '';
    const keep = mapView ? { project: mapView.project, scroll: mapView.scroll.scrollTop } : null;
    const feedScroll = ($('ol.feed') || {}).scrollTop || 0;
    const known = new Set($$('ol.feed li').map((li) => li.textContent));
    if (mapView) { mapView.destroy(); mapView = null; }
    main.innerHTML = next.innerHTML;
    const nav = $('.tmux-nav'), nextNav = parsed.querySelector('.tmux-nav');
    if (nav && nextNav) nav.innerHTML = nextNav.innerHTML;
    const stat = $('#server-status .label'), nextStat = parsed.querySelector('#server-status .label');
    if (stat && nextStat && !opts.keepStatus) stat.textContent = nextStat.textContent;
    document.title = parsed.title;
    const feed = $('ol.feed');
    if (feed) {
      feed.scrollTop = feedScroll;
      if (known.size) $$('ol.feed li').forEach((li) => { if (!known.has(li.textContent)) li.classList.add('fresh'); });
    }
    enhance();
    const app = document.getElementById('app');
    const data = readData();
    setupMap(data, opts.live || (app && app.dataset.view === oldView) ? keep : null);
    if (mapFull()) {
      const sc = document.getElementById('map-scroll');
      const inside = document.activeElement && document.activeElement.closest && document.activeElement.closest('#map-stage');
      if (sc && !inside) sc.focus({ preventScroll: true });
    }
    if (opts.live) restoreFocus(key);
    else if (!restoreFocus(key, opts.focusHref)) {
      const title = document.getElementById('view-title');
      if (opts.user && app && app.dataset.view !== oldView && title) { title.setAttribute('tabindex', '-1'); title.focus({ preventScroll: true }); }
    }
    if (opts.user && app && app.dataset.view !== oldView) window.scrollTo({ top: 0, behavior: 'auto' });
    return true;
  }

  /* replaces only some parts of the page, so a control the user holds (the timeline slider) stays in place */
  function swapParts(parsed, parts, focusHref) {
    const app = document.getElementById('app');
    const next = parsed.getElementById('app');
    if (!app || !next || app.dataset.view !== next.dataset.view || app.dataset.project !== next.dataset.project) return false;
    const pairs = parts.map((sel) => [document.querySelector(sel), parsed.querySelector(sel)]);
    if (pairs.some((p) => !p[0] || !p[1])) return false;
    const key = focusKey();
    pairs.forEach((p) => p[0].replaceWith(document.importNode(p[1], true)));
    const range = document.getElementById('tl-range'), nextRange = parsed.getElementById('tl-range');
    if (range && nextRange && document.activeElement !== range) {
      range.max = nextRange.max;
      range.value = nextRange.value;
    }
    if (range && nextRange) range.setAttribute('aria-valuetext', nextRange.getAttribute('aria-valuetext') || '');
    app.dataset.version = next.dataset.version;
    const nav = $('.tmux-nav'), nextNav = parsed.querySelector('.tmux-nav');
    if (nav && nextNav) nav.innerHTML = nextNav.innerHTML;
    document.title = parsed.title;
    enhance();
    if (key && key.id !== 'tl-range') restoreFocus(key, focusHref);
    return true;
  }

  async function navigate(url, opts) {
    opts = opts || {};
    if (S && url.charAt(0) === '#') url = fromHash(url);
    if (S) shownUrl = url;
    const seq = ++navSeq;
    navBusy = true;
    let ok = false;
    try {
      const text = await loadPage(url);
      if (seq !== navSeq) return false;
      const parsed = new DOMParser().parseFromString(text, 'text/html');
      if (opts.beforeSwap) await opts.beforeSwap();
      if (seq !== navSeq) return false;
      if (opts.push) history.pushState(null, '', shown(url));
      else if (opts.replace) history.replaceState(null, '', shown(url));
      ok = (opts.parts && swapParts(parsed, opts.parts, opts.focusHref)) || swap(parsed, { user: true, focusHref: opts.focusHref });
      if (ok && opts.timeline) animateTimeline();
      if (ok && opts.afterSwap) opts.afterSwap();
      if (ok && opts.announce !== false) B.announce(document.title.split(' · ').slice(0, 2).join(', '));
    } catch (e) {
      /* the live page loads the URL in full; a file has nothing to load, so it says what failed */
      if (seq === navSeq && !opts.silent) { if (S) console.error(e); else window.location.href = url; }
    } finally {
      if (seq === navSeq) {
        navBusy = false;
        if (liveQueued) { liveQueued = false; liveRefresh(); }
      }
    }
    return ok;
  }

  /* the feed, the windows and the status after an update that leaves this page's content as it is */
  async function feedRefresh(update) {
    const url = location.pathname + (location.search ? location.search + '&' : '?') + 'part=feed';
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok || navBusy) return;
      const part = await res.json();
      const feed = document.getElementById('feed');
      const known = new Set($$('ol.feed li').map((li) => li.textContent));
      const scrollTop = ($('ol.feed') || {}).scrollTop || 0;
      if (feed && part.feed) {
        const tpl = document.createElement('template');
        tpl.innerHTML = part.feed;
        const next = tpl.content.firstElementChild;
        if (next) feed.replaceWith(next);
        const list = $('ol.feed');
        if (list) {
          list.scrollTop = scrollTop;
          $$('ol.feed li').forEach((li) => { if (!known.has(li.textContent)) li.classList.add('fresh'); });
        }
      }
      const nav = $('.tmux-nav');
      if (nav && part.nav) nav.innerHTML = part.nav;
      setStatus('live', part.status);
      const app = document.getElementById('app');
      if (app) app.dataset.version = String(part.version);
      enhance();
      announceUpdate(update);
    } catch (e) {
      /* the next event retries */
    }
  }
  function announceUpdate(update) {
    if (!update || !update.events || !update.events.length) return;
    const important = update.events.filter((e) => e.kind !== 'file' && e.kind !== 'start');
    if (important.length) B.announce(important.slice(0, 3).map((e) => e.text).join('. ') + (important.length > 3 ? '. And ' + (important.length - 3) + ' more.' : '.'));
  }
  function stale(update) {
    if (!update || update.stale === undefined) return true;
    if (update.stale === '*') return true;
    const app = document.getElementById('app');
    return !app || update.stale.indexOf(app.dataset.view + '|' + app.dataset.project) >= 0;
  }

  async function liveRefresh(update) {
    if (update && !stale(update) && !navBusy) { feedRefresh(update); return; }
    const help = document.getElementById('help');
    if (navBusy || (help && help.open)) {
      liveQueued = true;
      if (help && help.open) help.addEventListener('close', () => { if (liveQueued) { liveQueued = false; liveRefresh(); } }, { once: true });
      return;
    }
    const url = here();
    try {
      const text = await loadPage(url);
      if (navBusy || url !== here()) return;
      const parsed = new DOMParser().parseFromString(text, 'text/html');
      if (navBusy || url !== here()) { liveQueued = true; return; }
      swap(parsed, { live: true });
      announceUpdate(update);
    } catch (e) {
      /* the next event retries */
    }
  }

  function zoomInto(url, rect) {
    if (!mapView || reduced || !mapView.canvas.animate || !rect) return navigate(url, { push: true });
    const canvas = mapView.canvas;
    canvas.style.transformOrigin = rect.x.toFixed(0) + 'px ' + rect.y.toFixed(0) + 'px';
    const out = canvas.animate([{ transform: 'scale(1)', opacity: 1, filter: 'brightness(1)' }, { transform: 'scale(5)', opacity: 0, filter: 'brightness(1.8)' }], { duration: 420, easing: 'cubic-bezier(0.55, 0, 0.8, 0.2)', fill: 'forwards' });
    pendingZoom = 'in';
    return navigate(url, { push: true, beforeSwap: () => out.finished.catch(() => {}), afterSwap: zoomArrive });
  }
  function zoomOut(url) {
    if (!mapView || reduced || !mapView.canvas.animate) return navigate(url, { push: true });
    const out = mapView.canvas.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.35)', opacity: 0 }], { duration: 320, easing: 'cubic-bezier(0.55, 0, 0.8, 0.2)', fill: 'forwards' });
    pendingZoom = 'out';
    return navigate(url, { push: true, beforeSwap: () => out.finished.catch(() => {}), afterSwap: zoomArrive });
  }
  function zoomArrive() {
    const dir = pendingZoom;
    pendingZoom = null;
    if (!mapView || !dir || reduced) return;
    const from = dir === 'in' ? 'scale(0.3)' : 'scale(2.6)';
    mapView.canvas.style.transformOrigin = '50% 30%';
    mapView.canvas.animate([{ transform: from, opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 360, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' });
  }

  /* ======================= events from the server ======================= */

  function setStatus(state, label) {
    const stat = document.getElementById('server-status');
    if (!stat) return;
    stat.dataset.state = state;
    const l = stat.querySelector('.label');
    if (l && label) l.textContent = label;
  }

  function connect() {
    if (S || typeof EventSource === 'undefined' || !B.events) return;
    let lost = false;
    const source = B.events('/api/events', {
      hello: (d) => {
        const app = document.getElementById('app');
        const version = app ? Number(app.dataset.version) : 0;
        if (lost || (d && d.version !== version)) liveRefresh();
        lost = false;
        setStatus('live');
      },
      update: (d) => liveRefresh(d)
    });
    source.addEventListener('error', () => {
      lost = true;
      setStatus('off', 'reconnecting');
    });
    source.addEventListener('open', () => setStatus('live'));
  }

  /* ======================= small enhancements after each swap ======================= */

  const timeFormat = (() => {
    try { return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { return null; }
  })();

  const dateFormat = (() => {
    try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return null; }
  })();
  function whenText(iso) {
    const d = new Date(iso);
    return dateFormat && !isNaN(d) ? dateFormat.format(d) : '';
  }

  /* ---- the map in fullscreen ---- */

  function mapFull() { return doc.classList.contains('map-full'); }
  function syncFull() {
    const b = document.getElementById('map-full');
    if (b) {
      const on = mapFull();
      b.setAttribute('aria-pressed', String(on));
      b.textContent = on ? 'Exit fullscreen' : 'Fullscreen';
    }
  }
  function refit() {
    requestAnimationFrame(() => requestAnimationFrame(() => { if (mapView && mapView.refit) mapView.refit(); }));
  }
  async function enterFull() {
    if (mapFull() || !document.getElementById('map-stage')) return;
    doc.classList.add('map-full');
    doc.dataset.full = 'overlay';
    syncFull();
    const scroll = document.getElementById('map-scroll');
    if (scroll) scroll.focus({ preventScroll: true });
    /* the whole document goes fullscreen, so following a link inside the map keeps it; without the API, or when the
       browser refuses, the map still covers the viewport inside the page */
    const gesture = !navigator.userActivation || navigator.userActivation.isActive;
    if (doc.requestFullscreen && !document.fullscreenElement && gesture) {
      try { await doc.requestFullscreen({ navigationUI: 'hide' }); if (mapFull()) doc.dataset.full = 'api'; } catch (e) { /* stays an overlay */ }
    }
    refit();
    B.announce('The map fills the screen. Escape or the Exit fullscreen button goes back.');
  }
  function exitFull(returnFocus) {
    if (!mapFull()) return;
    const api = doc.dataset.full === 'api';
    doc.classList.remove('map-full');
    delete doc.dataset.full;
    if (api && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    syncFull();
    refit();
    const b = document.getElementById('map-full');
    if (returnFocus && b) b.focus({ preventScroll: false });
    if (returnFocus) B.announce('The map is back in the page.');
  }
  document.addEventListener('fullscreenchange', () => {
    /* Escape in the browser's fullscreen mode ends it without a key event */
    if (!document.fullscreenElement && mapFull() && doc.dataset.full === 'api') exitFull(true);
    else refit();
  });
  document.addEventListener('click', (ev) => {
    if (!(ev.target.closest && ev.target.closest('#map-full'))) return;
    if (mapFull()) exitFull(true); else enterFull();
  });

  function enhance() {
    if (mapFull() && !document.getElementById('map-stage')) exitFull(false);
    syncFull();
    if (timeFormat) $$('ol.feed time[datetime]').forEach((t) => { const d = new Date(t.getAttribute('datetime')); if (!isNaN(d)) t.textContent = timeFormat.format(d); });
    $$('time[data-when]').forEach((t) => { const text = whenText(t.getAttribute('datetime')); if (text) t.textContent = text; });
    $$('#view-title').forEach((t) => t.setAttribute('tabindex', '-1'));
    /* on a phone the constellation scrolls sideways: start with the current project in view */
    $$('.constellation-scroll').forEach((pane) => {
      if (pane.scrollWidth <= pane.clientWidth) return;
      const node = pane.querySelector('.node.is-current') || pane.querySelector('.node');
      if (!node) return;
      const r = node.getBoundingClientRect(), p = pane.getBoundingClientRect();
      pane.scrollLeft = Math.max(0, pane.scrollLeft + (r.left + r.width / 2) - (p.left + p.width / 2));
    });
  }

  /* copy buttons, by delegation so swapped content works too */
  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest && ev.target.closest('[data-copy-id]');
    if (!btn) return;
    const target = document.getElementById(btn.dataset.copyId);
    if (!target) return;
    let ok = false;
    try { await navigator.clipboard.writeText(target.textContent.trim()); ok = true; } catch (e) { ok = false; }
    const label = btn.dataset.label || btn.textContent;
    btn.dataset.label = label;
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    B.announce(ok ? btn.dataset.copied || 'Copied the check message.' : 'Copy failed. Select the text and copy it by hand.');
    window.clearTimeout(Number(btn.dataset.timer || 0));
    btn.dataset.timer = String(window.setTimeout(() => { btn.textContent = btn.dataset.label; }, 1800));
  });

  /* links: swap instead of reloading */
  document.addEventListener('click', (ev) => {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const a = ev.target.closest && ev.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('data-more')) return;
    if (S && a.dataset.export) { ev.preventDefault(); saveFile(a.getAttribute('href')); return; }
    if (a.hasAttribute('download')) return;
    let href = a.getAttribute('href');
    if (S && href && href.charAt(0) === '#') {
      if (!isStateHash(href)) {
        /* an anchor such as the skip link: move there without touching the state in the hash */
        const target = document.getElementById(href.slice(1));
        if (target) { ev.preventDefault(); target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'start' }); }
        return;
      }
      href = fromHash(href);
    }
    if (!href || !href.startsWith('/') || href.startsWith('//') || href.startsWith('/assets/') || href.startsWith('/api/')) return;
    ev.preventDefault();
    if (a.closest('#tl-tracks') || a.id === 'tl-prev' || a.id === 'tl-next') {
      const target = new URL(href, location.href).searchParams.get('project') || '.';
      if (target === currentProject()) { stopPlay(); timelineGo(href, { push: true, replace: false, focusHref: a.hasAttribute('data-nav-item') ? href : undefined }); return; }
    }
    if (a.dataset.zoom && mapView) {
      zoomInto(href, mapView.projectRect(a.dataset.zoom) || { x: mapView.canvas.clientWidth / 2, y: mapView.canvas.clientHeight / 2 });
      return;
    }
    if ((a.dataset.kind === 'repo' || a.dataset.kind === 'project') && mapView && !a.hasAttribute('aria-current')) {
      const app = document.getElementById('app');
      const target = new URL(href, location.href).searchParams.get('project') || '.';
      if (app && target !== app.dataset.project) { zoomOut(href); return; }
    }
    navigate(href, { push: true, focusHref: a.hasAttribute('data-nav-item') ? href : undefined });
  });

  window.addEventListener('popstate', () => navigate(here(), { announce: false }));
  /* in a file, a hash typed in the address bar or a link from outside changes the state too; going back fires both
     events, and the second one finds the page already current */
  let shownUrl = S ? '/' : '';
  if (S) {
    window.addEventListener('hashchange', () => {
      if (isStateHash(location.hash) && here() !== shownUrl) navigate(here(), { announce: false });
    });
  }

  /* a download of a file: the SVG or Mermaid export made in the browser, saved through a link to a blob */
  function saveFile(link) {
    const file = S.file(link);
    if (!file) return;
    const url = URL.createObjectURL(new Blob([file.text], { type: file.type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    B.announce('Saved ' + file.name + '.');
  }

  /* search: submit and type-ahead */
  let searchTimer = 0;
  document.addEventListener('submit', (ev) => {
    const form = ev.target;
    if (!form || (form.id !== 'search-form' && !form.hasAttribute('data-swap'))) return;
    ev.preventDefault();
    const params = new URLSearchParams(new FormData(form));
    if (!params.get('q')) params.delete('q');
    for (const [k, v] of Array.from(params.entries())) if (v === '') params.delete(k);
    navigate('/?' + params.toString(), { push: true, focusHref: undefined });
  });
  function formUrl(form) {
    const params = new URLSearchParams(new FormData(form));
    for (const [k, v] of Array.from(params.entries())) if (v === '') params.delete(k);
    params.delete('all');
    if (params.get('view') === 'map') params.delete('view');
    const q = params.toString();
    return q ? '/?' + q : '/';
  }
  /* the symbol search and the filters of the tree and the matrix follow the typing, a little after the last key */
  document.addEventListener('input', (ev) => {
    const input = ev.target;
    if (!input || input.tagName === 'SELECT' || (input.id !== 'q' && !(input.hasAttribute && input.hasAttribute('data-live')))) return;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      if (input.form) navigate(formUrl(input.form), { replace: true, announce: false });
    }, 160);
  });
  document.addEventListener('change', (ev) => {
    const select = ev.target;
    if (!select || select.tagName !== 'SELECT' || !select.hasAttribute('data-live') || !select.form) return;
    navigate(formUrl(select.form), { replace: true, announce: false }).then(() => {
      const count = document.getElementById(select.id === 'mf' ? 'matrix-count' : 'tree-count');
      if (count) B.announce(count.textContent.trim());
    });
  });

  /* "Show N more": the rest of a long list waits in a template and goes in a few hundred rows per frame */
  document.addEventListener('click', (ev) => {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const a = ev.target.closest && ev.target.closest('a[data-more]');
    if (!a) return;
    ev.preventDefault();
    const tpl = document.getElementById('more-' + a.dataset.more);
    const list = document.getElementById(a.getAttribute('aria-controls') || '');
    if (!tpl || !list || !tpl.content) { navigate(a.getAttribute('href'), { push: true }); return; }
    const nodes = Array.from(tpl.content.childNodes);
    const items = nodes.filter((n) => n.nodeType === 1).length;
    const first = nodes.find((n) => n.nodeType === 1);
    const row = a.closest('.more-row');
    history.replaceState(null, '', a.getAttribute('href'));
    let i = 0;
    const step = () => {
      const frag = document.createDocumentFragment();
      for (let k = 0; k < 200 && i < nodes.length; k++, i++) frag.appendChild(nodes[i]);
      list.appendChild(frag);
      if (i < nodes.length) { requestAnimationFrame(step); return; }
      tpl.remove();
      if (row) row.remove();
    };
    step();
    /* focus moves to the first new item, or its first link, so the keyboard continues where the list grew */
    let target = first && (first.matches('a, button, [tabindex]') ? first : first.querySelector('a, button, [tabindex]'));
    if (!target && first) { first.setAttribute('tabindex', '-1'); target = first; }
    if (target) target.focus({ preventScroll: true });
    B.announce('Showing ' + items + ' more.');
  });

  /* keyboard */
  function currentView() { const app = document.getElementById('app'); return app ? app.dataset.view : 'map'; }
  function currentProject() { const app = document.getElementById('app'); return app ? app.dataset.project : '.'; }
  function viewUrl(view, extra) {
    const params = new URLSearchParams();
    if (view !== 'map') params.set('view', view);
    const project = currentProject();
    if (project !== '.') params.set('project', project);
    const now = new URLSearchParams(here().split('?')[1] || '');
    if ((view === 'map' || view === 'matrix' || view === 'impact') && now.get('bucket')) params.set('bucket', now.get('bucket'));
    if (extra) for (const k of Object.keys(extra)) params.set(k, extra[k]);
    const q = params.toString();
    return q ? '/?' + q : '/';
  }
  function moveSelection(step) {
    const items = $$('.main-col [data-nav-item]');
    if (!items.length) return;
    let i = items.findIndex((x) => x.getAttribute('aria-current') === 'true' || x.getAttribute('aria-current') === 'page');
    if (i < 0) i = items.indexOf(document.activeElement);
    const next = items[clamp(i < 0 ? (step > 0 ? 0 : items.length - 1) : i + step, 0, items.length - 1)];
    if (!next) return;
    const href = next.getAttribute('href');
    navigate(href, { replace: true, focusHref: href, announce: false }).then(() => {
      const label = (document.querySelector('[aria-current="true"][data-nav-item]') || {}).textContent;
      if (label) B.announce(label.trim());
    });
  }
  function openHelp() {
    const help = document.getElementById('help');
    if (help && typeof help.showModal === 'function' && !help.open) help.showModal();
  }
  document.addEventListener('click', (ev) => {
    if (ev.target.closest && ev.target.closest('#help-open')) openHelp();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) {
      if (ev.key === 'Escape' && t.id === 'q') t.blur();
      return;
    }
    const help = document.getElementById('help');
    if (help && help.open) return;
    if (ev.key === 'Escape' && mapFull()) { ev.preventDefault(); exitFull(true); return; }
    switch (ev.key) {
      case 'f': if (document.getElementById('map-stage')) { ev.preventDefault(); if (mapFull()) exitFull(true); else enterFull(); } break;
      case '/': {
        ev.preventDefault();
        const q = document.getElementById('q');
        if (q) { q.focus(); q.select(); }
        else navigate(viewUrl('trace'), { push: true }).then(() => { const input = document.getElementById('q'); if (input) input.focus(); });
        break;
      }
      case 'j': moveSelection(1); break;
      case 'k': moveSelection(-1); break;
      case 'm': navigate(viewUrl(currentView() === 'map' ? 'matrix' : 'map'), { push: true }); break;
      case 'g': navigate(viewUrl('projects'), { push: true }); break;
      case 'a': navigate(viewUrl('approvals'), { push: true }); break;
      case 't': navigate(viewUrl('timeline'), { push: true }).then((ok) => { if (ok) animateTimeline(); }); break;
      case 'i': navigate(viewUrl('impact'), { push: true }); break;
      case '[': case ']': {
        const link = document.getElementById(ev.key === '[' ? 'tl-prev' : 'tl-next');
        if (link && link.tagName === 'A') { ev.preventDefault(); link.click(); }
        break;
      }
      case 'p': if (currentView() === 'timeline') { ev.preventDefault(); togglePlay(); } break;
      case '?': ev.preventDefault(); openHelp(); break;
      case 'u': {
        const crumbs = $$('#crumbs a');
        const i = crumbs.findIndex((a) => a.hasAttribute('aria-current'));
        const target = i > 0 ? crumbs[i - 1] : null;
        if (target) target.click();
        break;
      }
      case 'Escape': {
        const close = $$('#panel a').find((a) => a.textContent.trim() === 'Close');
        if (close) close.click();
        break;
      }
      default:
    }
  });

  /* ======================= timeline: slider, play, film ======================= */

  const TIMELINE_PARTS = ['#tl-tracks', '#tl-label', '#tl-prev', '#tl-next', '#tl-stage', '#panel', '#tl-data'];
  let playTimer = 0;
  let slideTimer = 0;

  function timelineData() {
    const el = document.getElementById('tl-data');
    if (!el) return null;
    try { return JSON.parse(el.textContent || 'null'); } catch (e) { return null; }
  }
  function timelineUrl(data, i) {
    const point = data && data.points[i];
    if (!point) return null;
    const u = new URL(data.base, location.href);
    u.searchParams.set('at', point.id);
    return u.pathname + u.search;
  }
  function timelineGo(url, opts) {
    return navigate(url, Object.assign({ replace: true, parts: TIMELINE_PARTS, announce: false, timeline: true }, opts || {}));
  }
  /* the film plays once for each approval the user moves to; live updates redraw without it */
  function animateTimeline() {
    const map = document.getElementById('tl-map');
    if (!map || reduced) return;
    map.classList.remove('tl-anim');
    void map.offsetWidth;
    map.classList.add('tl-anim');
  }
  function stopPlay() {
    if (playTimer) { window.clearInterval(playTimer); playTimer = 0; }
    const btn = document.getElementById('tl-play');
    if (btn) { btn.setAttribute('aria-pressed', 'false'); btn.textContent = 'Play'; }
  }
  function step(range, value) {
    range.value = String(value);
    range.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function togglePlay() {
    const btn = document.getElementById('tl-play');
    const range = document.getElementById('tl-range');
    if (!btn || !range || range.disabled) return;
    if (playTimer) { stopPlay(); B.announce('Paused.'); return; }
    if (Number(range.value) >= Number(range.max)) step(range, 0);
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = 'Pause';
    B.announce('Playing the approvals.');
    playTimer = window.setInterval(() => {
      const r = document.getElementById('tl-range');
      const b = document.getElementById('tl-play');
      if (!r || !b || currentView() !== 'timeline') { stopPlay(); return; }
      b.setAttribute('aria-pressed', 'true');
      b.textContent = 'Pause';
      const next = Number(r.value) + 1;
      if (next > Number(r.max)) { stopPlay(); B.announce('Reached the newest approval.'); return; }
      step(r, next);
    }, 1500);
  }
  document.addEventListener('click', (ev) => {
    if (ev.target.closest && ev.target.closest('#tl-play')) togglePlay();
  });
  document.addEventListener('input', (ev) => {
    const range = ev.target;
    if (!range || range.id !== 'tl-range') return;
    const data = timelineData();
    if (!data) return;
    const i = Number(range.value);
    const point = data.points[i];
    if (!point) return;
    const label = document.getElementById('tl-label');
    const strong = label && label.querySelector('strong');
    if (strong) strong.textContent = String(i + 1);
    const date = label && label.querySelector('time');
    if (date) { date.setAttribute('datetime', point.date); date.textContent = whenText(point.date) || point.when; }
    range.setAttribute('aria-valuetext', point.label);
    window.clearTimeout(slideTimer);
    slideTimer = window.setTimeout(() => {
      const url = timelineUrl(data, i);
      if (url && url !== here()) timelineGo(url);
    }, 90);
  });
  document.addEventListener('pointerdown', (ev) => { if (ev.target && ev.target.id === 'tl-range') stopPlay(); });

  enhance();
  /* a file opens on the map; a link into another view of it renders that view in place */
  if (S && here() !== '/') navigate(here(), { announce: false });
  else {
    setupMap(readData(), null);
    animateTimeline();
  }
  connect();
})();
`;
