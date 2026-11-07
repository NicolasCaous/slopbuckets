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
  'guide/costs.md',
  'guide/coming-from.md',
  'guide/inspect.md',
  'guide/nested-projects.md',
  'guide/ci.md',
  'guide/performance.md',
  'guide/guarantees.md',
  'guide/adapters.md',
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

> slopbuckets keeps the architecture of a TypeScript or JavaScript project in one file, \`buckets.config.json\`: the buckets, the purpose of each one, which bucket depends on which and why. AI agents read and edit that file. Hooks in the agent stay silent while the code follows it, and when the code diverges they tell the agent, which either fixes the code or edits the file. Both are valid. The npm package is \`slopbuckets\` and the command is \`buckets\`.

This file follows the llms.txt format. The prompt "Install slopbuckets in this project and build its first architecture. Read ${PROMPT_URL} and follow the steps for agents." asks you to follow the steps below. The docs are at ${docsUrl}, and every page has a Markdown version at the same path with \`.md\` in place of \`.html\`.

**Install for agents.** Follow these steps in order, in the folder of the project the human named. Stop and show the human the output when a command fails or exits with a code the step does not expect.

1. Check that Node.js is version 20 or newer with \`node --version\`. If the project already has slopbuckets, in \`node_modules/slopbuckets\`, skip the install and run every \`buckets\` command below as \`npx buckets\`, such as \`npx buckets check\`. If \`buckets --version\` prints a version, slopbuckets is installed globally, so skip the install too. Otherwise install the CLI with \`npm install -g slopbuckets\`, then run \`buckets --version\`. If the global install fails because of permissions, stop and ask the human to install it. Do not use \`sudo\`.
2. Check that the project folder has a \`tsconfig.json\`. A JavaScript project needs one too, because slopbuckets does not read \`jsconfig.json\`. If it is missing, create one with \`npx -p typescript@6 tsc --init\` and tell the human you did. Do not install \`typescript\` for slopbuckets. It uses the project's TypeScript 5 or 6 when there is one, and otherwise its own TypeScript 6.
3. If the project folder already has a \`buckets.config.json\`, \`init\` has already run here, so skip this step. Otherwise run \`buckets init --agent <name>\`, where \`<name>\` is the coding agent you are: ${agentList}. If you are none of these, run \`buckets init --agent auto\`. It writes an empty \`buckets.config.json\` (\`"version": "2.0"\`, \`"buckets": {}\`, \`"ignore": []\`, \`"projects": []\`), installs the hooks of that agent, writes a block in \`AGENTS.md\`, copies the skill to \`.agents/skills/slopbuckets/SKILL.md\`, sets up the merge driver of the config in \`.gitattributes\` and adds \`.buckets/\` to \`.gitignore\`. It ends with warnings, such as a missing \`tsconfig.json\` or a hook command that is not on the PATH: tell the human each one. If \`init\` exits with 1, a setup step failed: show the human the failed lines, which start with \`!\` (or \`✗\` in a terminal) on stderr, and stop. If it exits with 64, the command line was wrong, for example an unknown agent name: read the usage it printed, fix the command and run it again. A 1.x \`buckets.config.json\` also makes \`init\` exit with 1 before it writes anything: tell the human, who renames that file. If \`init\` prints a step for the human, such as approving the hooks in the agent, tell the human.
4. Read \`.agents/skills/slopbuckets/SKILL.md\`. It says how to read the config, where a new file goes, when to create a bucket, how to write a purpose and a reason, and how to translate an Nx, eslint-plugin-boundaries, Sheriff or dependency-cruiser setup.
5. Build the first architecture. Run \`buckets check\`. Right after \`init\` it reports that the config has no buckets yet and lists the folders of the project with their file counts. Read the code and write the buckets in \`buckets.config.json\`: for each one a one-line \`purpose\`, the \`files\` globs, \`public\` (one file, a list of files, or \`null\` for an entry point that exports nothing), \`dependsOn\` with a one-line reason per bucket it imports, and \`packages\` with a one-line reason per npm package or Node built-in it imports, such as \`"node:fs"\`. Put tests, scripts and tool configs in \`ignore\`. A public file holds only named re-exports, such as \`export { charge } from './client'\`, so create one per bucket where none exists, then run \`buckets fix import-private\` to point the existing imports at the public files. On a large project, \`buckets check --summary\` gives the counts first. Run \`buckets check\` again after each change, and fix the code or the config for every violation, until it exits with 0.
6. Show the human the config and a short summary of the buckets and their dependencies. Tell the human to commit \`buckets.config.json\`, \`AGENTS.md\`, \`.agents/\`, \`.gitignore\`, \`.gitattributes\` and the files \`init\` wrote for your agent.

**What to avoid** when you build or change the architecture:

- One giant bucket, such as a single bucket with \`src/**\`. It passes every rule and says nothing about the architecture.
- A \`utils\` or \`shared\` bucket that every bucket depends on.
- A dependency added only to silence a warning. Write the real reason, or move the code.
- \`ignore\` as an escape hatch for code that belongs to a bucket, generated code that a bucket imports included.
- A reason or purpose that repeats the bucket name. Write it for the next agent, who will read it months later.

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
