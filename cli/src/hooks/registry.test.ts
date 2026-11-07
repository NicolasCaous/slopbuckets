import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hookCommand } from '../commands/hook.js';
import { isRecord } from '../files/json.js';
import { cleanupProjects, makeProject } from '../testing/fixture.js';
import { fakeIo, testContext } from '../testing/harness.js';
import { defineAdapter } from './adapter.js';
import type { HookAdapter } from './adapter.js';
import { decodeArgs, str } from './input.js';
import { detectHarnesses, findAdapter, findHarness, harnesses, resolveAgents } from './registry.js';

afterEach(cleanupProjects);

/** Test adapters that `buckets hook --agent` finds besides the real ones. */
const fakes = vi.hoisted(() => new Map<string, HookAdapter>());
vi.mock('./registry.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('./registry.js')>();
  return { ...m, findAdapter: (name: string) => fakes.get(name) ?? m.findAdapter(name) };
});
afterEach(() => fakes.clear());

/** A tiny adapter in the shape of GitHub Copilot's payload. It denies every shell command, in its own format. */
const fakeCopilot = defineAdapter({
  name: 'fake',
  title: 'Fake harness',
  markers: ['.fake'],
  handlers: {
    async pre(_ctx, io, input) {
      const args = decodeArgs(input.toolArgs);
      if (str(input.toolName) !== 'bash') return 0;
      io.stdout(`${JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: `no ${str(args.command) ?? ''}` })}\n`);
      return 2;
    },
  },
  install: () => [],
  uninstall: () => [],
});

async function run(args: string[], stdin: unknown, dir: string) {
  const io = fakeIo({ cwd: dir, stdin: JSON.stringify(stdin) });
  const code = await hookCommand(testContext(), io, args);
  return { code, out: io.out, err: io.err };
}

describe('buckets hook dispatch', () => {
  it('runs the Claude Code adapter without --agent, with --agent claude and with --agent=claude', async () => {
    const dir = makeProject({});
    const input = { cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/a.ts') } };
    for (const args of [['pre-tool-use'], ['--agent', 'claude', 'pre-tool-use'], ['--agent=claude', 'pre-tool-use'], ['pre-tool-use', '--agent', 'CLAUDE']]) {
      expect(await run(args, input, dir)).toEqual({ code: 0, out: '', err: '' });
    }
  });

  it('refuses an unknown agent and a missing event with the usage exit code, and lets an unknown event through', async () => {
    const dir = makeProject({});
    const agent = await run(['--agent', 'nope', 'pre-tool-use'], {}, dir);
    expect(agent.code).toBe(64);
    expect(agent.err).toContain('unknown agent "nope"');
    expect(agent.err).toContain('claude');
    const event = await run(['--agent', 'claude', 'pre'], {}, dir);
    expect(event.code).toBe(0);
    expect(event.err).toBe(
      'buckets hook --agent claude: unknown event "pre", so this hook did nothing. If the hooks come from an older slopbuckets, run `buckets init --agent claude` again. Events: pre-tool-use, stop, subagent-stop, post-compact.\n',
    );
    const missing = await run([], {}, dir);
    expect(missing.code).toBe(64);
    expect(missing.err).toBe('buckets hook: name an event. Events: pre-tool-use, stop, subagent-stop, post-compact. Usage: buckets hook [--agent <name>] <event>\n');
  });

  it('dispatches to a registered adapter, which keeps its own output format and exit code', async () => {
    fakes.set('fake', fakeCopilot);
    const dir = makeProject({});
    const denied = await run(['--agent', 'fake', 'pre'], { cwd: dir, toolName: 'bash', toolArgs: JSON.stringify({ command: 'ls' }) }, dir);
    expect(denied.code).toBe(2);
    expect(JSON.parse(denied.out)).toEqual({ permissionDecision: 'deny', permissionDecisionReason: 'no ls' });
    expect(await run(['--agent', 'fake', 'pre'], { cwd: dir, toolName: 'create', toolArgs: { path: 'root/_/a.ts' } }, dir)).toEqual({ code: 0, out: '', err: '' });
    expect((await run(['--agent', 'fake', 'pre-tool-use'], {}, dir)).code).toBe(0);
  });

  it('keeps a broken adapter from breaking the session', async () => {
    fakes.set('broken', { ...fakeCopilot, name: 'broken', handlers: { pre: async () => Promise.reject(new Error('boom')) } });
    const dir = makeProject({});
    const result = await run(['--agent', 'broken', 'pre'], {}, dir);
    expect(result.code).toBe(0);
    expect(result.err).toContain('buckets hook --agent broken pre: unexpected error: Error: boom');
  });
});

describe('the registry', () => {
  it('knows Claude Code as an adapter and other harnesses by name', () => {
    expect(findAdapter('claude')?.title).toBe('Claude Code');
    expect(findAdapter('codex')?.title).toBe('Codex CLI');
    expect(findHarness('codex')?.title).toBe('Codex CLI');
    expect(isRecord(findHarness('cursor'))).toBe(true);
    // Every adapter is listed once, before the known harnesses without one.
    const names = harnesses().map((h) => h.name);
    expect(new Set(names).size).toBe(names.length);
    const without = harnesses().find((h) => findAdapter(h.name) === undefined);
    if (without !== undefined) expect(findHarness(without.name.toUpperCase())).toBe(without);
  });

  it('detects harnesses by their folders and resolves --agent lists', () => {
    const dir = makeProject({ '.codex/config.toml': '', '.claude/settings.json': '{}', '.github/workflows/ci.yml': '' }, false);
    expect(detectHarnesses(dir).map((h) => h.name)).toEqual(['claude', 'codex']);
    expect(resolveAgents('auto', dir)).toMatchObject({ unknown: [], auto: true });
    expect(resolveAgents('auto', dir).harnesses.map((h) => h.name)).toEqual(['claude', 'codex']);
    expect(resolveAgents('cursor, claude,cursor', dir).harnesses.map((h) => h.name)).toEqual(['cursor', 'claude']);
    expect(resolveAgents('claude,vim', dir).unknown).toEqual(['vim']);
    expect(resolveAgents('auto', makeProject({}, false)).harnesses).toEqual([]);
  });
});
