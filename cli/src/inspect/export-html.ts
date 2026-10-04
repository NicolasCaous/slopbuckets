// `buckets inspect --export html`: the inspect page as one self-contained HTML file. The file holds the snapshot, the
// approvals read from git at export time and the exports the path simulation picks from, plus the stylesheets, the
// page script and the live renderers bundled for the browser (web/static-bundle.ts). Every view works in the file
// without a server: the page script renders a page from the data instead of fetching it, and the state of a page lives
// in the URL hash. A Content-Security-Policy in the file allows only its own inline scripts and styles, the fonts, and
// no requests at all. The file holds no absolute folder of the computer it was exported on.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CLI_VERSION } from '../version.js';
import { CLIENT_JS } from '../web/assets/client.js';
import { INSPECT_CSS, INSPECT_JS } from '../web/assets/inspect.js';
import { LOGO_SVG } from '../web/assets/logo.js';
import { THEME_CSS } from '../web/assets/theme.js';
import { html, raw } from '../web/html.js';
import type { View } from '../web/inspect-page.js';
import { packExports, packStaticData, STATIC_DATA_ID, staticOptions, type StaticData } from '../web/inspect-static.js';
import { renderPage } from '../web/layout.js';
import { buildStaticBundle, STATIC_BUNDLE_FILE } from '../web/static-bundle.js';
import { feedEvent } from './events.js';
import { codeExports } from './impact.js';
import type { InspectSnapshot } from './snapshot.js';
import { readTimeline, systemGit, type GitRunner, type Timeline } from './timeline.js';

export interface HtmlExportOptions {
  /** How git runs, for the timeline. Tests pass a fake. */
  git?: GitRunner;
  /** The browser script, when the caller already has it. */
  bundle?: string;
}

let bundleMemo: Promise<string> | null = null;

/**
 * The browser script: dist/inspect-static.js next to the built CLI, which tsup writes with the CLI. Running from the
 * source, as the tests do, it is built on the fly with esbuild from the same entry and options.
 */
export function staticBundle(): Promise<string> {
  bundleMemo ??= (async () => {
    const built = new URL(`./${STATIC_BUNDLE_FILE}`, import.meta.url);
    try {
      return readFileSync(built, 'utf8');
    } catch {
      // Not built: the source is running.
    }
    let esbuild: typeof import('esbuild');
    try {
      esbuild = await import('esbuild');
    } catch {
      throw new Error(`The browser script of the HTML export is missing (${fileURLToPath(built)}). Reinstall slopbuckets.`);
    }
    return buildStaticBundle(esbuild.build, fileURLToPath(new URL('../web/inspect-static-entry.ts', import.meta.url)));
  })();
  bundleMemo.catch(() => {
    bundleMemo = null;
  });
  return bundleMemo;
}

/** The snapshot without the absolute folders of this computer: each project's folder becomes its relative path. */
function withoutFolders(snapshot: InspectSnapshot): InspectSnapshot {
  return { ...snapshot, dir: snapshot.projects[0]?.name ?? '.', projects: snapshot.projects.map((p) => ({ ...p, dir: p.path })) };
}

function withoutRepos(timeline: Timeline): Timeline {
  return { tracks: timeline.tracks.map((t) => ({ ...t, repo: null })) };
}

/** The data the file carries, read now: the approvals from git and the exports of every `_/` folder. */
export async function staticData(snapshot: InspectSnapshot, git: GitRunner = systemGit()): Promise<StaticData> {
  let timeline: Timeline | null;
  try {
    timeline = withoutRepos(await readTimeline(snapshot, git));
  } catch {
    timeline = null;
  }
  const hidden: View[] = timeline === null || !timeline.tracks.some((t) => t.status === 'ok' && t.points.length > 0) ? ['timeline'] : [];
  const exports = Object.fromEntries(snapshot.projects.map((p) => [p.path, packExports(codeExports(p))]));
  const n = snapshot.projects.length;
  const text = `Snapshot of ${n === 1 ? '1 project' : `${n} projects`}, exported to a file. It does not watch files.`;
  return {
    snapshot: withoutFolders(snapshot),
    timeline,
    exports,
    feed: [feedEvent('start', '.', text, new Date(snapshot.generatedAt))],
    info: { takenAt: snapshot.generatedAt, cli: CLI_VERSION, hidden },
  };
}

function sha256Base64(text: string): string {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/** JSON for a `<script type="application/json">`: no `<` that could end the element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** The whole file for a snapshot, opened on the map of the starting project. */
export async function exportHtml(snapshot: InspectSnapshot, options: HtmlExportOptions = {}): Promise<string> {
  const [data, bundle] = await Promise.all([staticData(snapshot, options.git), options.bundle !== undefined ? Promise.resolve(options.bundle) : staticBundle()]);
  const css = [THEME_CSS, INSPECT_CSS];
  // Order matters: the shared script, then the renderers, then the page script that uses both.
  const js = [CLIENT_JS, bundle, INSPECT_JS];
  const csp = [
    "default-src 'none'",
    `script-src ${js.map(sha256Base64).join(' ')}`,
    `style-src ${css.map(sha256Base64).join(' ')} https://fonts.googleapis.com`,
    'font-src https://fonts.gstatic.com',
    'img-src data:',
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return renderPage({
    ...staticOptions(data, '/'),
    standalone: {
      css,
      js,
      icon: `data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}`,
      csp,
      data: html`  <script type="application/json" id="${STATIC_DATA_ID}">${raw(scriptJson(packStaticData(data)))}</script>\n`,
    },
  });
}
