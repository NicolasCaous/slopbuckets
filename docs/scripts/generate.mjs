// Generates the reference pages in docs/reference/ from the source of truth:
//   cli/src/contract/*.ts   rule ids, the warn or interrupt matrix, exit and environment codes, the messages,
//                           hook phases and decisions, session state, the check result and the inspect snapshot
//                           (types with their doc comments)
//   cli/src/testing/samples.ts   the sample violations of the rule and message pages
//   adapters/ts/src/protocol.ts  the adapter protocol
//   site/schema/v2.json     the config reference
//   the built CLI           `buckets --help`, `buckets --version` and the agents of `--agent`
//   docs/guide/agents/*.md  the title of each agent page, for the agents table
// The contract is TypeScript, so this script transpiles it into a temporary folder and imports it: the messages on
// these pages are the output of the same renderer the CLI uses.
// Run with `npm run generate -w docs`. The output folder is rebuilt from scratch on every run.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXPLAIN_DECISION, EXPLAIN_ENV, EXPLAIN_PHASE, EXPLAIN_RULE } from './explanations.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const out = path.resolve(here, '../reference');
const require = createRequire(import.meta.url);
const ts = require('typescript');

const rel = (p) => path.join(repo, p);
const read = (p) => readFileSync(rel(p), 'utf8');
const CONTRACT = 'cli/src/contract';
/** The sample violations that the rule and message pages render. */
const SAMPLES = 'cli/src/testing/samples.ts';
const PROTOCOL = 'adapters/ts/src/protocol.ts';

/* ---------- the contract, transpiled and imported ---------- */
const scratch = mkdtempSync(path.join(os.tmpdir(), 'slopbuckets-docs-'));
let C;
try {
  writeFileSync(path.join(scratch, 'package.json'), '{"type":"module"}');
  // Each module keeps its path from the repository root, so the relative imports between them still resolve.
  const modules = [
    ...readdirSync(rel(CONTRACT)).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).map((name) => `${CONTRACT}/${name}`),
    SAMPLES,
    PROTOCOL,
  ];
  const outOf = (file) => path.join(scratch, file.replace(/\.ts$/, '.js'));
  for (const file of modules) {
    const js = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    mkdirSync(path.dirname(outOf(file)), { recursive: true });
    writeFileSync(outOf(file), js);
  }
  // The contract has no index module: merge the exports of every file.
  C = {};
  for (const file of modules) Object.assign(C, await import(pathToFileURL(outOf(file)).href));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

/* ---------- types with their doc comments ---------- */
const docOf = (node) => (node.jsDoc ?? []).map((d) => (typeof d.comment === 'string' ? d.comment : (d.comment ?? []).map((c) => c.text).join(''))).join('\n').replace(/\s*\n\s*/g, ' ').trim();
/** The exported interfaces and type aliases of a contract file, in source order. */
function declarations(file, only) {
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const list = [];
  for (const st of sf.statements) {
    if (!(ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st))) continue;
    if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (only && !only.includes(st.name.text)) continue;
    const members = ts.isInterfaceDeclaration(st)
      ? st.members.filter(ts.isPropertySignature).map((m) => ({ name: m.name.getText(sf), optional: Boolean(m.questionToken), type: m.type ? m.type.getText(sf).replace(/\s+/g, ' ') : '', doc: docOf(m) }))
      : [];
    list.push({ name: st.name.text, doc: docOf(st), text: st.getText(sf), members });
  }
  if (only) for (const name of only) if (!list.some((d) => d.name === name)) throw new Error(`type ${name} not found in ${file}`);
  return list;
}

/* ---------- the built CLI ---------- */
const cliEnv = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', SLOPBUCKETS_NO_UPDATE_CHECK: '1' };
// CLI_BIN, relative to the repository root, points at another build of the CLI.
const bin = process.env.CLI_BIN ? path.resolve(repo, process.env.CLI_BIN) : rel('cli/dist/index.js');
if (!existsSync(bin)) throw new Error(`The built CLI is missing at ${bin}. Run \`npm run build\` first, or set CLI_BIN.`);
const runCli = (args) => execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: cliEnv });
/** The agents of `buckets init --agent`. The CLI lists them when it gets an unknown name, before it writes anything. */
function cliAgents() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'slopbuckets-docs-'));
  let text;
  try {
    text = spawnSync(process.execPath, [bin, 'init', '--agent', 'docs-generator-unknown-agent'], { cwd: dir, input: '', encoding: 'utf8', env: cliEnv }).stderr ?? '';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const m = /Known agents: (.+?), or auto\b/.exec(text);
  if (!m) throw new Error(`\`buckets init --agent <unknown>\` no longer lists the agents. Update cliAgents in docs/scripts/generate.mjs. It printed: ${text}`);
  return m[1].split(',').map((name) => name.trim()).filter(Boolean);
}
function parseHelp(text) {
  const sections = {};
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    if (/^\S/.test(line)) {
      const m = /^([A-Z][^:]*?):?$/.exec(line);
      current = m && !line.startsWith('Usage') ? m[1] : null;
      if (current) sections[current] = [];
      continue;
    }
    if (!current) continue;
    // An entry is indented by 2 spaces. A command wider than the first column stands alone on its line and its
    // description follows on the next lines.
    const entry = /^ {2}(\S.*?)\s{2,}(\S.*)$/.exec(line);
    const list = sections[current];
    if (entry) list.push([entry[1], entry[2]]);
    else if (/^ {2}\S/.test(line)) list.push([line.trim(), '']);
    else if (list.length) list[list.length - 1][1] = `${list[list.length - 1][1]} ${line.trim()}`.trim();
  }
  return sections;
}

/* ---------- page helpers ---------- */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Text with `code spans` becomes HTML with <code>. */
const inline = (s) => String(s).split(/(`[^`]+`)/).map((part) => (part.startsWith('`') && part.endsWith('`') && part.length > 1 ? `<code>${esc(part.slice(1, -1))}</code>` : esc(part))).join('');
const code = (s) => `<code>${esc(s)}</code>`;
const GEN = '<p class="gen-note">Generated from the source code by <code>docs/scripts/generate.mjs</code>. Do not edit this page by hand.</p>';
const front = (title, description) => `---\ntitle: ${title}\ndescription: ${description}\n---\n\n`;
// Vue condenses whitespace in templates, so a line break becomes <br> and the indent of the next line &nbsp;.
const msgText = (m) => esc(m).replace(/\n( *)/g, (_, indent) => `<br>${'&nbsp;'.repeat(indent.length)}`);
const msgBlock = (messages) => messages.map((m) => `<div class="msg" v-pre>${msgText(m)}</div>`).join('\n');
const codeBlock = (lang, text) => `\`\`\`${lang}\n${text}\n\`\`\``;
function table(head, allRows) {
  // A column with no text in any row, such as Notes for a type without doc comments, is left out.
  const cols = head.map((_, i) => i).filter((i) => allRows.some((r) => String(r[i] ?? '').trim()));
  const rows = allRows.map((r) => cols.map((i) => r[i]));
  return `<div class="table-wrap"><table v-pre>\n<thead><tr>${cols.map((i) => `<th scope="col">${esc(head[i])}</th>`).join('')}</tr></thead>\n<tbody>\n${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n')}\n</tbody>\n</table></div>`;
}
/** Fails when an explanation map and a list of ids from the contract drift apart. */
function check(list, map, what) {
  const missing = list.filter((id) => !(id in map));
  const extra = Object.keys(map).filter((id) => !list.includes(id));
  if (missing.length || extra.length) {
    throw new Error(`${what}: the explanations in docs/scripts/explanations.mjs are out of date. Missing: ${missing.join(', ') || 'none'}. Not in the contract: ${extra.join(', ') || 'none'}.`);
  }
}
/** One section per type: its doc comment, its source and a table of its fields. */
const typeSections = (decls, level = '###') =>
  decls.map((d) => `${level} ${d.name}\n\n${d.doc ? inline(d.doc) + '\n\n' : ''}${codeBlock('ts', d.text)}\n${d.members.length ? '\n' + table(['Field', 'Type', 'Notes'], d.members.map((m) => [code(`${m.name}${m.optional ? '?' : ''}`), code(m.type), inline(m.doc)])) + '\n' : ''}`).join('\n');
const behavior = (b) => (b === 'interrupt' ? 'interrupt' : 'warn');

/* =====================================================================
   Pages
   ===================================================================== */
const pages = {};
const ruleIds = [...C.RULE_IDS];
check(ruleIds, EXPLAIN_RULE, 'RULE_IDS');
check(Object.keys(C.RULES), EXPLAIN_RULE, 'RULES');
check([...C.ENVIRONMENT_CODES], EXPLAIN_ENV, 'ENVIRONMENT_CODES');
check([...C.HOOK_PHASES], EXPLAIN_PHASE, 'HOOK_PHASES');
const decisionKinds = [...new Set(Object.values(C.PHASE_DECISIONS).flat())];
check(decisionKinds, EXPLAIN_DECISION, 'HookDecision kinds');
const samples = (id) => [C.SAMPLES[id], ...C.SAMPLE_VARIANTS.filter((v) => v.rule === id)];
for (const id of ruleIds) if (!C.SAMPLES[id]) throw new Error(`${SAMPLES} has no sample for ${id}`);

/* ---------- CLI ---------- */
const AGENTS_JSON = 'agents.json';
let agentList = [];
{
  const help = runCli(['--help']);
  const version = runCli(['--version']).trim();
  const sections = parseHelp(help);
  const commands = sections.Commands ?? [];
  const options = sections.Options ?? [];
  const exits = sections['Exit codes of check'] ?? [];
  if (!commands.length) throw new Error('No commands found in `buckets --help`. The help layout changed: update parseHelp in docs/scripts/generate.mjs.');
  const pkg = JSON.parse(read('cli/package.json'));
  const agents = cliAgents().map((name) => {
    const page = `guide/agents/${name === 'claude' ? 'claude-code' : name}.md`;
    if (!existsSync(rel(`docs/${page}`))) throw new Error(`The agent "${name}" has no guide page at docs/${page}. Write one and add it to the sidebar.`);
    const title = /^title: (.+)$/m.exec(read(`docs/${page}`).replace(/\r\n/g, '\n'))?.[1]?.trim();
    if (!title) throw new Error(`docs/${page} has no title in its front matter`);
    return { name, title, link: `../${page.replace(/\.md$/, '')}` };
  });
  agentList = agents.map(({ name, title }) => ({ name, title }));
  pages['cli.md'] = front('CLI reference', 'Every buckets command and option, taken from the built CLI.') +
`# CLI reference

${GEN}

The package on npm is ${code(pkg.name)} and the command is <code>buckets</code>. This page was built with this CLI:

${codeBlock('text', `$ buckets --version\n${version}`)}

## Commands

${table(['Command', 'What it does'], commands.map(([c, d]) => [code(`buckets ${c}`), inline(d)]))}

## Options

${table(['Option', 'What it does'], options.map(([c, d]) => [code(c), inline(d)]))}

## Hook phases

<code>buckets hook [--agent &lt;name&gt;] &lt;event&gt;</code> runs one hook event of an agent, reading and writing JSON in the format of the agent. Each agent has its own event names, and <code>buckets hook --agent &lt;name&gt; --help</code> lists them. The adapter of the agent maps each event to one of these phases. See [Hooks](./hooks) for what each phase does.

${table(['Phase', 'What it does'], C.HOOK_PHASES.map((p) => [code(p), inline(EXPLAIN_PHASE[p])]))}

## Agents

<code>buckets init --agent &lt;name&gt;</code> installs the hooks of these agents. <code>--agent</code> takes a comma separated list, such as <code>--agent codex,cursor</code>, and <code>--agent auto</code> picks every agent whose folder or file exists in the project. <code>buckets init --git-hook</code> adds a git pre-commit hook that runs <code>buckets check</code> whatever the agent. The [Supported agents](../guide/agents/) page compares what each agent supports.

${table(['Agent', '--agent'], agents.map((a) => [`<a href="${a.link}">${esc(a.title)}</a>`, code(a.name)]))}

## Exit codes of check

${table(['Code', 'Meaning'], exits.length ? exits.map(([c, d]) => [code(c), inline(d)]) : Object.entries(C.EXIT_CODES).map(([k, v]) => [code(String(v)), esc(k)]))}

Every command exits with 64 for a command line it does not understand, such as an unknown option or a missing value, and prints its usage on stderr, so a typo in CI does not read as a violation. With nested projects, the exit code of <code>check</code> is 3 when any project has an environment problem, else 1 when any project has a violation, else 0. Advice never changes it.

## Full help text

${codeBlock('text', `$ buckets --help\n${help.trimEnd()}`)}
`;
}

/* ---------- rules ---------- */
{
  const matrix = table(['Rule', 'pre-edit and pre-tool', 'stop and subagent-stop'], ruleIds.map((id) => [`<a href="#${id}">${code(id)}</a>`, behavior(C.RULES[id].preTool), behavior(C.RULES[id].stop)]));
  const sections = ruleIds.map((id) => {
    const list = samples(id);
    return `## ${id}

${inline(C.RULES[id].detects)} ${inline(EXPLAIN_RULE[id])}

In pre-edit and pre-tool it is ${C.RULES[id].preTool === 'warn' ? 'a warning' : 'an interrupt'}. In stop and subagent-stop it is an interrupt.

${list.length === 1 ? 'The full message' : 'The full messages'}, as <code>buckets check</code>, the stop hook and <code>[NEW]</code> print ${list.length === 1 ? 'it' : 'them'}:

${msgBlock(list.map((v) => C.renderFull(v)))}

The one-line reminder under <code>[OLD]</code> and <code>[RESOLVED]</code>:

${msgBlock([...new Set(list.map((v) => C.renderSummary(v)))])}
`;
  }).join('\n');
  pages['rules.md'] = front('Rules', 'Every rule buckets check reports, whether the hooks warn or interrupt, and the exact messages.') +
`# Rules

${GEN}

slopbuckets 2.0 has ${ruleIds.length} rules. Each one has a full message, which ends with what to do, and a one-line reminder of at most 120 characters. When both answers make sense, the full message shows <code>choose one fix:</code>, then <code>fix code:</code> and <code>fix config:</code>. Both are valid, and the agent picks one. When only one makes sense, it shows only that one. The examples below come from the message renderer in <code>cli/src/contract/messages.ts</code> with the sample violations of <code>cli/src/testing/samples.ts</code>.

A violation of a nested project starts with the folder of the project, such as <code>packages/sdk: </code>.

## Warn or interrupt

A warning adds the pending list to the agent context and lets the tool run. An interrupt denies the edit, or blocks the end of the turn. See [Hooks](../guide/hooks) for the loop.

${matrix}

<code>config-invalid</code> interrupts in pre-edit because with an unreadable config no other rule runs, and every other warning would disappear until the stop. The edit is denied and never reaches the disk. The stop has no warnings, because the turn is over and nobody would read them.

## Exit codes

${table(['Code', 'Meaning'], [['<code>0</code>', 'No violation.'], ['<code>1</code>', 'At least one violation.'], ['<code>3</code>', 'Environment error: a project could not be checked at all.'], ['<code>64</code>', 'Usage error: the command line is wrong, such as an unknown option.']])}

Advice never changes the exit code.

## Environment codes

An environment error stops a project from being checked. <code>buckets check</code> exits with code 3 and prints <code>cannot check (&lt;code&gt;): &lt;message&gt;</code>.

${table(['Code', 'Meaning'], C.ENVIRONMENT_CODES.map((c) => [code(c), inline(EXPLAIN_ENV[c])]))}

For <code>config-newer</code> the message reads:

${msgBlock([C.configNewerMessage('2.1', '2.0.0')])}

## Advice

Advice is a note on the quality of the config, apart from the rules. It never fails the check, never enters the pending list and never makes a stop block. <code>buckets check</code> prints it after the violations, under a header of its own, and the stop hook adds it after the violations when it blocks anyway. A stop with nothing to block shows once the <code>reason-generic</code> advice on the purposes and reasons the session wrote, and lets the turn end. <code>buckets check --json</code> lists it in <code>advice</code>.

${table(['Advice', 'What it detects'], C.ADVICE_IDS.map((id) => [code(id), inline(C.ADVICE[id].detects)]))}

The messages, as <code>buckets check</code> prints them, each under the <code>buckets advice</code> header:

${msgBlock([...C.ADVICE_IDS.map((id) => C.ADVICE_SAMPLES[id]), ...C.ADVICE_VARIANTS].map((a) => C.renderAdvice(a)))}

${sections}`;
}

/* ---------- config ---------- */
{
  const schema = JSON.parse(read('site/schema/v2.json'));
  const resolve = (v) => (v?.$ref ? { ...schema.$defs[v.$ref.split('/').pop()], ...v } : v);
  const typeOf = (v) => {
    v = resolve(v);
    if (v.oneOf) return v.oneOf.map(typeOf).join(' | ');
    if (v.type === 'array') return `${typeOf(v.items ?? {})}[]`;
    if (v.type === 'object' && v.additionalProperties && typeof v.additionalProperties === 'object') return `{ [name]: ${typeOf(v.additionalProperties).replace(/^\{ \[name\]: (.*) \}$/, 'object')} }`;
    return v.type ?? 'object';
  };
  const constraint = (v) => {
    v = resolve(v);
    const list = [];
    if (v.minItems) list.push(`at least ${v.minItems} item`);
    if (v.$ref === '#/$defs/line' || v.pattern === schema.$defs.line.pattern) list.push('one non-empty line');
    if (v.propertyNames?.pattern) list.push(`keys match \`${v.propertyNames.pattern}\``);
    return list.join(', ');
  };
  const top = Object.entries(schema.properties);
  const required = new Set(schema.required);
  const bucket = schema.$defs.bucket;
  const bucketRequired = new Set(bucket.required);
  const example = {
    $schema: schema.$id,
    version: schema.properties.version.examples[0],
    ignore: schema.properties.ignore.examples[0],
    projects: schema.properties.projects.examples[0],
    buckets: {
      billing: {
        purpose: bucket.properties.purpose.examples[0],
        files: bucket.properties.files.examples[0],
        public: bucket.properties.public.examples[0],
        dependsOn: bucket.properties.dependsOn.examples[0],
        packages: bucket.properties.packages.examples[0],
      },
      payments: {
        purpose: 'Talks to the payment gateway',
        files: ['src/payments/**'],
        public: ['src/payments/index.ts', 'src/payments/server.ts'],
        dependsOn: {},
        packages: { stripe: 'Calls the Stripe API for charges and refunds' },
        external: bucket.properties.external.examples[0],
      },
      app: {
        purpose: 'Starts the server and wires every route',
        files: ['src/app/**'],
        public: null,
        dependsOn: { billing: 'Mounts the invoice routes' },
        packages: { express: 'Serves the HTTP routes' },
      },
    },
  };
  pages['config.md'] = front('Config reference', 'Every field of buckets.config.json, from the published JSON Schema.') +
`# Config reference

${GEN}

<code>buckets.config.json</code> sits at the root of the project. <code>buckets init</code> writes an empty one, and the CLI finds the project by looking for this file in the current folder and its parents. ${inline(schema.description)}

${codeBlock('json', JSON.stringify(example, null, 2))}

The <code>$schema</code> field points at the JSON Schema, <a href="${esc(schema.$id)}"><code>${esc(schema.$id)}</code></a>, so editors can autocomplete and validate the file.

## Top level

${table(['Field', 'Type', 'Required', 'Constraints', 'Meaning'], top.map(([k, v]) => [code(k), code(typeOf(v)), required.has(k) ? 'yes' : v.type === 'array' ? 'no, default <code>[]</code>' : 'no',inline(constraint(v)), inline(v.description)]))}

${schema.additionalProperties === false ? 'Unknown fields are not allowed. The check reports them' : 'The check reports problems'} as <a href="./rules#config-invalid"><code>config-invalid</code></a>.

## A bucket

${inline(bucket.description)} The key is the bucket name. ${inline(schema.properties.buckets.propertyNames.description)}

${table(['Field', 'Type', 'Required', 'Constraints', 'Meaning'], Object.entries(bucket.properties).map(([k, v]) => [code(k), code(typeOf(v)), bucketRequired.has(k) ? 'yes' : 'no', inline(constraint(v)), inline(v.description)]))}

Unknown fields in a bucket are <a href="./rules#config-invalid"><code>config-invalid</code></a> too.

## version

The check reads <code>version</code> before anything else. It checks a config whose major is 2 and whose minor is at most the minor of <code>${esc(C.CONFIG_VERSION)}</code>, the version this CLI writes. A greater version stops the check of that project with the environment error <a href="./rules#environment-codes"><code>config-newer</code></a>, exit code 3, before the rest of the file is validated, so the new fields of a newer format are never <code>config-invalid</code>. The hooks show that message once per session and never deny an edit or block a stop because of it. A value that is not a <code>&lt;major&gt;.&lt;minor&gt;</code> string, or a major below 2, is <code>config-invalid</code>.

## packages keys

A key of <code>packages</code> is a package name without a subpath, or a Node built-in with the <code>node:</code> prefix. The check maps every external import of a bucket file to its key: <code>lodash/merge</code> is <code>lodash</code>, <code>@scope/pkg/server</code> is <code>@scope/pkg</code>, and <code>fs</code>, <code>node:fs</code> and <code>fs/promises</code> are all <code>node:fs</code>. Type-only imports count, and an npm package that is not installed counts under its name. Ignored files need no entry. A key in another form, such as <code>fs</code> or <code>lodash/merge</code>, is <code>config-invalid</code>, and its message names the right key.

## Which files count

The check reads the files with the extensions of the adapter that git sees, as <code>git ls-files -co --exclude-standard</code> lists them, so <code>.gitignore</code> applies. Outside a git repository, it walks the folders and skips <code>node_modules</code> and folders that start with a dot. It applies <code>ignore</code> first and then the bucket globs, so a file in <code>ignore</code> leaves the architecture before buckets are matched and never conflicts with a bucket.
`;
}

/* ---------- hooks ---------- */
{
  const s = C.SAMPLES;
  const pending = C.renderPending({ fresh: [s['import-private']], old: [s['dependency-undeclared'], s['file-unowned']], resolved: [s['file-overlap']] });
  const stop = C.renderStop([s['dependency-undeclared'], s['file-unowned']]);
  const stopAgain = C.renderStop([s['dependency-unused']], { advice: [C.ADVICE_SAMPLES['reason-generic']], repeated: true });
  const deny = C.renderInterrupt([s['config-invalid']]);
  const session = declarations(`${CONTRACT}/session.ts`, ['SessionState']);
  const input = declarations(`${CONTRACT}/hooks.ts`, ['HookInput', 'HookEdit', 'HookDecision']);
  pages['hooks.md'] = front('Hooks', 'The hook phases, the decisions each phase may return, the pending list, the message headers and the session state, from the contract.') +
`# Hooks

${GEN}

Every agent adapter turns the agent's hook payload into one normalized input, calls the hook core, and turns the decision back into the agent's format. The [Hooks guide](../guide/hooks) explains the loop. [Supported agents](../guide/agents/) says which phases each agent has.

## Phases

${table(['Phase', 'What it does', 'Decisions it may return'], C.HOOK_PHASES.map((p) => [code(p), inline(EXPLAIN_PHASE[p]), C.PHASE_DECISIONS[p].map(code).join(', ')]))}

## Decisions

${table(['Decision', 'Meaning'], decisionKinds.map((k) => [code(k), inline(EXPLAIN_DECISION[k])]))}

## The pending list

Before every tool call, pre-edit and pre-tool show the whole pending list of the session while it is not empty. A new violation shows in full under <code>[NEW]</code> once. After that it shows as a one-line reminder under <code>[OLD]</code>. A violation that went away shows once under <code>[RESOLVED]</code> and then disappears. With nothing to say, the hook prints nothing.

${msgBlock([pending])}

## Stop

The stop and subagent-stop phases run the full check and block once, with a header and every violation in full:

${msgBlock([stop])}

When every violation of the block was also left at the end of an earlier turn, the block adds a line that asks the agent to tell the user which ones it leaves and why. When the check also found [advice](./rules#advice), it comes after the violations. Advice alone never blocks:

${msgBlock([stopAgain])}

## Denied edit

When an edit would make the config invalid, pre-edit denies it:

${msgBlock([deny])}

## Input

${typeSections(input)}

## Session state

The memory of what a session already showed lives in <code>${esc(C.SESSIONS_DIR)}/&lt;session_id&gt;[-&lt;agent_id&gt;].json</code> under the project root. A subagent has its own file. The hook writes it atomically, through a temporary file and a rename. A session id that could leave that folder, such as one with <code>..</code> or a slash, gets no memory. A stale or broken file reads as an empty state.

${typeSections(session)}
`;
}

/* ---------- report ---------- */
{
  const result = declarations(`${CONTRACT}/engine.ts`, ['CheckResult', 'EnvironmentError']);
  const violation = declarations(`${CONTRACT}/violation.ts`, ['ImportRef', 'ConfigProblem', 'Violation', 'Advice']);
  const example = { exitCode: 1, violations: [C.SAMPLES['import-private']], environment: [], advice: [C.ADVICE_SAMPLES['reason-generic']], projects: ['.'] };
  const summary = C.renderCheckSummary([C.SAMPLES['dependency-undeclared'], C.SAMPLES['import-private'], C.SAMPLES['export-unused'], C.SAMPLES['file-unowned']], [], [C.ADVICE_SAMPLES['reason-generic']]);
  const diff = [
    'Architecture changes since origin/main:',
    '  Added bucket `mail`: Sends invoice and receipt emails',
    '  Added the dependency of `billing` on `mail`: Sends each invoice to the customer',
    '  Added the package `node:fs` to `billing`: Writes invoice PDFs to the export folder',
    '  Changed the public files of `billing` from src/billing/index.ts to src/billing/index.ts, src/billing/server.ts',
    '  Added the export `send` to src/mail/index.ts, a public file of `mail`',
    '  Removed the export `refund` from src/payments/index.ts, a public file of `payments`',
  ].join('\n');
  pages['report.md'] = front('Check report', 'The text and JSON output of buckets check, from the contract.') +
`# Check report

${GEN}

<code>buckets check</code> prints a header and every violation in full, in the same order as the stop hook, then the environment errors and the [advice](./rules#advice). <code>buckets check --json</code>, the same as <code>--format json</code>, prints the same result as JSON. The process exits with <code>exitCode</code> in every format.

## Text

${msgBlock([C.renderCheck([C.SAMPLES['dependency-undeclared'], C.SAMPLES['import-private']])])}

With nothing to report:

${msgBlock([C.renderCheck([])])}

## Summary

<code>buckets check --summary</code> prints the number of violations per rule and per bucket, the advice per id and every environment error in full, for a first look at a large project. A violation that concerns two buckets counts under both. The hooks never use this form.

${msgBlock([summary])}

## GitHub annotations and SARIF

<code>buckets check --format github</code> prints the text report on stdout and, on stderr, one line per violation in the form <code>::error file=&lt;path&gt;,line=&lt;n&gt;,title=slopbuckets &lt;rule&gt;::&lt;reminder&gt;</code>. GitHub Actions turns each line into an annotation on that line of the pull request. When <code>GITHUB_ACTIONS</code> is <code>true</code>, as on every Actions runner, the text and JSON formats print the annotations too. Paths are relative to <code>GITHUB_WORKSPACE</code> when it is set.

<code>buckets check --format sarif</code> prints a SARIF 2.1.0 log on stdout, with one result per violation, for code scanning tools such as the <code>upload-sarif</code> action of CodeQL.

## Architecture diff

<code>buckets check --base &lt;ref&gt;</code> runs the check and then lists what changed in the architecture since the git ref, project by project: buckets added and removed, purposes, dependencies and packages with their reasons, public files, and the names the public files export. With <code>--json</code> or <code>--format sarif</code> the list goes to stderr, so stdout stays one JSON document. When <code>GITHUB_STEP_SUMMARY</code> is set, the list is also appended to that file as Markdown, which shows on the summary page of the run. The list never changes the exit code.

${codeBlock('text', diff)}

## JSON

${codeBlock('json', JSON.stringify(example, null, 2))}

${typeSections(result)}

## Violations

Each violation has a <code>rule</code> and a <code>project</code>, plus the fields its message needs. Paths are relative to the project and use <code>/</code>. The full union is in <code>cli/src/contract/violation.ts</code>. The [rules reference](./rules) shows the message of each one.

${typeSections(violation)}
`;
}

/* ---------- inspect snapshot ---------- */
{
  const decls = declarations(`${CONTRACT}/snapshot.ts`);
  pages['inspect.md'] = front('Inspect snapshot', 'The JSON that buckets inspect --json prints, snapshot version 2, from the contract.') +
`# Inspect snapshot

${GEN}

<code>buckets inspect --json</code> prints the snapshot that the inspect page loads, for agents and scripts. Paths are relative to their project and use <code>/</code>. Lists are sorted, so the same project gives byte-identical JSON. Files are stored in groups, one per folder and owner, so 50,000 files take about 1 MB. See [Inspect](../guide/inspect) for the page.

${typeSections(decls)}
`;
}

/* ---------- adapter protocol ---------- */
{
  const decls = declarations(PROTOCOL);
  pages['adapter-protocol.md'] = front('Adapter protocol', `The types a language adapter receives and returns, protocol ${C.ADAPTER_ABI}, from the adapter package.`) +
`# Adapter protocol

${GEN}

Protocol ${C.ADAPTER_ABI}: every request and response carries this number in the field <code>abi</code>. Every path is relative to the project folder and uses <code>/</code>, unless it leaves the project, and then it starts with <code>../</code>. See [Writing an adapter](../guide/adapters).

${typeSections(decls)}
`;
}

/* ---------- index ---------- */
pages['index.md'] = front('Reference', 'Reference pages generated from the slopbuckets source code.') +
`# Reference

${GEN}

${table(['Page', 'What it covers'], [
  ['<a href="./cli">CLI</a>', 'Every command and option, the hook phases, the agents of <code>--agent</code> and the exit codes.'],
  ['<a href="./rules">Rules</a>', 'Every rule, whether the hooks warn or interrupt, and the exact messages.'],
  ['<a href="./config">Config</a>', 'Every field of <code>buckets.config.json</code>.'],
  ['<a href="./hooks">Hooks</a>', 'The phases, the decisions, the pending list and the session state.'],
  ['<a href="./report">Check report</a>', 'The text and JSON output of <code>buckets check</code>.'],
  ['<a href="./inspect">Inspect snapshot</a>', 'The JSON of <code>buckets inspect --json</code>.'],
  ['<a href="./adapter-protocol">Adapter protocol</a>', 'The types a language adapter receives and returns.'],
])}
`;

/* ---------- write ---------- */
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [name, text] of Object.entries(pages)) writeFileSync(path.join(out, name), text);
// The agents of `buckets init --agent`, for the install steps in llms.txt (docs/scripts/llms.mjs). Not a page.
writeFileSync(path.join(out, AGENTS_JSON), `${JSON.stringify(agentList, null, 2)}\n`);
mkdirSync(path.resolve(here, '../public'), { recursive: true });
writeFileSync(path.resolve(here, '../public/logo.svg'), read('site/logo.svg'));
console.log(`generate.mjs: wrote ${Object.keys(pages).length} reference pages to ${path.relative(repo, out)}`);
