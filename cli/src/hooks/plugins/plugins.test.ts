// Runs each plugin file that `buckets init` writes for OpenCode, Pi and Amp against a fake harness API and a fake
// `buckets` command, so no real harness is needed. The plugin is transpiled with the repository's TypeScript and loaded
// as an ES module, the way Bun and Pi's jiti load it.
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AMP_PLUGIN } from './amp.js';
import { OPENCODE_PLUGIN } from './opencode.js';
import { PI_PLUGIN } from './pi.js';

/** A temporary folder outside the repository, so the plugin finds no CLI in a node_modules above it. */
const ROOT = path.join(os.tmpdir(), `slopbuckets-plugins-${randomUUID()}`);
mkdirSync(ROOT, { recursive: true });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/**
 * The fake CLI. It logs every call and answers like the real one for the cases the tests use: a payload that names
 * buckets.lock.json or runs `buckets refresh` without `--web` is denied, an edit of a path with "bad" in it gets
 * feedback, and a stop blocks while the file FAKE_STOP_FAIL exists.
 */
const FAKE_CLI = `
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const [, , hook, flag, agent, event] = process.argv;
const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ hook, flag, agent, event, payload }) + '\\n');
const text = JSON.stringify(payload);
let answer = {};
if (event === 'pre-tool-use') {
  const command = payload.command ?? payload.args?.command ?? '';
  const refresh = /buckets\\s+refresh(?!\\s+--web)/.test(command);
  answer = text.includes('buckets.lock.json') || refresh ? { decision: 'deny', reason: 'LOCK DENIED by ' + agent } : { decision: 'allow' };
} else if (event === 'post-tool-use') {
  if (text.includes('bad')) answer = { feedback: 'VIOLATION in the edited file' };
} else if (existsSync(process.env.FAKE_STOP_FAIL)) {
  answer = { block: 'CHECK FAILED (' + event + ')' };
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
});

function calls(): { agent: string; event: string; payload: Record<string, unknown>; flag: string; hook: string }[] {
  if (!existsSync(env.log)) return [];
  return readFileSync(env.log, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

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

const lock = () => path.join(env.dir, 'buckets.lock.json');
const bad = () => path.join(env.dir, 'root', '_', 'bad.ts');
const good = () => path.join(env.dir, 'root', '_', 'good.ts');

/** Hides the CLI completely: no override, an empty PATH and a folder with no node_modules above it. */
function hideCli(): void {
  delete process.env.SLOPBUCKETS_BIN;
  const empty = path.join(env.dir, 'empty-path');
  mkdirSync(empty, { recursive: true });
  process.env.PATH = empty;
  if (process.platform === 'win32') delete process.env.Path;
}

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
    const before = (tool: string, args: unknown, sessionID = 's1') => hooks['tool.execute.before']({ tool, sessionID, callID: 'c' }, { args });
    const after = async (tool: string, args: unknown, sessionID = 's1') => {
      const output = { title: '', output: 'tool output', metadata: {} };
      await hooks['tool.execute.after']({ tool, sessionID, callID: 'c', args }, output);
      return output.output;
    };
    const idle = (sessionID = 's1') => hooks.event({ event: { type: 'session.idle', properties: { sessionID } } });
    const userMessage = (text: string, sessionID = 's1') => hooks['chat.message']({ sessionID }, { message: {}, parts: [{ type: 'text', text }] });
    return { hooks, before, after, idle, userMessage, prompts, toasts };
  }

  it('blocks a lock write by throwing the reason, and blocks plain refresh but not refresh --web', async () => {
    const h = await start();
    await expect(h.before('write', { filePath: lock(), content: '{}' })).rejects.toThrow('LOCK DENIED by opencode');
    await expect(h.before('bash', { command: 'buckets refresh' })).rejects.toThrow('LOCK DENIED');
    await expect(h.before('bash', { command: 'buckets refresh --web > refresh.log 2>&1 &' })).resolves.toBeUndefined();
    await expect(h.before('write', { filePath: good() })).resolves.toBeUndefined();
    const sent = calls();
    expect(sent[0]).toMatchObject({ hook: 'hook', flag: '--agent', agent: 'opencode', event: 'pre-tool-use' });
    expect(sent[0]!.payload).toMatchObject({ api: 'v1', tool: 'write', cwd: env.dir, projectDir: env.dir, sessionId: 's1' });
  });

  it('does not call the CLI for tools it does not guard', async () => {
    const h = await start();
    await h.before('read', { filePath: lock() });
    expect(calls()).toEqual([]);
  });

  it('appends feedback after an edit with a violation, and nothing after a clean one', async () => {
    const h = await start();
    expect(await h.after('edit', { filePath: bad() })).toBe('tool output\n\nVIOLATION in the edited file');
    expect(await h.after('edit', { filePath: good() })).toBe('tool output');
    expect(await h.after('task', {})).toBe('tool output\n\nCHECK FAILED (subagent-stop)');
  });

  it('re-prompts once per user turn on session.idle, and not for subagent sessions', async () => {
    const h = await start({ child: { parentID: 's1' } });
    await h.idle();
    expect(h.prompts).toEqual([{ id: 's1', text: '[slopbuckets] CHECK FAILED (stop)' }]);
    // The re-prompt itself arrives as a user message and must not start a new turn.
    await h.userMessage('[slopbuckets] CHECK FAILED (stop)');
    await h.idle();
    expect(h.prompts).toHaveLength(1);
    // A message from the human starts a new turn.
    await h.userMessage('please continue');
    await h.idle();
    expect(h.prompts).toHaveLength(2);
    await h.idle('child');
    expect(h.prompts).toHaveLength(2);
    expect(calls().filter((c) => c.event === 'stop')).toHaveLength(2);
  });

  it('does not re-prompt when the check passes or after a session error', async () => {
    const h = await start();
    rmSync(env.stopFail);
    await h.idle();
    expect(h.prompts).toEqual([]);
    writeFileSync(env.stopFail, '');
    await h.hooks.event({ event: { type: 'session.error', properties: { sessionID: 's1' } } });
    await h.idle();
    expect(h.prompts).toEqual([]);
  });

  it('does not block when the CLI is missing, and warns once', async () => {
    hideCli();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await start();
    await expect(h.before('write', { filePath: lock() })).resolves.toBeUndefined();
    await expect(h.before('bash', { command: 'buckets refresh' })).resolves.toBeUndefined();
    expect(await h.after('edit', { filePath: bad() })).toBe('tool output');
    await h.idle();
    expect(h.prompts).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain('The buckets command was not found');
    expect(h.toasts).toHaveLength(1);
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
    /** Emits an event and waits for the plugin to handle it. */
    const emit = async (event: unknown) => {
      queue.push(event);
      wake?.();
      await vi.waitFor(() => expect(queue).toHaveLength(0));
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    return { toolHooks, sessionHooks, prompts, emit, cleanup };
  }

  it('blocks a lock write and plain refresh by throwing, and allows refresh --web', async () => {
    const h = await start();
    const before = h.toolHooks['execute.before']!;
    await expect(before({ tool: 'write', sessionID: 's1', input: { path: lock(), content: '{}' } })).rejects.toThrow('LOCK DENIED');
    await expect(before({ tool: 'shell', sessionID: 's1', input: { command: 'buckets refresh' } })).rejects.toThrow('LOCK DENIED');
    await expect(before({ tool: 'shell', sessionID: 's1', input: { command: 'buckets refresh --web' } })).resolves.toBeUndefined();
    expect(calls()[0]!.payload).toMatchObject({ api: 'v2', tool: 'write' });
    h.cleanup();
  });

  it('appends feedback to the tool result after an edit with a violation', async () => {
    const h = await start();
    const after = h.toolHooks['execute.after']!;
    const event = { tool: 'edit', sessionID: 's1', input: { path: bad() }, status: 'completed', result: { content: 'edited' } };
    await after(event);
    expect(event.result.content).toBe('edited\n\nVIOLATION in the edited file');
    const parts = { tool: 'write', sessionID: 's1', input: { path: bad() }, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } };
    await after(parts);
    expect(parts.result.content).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'text', text: 'VIOLATION in the edited file' },
    ]);
    const failed = { tool: 'edit', sessionID: 's1', input: { path: bad() }, status: 'error', error: { message: 'x' } };
    await after(failed);
    expect(calls().filter((c) => c.event === 'post-tool-use')).toHaveLength(2);
    h.cleanup();
  });

  it('re-prompts once on idle until the human writes again, and skips subagent sessions', async () => {
    const h = await start({ child: { parentID: 's1' } });
    await h.emit({ type: 'session.idle', properties: { sessionID: 's1' } });
    await vi.waitFor(() => expect(h.prompts).toEqual([{ sessionID: 's1', text: '[slopbuckets] CHECK FAILED (stop)' }]), { timeout: 10_000 });
    h.sessionHooks.prompt!({ sessionID: 's1', prompt: { text: '[slopbuckets] CHECK FAILED (stop)' } });
    await h.emit({ type: 'session.status', data: { sessionID: 's1', status: { type: 'idle' } } });
    expect(h.prompts).toHaveLength(1);
    h.sessionHooks.prompt!({ sessionID: 's1', prompt: { text: 'go on' } });
    await h.emit({ type: 'session.idle', properties: { sessionID: 's1' } });
    await vi.waitFor(() => expect(h.prompts).toHaveLength(2), { timeout: 10_000 });
    await h.emit({ type: 'session.idle', properties: { sessionID: 'child' } });
    expect(h.prompts).toHaveLength(2);
    h.cleanup();
  });

  it('does not block when the CLI is missing', async () => {
    hideCli();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await start();
    await expect(h.toolHooks['execute.before']!({ tool: 'write', sessionID: 's1', input: { path: lock() } })).resolves.toBeUndefined();
    h.cleanup();
  });
});

describe('Pi extension', () => {
  async function start() {
    const factory = (await loadPlugin(PI_PLUGIN)).default;
    const handlers: Record<string, (event: any, ctx: any) => any> = {};
    const notes: string[] = [];
    factory({ on: (name: string, handler: (event: any, ctx: any) => any) => void (handlers[name] = handler) });
    const ctx = { cwd: env.dir, hasUI: true, ui: { notify: (message: string) => void notes.push(message) }, sessionManager: { getSessionId: () => 's1' } };
    const settle = () => handlers.agent_before_settle!({ type: 'agent_before_settle', entries: [{ type: 'custom', customType: 'x' }], continue: false, outcome: 'completed' }, ctx);
    return { handlers, ctx, notes, settle };
  }

  it('blocks a lock write and plain refresh with { block, reason }, and allows refresh --web', async () => {
    const h = await start();
    const call = h.handlers.tool_call!;
    expect(await call({ toolName: 'write', input: { path: lock(), content: '{}' } }, h.ctx)).toEqual({ block: true, reason: 'LOCK DENIED by pi' });
    expect(await call({ toolName: 'powershell', input: { command: 'buckets refresh' } }, h.ctx)).toEqual({ block: true, reason: 'LOCK DENIED by pi' });
    expect(await call({ toolName: 'bash', input: { command: 'buckets refresh --web 2>&1 | tee refresh.log' } }, h.ctx)).toBeUndefined();
    expect(await call({ toolName: 'read', input: { path: lock() } }, h.ctx)).toBeUndefined();
    expect(calls()).toHaveLength(3);
    expect(calls()[0]!.payload).toMatchObject({ tool: 'write', cwd: env.dir, sessionId: 's1' });
  });

  it('appends feedback to the tool result after an edit with a violation', async () => {
    const h = await start();
    const result = h.handlers.tool_result!;
    expect(await result({ toolName: 'edit', input: { path: bad() }, content: [{ type: 'text', text: 'done' }], isError: false, structuredContent: { a: 1 } }, h.ctx)).toEqual({
      content: [
        { type: 'text', text: 'done' },
        { type: 'text', text: 'VIOLATION in the edited file' },
      ],
      structuredContent: { a: 1 },
    });
    expect(await result({ toolName: 'edit', input: { path: good() }, content: [], isError: false }, h.ctx)).toBeUndefined();
    expect(await result({ toolName: 'edit', input: { path: bad() }, content: [], isError: true }, h.ctx)).toBeUndefined();
  });

  it('continues the agent once per user turn with agent_before_settle', async () => {
    const h = await start();
    expect(await h.settle()).toEqual({
      entries: [
        { type: 'custom', customType: 'x' },
        { type: 'custom_message', customType: 'slopbuckets', content: 'CHECK FAILED (stop)', display: true },
      ],
      continue: true,
    });
    expect(await h.settle()).toBeUndefined();
    h.handlers.before_agent_start!({ type: 'before_agent_start', prompt: 'next' }, h.ctx);
    expect((await h.settle())?.continue).toBe(true);
    expect(await h.handlers.agent_before_settle!({ entries: [], outcome: 'aborted' }, h.ctx)).toBeUndefined();
  });

  it('does not block when the CLI is missing, and notifies once', async () => {
    hideCli();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await start();
    expect(await h.handlers.tool_call!({ toolName: 'write', input: { path: lock() } }, h.ctx)).toBeUndefined();
    expect(await h.handlers.tool_call!({ toolName: 'bash', input: { command: 'buckets refresh' } }, h.ctx)).toBeUndefined();
    expect(await h.settle()).toBeUndefined();
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toContain('The buckets command was not found');
  });
});

describe('Amp plugin', () => {
  async function start() {
    // Amp runs the plugin in the project folder, which the plugin reads from process.cwd().
    vi.spyOn(process, 'cwd').mockReturnValue(env.dir);
    const factory = (await loadPlugin(AMP_PLUGIN)).default;
    const handlers: Record<string, (event: any, ctx: any) => any> = {};
    const notes: string[] = [];
    const uri = (p: string) => ({ toString: () => pathToFileURL(p).href, fsPath: p });
    const amp = {
      on: (name: string, handler: (event: any, ctx: any) => any) => void (handlers[name] = handler),
      helpers: {
        filesModifiedByToolCall: (event: any) => (event.tool === 'edit_file' ? [uri(event.input.path)] : null),
        filePathFromURI: (u: { fsPath: string }) => u.fsPath,
        shellCommandFromToolCall: (event: any) => (event.tool === 'Bash' ? { command: event.input.cmd, dir: event.input.cwd } : null),
      },
    };
    factory(amp);
    const ctx = { ui: { notify: async (message: string) => void notes.push(message) } };
    const thread = { id: 'T-1' };
    const end = () => handlers['agent.end']!({ thread, message: 'hi', id: 'm', status: 'done', messages: [] }, ctx);
    return { handlers, ctx, notes, thread, end };
  }

  it('rejects a lock write and plain refresh with reject-and-continue, and allows refresh --web', async () => {
    const h = await start();
    const call = h.handlers['tool.call']!;
    expect(await call({ toolUseID: 'a', tool: 'edit_file', input: { path: lock() }, thread: h.thread }, h.ctx)).toEqual({ action: 'reject-and-continue', message: 'LOCK DENIED by amp' });
    expect(await call({ toolUseID: 'b', tool: 'Bash', input: { cmd: 'buckets refresh' }, thread: h.thread }, h.ctx)).toEqual({ action: 'reject-and-continue', message: 'LOCK DENIED by amp' });
    expect(await call({ toolUseID: 'c', tool: 'Bash', input: { cmd: 'buckets refresh --web', cwd: 'sub' }, thread: h.thread }, h.ctx)).toEqual({ action: 'allow' });
    expect(await call({ toolUseID: 'd', tool: 'Read', input: { path: lock() }, thread: h.thread }, h.ctx)).toEqual({ action: 'allow' });
    expect(calls().map((c) => c.payload)).toEqual([
      { cwd: env.dir, projectDir: env.dir, sessionId: 'T-1', tool: 'edit_file', paths: [lock()] },
      { cwd: env.dir, projectDir: env.dir, sessionId: 'T-1', tool: 'Bash', paths: [], command: 'buckets refresh' },
      { cwd: env.dir, projectDir: env.dir, sessionId: 'T-1', tool: 'Bash', paths: [], command: 'buckets refresh --web', commandCwd: 'sub' },
    ]);
  });

  it('appends feedback to the tool output after an edit with a violation', async () => {
    const h = await start();
    await h.handlers['tool.call']!({ toolUseID: 'a', tool: 'edit_file', input: { path: bad() }, thread: h.thread }, h.ctx);
    expect(await h.handlers['tool.result']!({ toolUseID: 'a', tool: 'edit_file', input: { path: bad() }, status: 'done', output: 'edited', thread: h.thread }, h.ctx)).toEqual({
      status: 'done',
      output: 'edited\n\nVIOLATION in the edited file',
    });
    expect(await h.handlers['tool.result']!({ toolUseID: 'b', tool: 'edit_file', input: { path: bad() }, status: 'done', output: { diff: '+x' }, thread: h.thread }, h.ctx)).toEqual({
      status: 'done',
      output: { diff: '+x', slopbuckets: 'VIOLATION in the edited file' },
    });
    expect(await h.handlers['tool.result']!({ toolUseID: 'c', tool: 'edit_file', input: { path: good() }, status: 'done', output: 'ok', thread: h.thread }, h.ctx)).toBeUndefined();
  });

  it('continues once per user turn on agent.end with maxContinuations 1', async () => {
    const h = await start();
    expect(await h.end()).toEqual({ action: 'continue', userMessage: '[slopbuckets] CHECK FAILED (stop)', maxContinuations: 1 });
    h.handlers['agent.start']!({ thread: h.thread, message: '[slopbuckets] CHECK FAILED (stop)', id: 'm2' }, h.ctx);
    expect(await h.end()).toBeUndefined();
    h.handlers['agent.start']!({ thread: h.thread, message: 'thanks, now fix it', id: 'm3' }, h.ctx);
    expect((await h.end())?.action).toBe('continue');
  });

  it('does not block when the CLI is missing, and notifies once', async () => {
    hideCli();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await start();
    expect(await h.handlers['tool.call']!({ toolUseID: 'a', tool: 'edit_file', input: { path: lock() }, thread: h.thread }, h.ctx)).toEqual({ action: 'allow' });
    expect(await h.end()).toBeUndefined();
    expect(h.notes).toHaveLength(1);
  });
});

describe('finding the buckets command', () => {
  async function piCall() {
    const factory = (await loadPlugin(PI_PLUGIN)).default;
    const handlers: Record<string, (event: any, ctx: any) => any> = {};
    factory({ on: (name: string, handler: (event: any, ctx: any) => any) => void (handlers[name] = handler) });
    return handlers.tool_call!({ toolName: 'write', input: { path: lock() } }, { cwd: env.dir, hasUI: false });
  }

  it('uses the CLI installed in node_modules of the project or a folder above it', async () => {
    delete process.env.SLOPBUCKETS_BIN;
    const entry = path.join(env.dir, 'node_modules', 'slopbuckets', 'dist', 'index.js');
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, FAKE_CLI, 'utf8');
    writeFileSync(path.join(env.dir, 'node_modules', 'slopbuckets', 'package.json'), '{ "type": "module" }');
    expect(await piCall()).toEqual({ block: true, reason: 'LOCK DENIED by pi' });
  });

  it('runs buckets from PATH, a Windows .cmd shim included', async () => {
    delete process.env.SLOPBUCKETS_BIN;
    const bin = path.join(env.dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const node = process.execPath;
    if (process.platform === 'win32') writeFileSync(path.join(bin, 'buckets.cmd'), `@echo off\r\n"${node}" "${env.fake}" %*\r\n`);
    else writeFileSync(path.join(bin, 'buckets'), `#!/bin/sh\nexec "${node}" "${env.fake}" "$@"\n`, { mode: 0o755 });
    process.env.PATH = [bin, path.dirname(node)].join(path.delimiter);
    expect(await piCall()).toEqual({ block: true, reason: 'LOCK DENIED by pi' });
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
    expect(await piCall()).toEqual({ block: true, reason: 'LOCK DENIED by pi' });
  });

  it('allows the call and warns when the CLI answers with something other than JSON', async () => {
    const broken = path.join(env.dir, 'broken.mjs');
    writeFileSync(broken, "process.stderr.write('unknown agent'); process.exit(1);\n");
    process.env.SLOPBUCKETS_BIN = broken;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await piCall()).toBeUndefined();
    expect(String(error.mock.calls[0]![0])).toContain('unknown agent');
  });
});
