// The GitHub Copilot adapter with Copilot CLI payloads: preToolUse with toolArgs as a JSON string, agentStop and
// subagentStop.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject, readFile } from '../../testing/fixture.js';
import { failOpenPowerShell, failOpenSh } from './json-install.js';
import { installSuite, line, newSessionId, patch, runAdapter } from './adapter-test-kit.js';
import { copilotAdapter } from './copilot.js';
import { crashingCore, decisionCases, fakeCore, restoreCoreAfterEach, TEXT } from './json-test-kit.js';

afterEach(cleanupProjects);
restoreCoreAfterEach();

function payload(dir: string, extra: Record<string, unknown>, sessionId = 'cp-1') {
  return { sessionId, timestamp: 1767225600000, cwd: dir, ...extra };
}

const tool = (dir: string, toolName: string, args: unknown) => payload(dir, { toolName, toolArgs: typeof args === 'string' ? args : JSON.stringify(args) });
const project = () => makeProject({ 'src/a.ts': 'export const a = 1;\n' });

describe('copilot phases', () => {
  it('maps create, str_replace_editor and a bare apply_patch to pre-edit with the new text', async () => {
    const dir = project();
    const calls = fakeCore();
    await runAdapter(copilotAdapter, 'pre-tool-use', tool(dir, 'create', { path: 'src/b.ts', file_text: 'b' }), dir);
    await runAdapter(copilotAdapter, 'pre-tool-use', tool(dir, 'str_replace_editor', { command: 'str_replace', path: 'src/a.ts', old_str: '1', new_str: '2' }), dir);
    await runAdapter(copilotAdapter, 'pre-tool-use', tool(dir, 'apply_patch', patch(['*** Add File: src/c.ts', '+c'])), dir);
    expect(calls.map((c) => [c.phase, c.toolName, c.edits])).toEqual([
      ['pre-edit', 'create', [{ path: path.join(dir, 'src', 'b.ts'), content: 'b' }]],
      ['pre-edit', 'str_replace_editor', [{ path: path.join(dir, 'src', 'a.ts'), content: 'export const a = 2;\n' }]],
      ['pre-edit', 'apply_patch', [{ path: path.join(dir, 'src', 'c.ts'), content: 'c\n' }]],
    ]);
  });

  it('maps bash and powershell to a shell pre-tool, view to a pre-tool, and keeps the agent id of a subagent', async () => {
    const dir = project();
    const calls = fakeCore();
    await runAdapter(copilotAdapter, 'pre-tool-use', tool(dir, 'bash', { command: 'npm test', description: 'test' }), dir);
    await runAdapter(copilotAdapter, 'pre-tool-use', { ...tool(dir, 'powershell', { command: 'dir' }), agentId: 'sub-2', agentType: 'explore' }, dir);
    await runAdapter(copilotAdapter, 'pre-tool-use', tool(dir, 'str_replace_editor', { command: 'view', path: 'src/a.ts' }), dir);
    expect(calls.map((c) => [c.phase, c.isShell, c.agentId])).toEqual([
      ['pre-tool', true, null],
      ['pre-tool', true, 'sub-2'],
      ['pre-tool', false, null],
    ]);
  });

  it('maps agentStop with stop_hook_active, and blocks a subagentStop once per agent by mark', async () => {
    const dir = project();
    const calls = fakeCore((input) => (input.stopHookActive ? { kind: 'silent' } : { kind: 'block', text: TEXT }));
    await runAdapter(copilotAdapter, 'agent-stop', payload(dir, { stopReason: 'end_turn', stop_hook_active: true }), dir);
    const session = newSessionId();
    const sub = payload(dir, { agentId: 'sub-3', agentType: 'explore', parentAgentId: 'root' }, session);
    const first = await runAdapter(copilotAdapter, 'subagent-stop', sub, dir);
    const second = await runAdapter(copilotAdapter, 'subagent-stop', sub, dir);
    const other = await runAdapter(copilotAdapter, 'subagent-stop', { ...sub, agentId: 'sub-4' }, dir);
    expect(calls.map((c) => [c.phase, c.stopHookActive, c.agentId])).toEqual([
      ['stop', true, null],
      ['subagent-stop', false, 'sub-3'],
      ['subagent-stop', true, 'sub-3'],
      ['subagent-stop', false, 'sub-4'],
    ]);
    expect([first.out, second.out, other.out]).toEqual([line({ decision: 'block', reason: TEXT }), '', line({ decision: 'block', reason: TEXT })]);
  });
});

describe('copilot answers', () => {
  const block = line({ decision: 'block', reason: TEXT });
  decisionCases(copilotAdapter, 'pre-tool-use', (dir) => tool(dir, 'create', { path: 'src/c.ts', file_text: 'c' }), project, {
    context: { code: 0, out: line({ additionalContext: TEXT }) },
    deny: { code: 0, out: line({ permissionDecision: 'deny', permissionDecisionReason: TEXT }) },
  });
  decisionCases(copilotAdapter, 'pre-tool-use', (dir) => tool(dir, 'bash', { command: 'ls' }), project, { context: { code: 0, out: line({ additionalContext: TEXT }) } });
  decisionCases(copilotAdapter, 'agent-stop', (dir) => payload(dir, { stop_hook_active: false }), project, { block: { code: 0, out: block } });
  decisionCases(copilotAdapter, 'subagent-stop', (dir) => payload(dir, { agentId: newSessionId() }), project, { block: { code: 0, out: block } });
});

describe('copilot fails open', () => {
  it('exits with 0 and prints nothing when the core crashes, so preToolUse never denies by error', async () => {
    const dir = project();
    crashingCore();
    for (const event of copilotAdapter.events) {
      const result = await runAdapter(copilotAdapter, event, tool(dir, 'create', { path: 'x.ts', file_text: '' }), dir);
      expect(result).toMatchObject({ code: 0, out: '' });
    }
  });

  it('runs every command inside the guard that skips it when buckets is missing', () => {
    const dir = makeProject({}, false);
    copilotAdapter.install(dir, { skill: null });
    const json = JSON.parse(readFile(dir, '.github/hooks/slopbuckets.json'));
    expect(json.hooks.preToolUse).toEqual([
      { type: 'command', bash: failOpenSh('buckets hook --agent copilot pre-tool-use'), powershell: failOpenPowerShell('buckets hook --agent copilot pre-tool-use'), timeoutSec: 60 },
    ]);
  });
});

describe('copilot install', () => {
  installSuite(copilotAdapter, {
    file: '.github/hooks/slopbuckets.json',
    userText: JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: 'command', bash: 'echo hi', powershell: 'echo hi' }] } }, null, 2),
    fresh(json) {
      expect(json.version).toBe(1);
      expect(Object.keys(json.hooks as object)).toEqual(['preToolUse', 'agentStop', 'subagentStop']);
    },
  });

  it('migrates a 1.x install: drops postToolUse and the preToolUse matcher', () => {
    const v1hook = (name: string, extra: Record<string, unknown>) => ({
      type: 'command',
      bash: failOpenSh(`buckets hook --agent copilot ${name}`),
      powershell: failOpenPowerShell(`buckets hook --agent copilot ${name}`),
      ...extra,
    });
    const v1 = {
      version: 1,
      hooks: {
        preToolUse: [v1hook('pre-tool-use', { timeoutSec: 30, matcher: 'edit|create|apply_patch|str_replace_editor|bash|powershell' })],
        postToolUse: [v1hook('post-tool-use', { timeoutSec: 300, matcher: 'edit|create|apply_patch|str_replace_editor' })],
        agentStop: [v1hook('agent-stop', { timeoutSec: 600 })],
        subagentStop: [v1hook('subagent-stop', { timeoutSec: 600 })],
      },
    };
    const dir = makeProject({ '.github/hooks/slopbuckets.json': JSON.stringify(v1, null, 2) }, false);
    expect(copilotAdapter.install(dir, { skill: null })[0]).toEqual({ status: 'done', text: 'Updated the GitHub Copilot hooks in .github/hooks/slopbuckets.json (preToolUse, postToolUse)' });
    const json = JSON.parse(readFile(dir, '.github/hooks/slopbuckets.json'));
    expect(json.hooks.postToolUse).toBeUndefined();
    expect(json.hooks.preToolUse[0].matcher).toBeUndefined();
    expect(json.hooks.agentStop).toEqual(v1.hooks.agentStop);
    expect(copilotAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'kept' });
  });
});
