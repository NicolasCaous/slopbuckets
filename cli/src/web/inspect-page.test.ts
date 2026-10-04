import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { linkCommand } from '../commands/link.js';
import { buildSnapshot, type InspectSnapshot } from '../inspect/snapshot.js';
import { cleanupProjects, LOGGER_PROJECT, makeProject, writeFile } from '../testing/fixture.js';
import { approve, fakeIo, testContext } from '../testing/harness.js';
import { feedEvent } from '../inspect/events.js';
import { CONTENT_SECURITY_POLICY } from './server.js';
import { largeSnapshot } from '../testing/large-snapshot.js';
import { html } from './html.js';
import {
  cappedList,
  clean,
  defaultState,
  href,
  mapData,
  mapView,
  parseState,
  renderApprovalsView,
  renderInspectPage,
  renderMapView,
  renderMatrixView,
  renderProjectsView,
  renderTraceView,
  symbolGroups,
  type InspectState,
  type PageInput,
} from './inspect-page.js';

const NESTED = 'root/log/_/engine';

/** A project with a cycle-free contract chain, an orphan, a forbidden import, a lock difference, a nested project and a link. */
async function richProject(): Promise<string> {
  const dir = makeProject({
    ...LOGGER_PROJECT,
    [`${NESTED}/buckets.config.json`]: '{ "root": "root", "alias": "@engine" }\n',
    [`${NESTED}/package.json`]: '{ "name": "engine" }\n',
    [`${NESTED}/root/_/run.ts`]: 'export const run = 1;\n',
    [`${NESTED}/root/core/_/engine.ts`]: 'export interface Engine {\n  name: string;\n}\n',
    [`${NESTED}/root/dmz/core/.external.ts`]: "export type { Engine } from '@engine/core/_/engine';\n",
    'root/web/_/app.ts': "import type { Engine } from '@engine/dmz/core/.external';\nexport const name = (e: Engine): string => e.name;\n",
  });
  await linkCommand(testContext(), fakeIo({ cwd: dir }), ['add', 'engine', NESTED, '--bucket', 'root/web', '--copy']);
  await approve(dir);
  await approve(path.join(dir, NESTED));
  writeFile(dir, 'root/log/_/logger.ts', 'export function logger(message: string, level: number): void {}\n');
  writeFile(dir, 'root/dmz/log/web.ts', "export { logger } from '@root/log/_/logger';\n");
  writeFile(dir, 'root/billing/payments/_/pay.ts', "import { billing } from '@root/billing/_/billing.module';\nexport const pay = billing;\n");
  return dir;
}

let snapshot: InspectSnapshot;
beforeAll(async () => {
  snapshot = await buildSnapshot(testContext(), await richProject(), { now: new Date('2026-10-04T12:00:00.000Z') });
});
afterAll(cleanupProjects);

function input(state: Partial<InspectState> = {}): PageInput {
  return {
    token: 'tok',
    snapshot,
    feed: [feedEvent('violation-added', '.', 'Violation appeared: <b>bad</b>', new Date('2026-10-04T12:00:00.000Z'))],
    version: 3,
    state: { ...defaultState(), ...state },
    watch: 'native',
  };
}


describe('state in the URL', () => {
  it('reads only what the snapshot knows', () => {
    const url = new URL('http://127.0.0.1/?view=matrix&project=nope&bucket=root/log&cell=root/dmz/log/billing.ts&q=log&v=zzz&link=x');
    expect(parseState(url, snapshot)).toEqual({ ...defaultState(), view: 'matrix', bucket: 'root/log', cell: 'root/dmz/log/billing.ts', q: 'log' });
    expect(parseState(new URL('http://127.0.0.1/?view=evil'), snapshot).view).toBe('map');
    expect(parseState(new URL(`http://127.0.0.1/?project=${encodeURIComponent(NESTED)}`), snapshot).project).toBe(NESTED);
  });

  it('builds links that leave defaults out and survive a round trip', () => {
    expect(href(defaultState())).toBe('/');
    const state: InspectState = { ...defaultState(), view: 'trace', symbol: 'logger', of: 'root/log/_/logger.ts', q: 'lo' };
    const link = href(state);
    expect(link).toBe('/?view=trace&symbol=logger&of=root%2Flog%2F_%2Flogger.ts&q=lo');
    expect(parseState(new URL(link, 'http://127.0.0.1'), snapshot)).toEqual(state);
  });
});

describe('inspect page', () => {
  it('renders a full page with the shared shell, the token and the map data', () => {
    const page = renderInspectPage(input());
    expect(page).toContain('<meta name="buckets-token" content="tok">');
    expect(page).toContain('/assets/inspect.css');
    expect(page).toContain('/assets/inspect.js');
    expect(page).toContain('aria-current="page"><span class="n" aria-hidden="true">0:</span>map</a>');
    expect(page).toContain('approvals 1');
    expect(page).toMatch(/<script type="application\/json" id="inspect-data">\{.*\}<\/script>/s);
    expect(page).not.toMatch(/<script>(?!<\/script>)/);
    expect(page).not.toMatch(/ style="/);
    expect(page).toContain('Violation appeared: &#60;b&#62;bad&#60;/b&#62;');
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
  });

  it('keeps project text out of the JSON block markup', () => {
    const data = JSON.stringify(mapData(snapshot, defaultState(), 1));
    expect(data).toContain('"project":"."');
    const page = renderInspectPage(input());
    const block = /id="inspect-data">(.*?)<\/script>/s.exec(page)![1]!;
    expect(block).not.toContain('<');
    expect(JSON.parse(block).buckets.length).toBe(snapshot.projects[0]!.buckets.length);
  });

  it('map: canvas, bucket tree with nested projects, and violations with copy buttons', () => {
    const html = renderMapView(input()).value;
    expect(html).toContain('<canvas class="map-canvas" id="map-canvas" role="img"');
    expect(html).toContain('<ul class="tree"');
    expect(html).toContain(`data-zoom="${NESTED}"`);
    expect(html).toContain('href="/?bucket=root%2Fbilling%2Finvoices"');
    expect(html).toMatch(/class="violation k-orphan"/);
    expect(html).toMatch(/class="violation k-forbidden"/);
    expect(html).toContain('data-copy-id="msg-');
    const data = mapData(snapshot, { ...defaultState(), bucket: 'root/log' }, 1) as { selected: string; overlays: { orphans: unknown[]; forbidden: { from: string; to: string }[] } };
    expect(data.selected).toBe('root/log');
    expect(data.overlays.orphans).toHaveLength(1);
    expect(data.overlays.forbidden).toEqual([expect.objectContaining({ from: 'root/billing/payments', to: 'root/billing' })]);
  });

  it('map: a selected bucket fills the side panel with offers, dependents and rewrite cost', () => {
    const page = renderInspectPage(input({ bucket: 'root/log' }));
    expect(page).toContain('id="panel"');
    expect(page).toContain('to honor');
    expect(page).toMatch(/<h3 class="sub3">Offers <span class="dim">\d+<\/span><\/h3>\s*<ul class="plain"[^>]*><li><a href="\/\?view=matrix&#38;bucket=root%2Flog&#38;cell=root%2Fdmz%2Flog%2Fbilling.ts"/);
    expect(page).toContain('<h3 class="sub3">Dependents</h3>');
    expect(page).toContain(`>${'engine'}</a>`);
  });

  it('matrix: one table per DMZ folder, counts as links, .self, .parent and .external columns', () => {
    const html = renderMatrixView(input()).value;
    expect(html).toContain('<table class="mx">');
    expect(html).toContain('root/billing/dmz/');
    expect(html).toContain('>.external</th>');
    expect(html).toContain('>.parent</th>');
    expect(html).toMatch(/class="count s-lock" href="\/\?view=matrix&#38;cell=root%2Fdmz%2Flog%2Fbilling.ts"/);
    expect(html).toMatch(/class="count s-violation" href="\/\?view=matrix&#38;cell=root%2Fdmz%2Flog%2Fweb.ts"/);
  });

  it('matrix: a selected cell shows symbols with signatures and chains', () => {
    const page = renderInspectPage(input({ view: 'matrix', cell: 'root/billing/dmz/.parent/invoices.ts' }));
    expect(page).toContain('export function logger(message: string, level: number): void');
    expect(page).toContain('<ol class="chain"');
    expect(page).toContain('signature changed');
  });

  it('trace: search results and the chain tree with importers', () => {
    const groups = symbolGroups(snapshot);
    expect(groups.map((g) => g.name)).toContain('logger');
    const logger = groups.find((g) => g.name === 'logger')!;
    expect(logger.carriers.map((c) => c.contract.file).sort()).toEqual(['root/billing/dmz/.parent/invoices.ts', 'root/dmz/log/billing.ts', 'root/dmz/log/web.ts']);
    const html = renderTraceView(input({ view: 'trace', q: 'log', symbol: 'logger', of: 'root/log/_/logger.ts' })).value;
    expect(html).toContain('<input type="search" id="q" name="q" value="log"');
    expect(html).toContain('class="trace-tree pulse"');
    expect(html).toContain('root/billing/invoices/_/create-invoice.ts:1');
    expect(html).toContain('orphan');
    expect(renderTraceView(input({ view: 'trace', q: 'zzz' })).value).toContain('No symbol matches.');
  });

  it('projects: constellation with project nodes and link edges, and public surfaces', () => {
    const html = renderProjectsView(input({ view: 'projects' })).value;
    expect(html).toContain('<svg class="constellation"');
    expect(html).toMatch(/class="edge m-copy st-ok"/);
    expect(html).toContain('Link engine: repo uses root/log/_/engine, copy mode, in sync');
    expect(html).toContain('root/dmz/core/.external.ts');
    expect(html).toContain('Consumed by');
    const page = renderInspectPage(input({ view: 'projects', link: 'root/web/_/links/engine' }));
    expect(page).toContain('Published symbols');
    expect(page).toContain('@engine/dmz/core/.external');
    expect(page).toContain('root/web/_/app.ts:1');
  });

  it('link panel: marks the published symbols that differ from the approved lock with a sign and words, like the approvals page', () => {
    const top = snapshot.projects[0]!;
    const link = top.links[0]!;
    const marked = structuredClone(snapshot);
    marked.projects[0]!.links[0]!.symbols = [
      { ...link.symbols[0]!, name: 'Engine', change: 'changed' },
      { ...link.symbols[0]!, name: 'Fresh', change: 'added' },
      { ...link.symbols[0]!, name: 'Gone', change: 'removed' },
      { ...link.symbols[0]!, name: 'Same' },
    ];
    const page = renderInspectPage({ ...input({ view: 'projects', link: link.path }), snapshot: marked });
    expect(page).toContain('3 published symbols differ from the approved lock.');
    expect(page).toMatch(/<li class="chg"><span aria-hidden="true">~ <\/span><code translate="no">Engine<\/code> <span class="tag">type<\/span> <span class="dim">signature changed<\/span>/);
    expect(page).toMatch(/<li class="add"><span aria-hidden="true">\+ <\/span><code translate="no">Fresh<\/code>.*published, not approved yet/);
    expect(page).toMatch(/<li class="del"><span aria-hidden="true">- <\/span><code translate="no">Gone<\/code>.*no longer published/);
    expect(page).toMatch(/<li><code translate="no">Same<\/code>/);
    // An unchanged link has no marks and no summary.
    expect(renderInspectPage(input({ view: 'projects', link: link.path }))).not.toContain('differ from the approved lock');
  });

  it('approvals: grouped by project, with the refresh --web explanation and no form', () => {
    const html = renderApprovalsView(input({ view: 'approvals' })).value;
    expect(html).toContain('It never approves anything.');
    expect(html).toContain('buckets refresh --web');
    expect(html).toContain('signature-changed');
    expect(html).toContain('refuses to approve until every rule passes');
    expect(html).not.toContain('<form');
  });

  it('shows the check message of a project the check could not run on', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const broken = await buildSnapshot(testContext({ analyzeError: new Error('boom <x>') }), dir);
    const page = renderInspectPage({ ...input(), snapshot: broken });
    expect(page).toContain('The check could not run');
    expect(page).toContain('boom &#60;x&#62;');
  });
});

describe('phase 2 state and views', () => {
  it('keeps the approval and the simulation inputs in the URL', () => {
    const at = 'a'.repeat(40);
    const state: InspectState = { ...defaultState(), view: 'timeline', project: NESTED, at };
    expect(href(state)).toBe(`/?view=timeline&project=${encodeURIComponent(NESTED)}&at=${at}`);
    expect(parseState(new URL(href(state), 'http://127.0.0.1'), snapshot)).toEqual(state);
    expect(parseState(new URL('http://127.0.0.1/?view=timeline&at=<x>'), snapshot).at).toBeNull();
    const route = parseState(new URL('http://127.0.0.1/?view=impact&sim=path&pick=root%2Flog%2F_%2Flogger.ts%3A%3Alogger&to=root%2Fbilling%2Fpayments'), snapshot);
    expect(route).toMatchObject({ view: 'impact', sim: 'path', symbol: 'logger', of: 'root/log/_/logger.ts', to: 'root/billing/payments' });
    expect(href(route)).toBe('/?view=impact&symbol=logger&of=root%2Flog%2F_%2Flogger.ts&sim=path&to=root%2Fbilling%2Fpayments');
    const published = parseState(new URL(`http://127.0.0.1/?view=impact&sim=external&pick=${encodeURIComponent(`${NESTED}::root/dmz/core/.external.ts::Engine`)}`), snapshot);
    expect(published).toMatchObject({ project: NESTED, sim: 'external', cell: 'root/dmz/core/.external.ts', symbol: 'Engine' });
    expect(parseState(new URL('http://127.0.0.1/?view=impact&sim=nope&to=root%2Fzzz'), snapshot)).toMatchObject({ sim: null, to: null });
  });

  it('lists the new windows and keys, and offers the exports on the map and the projects view', () => {
    const page = renderInspectPage(input());
    expect(page).toContain('<span class="n" aria-hidden="true">5:</span>timeline</a>');
    expect(page).toContain('<span class="n" aria-hidden="true">6:</span>impact</a>');
    expect(page).toContain('<dt><kbd>t</kbd></dt><dd>timeline of approvals</dd>');
    expect(page).toContain('<dt><kbd>[</kbd> <kbd>]</kbd></dt>');
    expect(page).toContain('<dt><kbd>i</kbd></dt><dd>impact simulation</dd>');
    expect(page).toContain('href="/export/map.svg" download data-export="svg"');
    const nested = renderInspectPage(input({ project: NESTED }));
    expect(nested).toContain(`href="/export/map.svg?project=${encodeURIComponent(NESTED)}" download`);
    expect(renderProjectsView(input({ view: 'projects' })).value).toContain('href="/export/buckets.mmd" download');
  });

  it('explains a missing timeline and renders the simulation forms as GET forms', () => {
    const none = renderInspectPage({ ...input({ view: 'timeline' }), timeline: { tracks: [{ project: '.', name: 'fixture', status: 'not-repo', message: 'The project is not in a git repository, so there is no history of the lock to show.', points: [], truncated: false, repo: null }] } });
    expect(none).toContain('There is no timeline to show.');
    expect(none).toContain('not in a git repository');
    const impact = renderInspectPage(input({ view: 'impact' }));
    expect(impact).toContain('<form class="sim-form" method="get" action="/" data-swap>');
    expect(impact).toContain('aria-current="page">Remove a bucket</a>');
    expect(impact).not.toMatch(/ style="/);
    const external = renderInspectPage(input({ view: 'impact', sim: 'external', project: NESTED, cell: 'root/dmz/core/.external.ts', symbol: 'Engine' }));
    expect(external).toContain('Other projects');
    expect(external).toContain('root/web/_/app.ts:1');
  });
});

describe('large projects', () => {
  const large = largeSnapshot();
  const big = (state: Partial<InspectState> = {}): PageInput => ({ ...input(state), snapshot: large });

  it('keeps the map layout, the dependency lines and the filters in the URL, and keeps them when following links', () => {
    const state: InspectState = { ...defaultState(), bucket: 'root/wide', layout: 'all', deps: true, tq: 'wid', tf: 'problems', mq: 's3', mf: 'pending', table: 'root/wide', all: 'violations' };
    const link = href(state);
    expect(link).toBe('/?bucket=root%2Fwide&layout=all&deps=1&tq=wid&tf=problems&mq=s3&mf=pending&table=root%2Fwide&all=violations');
    expect(parseState(new URL(link, 'http://127.0.0.1'), large)).toEqual(state);
    expect(parseState(new URL('http://127.0.0.1/?layout=evil&tf=x&table=root/nope&all=a%20b'), large)).toEqual(defaultState());
    // A link to another bucket keeps the display choices but not the expanded list.
    expect(href(clean(state, { view: 'map' }), { bucket: 'root/small' })).toBe('/?bucket=root%2Fsmall&layout=all&deps=1&tq=wid&tf=problems&mq=s3&mf=pending&table=root%2Fwide');
  });

  it('map: one level at a time, drilling into the selected bucket, with subtree counts on collapsed boxes', () => {
    const top = mapView(large, defaultState(), 1);
    expect(top.mode).toBe('level');
    expect(top.focus).toBe('root');
    expect(top.data.buckets.map((b) => b.path)).toEqual(['root', 'root/small', 'root/wide']);
    const small = top.data.buckets[1]!;
    expect(small).toMatchObject({ children: [], inside: 3, situation: 'violation', violations: 2, lockChanges: 1 });
    // No text inside the box: the edge ticks count the related buckets, the tooltip has the numbers.
    expect(small.lines).toBeUndefined();
    expect(small).toMatchObject({ ins: 0, outs: 0, cin: 0, cout: 0 });
    expect(small.href).toBe('/?bucket=root%2Fsmall');

    const wide = mapView(large, { ...defaultState(), bucket: 'root/wide/s7' }, 1);
    expect(wide.focus).toBe('root/wide');
    expect(wide.data.buckets).toHaveLength(51);
    expect(wide.data.selected).toBe('root/wide/s7');
    // The outer frame goes one level up.
    expect(wide.data.buckets[0]!.href).toBe('/?bucket=root');
    expect(wide.data.showDeps).toBe(false);
  });

  it('map: violation lines between the boxes that hold their buckets, with a note for each collapsed end', () => {
    const top = mapView(large, defaultState(), 1);
    expect(top.data.overlays.cycles).toEqual([]);
    expect(top.data.overlays.forbidden).toEqual([expect.objectContaining({ id: 'v2', from: 'root/small', to: 'root/wide' })]);
    expect(top.data.overlays.orphans).toEqual([]);
    expect(top.notes).toEqual([
      { id: 'v1', kind: 'cycle', buckets: ['root/small/a', 'root/small/b'], drawn: false, hidden: 'inside', open: 'root/small' },
      { id: 'v2', kind: 'forbidden', buckets: ['root/small/b', 'root/wide/s1'], drawn: true, open: 'root' },
    ]);
    const inside = mapView(large, { ...defaultState(), bucket: 'root/small' }, 1);
    expect(inside.data.overlays.cycles).toEqual([{ id: 'v1', buckets: ['root/small/a', 'root/small/b', 'root/small/a'] }]);
    expect(inside.notes).toEqual([{ id: 'v2', kind: 'forbidden', buckets: ['root/small/b', 'root/wide/s1'], drawn: false, hidden: 'outside', open: 'root' }]);
    const page = renderMapView(big()).value;
    expect(page).toContain('is inside one box at this level, so no line is drawn.');
    expect(page).toContain('href="/?bucket=root%2Fsmall&#38;v=v1">Open small</a>');
  });

  it('map: show all switches to a treemap of every bucket, colored by the worst situation below', () => {
    const all = mapView(large, { ...defaultState(), layout: 'all' }, 1);
    expect(all.mode).toBe('treemap');
    expect(all.data.mode).toBe('treemap');
    expect(all.data.buckets).toHaveLength(large.projects[0]!.buckets.length);
    expect(all.data.buckets.find((b) => b.path === 'root/small')!.situation).toBe('violation');
    const page = renderMapView(big({ layout: 'all' })).value;
    expect(page).toContain('<a href="/?layout=all" aria-current="true">Show all</a>');
    expect(page).toContain('<a href="/">One level</a>');
    expect(page).toContain('data-mode="treemap"');
  });

  it('map: the bucket tree is the navigation, collapsible, filtered and counted per subtree', () => {
    const page = renderMapView(big({ bucket: 'root/wide/s7' })).value;
    expect(page).toContain('<form class="filters" method="get" action="/" role="search" aria-label="Filter the buckets" data-swap>');
    expect(page).toContain('<input type="hidden" name="bucket" value="root/wide/s7">');
    expect(page).toContain('<ul class="tree-nav" aria-label="Buckets of large">');
    // The path to the selected bucket is open, the rest is closed.
    expect(page).toMatch(/small\/<\/a><span class="meta">3 inside, 2 violations, 1 pending<\/span><\/span><details><summary>/);
    expect(page).toMatch(/wide\/<\/a><span class="meta">50 inside<\/span><\/span><details open>/);
    expect(page).toContain('aria-current="true" data-nav-item translate="no">s7/</a>');
    const filtered = renderMapView(big({ tf: 'problems' })).value;
    expect(filtered).toContain('1 bucket of 56 match');
    expect(filtered).toContain('>b/</a>');
    expect(filtered).not.toContain('>s7/</a>');
    expect(renderMapView(big({ tq: 'zzz' })).value).toContain('No bucket matches.');
  });

  it('matrix: sparse tables, a list by provider for a folder too wide, and a switch back to the table', () => {
    const page = renderMatrixView(big()).value;
    expect(page).toContain('<form class="filters" method="get" action="/" role="search" aria-label="Filter the contracts" data-swap>');
    expect(page).toContain('<table class="mx-list">');
    expect(page).toContain('too many for a readable table');
    expect(page).toContain('<a class="btn btn-mini" href="/?view=matrix&#38;table=root%2Fwide">Show as a table</a>');
    // The list keeps the cell links.
    expect(page).toContain('href="/?view=matrix&#38;cell=root%2Fwide%2Fdmz%2Fs0%2Fs1.ts"');
    // A long list shows 40 rows and keeps the rest for "Show N more".
    expect(page).not.toContain('data-more=');
    const longer = renderMatrixView({ ...big(), snapshot: largeSnapshot(80) }).value;
    expect(longer).toContain('data-more="mx-root_wide" aria-controls="list-mx-root_wide">Show 39 more contracts</a>');
    const table = renderMatrixView(big({ table: 'root/wide' })).value;
    expect(table).toContain('<table class="mx">');
    expect(table).toContain('Show as a list</a>');
    const pending = renderMatrixView(big({ mf: 'pending' })).value;
    expect(pending).toContain('1 contract of 51 match, in 1 DMZ folder.');
    expect(pending).not.toContain('root/small/dmz/');
  });

  it('long lists keep the rest in a template behind a link that works without the script', () => {
    const items = Array.from({ length: 30 }, (_, i) => html`<li>${String(i)}</li>`);
    const list = cappedList({ items, cap: 10, key: 'demo', state: defaultState(), cls: 'plain', noun: 'items' }).value;
    expect(list).toContain('<ul class="plain" id="list-demo"><li>0</li>');
    expect(list).toContain('<template id="more-demo"><li>10</li>');
    expect(list).toContain('<a class="btn btn-mini" href="/?all=demo" data-more="demo" aria-controls="list-demo">Show 20 more items</a>');
    expect(cappedList({ items, cap: 10, key: 'demo', state: { ...defaultState(), all: 'demo' } }).value).not.toContain('<template');
  });

  it('map: a selected bucket gets the legend of its labels and the map a tooltip region', () => {
    const page = renderMapView(big({ bucket: 'root/wide/s7' })).value;
    expect(page).toContain('<ul class="legend tag-legend" aria-label="Labels of the selection">');
    expect(page).toContain('<span class="t t-sel" aria-hidden="true">● s7/</span>selected');
    expect(page).toContain('depends on <span class="dim">0</span>');
    expect(page).toContain('<div class="map-tip" id="map-tip" role="tooltip" hidden></div>');
    expect(page).toContain('the arrow keys move between boxes and Enter opens one');
    expect(renderMapView(big()).value).not.toContain('tag-legend');
    // The fullscreen button controls the stage that holds the map, its notes and both legends.
    expect(page).toContain('<button type="button" class="btn btn-mini" id="map-full" aria-pressed="false" aria-controls="map-stage">Fullscreen</button>');
    expect(page).toMatch(/<div class="map-stage" id="map-stage" role="region" aria-label="Map of large">[\s\S]*tag-legend[\s\S]*Legend[\s\S]*<\/div>\s*<div class="export-row"/);
    expect(renderMapView(input()).value).toContain('id="map-full"');
  });

  it('keeps a small project on the full map, without the layout switch or the tree filters', () => {
    const page = renderMapView(input()).value;
    expect(page).toContain('data-mode="full"');
    expect(page).not.toContain('Show all');
    expect(page).not.toContain('class="filters"');
    expect(mapData(snapshot, defaultState(), 1).buckets).toHaveLength(snapshot.projects[0]!.buckets.length);
  });
});
