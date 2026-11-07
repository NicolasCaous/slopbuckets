// The types between the graph view and the page that mounts it. The graph runs in the browser and, through svg.ts,
// in Node, so nothing in graph/ imports from page/, node/ or a Node module (graph.test.ts bundles it for the browser).
import type { SnapshotProject } from '../../contract/browser.js';

/** What the user selected. The URL hash mirrors it, so back and forward work and a link opens the same view. */
export type Selection =
  | { kind: 'none' }
  | { kind: 'bucket'; name: string }
  | { kind: 'edge'; from: string; to: string }
  | { kind: 'file'; path: string }
  | { kind: 'export'; bucket: string; name: string };

/** What the graph draws besides the project. */
export interface GraphState {
  selection: Selection;
  /** Focus mode depth: how many levels of dependencies and dependents around the selected bucket the graph shows. */
  focusDepth: number;
  /** Two buckets whose dependency paths are highlighted (shift-click), or null. */
  pathPair: [string, string] | null;
  /** Ids of buckets and edges (`from->to`) that changed since the page opened and are not marked seen. */
  changed: ReadonlySet<string>;
}

/** The graph view the page mounts in the center area. index.ts implements it. */
export interface GraphView {
  /** Draws the project with the state. Layout runs again only when the project's buckets or edges change. */
  update(project: SnapshotProject, state: GraphState): void;
  destroy(): void;
}

export interface GraphViewOptions {
  /** Called when the user selects a node or an edge, by mouse or keyboard. */
  onSelect(selection: Selection, options: { shift: boolean }): void;
}

export type CreateGraphView = (container: HTMLElement, options: GraphViewOptions) => GraphView;
