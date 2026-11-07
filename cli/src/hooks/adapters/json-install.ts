// The install-time half of the adapters for harnesses that run a shell command: the hook commands, with the command
// that runs slopbuckets (`buckets`, or a local install such as `node ./node_modules/slopbuckets/dist/index.js`), and
// the hook entries merged into or removed from a JSON config file, keeping comments when the file has them
// (../../files/jsonc.ts) and every entry the user wrote. The run-time half is ./json-run.ts.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  appendItemEdits,
  isRecord,
  JsoncText,
  removeItemEdits,
  removePropertyEdits,
  setPropertyEdits,
  type JsonNode,
  type JsonObject,
  type JsonRecord,
  type TextEdit,
} from '../../files/index.js';
import { message } from '../../output/index.js';
import type { InstallStep } from '../adapter.js';
import { removeProjectFile, writeProjectFile } from '../project-file.js';

/** The command that runs slopbuckets when init is not given another one. */
export const DEFAULT_COMMAND = 'buckets';

/**
 * `command` with its relative script anchored at the project folder that the harness sets in the environment variable
 * `variable`, such as `node "$CLAUDE_PROJECT_DIR/node_modules/slopbuckets/dist/index.js"`, so the hook finds the copy
 * whatever folder the agent's shell is in. The form is for POSIX shells, so only harnesses that run hooks in one on
 * every system use it. Any other command, such as `buckets`, comes back unchanged.
 */
export function anchoredCommand(command: string | undefined, variable: string): string | undefined {
  const script = command === undefined ? undefined : /^node (\.\.?\/[\w./@-]+)$/.exec(command)?.[1];
  return script === undefined ? command : `node "$${variable}/${script.replace(/^\.\//, '')}"`;
}

/** The command a harness config runs for one event of an adapter. */
export function hookCommand(agent: string, event: string, command: string = DEFAULT_COMMAND): string {
  return `${command} hook --agent ${agent} ${event}`;
}

/** The program of a command and the script it runs, such as `node` and `./node_modules/slopbuckets/dist/index.js`. */
export function commandParts(command: string): { program: string; script?: string } {
  const words = command.trim().split(/\s+/);
  const script = words.slice(1).find((word) => /\.[cm]?js$/i.test(word));
  return script === undefined ? { program: words[0]! } : { program: words[0]!, script };
}

const SH_GUARD = /^if command -v \S+ >\/dev\/null 2>&1(?: && \[ -f \S+ \])?; then (.+); fi$/;
const POWERSHELL_GUARD = /^if \(\(?Get-Command \S+ -ErrorAction SilentlyContinue\)(?: -and \(Test-Path \S+\)\))? \{ (.+) \}$/;

/**
 * `command` for sh or bash, run only when `cli` (the command that runs slopbuckets) exists: its program on the PATH,
 * and its script file when it names one. A harness that denies a tool call when its guard hook exits with an error,
 * such as GitHub Copilot, would otherwise deny every call on a machine without the CLI, where the shell exits with 127.
 * With the guard the hook exits with 0 and prints nothing there, so it fails open.
 */
export function failOpenSh(command: string, cli: string = DEFAULT_COMMAND): string {
  const { program, script } = commandParts(cli);
  return `if command -v ${program} >/dev/null 2>&1${script === undefined ? '' : ` && [ -f ${script} ]`}; then ${command}; fi`;
}

/** `command` for PowerShell, run only when `cli` exists. See failOpenSh. */
export function failOpenPowerShell(command: string, cli: string = DEFAULT_COMMAND): string {
  const { program, script } = commandParts(cli);
  const found = `Get-Command ${program} -ErrorAction SilentlyContinue`;
  return script === undefined ? `if (${found}) { ${command} }` : `if ((${found}) -and (Test-Path ${script})) { ${command} }`;
}

/** The hook command inside a failOpenSh or failOpenPowerShell guard, or `command` itself. */
export function unwrapFailOpen(command: string): string {
  const text = command.trim();
  return (SH_GUARD.exec(text) ?? POWERSHELL_GUARD.exec(text))?.[1]?.trim() ?? text;
}

/**
 * True when `command` runs `<cli> hook --agent <agent> <event>` for any event, with any command that runs slopbuckets
 * (one that names buckets, such as `buckets` or `node ./node_modules/slopbuckets/dist/index.js`). A command inside a
 * fail-open guard counts too. `agent` null matches `<cli> hook <event>`, the Claude Code form.
 */
export function isAgentCommand(agent: string | null, command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const tail = agent === null ? '(?:--agent claude )?[a-z-]+' : `--agent ${agent} [a-z-]+`;
  const match = new RegExp(`^(.+) hook ${tail}$`).exec(unwrapFailOpen(command));
  return match !== null && /buckets/.test(match[1]!);
}

type Key = string | number;

/** The edits install makes, against a plain value or against JSONC text. */
interface Editor {
  get(keys: Key[]): unknown;
  set(keys: Key[], value: unknown): void;
  append(keys: Key[], value: unknown): void;
  output(): string;
}

/** Edits a parsed value and writes it back with the indent and line ends of the original text. */
class PlainEditor implements Editor {
  constructor(
    private readonly root: JsonRecord,
    private readonly indent: string,
    private readonly newline: string,
  ) {}

  get(keys: Key[]): unknown {
    let node: unknown = this.root;
    for (const key of keys) {
      if (typeof key === 'number') node = Array.isArray(node) ? node[key] : undefined;
      else node = isRecord(node) ? node[key] : undefined;
    }
    return node;
  }

  set(keys: Key[], value: unknown): void {
    const parent = this.get(keys.slice(0, -1));
    if (isRecord(parent)) parent[keys[keys.length - 1] as string] = structuredClone(value);
  }

  append(keys: Key[], value: unknown): void {
    const list = this.get(keys);
    if (Array.isArray(list)) list.push(structuredClone(value));
  }

  output(): string {
    return `${JSON.stringify(this.root, null, this.indent).split('\n').join(this.newline)}${this.newline}`;
  }
}

/** Edits JSONC text in place, one change at a time, so comments and formatting elsewhere stay. */
class JsoncEditor implements Editor {
  constructor(private text: string) {}

  private node(doc: JsoncText, keys: Key[]): JsonNode | undefined {
    let node: JsonNode | undefined = doc.root;
    for (const key of keys) {
      if (node === undefined) return undefined;
      if (typeof key === 'number') node = node.kind === 'array' ? node.items[key] : undefined;
      else node = doc.property(node, key)?.value;
    }
    return node;
  }

  private edit(make: (doc: JsoncText) => TextEdit[]): void {
    const doc = new JsoncText(this.text);
    const edits = make(doc);
    if (edits.length > 0) this.text = doc.apply(edits);
  }

  get(keys: Key[]): unknown {
    const doc = new JsoncText(this.text);
    const node = this.node(doc, keys);
    return node === undefined ? undefined : doc.valueOf(node);
  }

  set(keys: Key[], value: unknown): void {
    this.edit((doc) => {
      const parent = this.node(doc, keys.slice(0, -1));
      return parent?.kind === 'object' ? setPropertyEdits(doc, parent, keys[keys.length - 1] as string, value) : [];
    });
  }

  append(keys: Key[], value: unknown): void {
    this.edit((doc) => {
      const list = this.node(doc, keys);
      return list?.kind === 'array' ? appendItemEdits(doc, list, value) : [];
    });
  }

  output(): string {
    return this.text;
  }
}

/** An editor for the text of a JSON file: plain when it has no comments, JSONC edits when it has. Throws on bad JSON. */
function editorFor(text: string, label: string): Editor {
  const doc = new JsoncText(text.trim() === '' ? '{}' : text);
  if (doc.root.kind !== 'object') throw new Error(`${label} must contain a JSON object`);
  if (doc.hasComments(0, doc.text.length)) return new JsoncEditor(text);
  const indent = /^([ \t]+)["{[]/m.exec(doc.text)?.[1] ?? '  ';
  return new PlainEditor(doc.valueOf(doc.root) as JsonRecord, indent, doc.newline);
}

/** One hook a harness config gets: the entry added to the event's list, and the command that shows it is there. */
export interface HookEntry {
  event: string;
  /** The item appended to the event's list: a group with `hooks` for the `groups` layout, a hook for `flat`. */
  entry: JsonRecord;
  command: string;
}

export interface JsonHookFile {
  /** The harness name, for `isAgentCommand`. */
  agent: string;
  /** The harness title, for messages. */
  title: string;
  /** The config file, relative to the project folder, with forward slashes. */
  file: string;
  /** Keys set at the top of the file when they are missing, such as `{ version: 1 }`. */
  top?: JsonRecord;
  /** The keys from the top of the file to the object that holds the events. Empty for the top itself. */
  container: string[];
  /**
   * `groups`: each event holds groups `{ matcher?, hooks: [ { command } ] }` (Claude Code's shape).
   * `flat`: each event holds hooks `{ command }` directly (Cursor, Copilot).
   */
  layout: 'groups' | 'flat';
  entries: HookEntry[];
  /** True when the file belongs to slopbuckets alone, so uninstall deletes it once it holds no hooks. */
  owned?: boolean;
  /** True for a command that this adapter writes. Default: `buckets hook --agent <agent> <event>`. */
  ours?: (command: string) => boolean;
  /** More changes in the same file, made after the hooks, such as a setting the harness needs. */
  extra?: (editor: { get(keys: Key[]): unknown; set(keys: Key[], value: unknown): void }) => InstallStep[];
}

/** One hook of a harness config before it takes the harness shape. `name` is the slopbuckets event. */
export interface HookDef {
  event: string;
  name: string;
  matcher?: string;
  /** More keys of the hook object, such as a timeout. */
  extra?: JsonRecord;
}

/** Entries in Claude Code's group shape: `{ matcher?, hooks: [{ type: "command", command, ...extra }] }`. */
export function groupEntries(agent: string, defs: HookDef[], cli: string = DEFAULT_COMMAND, wrap: (command: string) => string = (command) => command): HookEntry[] {
  return defs.map(({ event, name, matcher, extra }) => {
    const command = wrap(hookCommand(agent, name, cli));
    return { event, command, entry: { ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command, ...extra }] } };
  });
}

/** The command strings of one hook object, under every key a harness uses for one. */
function commandsOf(hook: unknown): string[] {
  if (!isRecord(hook)) return [];
  return ['command', 'bash', 'powershell', 'commandWindows'].map((key) => hook[key]).filter((value): value is string => typeof value === 'string');
}

function nodeAt(doc: JsoncText, keys: string[]): JsonNode | undefined {
  let node: JsonNode | undefined = doc.root;
  for (const key of keys) node = doc.property(node, key)?.value;
  return node;
}

/**
 * The next edit that removes a slopbuckets entry, or an event or container that such a removal left empty. With
 * `keep`, the entries equal to a current entry stay (the first of each).
 */
function nextRemoval(doc: JsoncText, spec: JsonHookFile, keep: boolean, touched: Set<string>): { event: string; edits: TextEdit[] } | undefined {
  const isOurs = spec.ours ?? ((command: string) => isAgentCommand(spec.agent, command));
  const ours = (hook: unknown): boolean => commandsOf(hook).some(isOurs);
  const container = nodeAt(doc, spec.container);
  if (container?.kind !== 'object') return undefined;
  for (const prop of container.props) {
    const list = prop.value;
    if (list.kind !== 'array') continue;
    if (list.items.length === 0 && touched.has(prop.key)) return { event: prop.key, edits: removePropertyEdits(doc, container, prop.key) };
    const wanted = keep ? spec.entries.filter((e) => e.event === prop.key).map((e) => e.entry) : [];
    for (const [i, item] of list.items.entries()) {
      const value = doc.valueOf(item);
      const match = wanted.findIndex((entry) => isDeepStrictEqual(entry, value));
      if (match !== -1) {
        wanted.splice(match, 1);
        continue;
      }
      if (spec.layout === 'flat') {
        if (ours(value)) return { event: prop.key, edits: removeItemEdits(doc, list, i) };
        continue;
      }
      if (!isRecord(value) || !Array.isArray(value.hooks)) continue;
      const hooks: unknown[] = value.hooks;
      const at = hooks.findIndex(ours);
      if (at === -1) continue;
      if (hooks.every(ours)) return { event: prop.key, edits: removeItemEdits(doc, list, i) };
      const hooksNode = doc.property(item, 'hooks')?.value;
      if (hooksNode?.kind === 'array') return { event: prop.key, edits: removeItemEdits(doc, hooksNode, at) };
    }
  }
  if (touched.size === 0) return undefined;
  // Containers left empty go, from the innermost out.
  for (let i = spec.container.length; i > 0; i--) {
    const node = nodeAt(doc, spec.container.slice(0, i));
    const parent = nodeAt(doc, spec.container.slice(0, i - 1));
    if (node?.kind === 'object' && node.props.length === 0 && parent?.kind === 'object') {
      return { event: spec.container[i - 1]!, edits: removePropertyEdits(doc, parent as JsonObject, spec.container[i - 1]!) };
    }
  }
  return undefined;
}

interface StripResult {
  /** absent: no file. kept: nothing to remove. written: entries removed. deleted: the file held only slopbuckets hooks. */
  state: 'absent' | 'kept' | 'written' | 'deleted';
  /** The events whose slopbuckets entries were removed. */
  removed: string[];
  /** The events of current entries the file does not hold after the removal. */
  missing: string[];
}

/**
 * Removes the slopbuckets entries of `spec` from its file, keeping comments and formatting elsewhere. With `keep`, the
 * entries equal to a current entry stay, so only older forms and events no longer used go. With `deleteEmpty`, a file
 * left with nothing but the `top` keys is deleted. Throws when the file is not a JSON object, when an entry to remove
 * holds a comment, or when the file is reached through a link.
 */
function stripHooks(projectDir: string, spec: JsonHookFile, options: { keep: boolean; deleteEmpty: boolean }): StripResult {
  const file = path.join(projectDir, spec.file);
  const events = [...new Set(spec.entries.map((e) => e.event))];
  if (!existsSync(file)) return { state: 'absent', removed: [], missing: events };
  const original = readFileSync(file, 'utf8');
  let text = original.trim() === '' ? '{}' : original;
  const touched = new Set<string>();
  for (;;) {
    const doc = new JsoncText(text);
    if (doc.root.kind !== 'object') throw new Error(`${spec.file} must contain a JSON object`);
    const removal = nextRemoval(doc, spec, options.keep, touched);
    if (removal === undefined) break;
    text = doc.apply(removal.edits);
    touched.add(removal.event);
  }
  const doc = new JsoncText(text);
  const container = nodeAt(doc, spec.container);
  const present = (entry: JsonRecord, event: string): boolean => {
    const list = container === undefined ? undefined : doc.property(container, event)?.value;
    return list?.kind === 'array' && list.items.some((item) => isDeepStrictEqual(doc.valueOf(item), entry));
  };
  const missing = [...new Set(spec.entries.filter((e) => !present(e.entry, e.event)).map((e) => e.event))];
  const removed = [...touched].filter((key) => !spec.container.includes(key));
  if (touched.size === 0) return { state: 'kept', removed, missing };
  const rest = doc.valueOf(doc.root) as JsonRecord;
  const leftover = Object.keys(rest).filter((key) => !(key in (spec.top ?? {})));
  if (options.deleteEmpty && leftover.length === 0 && (spec.owned === true || !doc.hasComments(0, doc.text.length))) {
    removeProjectFile(projectDir, spec.file);
    return { state: 'deleted', removed, missing };
  }
  writeProjectFile(projectDir, spec.file, text);
  return { state: 'written', removed, missing };
}

/** Appends the entries of `spec` that its file lacks. Returns the events that got one and the steps of `extra`. */
function addHooks(projectDir: string, spec: JsonHookFile): { added: string[]; extra: InstallStep[] } {
  const file = path.join(projectDir, spec.file);
  const editor = editorFor(existsSync(file) ? readFileSync(file, 'utf8') : '', spec.file);
  for (const [key, value] of Object.entries(spec.top ?? {})) if (editor.get([key]) === undefined) editor.set([key], value);
  for (let i = 0; i < spec.container.length; i++) {
    const keys = spec.container.slice(0, i + 1);
    const value = editor.get(keys);
    if (value === undefined) editor.set(keys, {});
    else if (!isRecord(value)) throw new Error(`"${keys.join('.')}" in ${spec.file} must be an object`);
  }
  const added: string[] = [];
  for (const hook of spec.entries) {
    const keys = [...spec.container, hook.event];
    const list = editor.get(keys);
    if (list === undefined) editor.set(keys, [hook.entry]);
    else if (!Array.isArray(list)) throw new Error(`"${keys.join('.')}" in ${spec.file} must be an array`);
    else if (list.some((item) => isDeepStrictEqual(item, hook.entry))) continue;
    else editor.append(keys, hook.entry);
    if (!added.includes(hook.event)) added.push(hook.event);
  }
  const extra = spec.extra?.(editor) ?? [];
  // A file whose hooks are all there is not rewritten, even when the plain editor would format it differently.
  if (added.length > 0 || extra.some((step) => step.status === 'done')) writeProjectFile(projectDir, spec.file, editor.output());
  return { added, extra };
}

/**
 * Writes the hooks of `spec` into its file, idempotently: other slopbuckets entries of the adapter (older events,
 * changed matchers or commands) go first, then the missing entries are added. The user's own entries and comments stay.
 */
export function installHooks(projectDir: string, spec: JsonHookFile): InstallStep[] {
  try {
    const strip = stripHooks(projectDir, spec, { keep: true, deleteEmpty: false });
    const { added, extra } = addHooks(projectDir, spec);
    const step: InstallStep =
      strip.removed.length > 0
        ? { status: 'done', text: `Updated the ${spec.title} hooks in ${spec.file} (${[...new Set([...strip.removed, ...strip.missing])].join(', ')})` }
        : added.length > 0
          ? { status: 'done', text: `Installed ${spec.title} hooks in ${spec.file} (${added.join(', ')})` }
          : { status: 'kept', text: `${spec.title} hooks are already in ${spec.file}` };
    return [step, ...extra];
  } catch (error) {
    return [{ status: 'failed', text: `Could not install the ${spec.title} hooks: ${message(error)}. Fix ${spec.file} and run \`buckets init\` again.` }];
  }
}

/** Removes every slopbuckets entry of `spec`, and the file when nothing else is left in it. */
export function uninstallHooks(projectDir: string, spec: JsonHookFile): InstallStep[] {
  try {
    const strip = stripHooks(projectDir, spec, { keep: false, deleteEmpty: true });
    if (strip.state === 'absent' || strip.state === 'kept') return [];
    if (strip.state === 'deleted') return [{ status: 'done', text: `Removed ${spec.file}, which held only the slopbuckets hooks` }];
    return [{ status: 'done', text: `Removed the slopbuckets hooks from ${spec.file} (${strip.removed.join(', ')})` }];
  } catch (error) {
    return [{ status: 'failed', text: `Could not remove the ${spec.title} hooks: ${message(error)}. Fix ${spec.file} and run \`buckets uninstall\` again.` }];
  }
}
