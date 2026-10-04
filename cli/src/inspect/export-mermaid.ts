// The bucket graph as a Mermaid flowchart, for `buckets inspect --export mermaid` and the download button of the page.
// Each project is a subgraph, each bucket a subgraph inside its parent with one node for its `_/` code, and a nested
// project sits inside the bucket that holds it. Every DMZ file is an edge labeled with its symbol count. The syntax
// stays conservative (plain ids, quoted labels, classDef, linkStyle) so older Mermaid versions read it too.
import type { ContractSnapshot, InspectSnapshot, ProjectSnapshot, Situation } from './snapshot.js';
import { projectSituation } from './snapshot.js';

export type MermaidNodeKind = 'code' | 'dmz' | 'external' | 'origin' | 'environment';
export type MermaidEdgeKind = 'contract' | 'up' | 'down' | 'publish' | 'link' | 'cycle';

export interface MermaidNode {
  id: string;
  label: string;
  kind: MermaidNodeKind;
  project: string | null;
  /** The bucket the node belongs to, or null for nodes outside the buckets. */
  bucket: string | null;
  situation: Situation;
}

export interface MermaidEdge {
  from: string;
  to: string;
  label: string;
  kind: MermaidEdgeKind;
  situation: Situation;
  /** The DMZ file or link folder the edge stands for. */
  file: string | null;
  project: string;
}

export interface MermaidGraph {
  nodes: MermaidNode[];
  edges: MermaidEdge[];
  text: string;
}

const COLORS: Record<Situation, { fill: string; stroke: string; color: string }> = {
  ok: { fill: '#021a0a', stroke: '#3dff74', color: '#b4f5c6' },
  lock: { fill: '#1c1404', stroke: '#ffc04d', color: '#ffe6b8' },
  violation: { fill: '#1a0402', stroke: '#ff6e61', color: '#ffd3cd' },
};

/** A label inside double quotes: Mermaid entity codes for the characters that would end or change it. */
export function mermaidLabel(text: string): string {
  return text
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/#/g, '#35;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;');
}

function symbolsText(count: number): string {
  return count === 1 ? '1 symbol' : `${count} symbols`;
}

function bucketLabel(project: ProjectSnapshot, path: string): string {
  const root = project.config?.root ?? 'root';
  return path === root ? `${root}/` : `${path.slice(path.lastIndexOf('/') + 1)}/`;
}

/** Builds the graph of every project in the snapshot (or one project and its nested ones). */
export function mermaidGraph(snapshot: InspectSnapshot): MermaidGraph {
  const nodes: MermaidNode[] = [];
  const edges: MermaidEdge[] = [];
  const lines: string[] = [];
  const comments: string[] = [];
  const projectIds = new Map<string, string>();
  snapshot.projects.forEach((p, i) => projectIds.set(p.path, `P${i}`));
  const bucketIds = new Map<string, string>();
  const bucketId = (project: string, bucket: string): string => bucketIds.get(`${project}\0${bucket}`)!;
  for (const project of snapshot.projects) {
    const pid = projectIds.get(project.path)!;
    project.buckets.forEach((b, i) => bucketIds.set(`${project.path}\0${b.path}`, `${pid}_B${i}`));
  }
  const dmzNodes = new Set<string>();
  const externalNodes = new Map<string, string>();

  // Nodes and subgraphs, nested projects inside the bucket that holds them.
  const renderProject = (project: ProjectSnapshot, indent: string): void => {
    const pid = projectIds.get(project.path)!;
    const title = project.path === '.' ? `${project.name} (repo)` : `${project.name} (${project.path})`;
    lines.push(`${indent}subgraph ${pid}["${mermaidLabel(title)}"]`);
    if (project.buckets.length === 0) {
      const id = `${pid}_env`;
      const label = project.environment ? `check could not run: ${project.environment.code}` : 'no buckets';
      nodes.push({ id, label, kind: 'environment', project: project.path, bucket: null, situation: 'violation' });
      lines.push(`${indent}  ${id}["${mermaidLabel(label)}"]`);
    }
    const byPath = new Map(project.buckets.map((b) => [b.path, b]));
    // Owners whose dmz/ has a contract with the level above or with other projects get a dmz node.
    const owners = new Set(project.contracts.filter((c) => c.provider === '.parent' || c.consumer === '.parent').map((c) => c.owner));
    const visit = (path: string, depth: string): void => {
      const bucket = byPath.get(path);
      if (!bucket) return;
      const bid = bucketId(project.path, path);
      lines.push(`${depth}subgraph ${bid}["${mermaidLabel(bucketLabel(project, path))}"]`);
      const code = `${bid}_c`;
      const codeLabel = `_/ ${bucket.files === 1 ? '1 file' : `${bucket.files} files`}`;
      nodes.push({ id: code, label: codeLabel, kind: 'code', project: project.path, bucket: path, situation: bucket.situation });
      lines.push(`${depth}  ${code}["${mermaidLabel(codeLabel)}"]`);
      if (owners.has(path)) {
        const dmz = `${bid}_d`;
        dmzNodes.add(dmz);
        nodes.push({ id: dmz, label: 'dmz/ .parent', kind: 'dmz', project: project.path, bucket: path, situation: 'ok' });
        lines.push(`${depth}  ${dmz}{{"dmz/ .parent"}}`);
      }
      for (const contract of project.contracts.filter((c) => c.owner === path && c.consumer === '.external')) {
        const id = `${bid}_x${externalNodes.size}`;
        externalNodes.set(`${project.path}\0${contract.file}`, id);
        const label = `${contract.provider}/.external`;
        nodes.push({ id, label, kind: 'external', project: project.path, bucket: path, situation: contract.situation });
        lines.push(`${depth}  ${id}(["${mermaidLabel(label)}"])`);
      }
      for (const nested of bucket.projects) {
        const child = snapshot.projects.find((p) => p.path === nested);
        if (child) renderProject(child, `${depth}  `);
      }
      for (const child of bucket.children) visit(child, `${depth}  `);
      lines.push(`${depth}end`);
    };
    const root = project.buckets[0];
    if (root) visit(root.path, `${indent}  `);
    lines.push(`${indent}end`);
  };
  for (const project of snapshot.projects) if (project.parent === null || !projectIds.has(project.parent)) renderProject(project, '  ');

  // Origins of links outside the visible projects.
  const origins = new Map<string, string>();
  for (const link of snapshot.links) {
    if (link.to !== null || origins.has(link.origin)) continue;
    const id = `O${origins.size}`;
    origins.set(link.origin, id);
    nodes.push({ id, label: link.origin, kind: 'origin', project: null, bucket: null, situation: 'ok' });
    lines.push(`  ${id}[/"${mermaidLabel(link.origin)}"/]`);
  }

  // Edges: one per DMZ file, then links between projects, then the cycles of the bucket graph.
  const edge = (e: MermaidEdge): void => {
    edges.push(e);
  };
  const ends = (project: ProjectSnapshot, contract: ContractSnapshot): { from: string; to: string; kind: MermaidEdgeKind; label: string } | null => {
    const count = symbolsText(contract.symbols.length);
    const ownerId = bucketId(project.path, contract.owner);
    const code = (bucket: string | null) => (bucket !== null && bucketIds.has(`${project.path}\0${bucket}`) ? `${bucketId(project.path, bucket)}_c` : null);
    if (contract.consumer === '.external') {
      const from = code(contract.providerBucket);
      const to = externalNodes.get(`${project.path}\0${contract.file}`);
      return from && to ? { from, to, kind: 'publish', label: count } : null;
    }
    if (contract.provider === '.parent') {
      const to = code(contract.consumerBucket);
      return to ? { from: `${ownerId}_d`, to, kind: 'down', label: count } : null;
    }
    if (contract.consumer === '.parent') {
      const from = code(contract.providerBucket);
      return from ? { from, to: `${ownerId}_d`, kind: 'up', label: count } : null;
    }
    const from = code(contract.providerBucket);
    const to = code(contract.consumerBucket);
    return from && to ? { from, to, kind: 'contract', label: count } : null;
  };
  for (const project of snapshot.projects) {
    for (const contract of project.contracts) {
      const e = ends(project, contract);
      if (e) edge({ ...e, situation: contract.situation, file: contract.file, project: project.path });
    }
    for (const change of project.lockChanges.filter((c) => c.kind === 'dmz-removed')) comments.push(`removed since the last approval of ${project.name}: ${change.path}`);
  }
  for (const link of snapshot.links) {
    const consumer = snapshot.projects.find((p) => p.path === link.from);
    const snap = consumer?.links.find((l) => l.path === link.link);
    if (!consumer || !snap || !bucketIds.has(`${consumer.path}\0${snap.bucket}`)) continue;
    const from = `${bucketId(consumer.path, snap.bucket)}_c`;
    // A link to a visible project points at the first published file it holds, or at that project's first one.
    const publisher = link.to !== null ? snapshot.projects.find((p) => p.path === link.to) : undefined;
    const root = publisher?.config?.root ?? 'root';
    const held = snap.symbols.map((s) => `${root}/${s.file}`);
    const file = publisher?.external.find((e) => held.includes(e.file))?.file ?? publisher?.external[0]?.file;
    const to = link.to !== null ? (file !== undefined ? externalNodes.get(`${link.to}\0${file}`) : undefined) : origins.get(link.origin);
    if (!to) continue;
    const situation: Situation = link.state === 'ok' ? 'ok' : link.state === 'missing' ? 'violation' : 'lock';
    edge({ from, to, kind: 'link', label: `link ${link.name}`, situation, file: link.link, project: consumer.path });
  }
  for (const project of snapshot.projects) {
    for (const imp of project.imports.filter((e) => e.cycle)) {
      if (!bucketIds.has(`${project.path}\0${imp.from}`) || !bucketIds.has(`${project.path}\0${imp.to}`)) continue;
      edge({ from: `${bucketId(project.path, imp.from)}_c`, to: `${bucketId(project.path, imp.to)}_c`, kind: 'cycle', label: 'cycle', situation: 'violation', file: null, project: project.path });
    }
  }

  // Text.
  const out: string[] = [];
  const top = snapshot.projects[0];
  // The diagram type comes first: older Mermaid versions do not skip comments before it.
  out.push('flowchart TB');
  out.push(`  %% Bucket graph of ${(top ? top.name : 'the project').replace(/[\r\n]+/g, ' ')}, from buckets inspect --export mermaid`);
  out.push('  %% Edges are DMZ files from provider to consumer, labeled with the number of symbols.');
  for (const c of comments) out.push(`  %% ${c.replace(/[\r\n]+/g, ' ')}`);
  out.push(...lines);
  for (const e of edges) {
    const arrow = e.kind === 'link' ? '-.->' : e.kind === 'cycle' ? '==>' : '-->';
    out.push(`  ${e.from} ${arrow}|"${mermaidLabel(e.label)}"| ${e.to}`);
  }
  for (const [name, c] of Object.entries(COLORS)) out.push(`  classDef ${name} fill:${c.fill},stroke:${c.stroke},color:${c.color}`);
  out.push('  classDef dmz fill:#010603,stroke:#8ef9ff,color:#8ef9ff');
  out.push('  classDef origin fill:#010603,stroke:#2b8a4c,color:#6cbf86,stroke-dasharray:4 4');
  const byClass = new Map<string, string[]>();
  for (const node of nodes) {
    const cls = node.kind === 'dmz' ? 'dmz' : node.kind === 'origin' ? 'origin' : node.situation;
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls)!.push(node.id);
  }
  for (const [cls, ids] of byClass) out.push(`  class ${ids.join(',')} ${cls}`);
  for (const project of snapshot.projects) {
    const situation = projectSituation(project);
    out.push(`  style ${projectIds.get(project.path)!} fill:#020904,stroke:${COLORS[situation].stroke},color:${COLORS[situation].stroke}`);
    for (const bucket of project.buckets) {
      out.push(`  style ${bucketId(project.path, bucket.path)} fill:#010603,stroke:${COLORS[bucket.situation].stroke},color:${COLORS[bucket.situation].color}`);
    }
  }
  const styled = new Map<string, number[]>();
  edges.forEach((e, i) => {
    const key = e.kind === 'cycle' ? 'cycle' : e.situation;
    if (!styled.has(key)) styled.set(key, []);
    styled.get(key)!.push(i);
  });
  for (const [key, indexes] of styled) {
    const stroke = key === 'cycle' ? `${COLORS.violation.stroke},stroke-width:3px` : `${COLORS[key as Situation].stroke},stroke-width:${key === 'ok' ? 1.5 : 2.5}px`;
    out.push(`  linkStyle ${indexes.join(',')} stroke:${stroke}`);
  }
  return { nodes, edges, text: `${out.join('\n')}\n` };
}
