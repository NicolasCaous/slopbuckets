// The impact view of `buckets inspect`: three simulations computed in memory from the snapshot. Each one is a plain
// GET form, so the URL holds the inputs and a result can be shared as a link.
import { bucketImpact, externalImpact, symbolPath, type BucketImpact, type ExternalImpact, type PathStep, type SymbolPath } from '../inspect/impact.js';
import { renderMapSvg, type MapEdge, type MapTone } from '../inspect/map-svg.js';
import type { InspectSnapshot, ProjectSnapshot } from '../inspect/snapshot.js';
import { plural } from '../output/text.js';
import { html, raw, type SafeHtml } from './html.js';
import { badge, bucketName, cappedList, clean, code, currentProject, defaultState, environmentScreen, href, mapData, pruneMap, screen, shownBucket, symbolGroups, type PageInput, type Simulation } from './inspect-page.js';

const SIM_LABEL: Record<Simulation, string> = { bucket: 'Remove a bucket', path: 'Route a symbol', external: 'Change a published symbol' };

const STEP_TEXT: Record<PathStep['status'], { text: string; tone: 'ok' | 'lock' | 'violation' }> = {
  present: { text: 'already there', tone: 'ok' },
  add: { text: 'add the line', tone: 'lock' },
  create: { text: 'new file', tone: 'lock' },
  conflict: { text: 'name taken', tone: 'violation' },
};

const ROLE_TEXT: Record<PathStep['role'], string> = {
  up: 'exposes it to the level above',
  across: 'passes it to the sibling',
  self: 'hands the code of this bucket to the child',
  down: 'hands it down to the child',
  'to-parent': 'hands it to the code of this bucket',
};

/** A line of code with a copy button, as a visible block. */
function copyBlock(id: string, text: string, label: string): SafeHtml {
  return html`<div class="copy-block"><pre class="term code-line" id="${id}" translate="no" tabindex="0">${text}</pre><button type="button" class="btn btn-mini" data-copy-id="${id}" data-copied="Copied the line." aria-label="${label}">Copy</button></div>`;
}

function impactMap(input: PageInput, project: ProjectSnapshot, tones: Map<string, MapTone>, edges: MapEdge[], title: string, keep: Iterable<string> = tones.keys()): SafeHtml {
  // A large project shows only the buckets the simulation touches, with their parents.
  const data = pruneMap(mapData(input.snapshot, { ...defaultState(), project: project.path }, input.version, 'full'), keep);
  const anchor = (a: MapEdge['from']): MapEdge['from'] => ('bucket' in a ? { bucket: shownBucket(data, a.bucket) } : { strip: shownBucket(data, a.strip) });
  edges = edges.map((e) => ({ ...e, from: anchor(e.from), to: anchor(e.to) }));
  for (const b of data.buckets) {
    b.situation = tones.get(b.path) ?? 'same';
    b.dmz = 'same';
    b.violations = 0;
    b.lockChanges = 0;
  }
  data.selected = null;
  data.codeTone = 'line';
  const svg = renderMapSvg(data, { standalone: false, idPrefix: 'im', cols: 120, overlays: false, edges, title, toneClasses: { added: 'tl-added', changed: 'tl-changed', removed: 'tl-removed' } });
  return html`<div class="tl-map-scroll" tabindex="0" role="region" aria-label="${title}, scrollable"><div class="tl-map im-map">${raw(svg.svg)}</div></div>`;
}

function bucketOptions(project: ProjectSnapshot, selected: string | null): SafeHtml[] {
  return project.buckets.map((b) => html`<option value="${b.path}"${b.path === selected ? html` selected` : ''}>${bucketName(project, b.path)}</option>`);
}

function form(state: PageInput['state'], sim: Simulation, fields: SafeHtml): SafeHtml {
  return html`<form class="sim-form" method="get" action="/" data-swap>
  <input type="hidden" name="view" value="impact">
  <input type="hidden" name="sim" value="${sim}">
  ${state.project !== '.' && sim !== 'external' ? html`<input type="hidden" name="project" value="${state.project}">` : ''}
  ${fields}
  <button type="submit" class="btn btn-mini btn-solid">Simulate</button>
</form>`;
}

// ---- remove a bucket ----

function bucketResult(input: PageInput, project: ProjectSnapshot, impact: BucketImpact): SafeHtml {
  const { state, snapshot } = input;
  const name = (b: string) => bucketName(project, b);
  const projects = new Set(impact.external.flatMap((e) => e.consumers.map((c) => c.project)));
  const tones = new Map<string, MapTone>();
  for (const b of impact.removed) tones.set(b, 'removed');
  for (const b of impact.buckets) tones.set(b, 'changed');
  for (const c of impact.contracts) if (c.reason === 'broken' && !tones.has(c.owner)) tones.set(c.owner, 'changed');
  const edges: MapEdge[] = impact.buckets.slice(0, 16).map((b) => ({ from: { bucket: b }, to: { bucket: impact.bucket }, tone: 'removed', dashed: true }));
  const along = [impact.removed.length > 1 ? `the ${plural(impact.removed.length - 1, 'bucket')} below it` : null, impact.nested.length > 0 ? plural(impact.nested.length, 'nested project') : null].filter((x): x is string => x !== null);
  const breaks = [plural(impact.contracts.length, 'contract'), impact.files.length > 0 ? `${plural(impact.files.length, 'file')} in ${plural(impact.buckets.length, 'other bucket')}` : null, projects.size > 0 ? `code in ${plural(projects.size, 'project')} that ${projects.size === 1 ? 'links' : 'link'} it` : null].filter((x): x is string => x !== null);
  const join = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
  const sentence = `${along.length > 0 ? ` also removes ${join(along)}. It` : ''} breaks ${join(breaks)}`;
  const link = (b: string) => html`<a href="${href(clean(state, { view: 'impact' }), { sim: 'bucket', bucket: b })}" translate="no">${name(b)}</a>`;
  return html`<article class="sim-result" aria-labelledby="sim-title">
<h2 class="sub" id="sim-title">Without <span translate="no">${name(impact.bucket)}</span></h2>
<p>Removing ${code(`${impact.bucket}/`)}${sentence}.</p>
<ul class="tiles" aria-label="What breaks">
  <li class="del"><span class="num">${impact.contracts.length}</span><span class="what">${impact.contracts.length === 1 ? 'contract breaks' : 'contracts break'}</span></li>
  <li class="chg"><span class="num">${impact.files.length}</span><span class="what">${impact.files.length === 1 ? 'file to fix' : 'files to fix'}</span></li>
  <li class="chg"><span class="num">${impact.buckets.length}</span><span class="what">${impact.buckets.length === 1 ? 'bucket affected' : 'buckets affected'}</span></li>
  <li class="all"><span class="num">${projects.size}</span><span class="what">${projects.size === 1 ? 'project affected' : 'projects affected'}</span></li>
</ul>
${impactMap(input, project, tones, edges, `Map of ${project.name} without ${name(impact.bucket)}`, [...tones.keys()].filter((b) => !b.startsWith(`${impact.bucket}/`)))}
<ul class="legend" aria-label="Legend">
  <li><span class="swatch t-removed" aria-hidden="true"></span>removed</li>
  <li><span class="swatch t-changed" aria-hidden="true"></span>breaks</li>
  <li><span class="swatch t-same" aria-hidden="true"></span>keeps working</li>
</ul>
<h3 class="sub3">Removed with it</h3>
${cappedList({
  items: [...impact.removed.map((b) => html`<li class="del">${code(`${b}/`)}</li>`), ...impact.nested.map((p) => html`<li class="del"><span class="tag">project</span>${code(p)} <span class="dim small">${snapshot.projects.find((x) => x.path === p)?.name ?? ''}</span></li>`)],
  cap: 25,
  key: 'im-removed',
  state,
  cls: 'plain',
  noun: 'buckets',
})}
<h3 class="sub3">Contracts that break <span class="dim">${impact.contracts.length}</span></h3>
${
  impact.contracts.length === 0
    ? html`<p class="dim small">None. No DMZ file passes on anything from this bucket.</p>`
    : cappedList({
        items: impact.contracts.map((c) => html`<li>${code(c.file)} ${c.reason === 'removed' ? badge('violation', 'goes with the folder') : badge('lock', 'broken')} <span class="dim small">${c.symbols.join(', ')}</span></li>`),
        cap: 30,
        key: 'im-contracts',
        state,
        cls: 'plain',
        noun: 'contracts',
      })
}
<h3 class="sub3">Files that stop compiling <span class="dim">${impact.files.length}</span></h3>
${
  impact.files.length === 0
    ? html`<p class="dim small">None. No other bucket imports from it.</p>`
    : cappedList({ items: impact.files.map((f) => html`<li>${code(`${f.file}:${f.line}`)} <span class="dim small">${f.symbols.join(', ')} through</span> ${code(f.via)}</li>`), cap: 30, key: 'im-files', state, cls: 'plain', noun: 'files' })
}
${impact.buckets.length > 0 ? html`<h3 class="sub3">Affected buckets <span class="dim">${impact.buckets.length}</span></h3>${cappedList({ items: impact.buckets.map((b) => html`<li>${link(b)}</li>`), cap: 30, key: 'im-buckets', state, cls: 'plain', noun: 'buckets' })}` : ''}
${
  impact.external.length > 0
    ? html`<h3 class="sub3">Other projects</h3><ul class="plain">${impact.external.map(
        (e) => html`<li>${code(e.file)}${e.project !== project.path ? html` <span class="dim small">in ${e.project}</span>` : ''} ${e.reason === 'project' ? badge('violation', 'project removed') : badge('lock', 'published')}
  ${e.consumers.length === 0 ? html`<p class="dim small">No visible project links it.</p>` : html`<ul class="plain nested">${e.consumers.map((c) => html`<li><span translate="no">${c.project === '.' ? 'repo' : c.project}</span> <span class="dim small">link ${c.name} in ${c.mode} mode</span>${c.files.length > 0 ? html`: ${c.files.map((f, i) => html`${i > 0 ? ', ' : ''}${code(`${f.file}:${f.line}`)}`)}` : html` <span class="dim small">(no code imports it)</span>`}</li>`)}</ul>`}</li>`,
      )}</ul>`
    : ''
}
</article>`;
}

// ---- route a symbol ----

interface SymbolChoice {
  value: string;
  label: string;
  bucket: string;
  typeOnly: boolean;
}

function symbolChoices(input: PageInput, project: ProjectSnapshot): SymbolChoice[] {
  const seen = new Map<string, SymbolChoice>();
  for (const g of symbolGroups(input.snapshot)) {
    if (g.project !== project.path || g.declaredIn === null || g.origin === null) continue;
    seen.set(`${g.declaredIn}::${g.name}`, { value: `${g.declaredIn}::${g.name}`, label: g.name, bucket: g.origin, typeOnly: g.typeOnly });
  }
  for (const e of input.exports ?? []) {
    const value = `${e.file}::${e.name}`;
    if (!seen.has(value)) seen.set(value, { value, label: e.name, bucket: e.bucket, typeOnly: e.typeOnly });
  }
  return [...seen.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1));
}

function pathResult(input: PageInput, project: ProjectSnapshot, result: SymbolPath): SafeHtml {
  const name = (b: string) => bucketName(project, b);
  const all = [...result.steps.filter((s) => s.status !== 'present').map((s) => `// ${s.file}\n${s.line}`), `// in ${result.consumer}/_/\n${result.importLine}`].join('\n\n');
  const tones = new Map<string, MapTone>();
  for (const s of result.steps) tones.set(s.owner, s.status === 'present' ? 'same' : 'changed');
  tones.set(result.origin, 'added');
  tones.set(result.consumer, 'added');
  const anchors = [{ bucket: result.origin } as const, ...result.steps.map((s) => ({ strip: s.owner }) as const), { bucket: result.consumer } as const];
  const edges: MapEdge[] = [];
  for (let i = 0; i + 1 < anchors.length; i++) {
    const s = result.steps[i];
    edges.push({ from: anchors[i]!, to: anchors[i + 1]!, tone: s === undefined || s.status === 'present' ? 'same' : 'added', ...(s ? { label: s.file.slice(s.owner.length + 1) } : {}) });
  }
  const missing = result.steps.filter((s) => s.status === 'create' || s.status === 'add').length;
  return html`<article class="sim-result" aria-labelledby="sim-title">
<h2 class="sub" id="sim-title"><span translate="no">${result.symbol}</span> <span class="dim">to</span> <span translate="no">${name(result.consumer)}</span></h2>
<p>${code(result.symbol)} is declared in ${code(result.declaredIn)}. ${
    result.steps.length === 0
      ? ''
      : missing === 0
        ? html`Every DMZ file on the way already passes it on, so ${code(name(result.consumer))} can import it now.`
        : html`${name(result.consumer)} needs ${plural(result.steps.length, 'DMZ file')} on the way, ${missing} of them to write.`
  }</p>
${result.note !== null ? html`<p class="callout">${result.note}</p>` : ''}
${result.cycle !== null ? html`<div class="callout bad" role="status"><p><strong>This import would close a cycle:</strong> ${result.cycle.map((b, i) => html`${i > 0 ? html`<span aria-hidden="true"> -&gt; </span><span class="visually-hidden"> to </span>` : ''}${code(name(b))}`)}. The check fails with graph-cycle until one of these imports goes away.</p></div>` : ''}
${result.steps.some((s) => s.status === 'conflict') ? html`<div class="callout bad"><p>A file on the way already passes another symbol named ${code(result.symbol)}. A DMZ file cannot rename with ${code('as')}, so rename one of the declarations first.</p></div>` : ''}
${impactMap(input, project, tones, edges, `Path of ${result.symbol} from ${name(result.origin)} to ${name(result.consumer)}`)}
<ul class="legend" aria-label="Legend">
  <li><span class="swatch t-added" aria-hidden="true"></span>origin and consumer</li>
  <li><span class="swatch t-changed" aria-hidden="true"></span>a DMZ file to write</li>
  <li><span class="swatch t-same" aria-hidden="true"></span>already in place or not involved</li>
</ul>
${
  result.steps.length === 0
    ? ''
    : html`<h3 class="sub3">DMZ files, level by level</h3>
<ol class="steps">${result.steps.map(
        (s, i) => html`<li class="step st-${s.status}">
  <div class="step-head"><span class="lvl">level ${s.level}</span>${code(s.file)}${badge(STEP_TEXT[s.status].tone, STEP_TEXT[s.status].text)}</div>
  <p class="small dim">${s.about ?? ''} This file ${ROLE_TEXT[s.role]}.</p>
  ${s.status === 'present' ? html`<p class="small">${code(s.file)} already has this line.</p>` : copyBlock(`step-${i}`, s.line, `Copy the line for ${s.file}`)}
</li>`,
      )}</ol>`
}
<h3 class="sub3">Import in ${code(`${result.consumer}/_/`)}</h3>
${copyBlock('step-import', result.importLine, 'Copy the import line')}
${missing > 0 ? html`<p class="cmd-copy"><button type="button" class="btn btn-mini" data-copy-id="step-all" data-copied="Copied every line." aria-label="Copy every line with the file names">Copy every line</button><span class="visually-hidden" id="step-all">${all}</span></p>` : ''}
<p class="small dim note">Lines come from the real tree and the alias ${code(project.config?.alias ?? '@root')}. A new contract waits for a human approval with ${code('buckets refresh --web')}.</p>
</article>`;
}

// ---- change a published symbol ----

function externalResult(input: PageInput, project: ProjectSnapshot, result: ExternalImpact): SafeHtml {
  const { snapshot } = input;
  const projectName = (p: string) => snapshot.projects.find((x) => x.path === p)?.name ?? p;
  const effect = (mode: 'link' | 'copy', name: string): string =>
    mode === 'link'
      ? `The link shows the source of the origin, so the change reaches it at once. A changed signature makes its check report link-changed until its human approves; a change that keeps the signature needs nothing.`
      : `The copy keeps the old source until buckets link update ${name}. Until then its check reports link-drift.`;
  const files = result.consumers.reduce((n, c) => n + c.files.length, 0);
  return html`<article class="sim-result" aria-labelledby="sim-title">
<h2 class="sub" id="sim-title"><span translate="no">${result.symbol}</span> <span class="dim">in</span> <span translate="no">${result.file.slice(result.file.indexOf('/dmz/') + 5)}</span></h2>
<p>${project.name} publishes ${code(result.symbol)} in ${code(result.file)}${result.declaredIn !== null ? html`, declared in ${code(result.declaredIn)}` : ''}. Projects that link ${project.name} import it through ${code(result.file.slice(result.file.indexOf('/') + 1).replace(/\.[^./]+$/, ''))} after the alias of ${project.name}. Changing its signature asks each of them for approval.</p>
${result.signature !== null ? html`<pre class="term sig" translate="no" tabindex="0" aria-label="Signature now">${result.signature}</pre>` : ''}
<ul class="tiles" aria-label="Who is affected">
  <li class="all"><span class="num">${result.consumers.length}</span><span class="what">${result.consumers.length === 1 ? 'link' : 'links'} in other projects</span></li>
  <li class="chg"><span class="num">${files}</span><span class="what">${files === 1 ? 'file there' : 'files there'}</span></li>
  <li class="chg"><span class="num">${result.inside.length}</span><span class="what">${result.inside.length === 1 ? 'import' : 'imports'} inside ${project.name}</span></li>
</ul>
<h3 class="sub3">Other projects</h3>
${
  result.consumers.length === 0
    ? html`<p class="dim small">No visible project links this file. Projects outside this tree may still link it.</p>`
    : html`<ul class="plain consumers">${result.consumers.map(
        (c) => html`<li><strong translate="no">${projectName(c.project)}</strong> <span class="dim small">${c.project === '.' ? 'repo' : c.project}, link ${c.name} in ${c.mode} mode</span>${c.holds ? '' : html` ${badge('lock', 'not in its copy yet')}`}
  ${c.files.length > 0 ? html`<ul class="plain nested">${c.files.map((f) => html`<li>${code(`${f.file}:${f.line}`)} <span class="dim small">${f.names.join(', ')}</span></li>`)}</ul>` : html`<p class="dim small">No code there imports ${result.symbol}.</p>`}
  <p class="small">${effect(c.mode, c.name)}</p></li>`,
      )}</ul>`
}
<h3 class="sub3">Inside ${project.name}</h3>
${
  result.inside.length === 0
    ? html`<p class="dim small">No other DMZ file of ${project.name} passes this declaration on.</p>`
    : html`<ul class="plain">${result.inside.map((f) => html`<li>${code(`${f.file}:${f.line}`)} <span class="dim small">through</span> ${code(f.via)}</li>`)}</ul>`
}
</article>`;
}

// ---- the view ----

function externalChoices(snapshot: InspectSnapshot): { project: ProjectSnapshot; items: { value: string; label: string }[] }[] {
  return snapshot.projects
    .filter((p) => p.external.length > 0)
    .map((p) => ({ project: p, items: p.external.flatMap((e) => e.symbols.map((s) => ({ value: `${p.path}::${e.file}::${s.name}`, label: `${s.name} (${e.file.slice(e.file.indexOf('/dmz/') + 5)})` }))) }));
}

export function renderImpactView(input: PageInput): SafeHtml {
  const { snapshot, state } = input;
  const project = currentProject(snapshot, state);
  const sim: Simulation = state.sim ?? 'bucket';
  if (sim !== 'external' && (project.status === 'environment' || project.buckets.length === 0)) return environmentScreen(project, 'impact');
  const tabs = html`<nav class="sim-tabs" aria-label="Simulations">${(['bucket', 'path', 'external'] as const).map(
    (s) => html`<a href="${href({ ...defaultState(), view: 'impact', project: state.project }, { sim: s })}"${s === sim ? html` aria-current="page"` : ''}>${SIM_LABEL[s]}</a>`,
  )}</nav>`;
  let body: SafeHtml;
  if (sim === 'bucket') {
    const impact = state.bucket !== null ? bucketImpact(snapshot, project.path, state.bucket) : null;
    body = html`${form(state, 'bucket', html`<div class="field"><label for="sim-bucket">Bucket to remove</label><select id="sim-bucket" name="bucket">${state.bucket === null ? html`<option value="" selected disabled>Pick a bucket</option>` : ''}${bucketOptions(project, state.bucket)}</select></div>`)}
${impact ? bucketResult(input, project, impact) : html`<p class="empty">Pick a bucket to see the contracts, symbols and files that would break without it, and the projects that link what it publishes.</p>`}`;
  } else if (sim === 'path') {
    const choices = symbolChoices(input, project);
    const picked = state.symbol !== null && state.of !== null ? `${state.of}::${state.symbol}` : null;
    const groups = new Map<string, SymbolChoice[]>();
    for (const c of choices) {
      if (!groups.has(c.bucket)) groups.set(c.bucket, []);
      groups.get(c.bucket)!.push(c);
    }
    const choice = choices.find((c) => c.value === picked);
    const result = picked !== null && state.to !== null ? symbolPath(snapshot, { project: project.path, symbol: state.symbol!, declaredIn: state.of!, consumer: state.to, typeOnly: choice?.typeOnly ?? false }) : null;
    body = html`${form(
      state,
      'path',
      html`<div class="field"><label for="sim-symbol">Symbol</label><select id="sim-symbol" name="pick">${picked === null ? html`<option value="" selected disabled>Pick a symbol</option>` : ''}${[...groups].map(
        ([bucket, items]) => html`<optgroup label="${bucketName(project, bucket)}">${items.map((c) => html`<option value="${c.value}"${c.value === picked ? html` selected` : ''}>${c.label}${c.typeOnly ? ' (type)' : ''}</option>`)}</optgroup>`,
      )}</select></div>
<div class="field"><label for="sim-to">Consumer bucket</label><select id="sim-to" name="to">${state.to === null ? html`<option value="" selected disabled>Pick a bucket</option>` : ''}${bucketOptions(project, state.to)}</select></div>`,
    )}
${
  result === null
    ? html`<p class="empty">Pick a symbol from the ${code('_/')} code of a bucket and the bucket that should use it. The answer lists the DMZ files needed at each level, through ${code('.self')} and ${code('.parent')}, with the lines to copy.</p>`
    : 'problem' in result
      ? html`<p class="callout bad">${result.problem}</p>`
      : pathResult(input, project, result)
}`;
  } else {
    const groups = externalChoices(snapshot);
    const picked = state.symbol !== null && state.cell !== null ? `${state.project}::${state.cell}::${state.symbol}` : null;
    const result = state.symbol !== null && state.cell !== null ? externalImpact(snapshot, project.path, state.cell, state.symbol) : null;
    body =
      groups.length === 0
        ? html`<p class="empty">No project here publishes anything: there is no ${code('.external.ts')} file.</p>`
        : html`${form(
            state,
            'external',
            html`<div class="field"><label for="sim-ext">Published symbol</label><select id="sim-ext" name="pick">${picked === null ? html`<option value="" selected disabled>Pick a symbol</option>` : ''}${groups.map(
              (g) => html`<optgroup label="${g.project.name}">${g.items.map((i) => html`<option value="${i.value}"${i.value === picked ? html` selected` : ''}>${i.label}</option>`)}</optgroup>`,
            )}</select></div>`,
          )}
${
  result === null
    ? html`<p class="empty">Pick a symbol of a ${code('.external.ts')} file to see which projects link it, which of their files use it and what each link does when it changes.</p>`
    : 'problem' in result
      ? html`<p class="callout bad">${result.problem}</p>`
      : externalResult(input, project, result)
}`;
  }
  return screen(
    'tty8',
    `impact ${project.name}`,
    SIM_LABEL[sim].toLowerCase(),
    html`<h1 class="view-title" id="view-title">Impact <span class="dim">simulation</span></h1>
<p class="intro">Ask what a change would do before making it. The answers come from the last check and are computed in memory. Nothing is written to the project.</p>
${tabs}
${body}`,
    { id: 'view', labelledBy: 'view-title', cls: 'view view-impact' },
  );
}
