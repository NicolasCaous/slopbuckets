// The page shell shared by every local page: head with the theme and fonts, CRT overlays, the tmux-style top bar,
// a main area for the page's tty boxes, the footer and the shared script. A page passes its own content,
// stylesheet and script paths; `sharedAssetRoutes` serves the files the shell links to.
import { CLIENT_JS } from './assets/client.js';
import { LOGO_SVG } from './assets/logo.js';
import { THEME_CSS } from './assets/theme.js';
import { html, raw, type SafeHtml } from './html.js';
import { asset, type Route } from './server.js';

export interface NavItem {
  label: string;
  /** Omit for a window that is not a link, such as the only page of `refresh --web`. */
  href?: string;
  current?: boolean;
}

export interface PageOptions {
  /** The tab title. */
  title: string;
  /** The server token, written into a meta tag for `buckets.post`. */
  token: string;
  /** Project name, shown in the top bar after the windows. */
  project: string;
  nav: NavItem[];
  /** The status at the right of the top bar. `state` picks the LED color. */
  status: { state: 'live' | 'wait' | 'off'; label: string };
  /** The content of <main>, usually one or more `.screen` boxes. */
  main: SafeHtml;
  /** Extra stylesheets and scripts served by the page's own routes. */
  styles?: string[];
  scripts?: string[];
  /** Left text of the footer. */
  footer: SafeHtml | string;
  /** Right text of the footer. Default `[127.0.0.1 only]`. */
  footerEnd?: string;
  /** A line between the top bar and the content, kept when a script swaps the content. */
  banner?: SafeHtml;
  /**
   * A page that is a file of its own, such as `inspect --export html`: its stylesheets and scripts are written into
   * the page in this order, after `data`, the icon is a data URL, and `csp` goes into a meta tag. `styles` and
   * `scripts` are ignored, and the page has no server token.
   */
  standalone?: { css: string[]; js: string[]; icon: string; csp: string; data?: SafeHtml };
}

/** The windows of the top bar, as the inside of `.tmux-nav`. A live update replaces them alone. */
export function renderNav(items: NavItem[], project: string): SafeHtml {
  const nav = items.map((item, i) => {
    const label = html`<span class="n" aria-hidden="true">${i}:</span>${item.label}`;
    return item.href !== undefined
      ? html`<a href="${item.href}"${item.current ? html` aria-current="page"` : ''}>${label}</a>`
      : html`<span class="win"${item.current ? html` aria-current="page"` : ''}>${label}</span>`;
  });
  return html`${nav}
      <span class="win project" translate="no" title="${project}">${project}</span>`;
}

export function renderPage(options: PageOptions): string {
  const alone = options.standalone;
  const icon = alone?.icon ?? '/assets/logo.svg';
  const head = alone
    ? html`  <meta http-equiv="Content-Security-Policy" content="${alone.csp}">
  <title>${options.title}</title>
  <link rel="icon" href="${icon}" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;800&amp;family=VT323&amp;display=swap">
${alone.css.map((css) => html`  <style>${raw(css)}</style>\n`)}`
    : html`  <meta name="buckets-token" content="${options.token}">
  <title>${options.title}</title>
  <link rel="icon" href="${icon}" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;800&amp;family=VT323&amp;display=swap">
  <link rel="stylesheet" href="/assets/theme.css">
${(options.styles ?? []).map((href) => html`  <link rel="stylesheet" href="${href}">\n`)}`;
  const scripts = alone
    ? html`${alone.data ?? ''}${alone.js.map((js) => html`  <script>${raw(js)}</script>\n`)}`
    : html`  <script src="/assets/app.js"></script>
${(options.scripts ?? []).map((src) => html`  <script src="${src}"></script>\n`)}`;
  const page = html`<!doctype html>
<html lang="en" class="no-js" data-crt="off">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#020904">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex">
${head}</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <div class="crt crt-scan" aria-hidden="true"></div>
  <div class="crt crt-roll" aria-hidden="true"></div>
  <div class="crt crt-vignette" aria-hidden="true"></div>

  <header class="tmux">
    <span class="tmux-brand" translate="no">
      <img src="${icon}" width="24" height="24" alt="">
      <span class="name">slopbuckets</span>
    </span>
    <nav class="tmux-nav" aria-label="Pages">
      ${renderNav(options.nav, options.project)}
    </nav>
    <div class="tmux-right">
      <span class="stat" id="server-status" data-state="${options.status.state}"><span class="led" aria-hidden="true"></span><span class="label">${options.status.label}</span></span>
      <button type="button" id="crt-toggle" aria-pressed="false" title="Turn scanlines, glow and flicker on or off">CRT&nbsp;<span class="crt-state">off</span></button>
    </div>
  </header>
${options.banner ?? ''}
  <main id="main" tabindex="-1">
${options.main}
  </main>

  <footer class="foot">
    <p>${options.footer}</p>
    <p class="end" aria-hidden="true">${options.footerEnd ?? '[127.0.0.1 only]'}</p>
  </footer>

  <p class="visually-hidden" aria-live="polite" id="live-status"></p>
${scripts}</body>
</html>
`;
  return page.value;
}

/** Routes for the files every page links to. */
export function sharedAssetRoutes(): Route[] {
  return [
    { method: 'GET', path: '/assets/theme.css', handler: asset(THEME_CSS, 'text/css; charset=utf-8') },
    { method: 'GET', path: '/assets/app.js', handler: asset(CLIENT_JS, 'text/javascript; charset=utf-8') },
    { method: 'GET', path: '/assets/logo.svg', handler: asset(LOGO_SVG, 'image/svg+xml') },
  ];
}
