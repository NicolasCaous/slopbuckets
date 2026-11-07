// `buckets inspect`: a read-only local page with the architecture of the project, updated while files change.
// `--json` prints the snapshot and exits. `--export` prints the bucket graph as SVG, Mermaid or DOT, or the whole page
// as one offline HTML file, and exits without a server.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { stderrStyle, stdoutStyle, type Context, type Io } from '../context/index.js';
import { CONFIG_FILE, EXIT_CODES } from '../contract/index.js';
import { findProjectDir } from '../files/index.js';
import {
  EXPORT_FORMATS,
  exportDot,
  exportMermaid,
  INSPECT_IDLE_MINUTES,
  keepRoot,
  outProblem,
  pageHtml,
  readPageAssets,
  renderGraphSvg,
  rootName,
  startInspectApp,
  type ExportFormat,
  type InspectApp,
} from '../inspect/index.js';
import { message } from '../output/index.js';
import { FAILED, parseCommand, type ParsedArgs } from './io.js';

export const INSPECT_USAGE = 'Usage: buckets inspect [--json] [--no-recursive] [--export svg|mermaid|dot|html [--out <file>]]';

/** Seams for tests. */
export interface InspectDeps {
  /** The folder of the page bundle. Default: the folder of the running CLI. */
  pageDir?: string;
  idleTimeoutMs?: number;
  debounceMs?: number;
  watch?: boolean;
  /** Called once the server listens. */
  onListening?: (app: InspectApp) => void;
  /** Resolves to stop the server, instead of Ctrl+C. */
  stop?: Promise<void>;
}

interface Options {
  json: boolean;
  recursive: boolean;
  format: ExportFormat | null;
  out: string | null;
}

const OPTIONS = { json: { type: 'boolean' }, 'no-recursive': { type: 'boolean' }, export: { type: 'string' }, out: { type: 'string' } } as const;

/** The options of a command line that parseCommand accepted, or the problem for stderr. */
export function inspectOptions(values: ParsedArgs['values']): Options | string {
  const format = values.export as string | undefined;
  const out = values.out as string | undefined;
  if (format !== undefined && !(EXPORT_FORMATS as readonly string[]).includes(format)) return `--export needs a format: ${EXPORT_FORMATS.join(', ')}, not "${format}".`;
  if (out === '') return '--out needs a file path.';
  if (out !== undefined && format === undefined) return '--out only works with --export.';
  if (values.json === true && format !== undefined) return '--json and --export do not go together. Pick one.';
  return { json: values.json === true, recursive: values['no-recursive'] !== true, format: (format as ExportFormat | undefined) ?? null, out: out ?? null };
}

export async function inspectCommand(ctx: Context, io: Io, args: string[], deps: InspectDeps = {}): Promise<number> {
  const err = stderrStyle(io);
  const parsed = parseCommand(io, 'inspect', INSPECT_USAGE, args, OPTIONS);
  if (typeof parsed === 'number') return parsed;
  const options = inspectOptions(parsed.values);
  if (typeof options === 'string') {
    io.stderr(`${err.error('buckets inspect:')} ${options} ${INSPECT_USAGE}\n`);
    return EXIT_CODES.usage;
  }
  const target = options.out !== null ? path.resolve(io.cwd, options.out) : null;
  const problem = target !== null ? outProblem(target) : null;
  if (problem !== null) {
    io.stderr(`${err.error('Not written')}: ${problem}\n`);
    return FAILED;
  }
  const root = findProjectDir(io.cwd, io.env);
  if (root === null) {
    io.stderr(`${err.error(`No ${CONFIG_FILE}`)} in ${io.cwd} or any parent folder. Run \`buckets init\` first.\n`);
    return EXIT_CODES.environment;
  }
  const loadAssets = () => {
    try {
      return readPageAssets(deps.pageDir);
    } catch (error) {
      io.stderr(`${err.error('buckets inspect')}: ${message(error)}\n`);
      return null;
    }
  };

  let snapshot = await ctx.engine.snapshot(root);
  if (!options.recursive) snapshot = keepRoot(snapshot);
  if (options.json) {
    io.stdout(`${JSON.stringify(snapshot, null, 2)}\n`);
    return EXIT_CODES.ok;
  }

  if (options.format !== null) {
    let text: string;
    if (options.format === 'mermaid') text = exportMermaid(snapshot, rootName(root));
    else if (options.format === 'dot') text = exportDot(snapshot, rootName(root));
    else if (options.format === 'svg') text = renderGraphSvg(snapshot, rootName(root));
    else {
      const assets = loadAssets();
      if (assets === null) return EXIT_CODES.environment;
      text = pageHtml(assets, snapshot, rootName(root));
    }
    if (target === null) {
      io.stdout(text);
      return EXIT_CODES.ok;
    }
    try {
      writeFileSync(target, text, 'utf8');
    } catch (error) {
      io.stderr(`${err.error('Not written')}: ${target}: ${message(error)}\n`);
      return FAILED;
    }
    io.stdout(`Wrote the ${options.format} export to ${target}.\n`);
    return EXIT_CODES.ok;
  }

  const assets = loadAssets();
  if (assets === null) return EXIT_CODES.environment;
  const app = await startInspectApp({
    engine: ctx.engine,
    root,
    recursive: options.recursive,
    assets,
    snapshot,
    onError: (error) => io.stderr(`${err.error('buckets inspect')}: the snapshot failed, the page keeps the last one: ${message(error)}\n`),
    ...(deps.idleTimeoutMs !== undefined ? { idleTimeoutMs: deps.idleTimeoutMs } : {}),
    ...(deps.debounceMs !== undefined ? { debounceMs: deps.debounceMs } : {}),
    ...(deps.watch !== undefined ? { watch: deps.watch } : {}),
  });
  const stop = (): void => void app.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const out = stdoutStyle(io);
    const live = app.watching ? 'The page is read only and updates while files change.' : 'The page is read only. This system cannot watch the folder, so reload the page to see changes.';
    io.stdout(`${out.bold('buckets inspect')}: ${live} Press Ctrl+C to stop. It stops by itself after ${INSPECT_IDLE_MINUTES} minutes without an open page.\n${app.server.url}\n`);
    deps.onListening?.(app);
    if (deps.stop) void deps.stop.then(() => app.close());
    await app.server.closed;
    return EXIT_CODES.ok;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await app.close();
  }
}
