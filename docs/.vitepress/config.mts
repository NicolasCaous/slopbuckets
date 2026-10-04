import { defineConfig } from 'vitepress';

// The docs are published at https://nicolascaous.github.io/slopbuckets/docs/ and built into site/docs/.
// DOCS_BASE and DOCS_LANDING let a local preview serve them from another path.
const base = process.env.DOCS_BASE ?? '/slopbuckets/docs/';
const landing = process.env.DOCS_LANDING ?? 'https://nicolascaous.github.io/slopbuckets/';
const repo = 'https://github.com/NicolasCaous/slopbuckets';

// A phosphor palette for code blocks, matching the landing page.
const phosphor = {
  name: 'phosphor',
  type: 'dark',
  colors: { 'editor.background': '#010803', 'editor.foreground': '#b4f5c6' },
  tokenColors: [
    { settings: { foreground: '#b4f5c6' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#6cbf86', fontStyle: 'italic' } },
    { scope: ['string', 'string.quoted', 'string.template'], settings: { foreground: '#ffc04d' } },
    { scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control'], settings: { foreground: '#3dff74' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character'], settings: { foreground: '#8ef9ff' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'entity.name.interface'], settings: { foreground: '#8ef9ff' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: '#b8ffcc' } },
    { scope: ['variable.other.property', 'support.type.property-name', 'meta.object-literal.key'], settings: { foreground: '#b8ffcc' } },
    { scope: ['punctuation', 'meta.brace'], settings: { foreground: '#7fd197' } },
  ],
};

export default defineConfig({
  lang: 'en-US',
  title: 'slopbuckets docs',
  titleTemplate: ':title | slopbuckets docs',
  description: 'Documentation for slopbuckets, sealed folders for AI-written code.',
  base,
  outDir: '../site/docs',
  cacheDir: './.vitepress/cache',
  appearance: 'force-dark',
  lastUpdated: false,
  head: [
    ['link', { rel: 'icon', href: `${base}logo.svg`, type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#020904' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400;0,600;0,800;1,400&family=VT323&display=swap' }],
  ],
  // docs/scripts/llms.mjs writes a Markdown version of every page next to its HTML, at the path of its source.
  transformHead({ pageData }) {
    if (pageData.isNotFound || !pageData.relativePath) return [];
    return [['link', { rel: 'alternate', type: 'text/markdown', href: `${base}${pageData.relativePath}`, title: 'This page as Markdown' }]];
  },
  markdown: {
    theme: phosphor as never,
    lineNumbers: false,
    // Wrap every markdown table, so a wide table scrolls inside its own box instead of the page.
    config(md) {
      md.renderer.rules.table_open = () => '<div class="table-wrap"><table>';
      md.renderer.rules.table_close = () => '</table></div>';
    },
  },
  themeConfig: {
    logo: { src: '/logo.svg', width: 24, height: 24, alt: '' },
    siteTitle: 'slopbuckets',
    nav: [
      { text: 'guide', link: '/guide/getting-started', activeMatch: '/guide/(?!agents/)' },
      { text: 'agents', link: '/guide/agents/', activeMatch: '/guide/agents/' },
      { text: 'reference', link: '/reference/', activeMatch: '/reference/' },
      { text: 'site', link: landing, target: '_self' },
      { text: 'npm', link: 'https://www.npmjs.com/package/slopbuckets' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Install with an AI agent', link: '/guide/install-with-an-agent' },
          { text: 'Concepts', link: '/guide/concepts' },
          { text: 'Who runs which command', link: '/guide/commands' },
          { text: 'The approval flow', link: '/guide/approval' },
          { text: 'Inspect', link: '/guide/inspect' },
          { text: 'Projects and links', link: '/guide/projects-and-links' },
          { text: 'Claude Code', link: '/guide/claude-code' },
          { text: 'CI', link: '/guide/ci' },
          { text: 'Threat model', link: '/guide/threat-model' },
          { text: 'Writing an adapter', link: '/guide/adapters' },
        ],
      },
      {
        text: 'Supported agents',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/guide/agents/' },
          { text: 'Codex CLI', link: '/guide/agents/codex' },
          { text: 'Cursor', link: '/guide/agents/cursor' },
          { text: 'Gemini CLI', link: '/guide/agents/gemini' },
          { text: 'GitHub Copilot', link: '/guide/agents/copilot' },
          { text: 'Factory Droid', link: '/guide/agents/factory' },
          { text: 'Qwen Code', link: '/guide/agents/qwen' },
          { text: 'Auggie', link: '/guide/agents/auggie' },
          { text: 'Devin Desktop', link: '/guide/agents/devin' },
          { text: 'OpenCode', link: '/guide/agents/opencode' },
          { text: 'Pi', link: '/guide/agents/pi' },
          { text: 'Amp', link: '/guide/agents/amp' },
          { text: 'Cline', link: '/guide/agents/cline' },
          { text: 'Windsurf', link: '/guide/agents/windsurf' },
          { text: 'Kiro', link: '/guide/agents/kiro' },
          { text: 'Goose', link: '/guide/agents/goose' },
          { text: 'Crush', link: '/guide/agents/crush' },
          { text: 'Zed', link: '/guide/agents/zed' },
          { text: 'Aider', link: '/guide/agents/aider' },
          { text: 'Continue', link: '/guide/agents/continue' },
          { text: 'Any other agent', link: '/guide/agents/any-agent' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Overview', link: '/reference/' },
          { text: 'CLI', link: '/reference/cli' },
          { text: 'Rule ids', link: '/reference/rules' },
          { text: 'Lock differences', link: '/reference/lock' },
          { text: 'Check report', link: '/reference/report' },
          { text: 'Lock file', link: '/reference/lockfile' },
          { text: 'Config', link: '/reference/config' },
          { text: 'Links registry', link: '/reference/links' },
          { text: 'Claude Code hooks', link: '/reference/hooks' },
          { text: 'Inspect snapshot', link: '/reference/inspect' },
          { text: 'Adapter protocol', link: '/reference/adapter-protocol' },
        ],
      },
      {
        text: 'Elsewhere',
        items: [
          { text: 'Landing page', link: landing, target: '_self' },
          { text: 'Source on GitHub', link: repo },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: repo, ariaLabel: 'slopbuckets on GitHub' }],
    search: { provider: 'local' },
    outline: { level: [2, 3], label: 'On this page' },
    docFooter: { prev: 'Previous page', next: 'Next page' },
    footer: {
      message: `slopbuckets is MIT licensed. <a href="${repo}/blob/main/LICENSE">Read the license</a>.`,
      copyright: `<a href="${landing}">Back to the landing page</a>`,
    },
    notFound: {
      code: '404',
      title: 'Page not found',
      quote: 'There is no page at this address. The link may be old, or the page moved.',
      linkLabel: 'Go to the docs home page',
      linkText: 'cd ~/docs',
    },
    darkModeSwitchLabel: 'Theme',
    sidebarMenuLabel: 'Menu',
    returnToTopLabel: 'Back to top',
    externalLinkIcon: false,
  },
});
