// The HTML shell of the inspect page and the page bundle that scripts/build-inspect.mjs writes next to the CLI in
// dist/. The server links the bundle; `--export html` inlines it with the snapshot, so the file works offline.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SnapshotV2 } from '../../contract/index.js';

export const PAGE_SCRIPT = 'inspect-page.js';
/** Written only when the page imports CSS files. */
export const PAGE_CSS = 'inspect-page.css';

export interface PageAssets {
  script: string;
  css: string | null;
}

/**
 * Reads the page bundle. The default folder is the one of the running code, which is dist/ once tsup has bundled the
 * CLI into dist/index.js.
 */
export function readPageAssets(dir: string = fileURLToPath(new URL('.', import.meta.url))): PageAssets {
  const script = path.join(dir, PAGE_SCRIPT);
  if (!existsSync(script)) throw new Error(`the inspect page bundle is missing at ${script}. Run \`npm run build\` in cli/ first.`);
  const css = path.join(dir, PAGE_CSS);
  return { script: readFileSync(script, 'utf8'), css: existsSync(css) ? readFileSync(css, 'utf8') : null };
}

/** JSON that is safe inside a script element: `<` never appears raw, so `</script>` cannot end the element. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** Keeps inline code from closing its own element. esbuild already escapes these in strings; this covers the rest. */
function inline(code: string, tag: 'script' | 'style'): string {
  return code.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`);
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * The page. Without `embed`, it links /inspect-page.js and the page loads /snapshot.json and /events. With `embed`,
 * the bundle and the snapshot are inline and a meta CSP blocks every request, for the offline export. `rootName`, the
 * folder name of the root project, goes into the title and into `data-root` on #app, where the page reads it.
 */
export function pageHtml(assets: PageAssets, embed?: SnapshotV2, rootName = ''): string {
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    // The page background of each scheme, --bg in inspect.css.
    '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">',
    '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#16181c">',
    `<title>${rootName === '' ? '' : `${escapeHtml(rootName)}: `}buckets inspect</title>`,
  ];
  const body = [rootName === '' ? '<div id="app"></div>' : `<div id="app" data-root="${escapeHtml(rootName)}"></div>`];
  if (embed === undefined) {
    if (assets.css !== null) head.push(`<link rel="stylesheet" href="/${PAGE_CSS}">`);
    body.push(`<script src="/${PAGE_SCRIPT}"></script>`);
  } else {
    head.unshift(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src blob:; base-uri 'none'; form-action 'none'">`,
    );
    if (assets.css !== null) head.push(`<style>${inline(assets.css, 'style')}</style>`);
    body.push(`<script type="application/json" id="snapshot">${embedJson(embed)}</script>`);
    body.push(`<script>${inline(assets.script, 'script')}</script>`);
  }
  return `<!doctype html>\n<html lang="en">\n<head>\n${head.join('\n')}\n</head>\n<body>\n${body.join('\n')}\n</body>\n</html>\n`;
}
