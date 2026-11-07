// The text exports of `buckets inspect`: the bucket graph as Mermaid and as Graphviz DOT, one cluster per project.
// A declared and used dependency is a solid edge labeled with its reason. A declared dependency without imports is a
// dashed edge, and an import without a declaration is a dotted red edge. The labels say which one it is too, so the
// difference never rests on color alone.
import { lstatSync } from 'node:fs';
import { oneLine, type SnapshotBucket, type SnapshotEdge, type SnapshotProject, type SnapshotV2 } from '../../contract/index.js';

export const EXPORT_FORMATS = ['svg', 'mermaid', 'dot', 'html'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const RED = '#d1242f';

/** The root project shows as `rootName`, the folder name when the command passes it. */
function projectTitle(project: SnapshotProject, rootName: string): string {
  const name = project.path === '.' ? rootName : project.path;
  return project.environment ? `${name}: not checked (${project.environment.code})` : name;
}

function bucketLabel(name: string, files: number): string {
  return `${name} (${files === 1 ? '1 file' : `${files} files`})`;
}

/** The public files of a bucket, on one line. The DOT export puts it in the node tooltip, Mermaid in a comment. */
export function publicText(bucket: SnapshotBucket): string {
  return bucket.public.length === 0 ? 'closed, no public file' : `public: ${bucket.public.map((p) => p.file).join(', ')}`;
}

function edgeLabel(edge: SnapshotEdge): string {
  if (edge.state === 'undeclared') return 'not declared';
  return edge.state === 'unused' ? `${edge.reason ?? ''} (no import)` : (edge.reason ?? '');
}

/** Node ids: p<project index>_b<bucket index>, so names with any character stay out of the syntax. */
function ids(snapshot: SnapshotV2): (project: number, bucket: string) => string | undefined {
  const map = new Map<string, string>();
  snapshot.projects.forEach((p, pi) => p.buckets.forEach((b, bi) => map.set(`${pi}\0${b.name}`, `p${pi}_b${bi}`)));
  return (project, bucket) => map.get(`${project}\0${bucket}`);
}

/** A label inside double quotes, with Mermaid entity codes for the characters that would end or change it. */
export function mermaidLabel(text: string): string {
  return text
    .replace(/[\r\n\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/#/g, '#35;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;');
}

export function exportMermaid(snapshot: SnapshotV2, rootName = 'root project'): string {
  const id = ids(snapshot);
  const out = ['flowchart TB'];
  const edges: string[] = [];
  const dashed: number[] = [];
  const red: number[] = [];
  snapshot.projects.forEach((project, pi) => {
    out.push(`  subgraph p${pi}["${mermaidLabel(projectTitle(project, rootName))}"]`);
    // Mermaid has no tooltip without a click handler, so the public files go into a comment above each node.
    project.buckets.forEach((b) => out.push(`    %% ${oneLine(`${b.name} ${publicText(b)}`)}`, `    ${id(pi, b.name)}["${mermaidLabel(bucketLabel(b.name, b.fileCount))}"]`));
    out.push('  end');
    for (const edge of project.edges) {
      const from = id(pi, edge.from);
      const to = id(pi, edge.to);
      if (from === undefined || to === undefined) continue;
      if (edge.state === 'unused') dashed.push(edges.length);
      if (edge.state === 'undeclared') red.push(edges.length);
      edges.push(`  ${from} ${edge.state === 'used' ? '-->' : '-.->'}|"${mermaidLabel(edgeLabel(edge))}"| ${to}`);
    }
  });
  out.push(...edges);
  if (dashed.length > 0) out.push(`  linkStyle ${dashed.join(',')} stroke-dasharray:6 4`);
  if (red.length > 0) out.push(`  linkStyle ${red.join(',')} stroke:${RED},stroke-dasharray:2 4`);
  return `${out.join('\n')}\n`;
}

/** A DOT string in double quotes. */
function dotString(text: string): string {
  return `"${text.replace(/[\r\n\p{Zl}\p{Zp}]+/gu, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function exportDot(snapshot: SnapshotV2, rootName = 'root project'): string {
  const id = ids(snapshot);
  const out = ['digraph buckets {', '  rankdir=TB;', '  node [shape=box];'];
  const edges: string[] = [];
  snapshot.projects.forEach((project, pi) => {
    out.push(`  subgraph cluster_p${pi} {`, `    label=${dotString(projectTitle(project, rootName))};`);
    project.buckets.forEach((b) => out.push(`    ${id(pi, b.name)} [label=${dotString(bucketLabel(b.name, b.fileCount))}, tooltip=${dotString(publicText(b))}];`));
    out.push('  }');
    for (const edge of project.edges) {
      const from = id(pi, edge.from);
      const to = id(pi, edge.to);
      if (from === undefined || to === undefined) continue;
      const style = edge.state === 'used' ? '' : edge.state === 'unused' ? ', style=dashed' : `, style=dotted, color=${dotString(RED)}, fontcolor=${dotString(RED)}`;
      edges.push(`  ${from} -> ${to} [label=${dotString(edgeLabel(edge))}${style}];`);
    }
  });
  out.push(...edges, '}');
  return `${out.join('\n')}\n`;
}

/** Why `--out` may not be written, or null. Writing through a hard link would change every name of the file. */
export function outProblem(file: string): string | null {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return `${file} exists and is not a regular file. Give the path of a new or regular file.`;
  if (stat.nlink > 1) return `${file} has other hard links, so writing it would change those files too. Pick another file.`;
  return null;
}
