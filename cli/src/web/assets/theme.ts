// The shared stylesheet of the local web pages, served as /assets/theme.css. It follows site/index.html:
// phosphor green on black, VT323 for display text, JetBrains Mono for the rest, scanlines, a tmux-style
// top bar and tty boxes. The fonts come from Google Fonts when the machine is online, and the stacks fall
// back to the system monospace fonts offline. Page-specific rules live in each page's own stylesheet.
export const THEME_CSS = String.raw`
:root {
  color-scheme: dark;
  --bg: #020904;
  --bg-2: #04140a;
  --bg-3: #072011;
  --phos: #3dff74;
  --phos-hi: #b8ffcc;
  --text: #b4f5c6;
  --dim: #6cbf86;
  --faint: #1f5532;
  --line: #2b8a4c;
  --amber: #ffc04d;
  --red: #ff6e61;
  --cyan: #8ef9ff;
  --ink: #021a0a;
  --glow: rgba(61, 255, 116, 0.55);
  --mono: "JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, "DejaVu Sans Mono", Menlo, monospace;
  --display: "VT323", "JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace;
  --bar-h: 46px;
  --gutter: max(16px, env(safe-area-inset-left));
}

*, *::before, *::after { box-sizing: border-box; }

html {
  background: var(--bg);
  -webkit-text-size-adjust: 100%;
  scroll-padding-top: calc(var(--bar-h) + 16px);
}

body {
  margin: 0;
  min-height: 100vh;
  background: radial-gradient(120% 70% at 50% 0%, #0a2a14 0%, rgba(2, 9, 4, 0) 60%), var(--bg);
  color: var(--text);
  font-family: var(--mono);
  font-size: 15px;
  line-height: 1.65;
  font-variant-ligatures: none;
  overflow-x: clip;
  touch-action: manipulation;
  -webkit-tap-highlight-color: rgba(61, 255, 116, 0.25);
  text-shadow: 0 0 1px rgba(61, 255, 116, 0.35);
}

::selection { background: var(--phos); color: var(--ink); text-shadow: none; }

a { color: var(--phos); text-underline-offset: 3px; text-decoration-thickness: 1px; }
a:hover { background: var(--phos); color: var(--ink); text-decoration: none; text-shadow: none; }

:focus-visible {
  outline: 2px solid var(--amber);
  outline-offset: 3px;
  box-shadow: 0 0 0 5px rgba(255, 192, 77, 0.22);
}

code, pre, kbd { font-family: var(--mono); }
:not(pre) > code {
  color: var(--phos-hi);
  background: rgba(61, 255, 116, 0.08);
  border: 1px solid var(--faint);
  padding: 0 0.3em;
  font-size: 0.92em;
  overflow-wrap: anywhere;
}

p { margin: 0 0 1em; text-wrap: pretty; }
h1, h2, h3 { text-wrap: balance; scroll-margin-top: calc(var(--bar-h) + 16px); }

.visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

.skip-link {
  position: absolute; left: 16px; top: -60px; z-index: 200;
  background: var(--amber); color: var(--ink); padding: 8px 14px;
  font-weight: 800; text-decoration: none; text-shadow: none;
}
.skip-link:focus-visible { top: 8px; }

/* CRT overlays */
.crt { position: fixed; inset: 0; pointer-events: none; z-index: 90; }
.crt-scan {
  background: repeating-linear-gradient(to bottom,
    rgba(0, 0, 0, 0) 0, rgba(0, 0, 0, 0) 2px,
    rgba(0, 0, 0, 0.18) 2px, rgba(0, 0, 0, 0.18) 4px);
  mix-blend-mode: multiply;
}
.crt-vignette {
  background: radial-gradient(130% 110% at 50% 50%, rgba(0, 0, 0, 0) 58%, rgba(0, 0, 0, 0.6) 100%);
  animation: flicker 5s steps(1) infinite;
}
.crt-roll {
  top: -30vh; bottom: auto; height: 26vh;
  background: linear-gradient(to bottom, rgba(61, 255, 116, 0), rgba(61, 255, 116, 0.04) 50%, rgba(61, 255, 116, 0));
  animation: roll 9s linear infinite;
}
html[data-crt="off"] .crt { display: none; }
html[data-crt="off"] body, html[data-crt="off"] h1, html[data-crt="off"] h2, html[data-crt="off"] h3 { text-shadow: none; }

@keyframes flicker {
  0% { opacity: 1; } 7% { opacity: 0.9; } 8% { opacity: 1; } 31% { opacity: 0.94; }
  32% { opacity: 1; } 63% { opacity: 0.88; } 64% { opacity: 1; } 89% { opacity: 0.95; } 90% { opacity: 1; }
}
@keyframes roll { from { transform: translateY(0); } to { transform: translateY(160vh); } }
@keyframes blink { 50% { opacity: 0; } }

/* tmux status bar */
.tmux {
  position: sticky; top: 0; z-index: 60;
  height: var(--bar-h);
  display: flex; align-items: stretch;
  background: rgba(2, 12, 6, 0.94);
  border-bottom: 1px solid var(--line);
  font-size: 13px;
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
}
.tmux-brand {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 0 14px; background: var(--phos); color: var(--ink);
  font-weight: 800; text-decoration: none; text-shadow: none;
}
.tmux-brand img { display: block; }
.tmux-nav {
  flex: 1 1 auto; min-width: 0;
  display: flex; align-items: stretch;
  overflow-x: auto; scrollbar-width: none;
  overscroll-behavior-x: contain;
}
.tmux-nav::-webkit-scrollbar { display: none; }
.tmux-nav a, .tmux-nav span.win {
  flex: none; display: flex; align-items: center; padding: 0 11px;
  color: var(--dim); text-decoration: none; white-space: nowrap;
}
.tmux-nav .n { color: var(--line); margin-right: 2px; }
.tmux-nav a:hover { background: rgba(61, 255, 116, 0.12); color: var(--phos-hi); }
.tmux-nav [aria-current="page"] { color: var(--phos); background: rgba(61, 255, 116, 0.1); }
.tmux-nav [aria-current="page"]::after { content: "*" / ""; color: var(--amber); margin-left: 1px; }
.tmux-nav a:focus-visible { outline-offset: -3px; }
.tmux-nav .project { color: var(--text); }
.tmux-right { flex: none; display: flex; align-items: stretch; }
.tmux-right a, .tmux-right button, .tmux-right .stat {
  display: flex; align-items: center; padding: 0 12px;
  color: var(--text); text-decoration: none;
  border: 0; border-left: 1px solid var(--faint); background: transparent;
  font: inherit; white-space: nowrap;
}
.tmux-right button { cursor: pointer; }
.tmux-right a:hover, .tmux-right button:hover { background: var(--phos); color: var(--ink); text-shadow: none; }
.tmux-right a:focus-visible, .tmux-right button:focus-visible { outline-offset: -3px; }
.tmux-right button[aria-pressed="false"] .crt-state { color: var(--red); }
.tmux-right button:hover .crt-state { color: var(--ink); }
.tmux-right .stat .led {
  width: 8px; height: 8px; border-radius: 50%; margin-right: 8px;
  background: var(--phos); box-shadow: 0 0 8px var(--glow);
}
.tmux-right .stat[data-state="wait"] .led { background: var(--amber); box-shadow: 0 0 8px rgba(255, 192, 77, 0.8); }
.tmux-right .stat[data-state="off"] .led { background: var(--red); box-shadow: 0 0 8px rgba(255, 110, 97, 0.8); }
.no-js #crt-toggle { display: none; }

/* screens (tty boxes) */
main { display: block; padding-bottom: 24px; }
.screen {
  position: relative;
  width: min(1180px, calc(100% - 2 * var(--gutter)));
  margin: 40px auto 0;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: linear-gradient(180deg, rgba(8, 38, 18, 0.55), rgba(2, 9, 4, 0.75) 240px);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.8), 0 0 48px rgba(61, 255, 116, 0.07), inset 0 0 60px rgba(0, 0, 0, 0.5);
}
.screen + .screen { margin-top: 28px; }
.screen-bar {
  display: flex; justify-content: space-between; gap: 12px;
  padding: 3px 12px;
  background: var(--phos); color: var(--ink);
  font-size: 12px; font-weight: 800; letter-spacing: 0.04em;
  text-shadow: none; white-space: nowrap; overflow: hidden;
}
.screen-bar span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.screen-bar.amber { background: var(--amber); }
.screen-bar.red { background: var(--red); color: #1a0402; }
.screen-body { padding: clamp(18px, 4vw, 44px); }
.screen-body > :last-child { margin-bottom: 0; }

.cmdline { margin: 0 0 10px; color: var(--dim); font-size: 14px; overflow-wrap: anywhere; }
.cmdline .ps { color: var(--amber); }
.cmdline .typed { color: var(--phos-hi); }
.cursor {
  display: inline-block; width: 0.62em; height: 1.1em; vertical-align: -0.15em; margin-left: 2px;
  background: var(--phos); box-shadow: 0 0 8px var(--glow);
  animation: blink 1s steps(1) infinite;
}

h1, h2 {
  font-family: var(--display); font-weight: 400;
  line-height: 0.92; letter-spacing: 0.01em;
  text-transform: uppercase; color: var(--phos);
  margin: 0 0 18px;
  text-shadow: 0 0 10px var(--glow), 0 0 30px rgba(61, 255, 116, 0.25), -1.5px 0 rgba(255, 60, 90, 0.28), 1.5px 0 rgba(60, 200, 255, 0.28);
}
h1 { font-size: clamp(2.6rem, 6vw, 4.6rem); color: var(--phos-hi); }
h2 { font-size: clamp(2rem, 4.4vw, 3rem); }
h3 {
  font-family: var(--display); font-weight: 400;
  font-size: clamp(1.6rem, 3vw, 2.1rem); line-height: 1;
  text-transform: uppercase; color: var(--phos);
  margin: 0 0 12px;
  text-shadow: 0 0 8px var(--glow);
}
.intro { max-width: 72ch; font-size: 16px; }
.dim { color: var(--dim); }
.ok { color: var(--phos); }
.warn { color: var(--amber); }
.bad { color: var(--red); }

/* buttons */
.btn {
  flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 44px; padding: 0 18px;
  font: inherit; font-size: 13px; font-weight: 800; letter-spacing: 0.08em;
  text-transform: uppercase; text-decoration: none;
  color: var(--phos); background: transparent;
  border: 1px solid var(--phos); cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease, box-shadow 120ms ease, opacity 120ms ease;
}
.btn:hover { background: var(--phos); color: var(--ink); text-shadow: none; box-shadow: 0 0 20px var(--glow); }
.btn:active { transform: translateY(1px); }
.btn-solid { background: var(--phos); color: var(--ink); text-shadow: none; }
.btn-solid:hover { background: var(--phos-hi); }
.btn-quiet { color: var(--text); border-color: var(--line); }
.btn-quiet:hover { background: var(--red); border-color: var(--red); color: #1a0402; box-shadow: 0 0 20px rgba(255, 110, 97, 0.45); }
.btn[disabled], .btn[aria-disabled="true"] { opacity: 0.55; cursor: progress; }
.btn[disabled]:hover { background: transparent; color: var(--phos); box-shadow: none; }
.btn-solid[disabled]:hover { background: var(--phos); color: var(--ink); }

/* terminal blocks and tables */
pre.term {
  margin: 0; padding: 14px 16px;
  background: rgba(0, 0, 0, 0.5); border: 1px solid var(--faint);
  overflow-x: auto; font-size: 13.5px; line-height: 1.6;
  box-shadow: inset 0 0 30px rgba(0, 0, 0, 0.6);
  scrollbar-width: thin; scrollbar-color: var(--line) transparent;
}
pre.term:focus-visible { outline-offset: -3px; }
pre.term.wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
.t-k { color: var(--phos); font-weight: 600; }
.t-s { color: var(--amber); }
.t-c { color: var(--dim); }

.table-scroll { overflow-x: auto; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; vertical-align: top; padding: 9px 12px; border-bottom: 1px dashed var(--faint); }
th { color: var(--dim); font-weight: 600; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; border-bottom: 1px solid var(--line); }
tbody tr:hover { background: rgba(61, 255, 116, 0.05); }

/* count tiles, like the exit code tiles on the site */
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 22px 0 0; padding: 0; list-style: none; }
.tiles li { border: 1px solid var(--faint); border-top: 3px solid var(--line); padding: 12px 14px 14px; background: rgba(0, 0, 0, 0.4); min-width: 0; }
.tiles .num { display: block; font-family: var(--display); font-size: 3.6rem; line-height: 0.8; margin-bottom: 8px; font-variant-numeric: tabular-nums; }
.tiles .what { display: block; color: var(--dim); font-size: 13px; }
.tiles .add { border-top-color: var(--phos); }
.tiles .add .num { color: var(--phos); text-shadow: 0 0 16px var(--glow); }
.tiles .del { border-top-color: var(--red); }
.tiles .del .num { color: var(--red); text-shadow: 0 0 16px rgba(255, 110, 97, 0.6); }
.tiles .chg { border-top-color: var(--amber); }
.tiles .chg .num { color: var(--amber); text-shadow: 0 0 16px rgba(255, 192, 77, 0.6); }
.tiles .all { border-top-color: var(--cyan); }
.tiles .all .num { color: var(--cyan); text-shadow: 0 0 16px rgba(142, 249, 255, 0.5); }

.callout {
  margin: 20px 0 0; padding: 14px 18px; border: 1px solid var(--line);
  background: rgba(61, 255, 116, 0.05); max-width: 80ch;
}
.callout.warn { border-color: var(--amber); background: rgba(255, 192, 77, 0.06); color: #ffe6b8; }
.callout.bad { border-color: var(--red); background: rgba(255, 110, 97, 0.06); color: #ffd3cd; }
.callout strong { color: inherit; }
.callout > :last-child { margin-bottom: 0; }

/* footer */
.foot {
  width: min(1180px, calc(100% - 2 * var(--gutter)));
  margin: 48px auto 0;
  padding: 18px 0 max(28px, env(safe-area-inset-bottom));
  border-top: 1px solid var(--line);
  display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px 24px;
  font-size: 13.5px; color: var(--dim);
}
.foot p { margin: 0; }
.foot .end { color: var(--phos); }

@media (max-width: 860px) {
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  body { font-size: 14.5px; }
  .tmux-brand .name { display: none; }
  .tmux-brand { padding: 0 11px; }
  .tmux-right .stat .label { display: none; }
  .tmux-right .stat .led { margin-right: 0; }
  .screen { margin-top: 24px; }
  .tiles .num { font-size: 2.8rem; }
  pre.term { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; }
}
@media (max-width: 380px) {
  .tmux-right a, .tmux-right button, .tmux-right .stat { padding: 0 9px; }
  .tmux-nav a, .tmux-nav span.win { padding: 0 8px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition-duration: 0.01ms !important; }
  .crt-roll { display: none; }
}
`;
