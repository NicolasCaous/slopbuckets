// The plugin files that slopbuckets writes for OpenCode, Pi and Amp, put together from the real JavaScript next to
// this file: a header, ./runtime.js without its `export` words, and the plugin of the harness without its import of
// ./runtime.js. The build loads the .js files as text (the `?raw` imports, see cli/tsup.config.ts), and so does vitest.
import { PLUGIN_MARKER } from '../plugin-file.js';
import { DEFAULT_COMMAND } from '../adapters/json-install.js';
import AMP from './amp.js?raw';
import OPENCODE from './opencode.js?raw';
import PI from './pi.js?raw';
import RUNTIME from './runtime.js?raw';

export const DOCS_BASE = 'https://nicolascaous.github.io/slopbuckets/docs/guide/agents/';

/** The first lines of a plugin file: the ownership marker and what the file does. */
function header(agent: string, title: string, events: string): string {
  return `// @ts-nocheck
// ${PLUGIN_MARKER}: the slopbuckets plugin for ${title}. "buckets init --agent ${agent}" wrote this file and rewrites
// it on the next run, so local edits are lost. Docs: ${DOCS_BASE}${agent}.html
//
// The plugin holds no rules. For ${events} it runs
// "buckets hook --agent ${agent} <event>" with a JSON object on stdin and applies the JSON answer: context for the model,
// a denied edit, or one more turn.
// When the buckets command cannot run, crashes or takes too long, the plugin lets everything run and warns once per
// session. Set SLOPBUCKETS_BIN to the path of the buckets command (or of its index.js) to choose it.
`;
}

/** Replaces one line of the source, and throws when it is not there, so a renamed constant fails the tests. */
function replaceLine(text: string, line: string, next: string): string {
  if (!text.includes(line)) throw new Error(`the plugin runtime has no line ${line}`);
  return text.replace(line, next);
}

/**
 * The text from the first import on, because the comments above it describe the source file, not the installed one.
 * Line ends become LF, whatever the checkout gave the source.
 */
function fromImports(text: string): string {
  const lf = text.replace(/\r\n/g, '\n');
  const at = /^import /m.exec(lf)?.index;
  if (at === undefined) throw new Error('a plugin source has no import');
  return lf.slice(at);
}

function assemble(agent: string, title: string, events: string, plugin: string, cli: string): string {
  let runtime = fromImports(RUNTIME);
  runtime = replaceLine(runtime, 'const AGENT = "agent";', `const AGENT = ${JSON.stringify(agent)};`);
  runtime = replaceLine(runtime, 'const TITLE = "Agent";', `const TITLE = ${JSON.stringify(title)};`);
  runtime = replaceLine(runtime, 'const COMMAND = "buckets";', `const COMMAND = ${JSON.stringify(cli)};`);
  runtime = runtime.replace(/^export (?=(?:async )?function |const )/gm, '');
  const body = fromImports(plugin).replace(/^import \{[^}]*\} from "\.\/runtime\.js";\r?\n/, '');
  return `${header(agent, title, events)}${runtime}\n${body}`;
}

export function opencodePlugin(cli: string = DEFAULT_COMMAND): string {
  return assemble('opencode', 'OpenCode', 'each tool call, end of turn and compaction', OPENCODE, cli);
}

export function piPlugin(cli: string = DEFAULT_COMMAND): string {
  return assemble('pi', 'Pi', 'each tool call, end of turn and compaction', PI, cli);
}

export function ampPlugin(cli: string = DEFAULT_COMMAND): string {
  return assemble('amp', 'Amp', 'each tool call and end of turn', AMP, cli);
}
