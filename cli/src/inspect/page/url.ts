// The URL hash holds the view, the selection and the graph options, so back and forward work and a link reopens the
// same place. Shape: #/<view>/<selection>?project=<path>&depth=<n>&pair=<a>,<b>, where every part is optional:
// #/bucket/billing, #/edge/billing/payments, #/matrix, #/files/file/src/a.ts, #/graph?depth=2.
import type { Selection } from '../graph/types.js';
import { OWNER_FILTERS, SORT_KEYS, type OwnerFilter, type SortKey } from './model.js';

/** The views of the center area, in tab order. Keys 1 to 4 switch between them. */
export const VIEWS = ['graph', 'matrix', 'pending', 'files'] as const;
export type View = (typeof VIEWS)[number];

export interface UrlState {
  /** Null when the hash names no view; the page then picks one. */
  view: View | null;
  selection: Selection;
  /** Null when the hash has no depth; the page then uses its default. */
  depth: number | null;
  /** The nested project, '.' for the root. */
  project: string;
  pair: [string, string] | null;
}

export const EMPTY_URL: UrlState = { view: null, selection: { kind: 'none' }, depth: null, project: '.', pair: null };

/** Reads a hash such as '#/edge/a/b?depth=2'. Returns null for a hash that is not a route, such as '#main'. */
export function parseHash(hash: string): UrlState | null {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  if (text === '') return { ...EMPTY_URL };
  if (!text.startsWith('/')) return null;
  const q = text.indexOf('?');
  let parts: string[];
  try {
    parts = (q === -1 ? text : text.slice(0, q)).split('/').filter((s) => s !== '').map(decodeURIComponent);
  } catch {
    return { ...EMPTY_URL };
  }
  const params = new URLSearchParams(q === -1 ? '' : text.slice(q + 1));
  const state: UrlState = { ...EMPTY_URL, project: params.get('project') || '.' };
  if ((VIEWS as readonly string[]).includes(parts[0] ?? '')) state.view = parts.shift() as View;
  const [kind, a, b] = parts;
  if (kind === 'bucket' && a) state.selection = { kind, name: a };
  else if (kind === 'edge' && a && b) state.selection = { kind, from: a, to: b };
  else if (kind === 'export' && a && b) state.selection = { kind, bucket: a, name: b };
  else if (kind === 'file' && parts.length > 1) state.selection = { kind, path: parts.slice(1).join('/') };
  const depth = Number(params.get('depth') ?? NaN);
  if (Number.isInteger(depth) && depth >= 0) state.depth = depth;
  const pair = params.get('pair')?.split(',');
  if (pair?.length === 2 && pair[0] && pair[1]) state.pair = [pair[0], pair[1]];
  return state;
}

/**
 * Filters and display choices of the lists. They live in the query string, not the hash, so every link to a
 * selection keeps them, and the hash stays the place the page shows: ?filter=pay&sort=files&by=bucket#/graph.
 */
export interface ViewOptions {
  /** Bucket list filter and sort. */
  filter: string;
  sort: SortKey;
  /** Pending view grouping and filter. */
  by: 'rule' | 'bucket';
  pending: string;
  /** Files view owner state and path filter. */
  owner: OwnerFilter;
  path: string;
  /** The canvas matrix shown as a table of dependencies. */
  table: boolean;
}

export const DEFAULT_OPTIONS: ViewOptions = { filter: '', sort: 'name', by: 'rule', pending: '', owner: 'all', path: '', table: false };

const oneOf = <T extends string>(list: readonly T[], value: string | null, fallback: T): T => ((list as readonly string[]).includes(value ?? '') ? (value as T) : fallback);

export function parseOptions(search: string): ViewOptions {
  const p = new URLSearchParams(search);
  return {
    filter: p.get('filter') ?? '',
    sort: oneOf(SORT_KEYS, p.get('sort'), 'name'),
    by: oneOf(['rule', 'bucket'] as const, p.get('by'), 'rule'),
    pending: p.get('pending') ?? '',
    owner: oneOf(OWNER_FILTERS, p.get('owner'), 'all'),
    path: p.get('path') ?? '',
    table: p.get('table') === '1',
  };
}

/** The query string of `options`, '' when every option has its default. Defaults are left out. */
export function formatOptions(options: ViewOptions): string {
  const p = new URLSearchParams();
  for (const key of Object.keys(DEFAULT_OPTIONS) as (keyof ViewOptions)[]) {
    const value = options[key];
    if (value !== DEFAULT_OPTIONS[key]) p.set(key, value === true ? '1' : String(value));
  }
  const text = p.toString();
  return text === '' ? '' : `?${text}`;
}

export function formatHash(state: UrlState): string {
  const parts: string[] = [];
  if (state.view !== null) parts.push(state.view);
  const s = state.selection;
  if (s.kind === 'bucket') parts.push('bucket', s.name);
  else if (s.kind === 'edge') parts.push('edge', s.from, s.to);
  else if (s.kind === 'export') parts.push('export', s.bucket, s.name);
  else if (s.kind === 'file') parts.push('file', ...s.path.split('/'));
  const params: string[] = [];
  if (state.project !== '.') params.push(`project=${encodeURIComponent(state.project)}`);
  if (state.depth !== null) params.push(`depth=${state.depth}`);
  if (state.pair !== null) params.push(`pair=${state.pair.map(encodeURIComponent).join(',')}`);
  return `#/${parts.map(encodeURIComponent).join('/')}${params.length > 0 ? `?${params.join('&')}` : ''}`;
}
