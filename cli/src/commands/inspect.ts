// `buckets inspect`: a read-only local web page with the state of the project and of every project nested in it,
// updated live while files change. `--json` prints the same snapshot and exits without a server, and `--export` prints
// the map as SVG, the bucket graph as Mermaid or the whole page as one HTML file. Inspect never writes to the project;
// the check it runs may write its analysis cache in `.buckets/cache/`, as `buckets check` does.
import { existsSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from '../core/cache.js';
import { CONFIG_FILE, LOCK_FILE } from '../core/paths.js';
import { findProjectDir } from '../core/project.js';
import type { Context } from '../core/types.js';
import { EXPORT_FORMATS, exportMermaid, exportSvg, readOnlyCache, type ExportFormat } from '../inspect/export.js';
import { exportHtml } from '../inspect/export-html.js';
import type { GitRunner } from '../inspect/timeline.js';
import { buildSnapshot } from '../inspect/snapshot.js';
import { plural } from '../output/text.js';
import { INSPECT_IDLE_MINUTES, startInspectApp, type InspectApp } from '../web/inspect-app.js';
import { stderrStyle, stdoutStyle, type Io } from './io.js';

export const INSPECT_USAGE = 'Usage: buckets inspect [--json] [--no-recursive] [--export svg|mermaid|html [--out <file>]]\n';

const FORMAT_LIST = `${EXPORT_FORMATS.slice(0, -1).join(', ')} or ${EXPORT_FORMATS[EXPORT_FORMATS.length - 1]}`;
const WROTE: Record<ExportFormat, string> = { svg: 'the map as SVG', mermaid: 'the bucket graph as Mermaid', html: 'the inspect page as one HTML file' };

/** Seams for tests. */
export interface InspectDeps {
  idleTimeoutMs?: number;
  watch?: boolean | 'polling';
  debounceMs?: number;
  /** Called once the server listens. */
  onListening?: (app: InspectApp) => void;
  /** Resolves to stop the server, instead of Ctrl+C. */
  stop?: Promise<void>;
  /** How git runs, for the timeline of `--export html`. */
  git?: GitRunner;
}

/**
 * Why `--out` may not be written, or null. The export never replaces a lock file, also through a link, because only
 * a human approval writes `buckets.lock.json`.
 */
export function outProblem(file: string): string | null {
  const isLock = (p: string) => path.basename(p).toLowerCase() === LOCK_FILE;
  if (isLock(file)) return `${file} is a lock file. Only an approval writes ${LOCK_FILE}. Pick another file.`;
  if (existsSync(file)) {
    let real = file;
    try {
      real = realpathSync(file);
    } catch {
      // An unreadable path fails on write with its own message.
    }
    if (isLock(real)) return `${file} points to a lock file (${real}). Only an approval writes ${LOCK_FILE}. Pick another file.`;
    try {
      const stat = statSync(real);
      if (stat.isDirectory()) return `${file} is a folder. Give the path of a file, such as ${path.join(file, 'map.svg')}.`;
      // A hard link has no target to resolve, and writing it writes every name of the file, a lock included.
      if (stat.nlink > 1) return `${file} has other hard links, so writing it would also change those files, which can include ${LOCK_FILE}. Pick another file.`;
    } catch {
      // Same as above.
    }
  }
  return null;
}

export async function inspectCommand(ctx: Context, io: Io, args: string[], deps: InspectDeps = {}): Promise<number> {
  let asJson = false;
  let recursive = true;
  let format: ExportFormat | null = null;
  let outFile: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = (name: string): string | null => {
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) return null;
      i++;
      return next;
    };
    if (arg === '--json') asJson = true;
    else if (arg === '--no-recursive') recursive = false;
    else if (arg === '--export' || arg.startsWith('--export=')) {
      const given = value('--export');
      if (given === null || !(EXPORT_FORMATS as readonly string[]).includes(given)) {
        io.stderr(`buckets inspect: --export needs a format: ${FORMAT_LIST}${given !== null ? `, not "${given}"` : ''}.\n${INSPECT_USAGE}`);
        return 1;
      }
      format = given as ExportFormat;
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const given = value('--out');
      if (given === null || given === '') {
        io.stderr(`buckets inspect: --out needs a file path.\n${INSPECT_USAGE}`);
        return 1;
      }
      outFile = given;
    } else {
      io.stderr(`buckets inspect: unknown option "${arg}".\n${INSPECT_USAGE}`);
      return 1;
    }
  }
  if (outFile !== null && format === null) {
    io.stderr(`buckets inspect: --out only works with --export svg, mermaid or html.\n${INSPECT_USAGE}`);
    return 1;
  }
  const err = stderrStyle(io);
  const target = outFile !== null ? path.resolve(io.cwd, outFile) : null;
  if (target !== null) {
    const problem = outProblem(target);
    if (problem !== null) {
      io.stderr(`${err.error('Not written')}: ${problem}\n`);
      return 1;
    }
  }
  const projectDir = findProjectDir(io.cwd);
  if (projectDir === null) {
    io.stderr(`${err.error(`No ${CONFIG_FILE}`)} in ${io.cwd} or any parent folder. Run \`buckets init\` first.\n`);
    return 3;
  }
  const cacheDir = path.join(projectDir, CACHE_DIR);
  if (format !== null) {
    // An export reads the analysis cache but never writes it: the only file it writes is the one --out names.
    const snapshot = await buildSnapshot(ctx, projectDir, { cache: readOnlyCache(cacheDir), recursive });
    const svg = format === 'svg' ? exportSvg(snapshot) : null;
    const graph = format === 'mermaid' ? exportMermaid(snapshot) : null;
    const page = format === 'html' ? await exportHtml(snapshot, deps.git !== undefined ? { git: deps.git } : {}) : null;
    const text = svg?.svg ?? graph?.text ?? page!;
    if (target !== null) {
      try {
        writeFileSync(target, text, 'utf8');
      } catch (error) {
        io.stderr(`${err.error('Not written')}: ${target}: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
    if (asJson) {
      const extra = svg !== null ? { width: svg.width, height: svg.height } : graph !== null ? { nodes: graph.nodes, edges: graph.edges } : { bytes: Buffer.byteLength(text, 'utf8') };
      io.stdout(`${JSON.stringify({ format, file: target, ...extra, text }, null, 2)}\n`);
    } else if (target !== null) {
      io.stdout(`Wrote ${WROTE[format]} to ${target}.\n`);
    } else {
      io.stdout(text);
    }
    return 0;
  }
  const snapshot = await buildSnapshot(ctx, projectDir, { cacheDir, recursive });
  if (asJson) {
    io.stdout(`${JSON.stringify(snapshot, null, 2)}\n`);
    return 0;
  }

  const out = stdoutStyle(io);
  const app = await startInspectApp({
    ctx,
    projectDir,
    snapshot,
    ...(deps.idleTimeoutMs !== undefined ? { idleTimeoutMs: deps.idleTimeoutMs } : {}),
    ...(deps.watch !== undefined ? { watch: deps.watch } : {}),
    ...(deps.debounceMs !== undefined ? { debounceMs: deps.debounceMs } : {}),
  });
  const stop = (): void => void app.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const { summary } = snapshot;
    const state = summary.violations > 0 ? plural(summary.violations, 'violation') : summary.lockChanges > 0 ? plural(summary.lockChanges, 'lock difference') : 'every rule passes';
    io.stdout(
      `${out.bold('buckets inspect')}: ${plural(summary.projects, 'project')}, ${plural(summary.buckets, 'bucket')}, ${plural(summary.contracts, 'contract')}, ${state}.\n` +
        `The page is read only and updates while files change. Press Ctrl+C to stop. It stops by itself after ${INSPECT_IDLE_MINUTES} minutes without an open page.\n` +
        `${app.server.url}\n`,
    );
    deps.onListening?.(app);
    if (deps.stop) void deps.stop.then(() => app.close());
    await app.server.closed;
    return 0;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await app.close();
  }
}
