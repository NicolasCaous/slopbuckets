// Writes the files for AI agents after `vitepress build`:
//   site/docs/**/*.md    a Markdown version of every docs page, next to its HTML
//   site/llms.txt        the llmstxt.org index: install steps for agents and links to the Markdown pages
//   site/llms-full.txt   every docs page in one file, in sidebar order
// It reads the same sources as the HTML pages: the hand-written guide pages and the reference pages that
// generate.mjs wrote. VitePress resolves the config, so the page list, the sidebar order and the base are the
// ones of the build. HTML that the pages use (tables, CLI messages, figures, inline code and links) becomes
// plain Markdown, and every docs link points at the Markdown version of its page.
//
// Links are absolute. The origin is https://nicolascaous.github.io for the production base and
// http://localhost:4173 (the local preview in .claude/launch.json) for any other base. DOCS_ORIGIN overrides it.
// Run with `npm run docs:build -w docs`, which runs this script last.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'vitepress';

const here = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(here, '..');
const config = await resolveConfig(docsRoot, 'build', 'production');
const base = config.site.base;
const origin = process.env.DOCS_ORIGIN ?? (base.startsWith('/slopbuckets/') ? 'https://nicolascaous.github.io' : 'http://localhost:4173');
const docsUrl = new URL(base, origin).href;
// The docs build into site/docs/, so the site root is the folder above, at the URL above.
if (path.basename(config.outDir) !== 'docs') throw new Error(`llms.mjs expects the docs to build into a docs/ folder, not ${config.outDir}`);
const siteDir = path.dirname(config.outDir);
const siteUrl = new URL('../', docsUrl).href;

/** Pages that llms.txt lists under "Optional": useful, but not needed to install or use slopbuckets. */
const OPTIONAL = new Set([
  'guide/inspect.md',
  'guide/projects-and-links.md',
  'guide/ci.md',
  'guide/threat-model.md',
  'guide/adapters.md',
  'reference/links.md',
  'reference/inspect.md',
  'reference/adapter-protocol.md',
]);

/* ---------- pages in sidebar order ---------- */
const toPage = (link) => {
  const p = link.replace(/^\//, '').replace(/#.*$/, '');
  return p === '' || p.endsWith('/') ? `${p}index.md` : `${p.replace(/\.html$/, '')}.md`;
};
const groups = [];
for (const group of config.site.themeConfig.sidebar ?? []) {
  const pages = (group.items ?? []).filter((i) => typeof i.link === 'string' && i.link.startsWith('/')).map((i) => ({ page: toPage(i.link), text: i.text }));
  if (pages.length) groups.push({ text: group.text, pages });
}
const inSidebar = new Set(groups.flatMap((g) => g.pages.map((p) => p.page)));
for (const g of groups) for (const p of g.pages) if (!config.pages.includes(p.page)) throw new Error(`The sidebar links ${p.page}, which is not a docs page`);
const order = ['index.md', ...groups.flatMap((g) => g.pages.map((p) => p.page)), ...config.pages.filter((p) => p !== 'index.md' && !inSidebar.has(p)).sort()];

const htmlUrl = (page) => docsUrl + page.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '.html');
const mdUrl = (page) => docsUrl + page;

/* ---------- HTML and VitePress syntax to plain Markdown ---------- */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENTITIES[e.toLowerCase()] ?? m;
});
/** A Markdown code span that survives backticks in its text. */
const codeSpan = (text) => {
  const runs = text.match(/`+/g) ?? [];
  const ticks = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  return ticks.length > 1 ? `${ticks} ${text} ${ticks}` : `\`${text}\``;
};

function frontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(src);
  if (!m) return { data: {}, body: src };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return { data, body: src.slice(m[0].length) };
}

/** The absolute URL of a link in `page`: a docs page becomes its .md version, an asset keeps its path. */
function resolveLink(href, page) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  if (href.startsWith('#')) return mdUrl(page) + href;
  const url = new URL(href, `https://docs.invalid/${page}`);
  let p = decodeURIComponent(url.pathname).replace(/^\//, '');
  if (p === '' || p.endsWith('/')) p += 'index.md';
  else if (p.endsWith('.html')) p = p.slice(0, -5) + '.md';
  else if (!/\.[a-z0-9]+$/i.test(p)) p += '.md';
  return docsUrl + p + url.hash;
}

/** Inline HTML to Markdown, outside Markdown code spans. Links point at absolute .md URLs. */
function inline(text, page, { cell = false } = {}) {
  const parts = text.split(/(`+[^`]*?`+)/);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part;
    const kept = [];
    const keep = (s) => `\u0000${kept.push(s) - 1}\u0000`;
    let s = part.replace(/<code>([\s\S]*?)<\/code>/g, (_, c) => keep(codeSpan(decode(c.replace(/<wbr>/g, '')))));
    s = s.replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_, h, t) => `[${t}](${resolveLink(decode(h), page)})`);
    s = s.replace(/\]\(([^)\s]+)\)/g, (m, h) => (h.startsWith('\u0000') ? m : `](${resolveLink(h, page)})`));
    s = s
      .replace(/<wbr\s*\/?>/g, '')
      .replace(/<br\s*\/?>/g, cell ? ' ' : '  \n')
      .replace(/<\/?(strong|b)>/g, '**')
      .replace(/<\/?(em|i)>/g, '*')
      .replace(/<\/?span[^>]*>/g, '');
    s = decode(s);
    if (cell) s = s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
    return s.replace(/\u0000(\d+)\u0000/g, (_, n) => (cell ? kept[Number(n)].replace(/\|/g, '\\|') : kept[Number(n)]));
  }).join('');
}

function table(html, page) {
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<t([hd])[^>]*>([\s\S]*?)<\/t\1>/g)].map((c) => inline(c[2].trim(), page, { cell: true }).trim()));
  if (rows.length === 0) return '';
  const [head, ...body] = rows;
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

/**
 * HTML blocks to Markdown in a stretch of the page outside code fences. Each converted block is kept aside in
 * `kept` and leaves a placeholder, so the inline pass does not convert its text a second time.
 */
function blocks(text, page, kept) {
  const keep = (s) => `\u0001${kept.push(s) - 1}\u0001`;
  return text
    .replace(/<script\b[\s\S]*?<\/script>\s*|<style\b[\s\S]*?<\/style>\s*/g, '')
    .replace(/(?:<div class="table-wrap">)?<table[^>]*>([\s\S]*?)<\/table>(?:<\/div>)?/g, (_, t) => keep(table(t, page)))
    .replace(/<div class="msg"[^>]*>([\s\S]*?)<\/div>/g, (_, m) => keep(`\`\`\`text\n${decode(m.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ''))}\n\`\`\``))
    .replace(/<figure[^>]*>([\s\S]*?)<\/figure>/g, (_, f) => {
      const img = /<img\b([^>]*)>/.exec(f)?.[1] ?? '';
      const attr = (name) => decode(new RegExp(`\\b${name}="([^"]*)"`).exec(img)?.[1] ?? '');
      const caption = /<figcaption>([\s\S]*?)<\/figcaption>/.exec(f)?.[1];
      return `${keep(`![${attr('alt')}](${resolveLink(attr('src').replace(/^\//, ''), 'index.md')})`)}${caption ? `\n\n${caption.trim()}` : ''}`;
    })
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/g, '$1')
    .replace(/^[ \t]*<\/?div\b[^>]*>[ \t]*$/gm, '');
}

/** One docs page as plain Markdown, with its front matter. */
function toMarkdown(src, page) {
  const { data, body } = frontmatter(src);
  const out = [];
  let prose = [];
  let fence = null;
  let container = 0;
  const flush = () => {
    if (!prose.length) return;
    const kept = [];
    const converted = blocks(prose.join('\n'), page, kept);
    // Inline conversion works paragraph by paragraph, so a code span never pairs across paragraphs.
    const paragraphs = converted.split(/(\n{2,})/).map((para, i) => (i % 2 ? para : inline(para, page))).join('');
    out.push(paragraphs.replace(/\u0001(\d+)\u0001/g, (_, n) => kept[Number(n)]));
    prose = [];
  };
  for (const line of body.split(/\r?\n/)) {
    const quote = container > 0 ? '> ' : '';
    if (fence) {
      out.push(quote + line);
      if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    const open = /^(\s*)(`{3,}|~{3,})\s*([^\s{[:]*)/.exec(line);
    if (open) {
      flush();
      fence = open[2];
      out.push(`${quote}${open[1]}${open[2]}${open[3]}`);
      continue;
    }
    const custom = /^:::\s*([a-z-]+)\s*(.*)$/i.exec(line);
    if (custom) {
      flush();
      container++;
      out.push(`> **${custom[2].trim() || custom[1][0].toUpperCase() + custom[1].slice(1)}**`, '>');
      continue;
    }
    if (/^:::\s*$/.test(line) && container > 0) {
      flush();
      container--;
      continue;
    }
    if (/^\s*\[\[toc\]\]\s*$/.test(line)) continue;
    prose.push(quote + line.replace(/^(#{1,6} .*?)\s*\{#[^}]+\}\s*$/, '$1'));
  }
  flush();
  const text = out.join('\n').replace(/[ \t]+$/gm, (m) => (m === '  ' ? m : '')).replace(/\n{3,}/g, '\n\n').trim();
  return { title: data.title ?? /^# (.+)$/m.exec(text)?.[1] ?? page, description: data.description ?? '', text: `${text}\n` };
}

/* ---------- write the Markdown pages ---------- */
const docs = new Map();
for (const page of order) {
  const md = toMarkdown(readFileSync(path.join(config.srcDir, page), 'utf8'), page);
  docs.set(page, md);
  const file = path.join(config.outDir, page);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, md.text, 'utf8');
}

/* ---------- llms.txt ---------- */
// generate.mjs takes the agents of `buckets init --agent` from the built CLI.
const agents = JSON.parse(readFileSync(path.join(docsRoot, 'reference', 'agents.json'), 'utf8'));
if (!agents.length) throw new Error('docs/reference/agents.json lists no agents. Run docs/scripts/generate.mjs first.');
const agentNames = agents.map((a) => `\`${a.name}\` (${a.title})`);
const agentList = `${agentNames.slice(0, -1).join(', ')} or ${agentNames.at(-1)}`;
const PROMPT_URL = 'https://nicolascaous.github.io/slopbuckets/llms.txt';
const item = (page, text) => `- [${text ?? docs.get(page).title}](${mdUrl(page)}): ${docs.get(page).description}`;
const sections = [];
for (const g of groups) {
  const main = g.pages.filter((p) => !OPTIONAL.has(p.page));
  if (main.length) sections.push(`## ${g.text}\n\n${main.map((p) => item(p.page, p.text)).join('\n')}`);
}
const optional = groups.flatMap((g) => g.pages).filter((p) => OPTIONAL.has(p.page));
sections.push(`## Optional\n\n${[...optional.map((p) => item(p.page, p.text)), `- [Full docs in one file](${siteUrl}llms-full.txt): every docs page as Markdown, in sidebar order.`].join('\n')}`);

const llms = `# slopbuckets

> slopbuckets splits a TypeScript project into sealed folders called buckets. Inside a bucket, an AI agent writes any code it wants. Between buckets, every import goes through a contract file in a \`dmz/\` folder, and a human approves every contract change in \`buckets.lock.json\`. The npm package is \`slopbuckets\` and the command is \`buckets\`.

This file follows the llms.txt format. The prompt "Install slopbuckets in this project. Read ${PROMPT_URL} and follow the steps for agents." asks you to follow the install steps below. The docs are at ${docsUrl}, and every page has a Markdown version at the same path with \`.md\` in place of \`.html\`.

**Install for agents.** Follow these steps in order, in the folder of the project the human named. Stop and show the human the output when a command fails or exits with a code other than the one the step expects.

1. Check that Node.js is version 20 or newer with \`node --version\`. Install the CLI with \`npm install -g slopbuckets\`, then run \`buckets --version\`. If the global install fails because of permissions, stop and ask the human to install it. Do not use \`sudo\`.
2. Check that the project folder has a \`tsconfig.json\` and that \`typescript\` is in its \`node_modules\`, because the TypeScript adapter loads the compiler from the project. If \`typescript\` is missing, install it with \`npm install --save-dev typescript\`. If \`tsconfig.json\` is missing, create one with \`npx tsc --init\` and tell the human you did.
3. Run \`buckets init --yes --agent <name>\`, where \`<name>\` is the coding agent you are: ${agentList}. If you are none of these, run \`buckets init --yes --agent auto\`, which picks the agents whose folders are already in the project. It takes the defaults without asking: it writes \`buckets.config.json\` with a generated alias such as \`@root-k3x9pm2a\`, creates \`root/_/\`, adds the alias and \`noUnusedLocals\` to \`tsconfig.json\`, installs the hooks of that agent, such as \`.claude/settings.json\` for Claude Code or \`.codex/hooks.json\` for Codex CLI, writes the rules in a block of \`AGENTS.md\` and copies the skill to \`.agents/skills/slopbuckets/SKILL.md\`. It never writes the lock. Exit code 3 means an environment problem. Show the human the message and stop. If \`init\` prints a step for the human, such as approving the hooks in the agent, tell the human.
4. Show the human what \`init\` did: its output, and the changes to \`tsconfig.json\` and to the files of your agent, for example with \`git diff\`. Read \`.agents/skills/slopbuckets/SKILL.md\`, which has the rules for working in the project from now on.
5. Ask the human to approve the first state. Run exactly \`buckets refresh --web\` in the background. It prints the state and, on its last line, a link to a review page on \`127.0.0.1\`. Send the human that link and say that the page shows a confirmation code that they type into a window of their operating system. Wait for the command to finish. Do not open the page or call its endpoints. Exit code 0 means the human approved and \`buckets.lock.json\` exists. Exit code 1 means the human cancelled or the page timed out. Ask the human what to do, and do not retry on your own.
6. If \`buckets refresh --web\` says it cannot ask for approval on this machine (an SSH session, a container or no desktop), or the human prefers a terminal, ask the human to run \`buckets refresh\` in their own terminal and answer \`y\`.
7. Run \`buckets check\`. Exit code 0 means the setup is done. Tell the human to commit \`buckets.lock.json\` together with \`buckets.config.json\`, \`tsconfig.json\`, \`AGENTS.md\`, \`.agents/\` and the files \`init\` wrote for your agent.

**Rules you must never break**, during the install and after it:

- Never create, edit, move or delete any \`buckets.lock.json\`, nested ones included, under any name or path: no short names, links, wildcards or scripts that compute the name. Only a human approves a state.
- Never create, edit, move or delete any \`buckets.config.json\` yourself. \`buckets init\` writes it, and after that only a human changes it. When a task needs a change in it, such as an \`access\` line, stop and ask the human with the exact line.
- Never run plain \`buckets refresh\`, or any form of it other than exactly \`buckets refresh --web\`. A human runs \`buckets refresh\` in their own terminal.
- Never type the confirmation code, and never ask the human for it. The human reads it on the review page and types it into the window of the operating system.

${sections.join('\n\n')}
`;
writeFileSync(path.join(siteDir, 'llms.txt'), llms, 'utf8');

/* ---------- llms-full.txt ---------- */
const full = [
  `# slopbuckets documentation, full text\n\n> Every page of the slopbuckets docs as Markdown, in sidebar order. The index with the install steps for agents is ${siteUrl}llms.txt.`,
  ...order.map((page) => {
    const { text } = docs.get(page);
    const withUrl = /^# .+$/m.test(text) ? text.replace(/^(# .+)$/m, `$1\n\nURL: ${htmlUrl(page)}\nMarkdown: ${mdUrl(page)}`) : `# ${docs.get(page).title}\n\nURL: ${htmlUrl(page)}\nMarkdown: ${mdUrl(page)}\n\n${text}`;
    return withUrl.trim();
  }),
].join('\n\n---\n\n');
writeFileSync(path.join(siteDir, 'llms-full.txt'), `${full}\n`, 'utf8');

console.log(`llms.mjs: wrote ${order.length} Markdown pages, llms.txt and llms-full.txt for ${docsUrl}`);
