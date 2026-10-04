// The GitHub Copilot adapter with Copilot CLI payloads: camelCase fields and toolArgs as a JSON string (or the bare
// patch text for apply_patch).
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, fileExists, makeProject, readFile } from '../../testing/fixture.js';
import {
  cleanProject,
  feedbackFor,
  installSuite,
  line,
  LOCK_DENY_REASON,
  lockNames,
  newSessionId,
  patch,
  REFRESH_ALLOWED,
  REFRESH_DENIED,
  runAdapter,
  stopReportFor,
  violationProject,
} from './adapter-test-kit.js';
import { copilotAdapter } from './copilot.js';

afterEach(cleanupProjects);

const DENY = line({ permissionDecision: 'deny', permissionDecisionReason: LOCK_DENY_REASON });

function payload(dir: string, extra: Record<string, unknown>) {
  return { sessionId: newSessionId(), timestamp: 1791115200000, cwd: dir, ...extra };
}

const tool = (dir: string, toolName: string, args: unknown) => payload(dir, { toolName, toolArgs: typeof args === 'string' ? args : JSON.stringify(args) });

describe('copilot pre-tool-use', () => {
  it('allows ordinary calls with no output', async () => {
    const dir = violationProject();
    expect(await runAdapter(copilotAdapter, 'pre-tool-use', tool(dir, 'bash', { command: 'npm test', description: 'tests' }), dir)).toEqual({ code: 0, out: '', err: '' });
    expect(await runAdapter(copilotAdapter, 'pre-tool-use', tool(dir, 'create', { path: path.join(dir, 'root/_/x.ts'), file_text: 'x' }), dir)).toEqual({ code: 0, out: '', err: '' });
    expect(await runAdapter(copilotAdapter, 'pre-tool-use', tool(dir, 'view', { path: path.join(dir, 'buckets.lock.json') }), dir)).toEqual({ code: 0, out: '', err: '' });
  });

  it('denies create, edit and str_replace_editor on the lock under any name, with toolArgs as a string or an object', async () => {
    const dir = violationProject();
    for (const name of lockNames(dir)) {
      expect(await runAdapter(copilotAdapter, 'pre-tool-use', tool(dir, 'create', { path: name, file_text: '{}' }), dir)).toEqual({ code: 0, out: DENY, err: '' });
      expect(await runAdapter(copilotAdapter, 'pre-tool-use', tool(dir, 'edit', { path: name, old_str: 'a', new_str: 'b' }), dir)).toEqual({ code: 0, out: DENY, err: '' });
      expect((await runAdapter(copilotAdapter, 'pre-tool-use', payload(dir, { toolName: 'edit', toolArgs: { file_path: name } }), dir)).out).toBe(DENY);
      expect((await runAdapter(copilotAdapter, 'pre-tool-use', tool(dir, 'str_replace_editor', { command: 'create', path: name, file_text: '{}' }), dir)).out).toBe(DENY);
    }
  });

  it('denies apply_patch on the lock, with the patch as bare text, as a JSON string or under "input"', async () => {
    const dir = violationProject();
    const text = patch(['*** Update File: root/_/main.ts', '@@', '-a', '+b', `*** Add File: ${path.join(dir, 'buckets.lock.json')}`, '+{}']);
    expect(await runAdapter(copilotAdapter, 'pre-tool-use', tool(dir, 'apply_patch', text), dir)).toEqual({ code: 0, out: DENY, err: '' });
    expect((await runAdapter(copilotAdapter, 'pre-tool-use', tool(dir, 'apply_patch', JSON.stringify(text)), dir)).out).toBe(DENY);
    expect((await runAdapter(copilotAdapter, 'pre-tool-use', tool(dir, 'apply_patch', { input: text }), dir)).out).toBe(DENY);
    const ok = patch(['*** Update File: root/_/main.ts', '@@', '-a', '+b']);
    expect((await runAdapter(copilotAdapter, 'pre-tool-use', tool(dir, 'apply_patch', ok), dir)).out).toBe('');
  });

  it('denies plain buckets refresh and allows buckets refresh --web in bash and powershell', async () => {
    const dir = violationProject();
    for (const shell of ['bash', 'powershell']) {
      for (const command of REFRESH_DENIED) expect(await runAdapter(copilotAdapter, 'pre-tool-use', tool(dir, shell, { command }), dir)).toEqual({ code: 0, out: DENY, err: '' });
      for (const command of REFRESH_ALLOWED) expect(await runAdapter(copilotAdapter, 'pre-tool-use', tool(dir, shell, { command }), dir)).toEqual({ code: 0, out: '', err: '' });
    }
  });
});

describe('copilot post-tool-use', () => {
  it('reports the violations of an edited file in additionalContext', async () => {
    const dir = violationProject();
    const feedback = await feedbackFor(dir, 'root/_/main.ts');
    const edit = { ...tool(dir, 'edit', { path: path.join(dir, 'root', '_', 'main.ts'), old_str: 'a', new_str: 'b' }), toolResult: { resultType: 'success', textResultForLlm: 'ok' } };
    expect(await runAdapter(copilotAdapter, 'post-tool-use', edit, dir)).toEqual({ code: 0, out: line({ additionalContext: feedback }), err: '' });
    const clean = tool(dir, 'create', { path: 'root/log/_/logger.ts', file_text: 'x' });
    expect(await runAdapter(copilotAdapter, 'post-tool-use', clean, dir)).toEqual({ code: 0, out: '', err: '' });
  });
});

describe('copilot agent-stop and subagent-stop', () => {
  it('blocks the agent once and lets it finish when stop_hook_active is set', async () => {
    const dir = violationProject();
    const report = await stopReportFor(dir);
    const first = payload(dir, { stop_hook_active: false, stopReason: 'end_turn' });
    expect(await runAdapter(copilotAdapter, 'agent-stop', first, dir)).toEqual({ code: 0, out: line({ decision: 'block', reason: report }), err: '' });
    expect(await runAdapter(copilotAdapter, 'agent-stop', { ...first, stop_hook_active: true }, dir)).toEqual({ code: 0, out: '', err: '' });
  });

  it('tracks each subagent, which has no stop_hook_active, and blocks it only once in a row', async () => {
    const dir = violationProject();
    const report = await stopReportFor(dir, true);
    const session = newSessionId();
    const sub = (agentId: string) => ({ sessionId: session, timestamp: 1791115200000, cwd: dir, agentId, agentName: 'explore' });
    const block = { code: 0, out: line({ decision: 'block', reason: report }), err: '' };
    expect(await runAdapter(copilotAdapter, 'subagent-stop', sub('a1'), dir)).toEqual(block);
    expect(await runAdapter(copilotAdapter, 'subagent-stop', sub('a2'), dir)).toEqual(block);
    expect(await runAdapter(copilotAdapter, 'subagent-stop', sub('a1'), dir)).toEqual({ code: 0, out: '', err: '' });
    expect(await runAdapter(copilotAdapter, 'subagent-stop', sub('a2'), dir)).toEqual({ code: 0, out: '', err: '' });
  });

  it('says nothing for a clean project', async () => {
    const dir = await cleanProject();
    expect(await runAdapter(copilotAdapter, 'agent-stop', payload(dir, { stop_hook_active: false }), dir)).toEqual({ code: 0, out: '', err: '' });
  });
});

describe('copilot install', () => {
  const plain = (event: string) => `buckets hook --agent copilot ${event}`;
  const bash = (event: string) => `if command -v buckets >/dev/null 2>&1; then ${plain(event)}; fi`;
  const powershell = (event: string) => `if (Get-Command buckets -ErrorAction SilentlyContinue) { ${plain(event)} }`;
  installSuite(copilotAdapter, {
    file: '.github/hooks/slopbuckets.json',
    userText: JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: 'command', bash: './scripts/hello.sh', powershell: './scripts/hello.ps1' }] } }, null, 2),
    freshUninstallDeletes: true,
    fresh(json) {
      expect(json).toEqual({
        version: 1,
        hooks: {
          preToolUse: [{ type: 'command', bash: bash('pre-tool-use'), powershell: powershell('pre-tool-use'), timeoutSec: 30, matcher: 'edit|create|apply_patch|str_replace_editor|bash|powershell' }],
          postToolUse: [{ type: 'command', bash: bash('post-tool-use'), powershell: powershell('post-tool-use'), timeoutSec: 300, matcher: 'edit|create|apply_patch|str_replace_editor' }],
          agentStop: [{ type: 'command', bash: bash('agent-stop'), powershell: powershell('agent-stop'), timeoutSec: 600 }],
          subagentStop: [{ type: 'command', bash: bash('subagent-stop'), powershell: powershell('subagent-stop'), timeoutSec: 600 }],
        },
      });
    },
  });

  it('replaces hooks written before the fail-open guard, and keeps the user hooks', () => {
    const older = {
      version: 1,
      hooks: {
        sessionStart: [{ type: 'command', bash: './scripts/hello.sh', powershell: './scripts/hello.ps1' }],
        preToolUse: [{ type: 'command', bash: plain('pre-tool-use'), powershell: plain('pre-tool-use'), timeoutSec: 30, matcher: 'edit|create|apply_patch|str_replace_editor|bash|powershell' }],
        agentStop: [{ type: 'command', bash: plain('agent-stop'), powershell: plain('agent-stop'), timeoutSec: 600 }],
      },
    };
    const dir = makeProject({ '.github/hooks/slopbuckets.json': `${JSON.stringify(older, null, 2)}\n` }, false);
    expect(copilotAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'done' });
    const json = JSON.parse(readFile(dir, '.github/hooks/slopbuckets.json')) as { hooks: Record<string, { bash: string; powershell: string }[]> };
    expect(json.hooks.sessionStart).toEqual(older.hooks.sessionStart);
    for (const event of ['preToolUse', 'postToolUse', 'agentStop', 'subagentStop']) {
      expect(json.hooks[event]).toHaveLength(1);
      expect(json.hooks[event]![0]!.bash).toMatch(/^if command -v buckets /);
      expect(json.hooks[event]![0]!.powershell).toMatch(/^if \(Get-Command buckets /);
    }
    expect(copilotAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'kept' });
  });

  it('leaves other hook files in .github/hooks alone', () => {
    const dir = makeProject({ '.github/hooks/team.json': '{"version":1,"hooks":{}}\n' }, false);
    copilotAdapter.install(dir, { skill: null });
    expect(readFile(dir, '.github/hooks/team.json')).toBe('{"version":1,"hooks":{}}\n');
    copilotAdapter.uninstall(dir);
    expect(readFile(dir, '.github/hooks/team.json')).toBe('{"version":1,"hooks":{}}\n');
    expect(fileExists(dir, '.github/hooks/slopbuckets.json')).toBe(false);
  });
});
