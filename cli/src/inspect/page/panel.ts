// The detail panel on the right: the selected bucket, dependency, file or export, the paths between a pair of
// buckets, or the project overview.
import { snapshotFiles, violationLocation, type PackageImport, type SnapshotImport, type SnapshotProject } from '../../contract/browser.js';
import { adjacency, listPaths, type Adjacency } from '../graph/model.js';
import { code, commaList, fmt, link, plural, rerender, tag, type Ctx } from './dom.js';
import { html, type HtmlValue, type SafeHtml } from './html.js';
import { edgeId, findExport, isSubpath, ownerLabel, projectName, splitGroups, type Change } from './model.js';
import { copyButton, pendingItem } from './views.js';

const section = (title: string, body: HtmlValue, count?: number) =>
  html`<section><h3>${title}${count === undefined ? '' : html` <span class="count">${fmt(count)}</span>`}</h3>${body}</section>`;
const none = (text: string) => html`<p class="muted">${text}</p>`;
/** `moreAt` marks the first item that a "Show N more" button revealed, so the focus can move there. */
const list = (items: HtmlValue[], cls = '', moreKey = '', moreAt = LIST_MAX) =>
  html`<ul class="plain ${cls}">${items.map((item, i) => html`<li${moreKey !== '' && i === moreAt ? html` data-more-at="${moreKey}"` : ''}>${item}</li>`)}</ul>`;
const STATE_TEXT = { used: 'declared', unused: 'declared, never imported', undeclared: 'undeclared' };
/** The arrow of a dependency: seen as ->, read as "depends on". */
const arrow = html`<span aria-hidden="true">-></span><span class="sr"> depends on </span>`;

/** Long lists show this many items and a "Show N more" button. */
const LIST_MAX = 50;
const INLINE_MAX = 20;
/** The imports listed under each dependency or package of a bucket before a "Show N more" button. */
const BACKING_MAX = 3;
const expanded = new Set<string>();

/** Opens a list cut by capped or cappedInline. The shell renders again and focuses the first new item. */
export const showMore = (key: string) => expanded.add(key);

const moreButton = (key: string, hidden: number) => html`<button type="button" class="more" data-more="${key}">Show ${fmt(hidden)} more</button>`;

function capped(key: string, items: HtmlValue[], cls = '', max = LIST_MAX): SafeHtml {
  if (items.length <= max || expanded.has(key)) return list(items, cls, key, max);
  return html`${list(items.slice(0, max), cls)}${moreButton(key, items.length - max)}`;
}

function cappedInline(key: string, items: HtmlValue[]): SafeHtml {
  if (items.length <= INLINE_MAX || expanded.has(key)) return html`<span data-more-at="${key}">${commaList(items)}</span>`;
  return html`${commaList(items.slice(0, INLINE_MAX))} ${moreButton(key, items.length - INLINE_MAX)}`;
}

/**
 * Draws the panel. When the focus was inside, it goes back to the same link or button, or to the new heading after
 * a link in the panel opened something else.
 */
export function renderPanel(el: HTMLElement, ctx: Ctx, changes: readonly Change[], selectionChanged: boolean): void {
  const s = ctx.state.selection;
  const body =
    ctx.state.pair !== null
      ? pairPanel(ctx, ...ctx.state.pair)
      : s.kind === 'bucket'
        ? bucketPanel(ctx, s.name)
        : s.kind === 'edge'
          ? edgePanel(ctx, s.from, s.to)
          : s.kind === 'file'
            ? filePanel(ctx, s.path)
            : s.kind === 'export'
              ? exportPanel(ctx, s.bucket, s.name)
              : overview(ctx, changes);
  const top = el.scrollTop;
  if (!rerender(el, body.value) || (selectionChanged && el.contains(document.activeElement))) el.querySelector('h2')?.focus({ preventScroll: true });
  el.scrollTop = selectionChanged ? 0 : top;
}

function missing(what: string): SafeHtml {
  return html`<h2 tabindex="-1">Not found</h2><p class="empty">${what} is not in this snapshot. It may have been renamed or removed.</p>`;
}

function overview(ctx: Ctx, changes: readonly Change[]): SafeHtml {
  const p = ctx.index.project;
  let files = 0;
  for (const g of p.files) files += g.names.length;
  return html`<h2 tabindex="-1">Project ${code(projectName(p.path, ctx.rootName))}</h2>
    ${p.environment ? html`<p class="bad-text">${p.environment.message}</p>` : ''}
    <dl class="stats">
      <dt>Buckets</dt><dd>${fmt(p.buckets.length)}</dd>
      <dt>Dependencies</dt><dd>${fmt(p.edges.length)}</dd>
      <dt>Files</dt><dd>${fmt(files)}</dd>
      <dt>Pending</dt><dd>${link(ctx.href({ kind: 'none' }, 'pending'), fmt(p.violations.length))}</dd>
      ${p.advice.length > 0 ? html`<dt>Advice</dt><dd>${link(ctx.href({ kind: 'none' }, 'pending'), plural(p.advice.length, 'note'))}, not blocking</dd>` : ''}
    </dl>
    ${section(
      'Changed since the page opened',
      changes.length === 0
        ? none('Nothing yet. Changes that agents make while the page is open show here and stay marked until you press Mark changes seen.')
        : html`${capped('changes', changes.map((c) => changeLine(ctx, c)))}<button type="button" class="seen" data-key="seen">Mark changes seen</button>`,
      changes.length,
    )}
    <p class="muted">Select a bucket in the list, the graph or the matrix to see its purpose, files, exports and dependencies.</p>`;
}

function changeLine(ctx: Ctx, c: Change): HtmlValue {
  if (c.kind === 'bucket' && ctx.index.buckets.has(c.id)) return link(ctx.href({ kind: 'bucket', name: c.id }), c.text);
  if (c.kind === 'edge' && ctx.index.edges.has(c.id)) {
    const e = ctx.index.edges.get(c.id)!;
    return link(ctx.href({ kind: 'edge', from: e.from, to: e.to }), c.text);
  }
  return c.text;
}

const bucketLink = (ctx: Ctx, name: string) => link(ctx.href({ kind: 'bucket', name }), code(name));

function bucketPanel(ctx: Ctx, name: string): SafeHtml {
  const b = ctx.index.buckets.get(name);
  if (!b) return missing(`Bucket ${name}`);
  const pending = ctx.index.pending.get(name) ?? [];
  const out = ctx.index.outEdges.get(name) ?? [];
  const declared = new Map(b.dependsOn.map((d) => [d.bucket, d]));
  const exportCount = b.public.reduce((n, p) => n + p.exports.length, 0);
  const split = splitGroups(b);
  return html`<h2 tabindex="-1">${code(b.name)} ${ctx.changed.has(name) ? tag('new') : ''} ${copyButton(b.name)}</h2>
    <p class="purpose">${b.purpose}</p>
    ${ctx.state.view === 'graph' ? html`<p class="muted">Shift-click another bucket in the graph to see the dependency paths between the two.</p>` : ''}
    ${section(
      'Files',
      html`${list(b.files.map((f) => html`${code(f.glob)} <span class="num">${fmt(f.count)}</span>`))}
        <details class="owned" data-bucket="${name}"><summary>${plural(b.fileCount, 'file')} owned by ${b.name} alone</summary><ul class="plain"></ul></details>`,
    )}
    ${section(
      b.public.length === 1 ? 'Public file' : 'Public files',
      b.public.length === 0
        ? none(`Closed: ${b.name} exports nothing, so no other bucket may import it.`)
        : html`${b.public.map(
            (pub) => html`<h4>${link(ctx.href({ kind: 'file', path: pub.file }), code(pub.file))} ${pub.exists ? '' : html`<span class="bad-text">does not exist</span>`}</h4>
              ${pub.exports.length === 0
                ? none('No exports.')
                : capped(
                    `${name}|exports|${pub.file}`,
                    pub.exports.map((e) => {
                      const users = [...new Set(e.consumers.map((c) => c.bucket))];
                      return html`${link(ctx.href({ kind: 'export', bucket: name, name: e.name }), code(e.name))} <span class="muted">line ${e.line}${e.typeOnly ? ', type' : ''}</span>
                        <div class="sub">${users.length === 0 ? html`<span class="muted">${b.external ? 'no bucket imports it (external)' : 'not imported by any bucket'}</span>` : html`used by ${cappedInline(`${name}|users|${pub.file}|${e.name}`, users.map((u) => bucketLink(ctx, u)))}`}</div>`;
                    }),
                  )}`,
          )}`,
      b.public.length === 0 ? undefined : exportCount,
    )}
    ${b.external ? section('External', html`<p>${b.external}</p>`) : ''}
    ${section(
      'Dependencies',
      out.length === 0
        ? none(`${b.name} imports no other bucket.`)
        : capped(
            `${name}|dependencies`,
            out.map((e) => {
              const d = declared.get(e.to);
              return html`${link(ctx.href({ kind: 'edge', from: name, to: e.to }), code(e.to), e.state)} <span class="state-${e.state}">${STATE_TEXT[e.state]}</span>
                <span class="num">${plural(e.imports.length, 'import')}</span> ${ctx.changed.has(edgeId(name, e.to)) ? tag('changed') : ''}
                ${d ? html`<div class="sub">${d.reason}</div>` : ''}
                ${e.imports.length === 0 ? '' : capped(`${name}|backing|${e.to}`, e.imports.map((i) => importLine(ctx, i)), 'backing', BACKING_MAX)}`;
            }),
          ),
      out.length,
    )}
    ${section(
      'Dependents',
      b.dependents.length === 0
        ? none(`No bucket imports ${b.name}.`)
        : html`${split === null
            ? ''
            : split.every((g) => g.buckets.length === 1)
              ? html`<div class="note" role="note"><p><strong>May want to split.</strong> No two dependents of ${code(b.name)} use the same exported name, so each one below uses its own part of the public interface.</p></div>`
              : html`<div class="note" role="note"><p><strong>May want to split.</strong> The dependents of ${code(b.name)} use disjoint parts of its public interface:</p>
                ${capped(
                  `${name}|split`,
                  split.map((g) => html`${commaList(g.buckets.map((u) => bucketLink(ctx, u)))} <div class="sub">${g.buckets.length === 1 ? 'uses' : 'use'} ${cappedInline(`${name}|split|${g.buckets[0]}`, g.names.map((n) => code(n)))}</div>`),
                  'backing',
                  BACKING_MAX,
                )}</div>`}
          ${capped(
            `${name}|dependents`,
            b.dependents.map(
              (d) =>
                html`${link(ctx.href({ kind: 'edge', from: d.bucket, to: name }), code(d.bucket))}
                  <div class="sub">${d.names.length === 0 ? html`<span class="muted">no named imports</span>` : html`uses ${cappedInline(`${name}|uses|${d.bucket}`, d.names.map((n) => code(n)))}`}</div>`,
            ),
          )}`,
      b.dependents.length,
    )}
    ${section(
      'Packages',
      b.packages.length === 0
        ? none(`${b.name} imports no npm package and no Node module.`)
        : capped(
            `${name}|packages`,
            b.packages.map(
              (p) => html`${code(p.name)} <span class="state-${p.state}">${STATE_TEXT[p.state]}</span> <span class="num">${plural(p.imports.length, 'import')}</span>
                ${p.reason === null ? '' : html`<div class="sub">${p.reason}</div>`}
                ${p.imports.length === 0 ? '' : capped(`${name}|package|${p.name}`, p.imports.map((i) => packageLine(ctx, p.name, i)), 'backing', BACKING_MAX)}`,
            ),
          ),
      b.packages.length,
    )}
    ${section('Pending', pending.length === 0 ? none('Nothing pending.') : html`${pending.map((v) => pendingItem(v, ctx))}`, pending.length)}`;
}

/** An import of package `name`: file:line, and the specifier as written when it names a path inside the package. */
function packageLine(ctx: Ctx, name: string, imp: PackageImport): SafeHtml {
  const loc = `${imp.file}:${imp.line}`;
  return html`${link(ctx.href({ kind: 'file', path: imp.file }), code(loc))} ${copyButton(loc)}${isSubpath(name, imp.specifier) ? html` <div class="sub">imports ${code(imp.specifier)}</div>` : ''}`;
}

const graphs = new WeakMap<SnapshotProject, Adjacency>();

/** The dependency paths between the two buckets of a shift-click pair, as text with links. */
function pairPanel(ctx: Ctx, a: string, b: string): SafeHtml {
  const p = ctx.index.project;
  let graph = graphs.get(p);
  if (!graph) graphs.set(p, (graph = adjacency(p)));
  const { paths, more } = listPaths(graph, a, b);
  const clear = link(ctx.href({ kind: 'bucket', name: b }), 'Clear the paths');
  const body =
    paths.length === 0
      ? html`<p class="bad-text"><strong>No dependency path.</strong> Neither ${code(a)} nor ${code(b)} depends on the other, directly or through other buckets.</p>`
      : html`<p>${code(paths[0]![0]!)} depends on ${code(paths[0]![paths[0]!.length - 1]!)} through ${more ? `more than ${plural(paths.length, 'path')}` : plural(paths.length, 'path')}. The graph shows only these buckets.</p>
        <ol class="plain paths">${paths.map((path) => html`<li>${path.map((name, i) => (i === 0 ? bucketLink(ctx, name) : html` <span class="ci">${arrow} ${bucketLink(ctx, name)}</span>`))}</li>`)}</ol>
        ${more ? none(`The list stops at ${fmt(paths.length)} paths.`) : ''}`;
  return html`<h2 tabindex="-1">Paths between ${bucketLink(ctx, a)} and ${bucketLink(ctx, b)}</h2>
    ${body}
    <p class="muted">Shift-click another bucket in the graph to replace ${code(b)}. ${clear}.</p>`;
}

/** Fills the owned-file list of a bucket when its details element opens. */
export function fillOwned(details: HTMLDetailsElement, ctx: Ctx): void {
  const ul = details.querySelector('ul')!;
  if (!details.open || ul.childElementCount > 0) return;
  const name = details.dataset.bucket!;
  const items: SafeHtml[] = [];
  for (const f of snapshotFiles(ctx.index.project)) {
    if (f.owner.state === 'bucket' && f.owner.bucket === name) items.push(html`<li>${link(ctx.href({ kind: 'file', path: f.path }), code(f.path))}</li>`);
  }
  ul.innerHTML = items.map((i) => i.value).join('');
}

const names = (imp: SnapshotImport): HtmlValue =>
  imp.names === '*' ? 'imports *' : imp.names.length === 0 ? 'side-effect import' : html`imports ${commaList(imp.names.map((n) => code(n)))}`;

/** An import seen from the importing side: file:line, then the names and the imported file. */
function importLine(ctx: Ctx, imp: SnapshotImport): SafeHtml {
  const loc = `${imp.file}:${imp.line}`;
  return html`${link(ctx.href({ kind: 'file', path: imp.file }), code(loc))} ${copyButton(loc)}
    <div class="sub">${names(imp)} from ${link(ctx.href({ kind: 'file', path: imp.target }), code(imp.target))}${imp.private ? html` <span class="bad-text">private file</span>` : ''}</div>`;
}

function edgePanel(ctx: Ctx, from: string, to: string): SafeHtml {
  const e = ctx.index.edges.get(edgeId(from, to));
  if (!e) return missing(`The dependency ${from} -> ${to}`);
  return html`<h2 tabindex="-1">${bucketLink(ctx, from)} ${arrow} ${bucketLink(ctx, to)}</h2>
    <p><span class="state-${e.state}">${STATE_TEXT[e.state]}</span> ${ctx.changed.has(edgeId(from, to)) ? tag('changed') : ''}</p>
    ${section('Reason', e.reason === null ? html`<p class="bad-text">No reason: ${from} imports ${to} without declaring it in dependsOn.</p>` : html`<p>${e.reason}</p>`)}
    ${section('Imports', e.imports.length === 0 ? none(`Declared, but no file of ${from} imports ${to}.`) : capped(`${from}->${to}|imports`, e.imports.map((i) => importLine(ctx, i))), e.imports.length)}`;
}

function filePanel(ctx: Ctx, path: string): SafeHtml {
  const owner = ctx.owner(path);
  if (!owner) return missing(`The file ${path}`);
  const from = ctx.index.importsFrom.get(path) ?? [];
  const to = ctx.index.importsTo.get(path) ?? [];
  const byTarget = new Map<string, SnapshotImport[]>();
  for (const { edge, imp } of from) byTarget.set(edge.to, [...(byTarget.get(edge.to) ?? []), imp]);
  const pending = ctx.index.project.violations.filter((v) => violationLocation(v).file === path);
  return html`<h2 tabindex="-1">${code(path)} ${copyButton(path)}</h2>
    ${section(
      'Owner',
      html`<p>${owner.state === 'bucket' ? bucketLink(ctx, owner.bucket) : html`<span class="state-${owner.state}">${ownerLabel(owner)}</span>`}
        ${owner.state === 'overlap' ? html`: ${commaList(owner.buckets.map((b) => bucketLink(ctx, b)))}` : ''}</p>`,
    )}
    ${section(
      'Imports from other buckets',
      byTarget.size === 0
        ? none('None.')
        : html`${[...byTarget].map(([bucket, imps]) => html`<h4>${bucketLink(ctx, bucket)}</h4>${list(imps.map((i) => importLine(ctx, i)))}`)}`,
      from.length,
    )}
    ${section(
      'Imported by',
      to.length === 0 ? none('No file of another bucket imports this file.') : capped(`${path}|importers`, to.map(({ edge, imp }) => html`${importLine(ctx, imp)} <span class="muted">(${edge.from})</span>`)),
      to.length,
    )}
    ${pending.length > 0 ? section('Pending', html`${pending.map((v) => pendingItem(v, ctx))}`, pending.length) : ''}`;
}

function exportPanel(ctx: Ctx, bucket: string, name: string): SafeHtml {
  const found = findExport(ctx.index.buckets.get(bucket), name);
  if (!found) return missing(`The export ${bucket}.${name}`);
  const { file, e } = found;
  const loc = `${file}:${e.line}`;
  return html`<h2 tabindex="-1">${code(name)} ${e.typeOnly ? html`<span class="muted">type</span>` : ''}</h2>
    <p>Export of ${bucketLink(ctx, bucket)} at ${link(ctx.href({ kind: 'file', path: file }), code(loc))} ${copyButton(loc)}</p>
    ${section(
      'Importers',
      e.consumers.length === 0
        ? none('No bucket imports this name.')
        : capped(
            `${bucket}.${name}|importers`,
            e.consumers.map((c) => {
              const at = `${c.file}:${c.line}`;
              return html`${link(ctx.href({ kind: 'file', path: c.file }), code(at))} ${copyButton(at)} <span class="muted">(${c.bucket})</span>`;
            }),
          ),
      e.consumers.length,
    )}`;
}
