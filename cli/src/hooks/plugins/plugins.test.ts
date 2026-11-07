// Runs each plugin file that `buckets init` writes for OpenCode, Pi and Amp against a fake harness API and a fake
// `buckets` command, so no real harness is needed. The plugin is transpiled with the repository's TypeScript and loaded
// as an ES module, the way Bun and Pi's jiti load it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OUTSIDE_BASE, runFolder } from '@slopbuckets/adapter-ts/test-support';
import { PLUGIN_MARKER } from '../plugin-file.js';
import { ampPlugin, opencodePlugin, piPlugin } from './sources.js';

const OPENCODE_PLUGIN = opencodePlugin();
const PI_PLUGIN = piPlugin();
const AMP_PLUGIN = ampPlugin();

/** A temporary folder outside the repository, so the plugin finds no CLI in a node_modules above it. */
const ROOT = runFolder(OUTSIDE_BASE);

/**
 * The fake CLI. It logs every call and answers with a HookDecision: a pre-tool payload that mentions "denied" is
 * denied, one that mentions "ctx" gets context, and a stop or subagent-stop blocks while the file FAKE_STOP_FAIL exists.
 */
const FAKE_CLI = `
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const [, , hook, flag, agent, event] = process.argv;
const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ hook, flag, agent, event, payload }) + '\\n');
const text = JSON.stringify(payload);
let answer = { kind: 'silent' };
if (event === 'pre-tool') {
  if (text.includes('denied')) answer = { kind: 'deny', text: 'DENIED by ' + agent };
  else if (text.includes('ctx')) answer = { kind: 'context', text: 'CONTEXT for ' + agent };
} else if ((event === 'stop' || event === 'subagent-stop') && existsSync(process.env.FAKE_STOP_FAIL)) {
  answer = { kind: 'block', text: 'BLOCK (' + event + ')' };
}
process.stdout.write('some log line\\n' + JSON.stringify(answer) + '\\n');
`;

interface Env {
  dir: string;
  log: string;
  stopFail: string;
  fake: string;
}

let env: Env;
const savedEnv = { ...process.env };

beforeEach(() => {
  const dir = path.join(ROOT, randomUUID());
  mkdirSync(dir, { recursive: true });
  const fake = path.join(dir, 'fake-buckets.mjs');
  writeFileSync(fake, FAKE_CLI, 'utf8');
  env = { dir, log: path.join(dir, 'calls.jsonl'), stopFail: path.join(dir, 'stop-fails'), fake };
  process.env.FAKE_LOG = env.log;
  process.env.FAKE_STOP_FAIL = env.stopFail;
  process.env.SLOPBUCKETS_BIN = fake;
  writeFileSync(env.stopFail, '');
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function calls(): { agent: string; event: string; payload: Record<string, unknown>; flag: string; hook: string }[] {
  if (!existsSync(env.log)) return [];
  return readFileSync(env.log, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

const events = () => calls().map((c) => c.event);

/** Transpiles a plugin source and imports a fresh copy of it, with its own module state. */
async function loadPlugin(source: string): Promise<{ default: any }> {
  const { outputText, diagnostics } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  expect(diagnostics ?? []).toEqual([]);
  const file = path.join(env.dir, `plugin-${randomUUID()}.mjs`);
  writeFileSync(file, outputText, 'utf8');
  return import(pathToFileURL(file).href);
}

/** Hides the CLI completely: no override, an empty PATH and a folder with no node_modules above it. */
function hideCli(): void {
  delete process.env.SLOPBUCKETS_BIN;
  const empty = path.join(env.dir, 'empty-path');
  mkdirSync(empty, { recursive: true });
  process.env.PATH = empty;
  if (process.platform === 'win32') delete process.env.Path;
}

/** A CLI that never answers. */
function hangCli(): void {
  const hang = path.join(env.dir, 'hang.mjs');
  writeFileSync(hang, 'setInterval(() => {}, 1000);\n');
  process.env.SLOPBUCKETS_BIN = hang;
}

describe('plugin sources', () => {
  it('type-check as JavaScript with @ts-check', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const files = ['runtime.js', 'opencode.js', 'pi.js', 'amp.js'].map((name) => path.join(dir, name));
    const program = ts.createProgram(files, {
      allowJs: true,
      checkJs: true,
      // The harness APIs have no types here, so parameters stay implicitly any; every other check runs.
      strict: false,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: ['node'],
    });
    const problems = ts.getPreEmitDiagnostics(program).map((d) => `${d.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
    expect(problems).toEqual([]);
  });

  it.each([
    ['opencode', OPENCODE_PLUGIN],
    ['pi', PI_PLUGIN],
    ['amp', AMP_PLUGIN],
  ])('%s is one file with the marker, the runtime and no import of it', (name, source) => {
    expect(source.startsWith('// @ts-nocheck\n')).toBe(true);
    expect(source).toContain(PLUGIN_MARKER);
    expect(source).toContain(`const AGENT = "${name}";`);
    expect(source).toContain('const COMMAND = "buckets";');
    expect(source).not.toContain('./runtime.js');
    expect(source).not.toMatch(/^export (?!default)/m);
    expect(source).not.toContain('\r');
  });
});

describe('OpenCode plugin, V1 API', () => {
  async function start(sessions: Record<string, { parentID?: string }> = {}) {
    const plugin = (await loadPlugin(OPENCODE_PLUGIN)).default;
    const prompts: { id: string; text: string }[] = [];
    const toasts: string[] = [];
    const client = {
      app: { log: async () => ({}) },
      tui: { showToast: async ({ body }: { body: { message: string } }) => void toasts.push(body.message) },
      session: {
        get: async ({ path: p }: { path: { id: string } }) => ({ data: { id: p.id, ...sessions[p.id] } }),
        prompt: async ({ path: p, body }: { path: { id: string }; body: { parts: { text: string }[] } }) => {
          prompts.push({ id: p.id, text: body.parts[0]!.text });
          return { data: {} };
        },
      },
    };
    expect(plugin.id).toBe('slopbuckets');
    const hooks = await plugin.server({ directory: env.dir, worktree: env.dir, client });
    const before = (tool: string, args: unknown, callID = 'c1', sessionID = 's1') => hooks['tool.execute.before']({ tool, sessionID, callID }, { args });
    const after = async (tool: string, callID = 'c1', metadata: unknown = {}) => {
      const output = { title: '', output: 'tool output', metadata };
      await hooks['tool.execute.after']({ tool, sessionID: 's1', callID }, output);
      return output.output;
    };
    const event = (type: string, sessionID = 's1') => hooks.event({ event: { type, properties: { sessionID } } });
    const userMessage = (text: string, sessionID = 's1') => hooks['chat.message']({ sessionID }, { message: {}, parts: [{ type: 'text', text }] });
    return { hooks, before, after, event, userMessage, prompts, toasts };
  }

  it('sends every tool call as pre-tool, throws a deny, and lets other calls run', async () => {
    const h = await start();
    await expect(h.before('write', { filePath: 'denied.ts', content: '' })).rejects.toThrow('DENIED by opencode');
    await expect(h.before('bash', { command: 'ls' })).resolves.toBeUndefined();
    await expect(h.before('read', { filePath: 'a.ts' })).resolves.toBeUndefined();
    expect(calls()[0]).toMatchObject({ hook: 'hook', flag: '--agent', agent: 'opencode', event: 'pre-tool' });
    expect(calls().map((c) => c.payload)).toEqual([
      { cwd: env.dir, sessionId: 's1', tool: 'write', args: { filePath: 'denied.ts', content: '' } },
      { cwd: env.dir, sessionId: 's1', tool: 'bash', args: { command: 'ls' } },
      { cwd: env.dir, sessionId: 's1', tool: 'read', args: { filePath: 'a.ts' } },
    ]);
  });

  it('appends context to the output of the same call, once', async () => {
    const h = await start();
    await h.before('read', { filePath: 'ctx.ts' }, 'c1');
    await h.before('read', { filePath: 'a.ts' }, 'c2');
    expect(await h.after('read', 'c2')).toBe('tool output');
    expect(await h.after('read', 'c1')).toBe('tool output\n\nCONTEXT for opencode');
    expect(await h.after('read', 'c1')).toBe('tool output');
  });

  it('appends the subagent-stop check of the child session to a task result', async () => {
    const h = await start();
    expect(await h.after('task', 'c3', { sessionId: 'child' })).toBe('tool output\n\nBLOCK (subagent-stop)');
    expect(calls().at(-1)).toMatchObject({ event: 'subagent-stop', payload: { sessionId: 'child' } });
    expect(await h.after('task', 'c4', {})).toBe('tool output');
    expect(events()).toEqual(['subagent-stop']);
  });

  it('re-prompts once per user turn on session.idle, and not for child sessions', async () => {
    const h = await start({ child: { parentID: 's1' } });
    await h.event('session.idle');
    expect(h.prompts).toEqual([{ id: 's1', text: '[slopbuckets] BLOCK (stop)' }]);
    // The re-prompt itself arrives as a user message and must not start a new turn.
    await h.userMessage('[slopbuckets] BLOCK (stop)');
    await h.event('session.idle');
    expect(h.prompts).toHaveLength(1);
    expect(calls().map((c) => c.payload.stopHookActive)).toEqual([false, true]);
    await h.userMessage('please continue');
    await h.event('session.idle');
    expect(h.prompts).toHaveLength(2);
    await h.event('session.idle', 'child');
    expect(h.prompts).toHaveLength(2);
    expect(events()).toEqual(['stop', 'stop', 'stop']);
  });

  it('does not re-prompt when the check passes or after a session error', async () => {
    const h = await start();
    rmSync(env.stopFail);
    await h.event('session.idle');
    expect(h.prompts).toEqual([]);
    writeFileSync(env.stopFail, '');
    await h.event('session.error');
    await h.event('session.idle');
    expect(h.prompts).toEqual([]);
  });

  it('runs post-compact on session.compacted', async () => {
    const h = await start();
    await h.event('session.compacted');
    expect(calls()).toEqual([expect.objectContaining({ event: 'post-compact', payload: { cwd: env.dir, sessionId: 's1' } })]);
  });

  it('lets everything run when the CLI is missing, and warns once', async () => {
    hideCli();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await start();
    await expect(h.before('write', { filePath: 'denied.ts' })).resolves.toBeUndefined();
    await expect(h.before('read', { filePath: 'ctx.ts' })).resolves.toBeUndefined();
    expect(await h.after('read')).toBe('tool output');
    await h.event('session.idle');
    expect(h.prompts).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain('The buckets command was not found');
    expect(h.toasts).toHaveLength(1);
  });

  it('lets the tool run when the CLI times out', async () => {
    hangCli();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = h.before('write', { filePath: 'denied.ts' });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBeUndefined();
    expect(String(error.mock.calls[0]![0])).toContain('took more than 10 seconds');
  });
});

describe('OpenCode plugin, V2 API', () => {
  async function start(sessions: Record<string, { parentID?: string }> = {}) {
    const plugin = (await loadPlugin(OPENCODE_PLUGIN)).default;
    const toolHooks: Record<string, (event: any) => Promise<void>> = {};
    const sessionHooks: Record<string, (event: any) => void> = {};
    const prompts: { sessionID: string; text: string }[] = [];
    const queue: unknown[] = [];
    let wake: (() => void) | undefined;
    const ctx = {
      location: { directory: env.dir },
      tool: { hook: async (name: string, cb: (event: any) => Promise<void>) => void (toolHooks[name] = cb) },
      session: {
        hook: async (name: string, cb: (event: any) => void) => void (sessionHooks[name] = cb),
        get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, ...sessions[sessionID] }),
        prompt: async (input: { sessionID: string; text: string }) => void prompts.push(input),
      },
      event: {
        subscribe: ({ signal }: { signal: AbortSignal }) => ({
          async *[Symbol.asyncIterator]() {
            while (!signal.aborted) {
              if (queue.length > 0) yield queue.shift();
              else await new Promise<void>((resolve) => (wake = resolve));
            }
          },
        }),
      },
    };
    const cleanup = await plugin.setup(ctx);
    const emit = (event: unknown) => {
      queue.push(event);
      wake?.();
    };
    return { toolHooks, sessionHooks, prompts, emit, cleanup };
  }

  it('throws a deny, and appends context to a completed result of the same call', async () => {
    const h = await start();
    const before = h.toolHooks['execute.before']!;
    const after = h.toolHooks['execute.after']!;
    await expect(before({ id: 'a', tool: 'write', sessionID: 's1', input: { path: 'denied.ts', content: '' } })).rejects.toThrow('DENIED by opencode');
    await before({ id: 'b', tool: 'shell', sessionID: 's1', input: { command: 'cat ctx.ts' } });
    const done = { id: 'b', tool: 'shell', sessionID: 's1', status: 'completed', result: { content: 'out' } };
    await after(done);
    expect(done.result.content).toBe('out\n\nCONTEXT for opencode');
    await before({ id: 'c', tool: 'read', sessionID: 's1', input: { path: 'ctx.ts' } });
    await after({ id: 'c', tool: 'read', sessionID: 's1', status: 'error', error: { message: 'x' } });
    const parts = { id: 'c', tool: 'read', sessionID: 's1', status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } };
    await after(parts);
    expect(parts.result.content).toEqual([{ type: 'text', text: 'ok' }]);
    h.cleanup();
  });

  it('never rejects from execute.after', async () => {
    const h = await start();
    const broken = Object.defineProperty({ id: 'x', status: 'completed' }, 'tool', {
      get() {
        throw new Error('broken');
      },
    });
    await expect(h.toolHooks['execute.after']!(broken)).resolves.toBeUndefined();
    h.cleanup();
  });

  it('re-prompts once on idle until the human writes again, skips child sessions and runs post-compact', async () => {
    const h = await start({ child: { parentID: 's1' } });
    h.emit({ type: 'session.idle', properties: { sessionID: 's1' } });
    await vi.waitFor(() => expect(h.prompts).toEqual([{ sessionID: 's1', text: '[slopbuckets] BLOCK (stop)' }]), { timeout: 10_000 });
    h.sessionHooks.prompt!({ sessionID: 's1', prompt: { text: '[slopbuckets] BLOCK (stop)' } });
    h.emit({ type: 'session.status', data: { sessionID: 's1', status: { type: 'idle' } } });
    await vi.waitFor(() => expect(events()).toEqual(['stop', 'stop']), { timeout: 10_000 });
    expect(h.prompts).toHaveLength(1);
    h.sessionHooks.prompt!({ sessionID: 's1', prompt: { text: 'go on' } });
    h.emit({ type: 'session.idle', properties: { sessionID: 's1' } });
    await vi.waitFor(() => expect(h.prompts).toHaveLength(2), { timeout: 10_000 });
    h.emit({ type: 'session.idle', properties: { sessionID: 'child' } });
    h.emit({ type: 'session.compaction.ended', properties: { sessionID: 's1' } });
    await vi.waitFor(() => expect(events()).toContain('post-compact'), { timeout: 10_000 });
    expect(events().filter((e) => e === 'stop')).toHaveLength(3);
    expect(h.prompts).toHaveLength(2);
    h.cleanup();
  });

  it('lets everything run when the CLI is missing', async () => {
    hideCli();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await start();
    await expect(h.toolHooks['execute.before']!({ id: 'a', tool: 'write', sessionID: 's1', input: { path: 'denied.ts' } })).resolves.toBeUndefined();
    h.cleanup();
  });
});

describe('Pi extension', () => {
  async function start(options: { sendMessage?: (...args: unknown[]) => unknown; refuse?: string[] } = {}) {
    const factory = (await loadPlugin(PI_PLUGIN)).default;
    const handlers: Record<string, (event: any, ctx: any) => any> = {};
    const notes: string[] = [];
    const sent: unknown[][] = [];
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => any) => {
        if (options.refuse?.includes(name)) throw new Error(`unknown event ${name}`);
        handlers[name] = handler;
      },
      sendMessage: options.sendMessage ?? ((...args: unknown[]) => void sent.push(args)),
    };
    factory(pi);
    const ctx = { cwd: env.dir, hasUI: true, ui: { notify: (message: string) => void notes.push(message) }, sessionManager: { getSessionId: () => 's1' } };
    const settle = () => handlers.agent_before_settle!({ type: 'agent_before_settle', entries: [{ type: 'custom', customType: 'x' }], continue: false, outcome: 'completed' }, ctx);
    return { handlers, ctx, notes, sent, settle };
  }

  it('blocks a denied call with { block, reason }, and lets other calls run', async () => {
    const h = await start();
    const call = h.handlers.tool_call!;
    expect(await call({ toolCallId: 't1', toolName: 'write', input: { path: 'denied.ts', content: '' } }, h.ctx)).toEqual({ block: true, reason: 'DENIED by pi' });
    expect(await call({ toolCallId: 't2', toolName: 'read', input: { path: 'a.ts' } }, h.ctx)).toBeUndefined();
    expect(calls().map((c) => [c.event, c.payload])).toEqual([
      ['pre-tool', { cwd: env.dir, sessionId: 's1', tool: 'write', args: { path: 'denied.ts', content: '' } }],
      ['pre-tool', { cwd: env.dir, sessionId: 's1', tool: 'read', args: { path: 'a.ts' } }],
    ]);
  });

  it('sends context as a hidden steering message', async () => {
    const h = await start();
    expect(await h.handlers.tool_call!({ toolCallId: 't1', toolName: 'read', input: { path: 'ctx.ts' } }, h.ctx)).toBeUndefined();
    expect(h.sent).toEqual([[{ customType: 'slopbuckets', content: 'CONTEXT for pi', display: false }, { deliverAs: 'steer' }]]);
    expect(h.handlers.tool_result!({ toolCallId: 't1', content: [], isError: false }, h.ctx)).toBeUndefined();
  });

  it('appends context to the tool result when steering fails', async () => {
    const h = await start({
      sendMessage: () => {
        throw new Error('not now');
      },
    });
    expect(await h.handlers.tool_call!({ toolCallId: 't1', toolName: 'read', input: { path: 'ctx.ts' } }, h.ctx)).toBeUndefined();
    expect(h.handlers.tool_result!({ toolCallId: 't1', content: [{ type: 'text', text: 'done' }], isError: false, structuredContent: { a: 1 } }, h.ctx)).toEqual({
      content: [
        { type: 'text', text: 'done' },
        { type: 'text', text: 'CONTEXT for pi' },
      ],
      structuredContent: { a: 1 },
    });
    expect(h.handlers.tool_result!({ toolCallId: 't1', content: [], isError: false }, h.ctx)).toBeUndefined();
  });

  it('never throws from tool_call, because a throw would block the tool', async () => {
    const h = await start();
    const broken = Object.defineProperty({ toolCallId: 't1' }, 'toolName', {
      get() {
        throw new Error('broken');
      },
    });
    await expect(h.handlers.tool_call!(broken, h.ctx)).resolves.toBeUndefined();
    await expect(h.handlers.tool_call!({ toolName: 'read', input: {} }, null)).resolves.toBeUndefined();
  });

  it('continues once per user turn with agent_before_settle', async () => {
    const h = await start();
    expect(await h.settle()).toEqual({
      entries: [
        { type: 'custom', customType: 'x' },
        { type: 'custom_message', customType: 'slopbuckets', content: 'BLOCK (stop)', display: true },
      ],
      continue: true,
    });
    expect(await h.settle()).toBeUndefined();
    expect(calls().map((c) => c.payload.stopHookActive)).toEqual([false, true]);
    // A run started by an extension (Pi 1.2.0 and newer) is not a new user turn.
    h.handlers.before_agent_start!({ type: 'before_agent_start', messageType: 'custom' }, h.ctx);
    expect(await h.settle()).toBeUndefined();
    h.handlers.before_agent_start!({ type: 'before_agent_start', messageType: 'user', prompt: 'next' }, h.ctx);
    expect((await h.settle())?.continue).toBe(true);
    expect(await h.handlers.agent_before_settle!({ entries: [], outcome: 'aborted' }, h.ctx)).toBeUndefined();
  });

  it('runs post-compact on session_compact', async () => {
    const h = await start();
    await h.handlers.session_compact!({ type: 'session_compact', reason: 'threshold' }, h.ctx);
    expect(calls()).toEqual([expect.objectContaining({ event: 'post-compact', payload: { cwd: env.dir, sessionId: 's1' } })]);
  });

  it('keeps working on a Pi without agent_before_settle, and warns', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await start({ refuse: ['agent_before_settle'] });
    expect(h.handlers.tool_call).toBeDefined();
    expect(String(error.mock.calls[0]![0])).toContain('no agent_before_settle event');
  });

  it('lets everything run when the CLI is missing, and notifies once', async () => {
    hideCli();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await start();
    expect(await h.handlers.tool_call!({ toolName: 'write', input: { path: 'denied.ts' } }, h.ctx)).toBeUndefined();
    expect(await h.handlers.tool_call!({ toolName: 'read', input: { path: 'ctx.ts' } }, h.ctx)).toBeUndefined();
    expect(await h.settle()).toBeUndefined();
    expect(h.sent).toEqual([]);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toContain('The buckets command was not found');
  });
});

describe('Amp plugin', () => {
  async function start(parent: string | null = null) {
    // Amp runs the plugin in the project folder, which the plugin reads from process.cwd().
    vi.spyOn(process, 'cwd').mockReturnValue(env.dir);
    const factory = (await loadPlugin(AMP_PLUGIN)).default;
    const handlers: Record<string, (event: any, ctx: any) => any> = {};
    const notes: string[] = [];
    const uri = (p: string) => ({ toString: () => pathToFileURL(p).href, fsPath: p });
    const amp = {
      on: (name: string, handler: (event: any, ctx: any) => any) => void (handlers[name] = handler),
      helpers: {
        filesModifiedByToolCall: (event: any) => (event.tool === 'edit_file' ? [uri(path.join(env.dir, event.input.path))] : null),
        filePathFromURI: (u: { fsPath: string }) => u.fsPath,
        shellCommandFromToolCall: (event: any) => (event.tool === 'Bash' ? { command: event.input.cmd, dir: event.input.cwd } : null),
      },
    };
    factory(amp);
    const ctx = { ui: { notify: async (message: string) => void notes.push(message) }, thread: { parentThreadID: async () => parent } };
    const thread = { id: 'T-1' };
    const end = () => handlers['agent.end']!({ thread, message: 'hi', id: 'm', status: 'done', messages: [] }, ctx);
    return { handlers, ctx, notes, thread, end };
  }

  it('rejects a denied call with reject-and-continue, and allows other calls', async () => {
    const h = await start();
    const call = h.handlers['tool.call']!;
    expect(await call({ toolUseID: 'a', tool: 'edit_file', input: { path: 'denied.ts' }, thread: h.thread }, h.ctx)).toEqual({ action: 'reject-and-continue', message: 'DENIED by amp' });
    expect(await call({ toolUseID: 'b', tool: 'Bash', input: { cmd: 'ls', cwd: 'sub' }, thread: h.thread }, h.ctx)).toEqual({ action: 'allow' });
    expect(await call({ toolUseID: 'c', tool: 'Read', input: { path: 'a.ts' }, thread: h.thread }, h.ctx)).toEqual({ action: 'allow' });
    expect(calls().map((c) => c.payload)).toEqual([
      { cwd: env.dir, sessionId: 'T-1', tool: 'edit_file', args: { path: 'denied.ts' }, paths: [path.join(env.dir, 'denied.ts')] },
      { cwd: env.dir, sessionId: 'T-1', tool: 'Bash', args: { cmd: 'ls', cwd: 'sub' }, command: 'ls' },
      { cwd: env.dir, sessionId: 'T-1', tool: 'Read', args: { path: 'a.ts' }, paths: [] },
    ]);
  });

  it('appends context to the output of the same call when it is done', async () => {
    const h = await start();
    const call = h.handlers['tool.call']!;
    const result = h.handlers['tool.result']!;
    await call({ toolUseID: 'a', tool: 'Read', input: { path: 'ctx.ts' }, thread: h.thread }, h.ctx);
    expect(result({ toolUseID: 'a', tool: 'Read', status: 'done', output: 'text', thread: h.thread }, h.ctx)).toEqual({ status: 'done', output: 'text\n\nCONTEXT for amp' });
    await call({ toolUseID: 'b', tool: 'Read', input: { path: 'ctx.ts' }, thread: h.thread }, h.ctx);
    expect(result({ toolUseID: 'b', tool: 'Read', status: 'done', output: { diff: '+x' }, thread: h.thread }, h.ctx)).toEqual({
      status: 'done',
      output: { diff: '+x', slopbuckets: 'CONTEXT for amp' },
    });
    await call({ toolUseID: 'c', tool: 'Read', input: { path: 'ctx.ts' }, thread: h.thread }, h.ctx);
    expect(result({ toolUseID: 'c', tool: 'Read', status: 'error', error: 'x', thread: h.thread }, h.ctx)).toBeUndefined();
    expect(result({ toolUseID: 'd', tool: 'Read', status: 'done', output: 'ok', thread: h.thread }, h.ctx)).toBeUndefined();
  });

  it('continues once per user turn on agent.end with maxContinuations 1', async () => {
    const h = await start();
    expect(await h.end()).toEqual({ action: 'continue', userMessage: '[slopbuckets] BLOCK (stop)', maxContinuations: 1 });
    h.handlers['agent.start']!({ thread: h.thread, message: '[slopbuckets] BLOCK (stop)', id: 'm2' }, h.ctx);
    expect(await h.end()).toBeUndefined();
    expect(calls().map((c) => c.payload.stopHookActive)).toEqual([false, true]);
    h.handlers['agent.start']!({ thread: h.thread, message: 'thanks, now fix it', id: 'm3' }, h.ctx);
    expect((await h.end())?.action).toBe('continue');
  });

  it('sends subagent-stop for a thread with a parent', async () => {
    const h = await start('T-0');
    expect(await h.end()).toEqual({ action: 'continue', userMessage: '[slopbuckets] BLOCK (subagent-stop)', maxContinuations: 1 });
    expect(calls()[0]).toMatchObject({ event: 'subagent-stop', payload: { sessionId: 'T-1' } });
  });

  it('lets everything run when the CLI is missing, and notifies once', async () => {
    hideCli();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await start();
    expect(await h.handlers['tool.call']!({ toolUseID: 'a', tool: 'edit_file', input: { path: 'denied.ts' }, thread: h.thread }, h.ctx)).toEqual({ action: 'allow' });
    expect(await h.end()).toBeUndefined();
    expect(h.notes).toHaveLength(1);
  });
});

describe('finding the buckets command', () => {
  async function piCall() {
    const factory = (await loadPlugin(PI_PLUGIN)).default;
    const handlers: Record<string, (event: any, ctx: any) => any> = {};
    factory({ on: (name: string, handler: (event: any, ctx: any) => any) => void (handlers[name] = handler), sendMessage: () => {} });
    return handlers.tool_call!({ toolName: 'write', input: { path: 'denied.ts' } }, { cwd: env.dir, hasUI: false });
  }

  it('uses the CLI installed in node_modules of the project or a folder above it', async () => {
    delete process.env.SLOPBUCKETS_BIN;
    const entry = path.join(env.dir, 'node_modules', 'slopbuckets', 'dist', 'index.js');
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, FAKE_CLI, 'utf8');
    writeFileSync(path.join(env.dir, 'node_modules', 'slopbuckets', 'package.json'), '{ "type": "module" }');
    expect(await piCall()).toEqual({ block: true, reason: 'DENIED by pi' });
  });

  it('runs buckets from PATH, a Windows .cmd shim included', async () => {
    delete process.env.SLOPBUCKETS_BIN;
    const bin = path.join(env.dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const node = process.execPath;
    if (process.platform === 'win32') writeFileSync(path.join(bin, 'buckets.cmd'), `@echo off\r\n"${node}" "${env.fake}" %*\r\n`);
    else writeFileSync(path.join(bin, 'buckets'), `#!/bin/sh\nexec "${node}" "${env.fake}" "$@"\n`, { mode: 0o755 });
    process.env.PATH = [bin, path.dirname(node)].join(path.delimiter);
    expect(await piCall()).toEqual({ block: true, reason: 'DENIED by pi' });
  });

  it.runIf(process.platform === 'win32')('runs the real entry next to an npm .cmd shim with node, without a shell', async () => {
    delete process.env.SLOPBUCKETS_BIN;
    const bin = path.join(env.dir, 'npm');
    const entry = path.join(bin, 'node_modules', 'slopbuckets', 'dist', 'index.js');
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, FAKE_CLI, 'utf8');
    writeFileSync(path.join(bin, 'node_modules', 'slopbuckets', 'package.json'), '{ "type": "module" }');
    // A shim that would fail if it ran: the plugin must skip it and start the entry with node.
    writeFileSync(path.join(bin, 'buckets.cmd'), '@echo off\r\nexit /b 3\r\n');
    process.env.PATH = [bin, path.dirname(process.execPath)].join(path.delimiter);
    expect(await piCall()).toEqual({ block: true, reason: 'DENIED by pi' });
  });

  it('lets the call run and warns when the CLI crashes or answers something other than a decision', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = path.join(env.dir, 'broken.mjs');
    writeFileSync(broken, "process.stderr.write('unknown event'); process.exit(1);\n");
    process.env.SLOPBUCKETS_BIN = broken;
    expect(await piCall()).toBeUndefined();
    expect(String(error.mock.calls[0]![0])).toContain('unknown event');
    // A 1.x answer is JSON but not a decision.
    writeFileSync(broken, "process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'old' }) + '\\n');\n");
    expect(await piCall()).toBeUndefined();
  });
});
