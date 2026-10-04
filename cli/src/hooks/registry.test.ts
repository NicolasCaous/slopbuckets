import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hookCommand, LOCK_DENY_REASON } from '../commands/hook.js';
import { cleanupProjects, LOGGER_PROJECT, makeProject } from '../testing/fixture.js';
import { fakeIo, testContext } from '../testing/harness.js';
import type { HookAdapter } from './adapter.js';
import { preTool } from './core.js';
import { decodeArgs, isRecord, parseHookInput, str } from './input.js';
import { detectHarnesses, findAdapter, findHarness, harnesses, registerAdapter, resolveAgents } from './registry.js';

afterEach(cleanupProjects);

const DENY = `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: LOCK_DENY_REASON } })}\n`;

/** A tiny adapter in the shape of GitHub Copilot's payload, to show what a real adapter does with the core. */
const fakeCopilot: HookAdapter = {
  name: 'fake',
  title: 'Fake harness',
  markers: ['.fake'],
  events: ['pre'],
  async run(_ctx, io) {
    const input = parseHookInput(await io.readStdin());
    const args = decodeArgs(input.toolArgs);
    const tool = str(input.toolName);
    const action = tool === 'bash' ? { kind: 'shell' as const, command: str(args.command) ?? '' } : tool === 'create' ? { kind: 'write' as const, paths: [str(args.path) ?? ''] } : { kind: 'other' as const };
    const result = preTool({ cwd: str(input.cwd) ?? io.cwd, action });
    if (result.decision === 'deny') {
      io.stdout(`${JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: result.reason })}\n`);
      return 2;
    }
    return 0;
  },
  install: () => [],
  uninstall: () => [],
};

async function run(args: string[], stdin: unknown, dir: string) {
  const io = fakeIo({ cwd: dir, stdin: JSON.stringify(stdin) });
  const code = await hookCommand(testContext(), io, args);
  return { code, out: io.out, err: io.err };
}

describe('buckets hook dispatch', () => {
  it('runs the Claude Code adapter without --agent, with --agent claude and with --agent=claude', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const input = { cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'buckets.lock.json') } };
    for (const args of [['pre-tool-use'], ['--agent', 'claude', 'pre-tool-use'], ['--agent=claude', 'pre-tool-use'], ['pre-tool-use', '--agent', 'CLAUDE']]) {
      expect(await run(args, input, dir)).toEqual({ code: 0, out: DENY, err: '' });
    }
  });

  it('refuses an unknown agent and an unknown event with exit 1', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const agent = await run(['--agent', 'nope', 'pre-tool-use'], {}, dir);
    expect(agent.code).toBe(1);
    expect(agent.err).toContain('unknown agent "nope"');
    expect(agent.err).toContain('claude');
    const event = await run(['--agent', 'claude', 'pre'], {}, dir);
    expect(event.code).toBe(1);
    expect(event.err).toBe('buckets hook --agent claude: unknown event "pre". Events: pre-tool-use, post-tool-use, stop, subagent-stop.\n');
    expect((await run([], {}, dir)).err).toBe('buckets hook: unknown event "". Events: pre-tool-use, post-tool-use, stop, subagent-stop.\n');
  });

  it('dispatches to a registered adapter, which keeps its own output format and exit code', async () => {
    const remove = registerAdapter(fakeCopilot);
    try {
      const dir = makeProject(LOGGER_PROJECT);
      const denied = await run(['--agent', 'fake', 'pre'], { cwd: dir, toolName: 'bash', toolArgs: JSON.stringify({ command: 'buckets refresh' }) }, dir);
      expect(denied.code).toBe(2);
      expect(JSON.parse(denied.out)).toEqual({ permissionDecision: 'deny', permissionDecisionReason: LOCK_DENY_REASON });
      expect(await run(['--agent', 'fake', 'pre'], { cwd: dir, toolName: 'create', toolArgs: { path: 'root/_/a.ts' } }, dir)).toEqual({ code: 0, out: '', err: '' });
      expect((await run(['--agent', 'fake', 'pre-tool-use'], {}, dir)).code).toBe(1);
    } finally {
      remove();
    }
    expect(findAdapter('fake')).toBeUndefined();
  });

  it('keeps a broken adapter from breaking the session', async () => {
    const remove = registerAdapter({ ...fakeCopilot, name: 'broken', run: async () => Promise.reject(new Error('boom')) });
    try {
      const dir = makeProject(LOGGER_PROJECT);
      const result = await run(['--agent', 'broken', 'pre'], {}, dir);
      expect(result.code).toBe(0);
      expect(result.err).toContain('buckets hook --agent broken pre: unexpected error: Error: boom');
    } finally {
      remove();
    }
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
