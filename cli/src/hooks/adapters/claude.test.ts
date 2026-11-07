// The Claude Code adapter: payload parsing for each tool and event, the exact JSON of each decision, and the install
// into .claude/settings.json (fresh, user hooks, an older install).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderInterrupt, renderPending, renderStop } from '../../contract/messages.js';
import { createFakeEngine, type FakeEngine, type FakeEngineScript } from '../../testing/fake-engine.js';
import { cleanupProjects, makeProject } from '../../testing/fixture.js';
import { fakeIo, testContext } from '../../testing/harness.js';
import { SAMPLES } from '../../testing/samples.js';
import { loadSession, sessionRef } from '../session.js';
import { claudeAdapter, claudeHooks, claudeOutput } from './claude.js';
import { runJson } from './json-run.js';

afterEach(cleanupProjects);

const A = SAMPLES['import-private'];
const BAD = SAMPLES['config-invalid'];
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

function setup(script: FakeEngineScript = {}, files: Record<string, string> = {}) {
  const dir = makeProject(files);
  const engine: FakeEngine = createFakeEngine(script);
  const outputs: string[] = [];
  const run = async (event: string, payload: Record<string, unknown>, env: Record<string, string> = {}) => {
    const io = fakeIo({ cwd: dir, stdin: JSON.stringify({ session_id: 's1', cwd: dir, ...payload }), env });
    const code = await runJson({ ...testContext(), engine }, io, claudeAdapter, event);
    outputs.push(io.out);
    return { code, out: io.out, err: io.err };
  };
  return { dir, engine, run, outputs, file: (name: string) => path.join(dir, name) };
}

describe('claudeOutput', () => {
  it('prints the exact JSON of each decision, and nothing for silent', () => {
    expect(claudeOutput({ kind: 'silent' })).toBe('');
    expect(claudeOutput({ kind: 'context', text: 't' })).toBe('{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"t"}}\n');
    expect(claudeOutput({ kind: 'deny', text: 't' })).toBe('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"t"}}\n');
    expect(claudeOutput({ kind: 'block', text: 't' })).toBe('{"decision":"block","reason":"t"}\n');
    expect(claudeOutput({ kind: 'note', text: 't' })).toBe('{"systemMessage":"t"}\n');
  });
});

describe('claude run', () => {
  it('Write: simulates the new content and adds the pending list as context, without allow', async () => {
    const { run, engine, file } = setup({ edits: { 'src/a.ts': [A] } });
    const result = await run('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: file('src/a.ts'), content: 'import x;\n' } });
    expect(engine.calls).toEqual([{ method: 'checkEdit', root: path.dirname(file('x')), edits: [{ path: file('src/a.ts'), content: 'import x;\n' }] }]);
    expect(result).toEqual({ code: 0, out: line({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: renderPending({ fresh: [A], old: [], resolved: [] }) } }), err: '' });
  });

  it('Edit: applies old_string and new_string to the file on disk, once or with replace_all', async () => {
    const { run, engine, file } = setup({}, { 'src/a.ts': 'a b a\n', 'src/one.ts': 'a b\n' });
    await run('pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: file('src/a.ts'), old_string: 'a', new_string: 'c', replace_all: true } });
    await run('pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: file('src/one.ts'), old_string: 'a', new_string: 'c' } });
    expect(engine.calls.map((c) => (c.method === 'checkEdit' ? c.edits : c.method))).toEqual([
      [{ path: file('src/a.ts'), content: 'c b c\n' }],
      [{ path: file('src/one.ts'), content: 'c b\n' }],
    ]);
  });

  it('Edit that cannot apply (two matches without replace_all) counts as a tool call that changes files', async () => {
    const { run, engine, file, dir } = setup({}, { 'src/a.ts': 'a b a\n' });
    expect((await run('pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: file('src/a.ts'), old_string: 'a', new_string: 'c' } })).out).toBe('');
    expect(engine.calls).toEqual([]);
    expect(loadSession(sessionRef(dir, 's1')).dirty).toBe(true);
  });

  it('denies a Write that makes the config invalid', async () => {
    const { run, file } = setup({ edits: { 'buckets.config.json': [BAD] } });
    const result = await run('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: file('buckets.config.json'), content: '{' } });
    expect(result.out).toBe(line({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: renderInterrupt([BAD]) } }));
  });

  it('Bash and PowerShell mark the session dirty, Read does not, and both are silent with nothing pending', async () => {
    const { run, dir } = setup();
    expect((await run('pre-tool-use', { tool_name: 'Read', tool_input: { file_path: 'x' } })).out).toBe('');
    expect(loadSession(sessionRef(dir, 's1')).dirty).toBe(false);
    expect((await run('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'rm -rf src' } })).out).toBe('');
    expect(loadSession(sessionRef(dir, 's1')).dirty).toBe(true);
  });

  it('Read shows the pending list as a reminder', async () => {
    const { run, file } = setup({ edits: { 'src/a.ts': [A] } });
    await run('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: file('src/a.ts'), content: '' } });
    const result = await run('pre-tool-use', { tool_name: 'Read', tool_input: { file_path: file('src/a.ts') } });
    expect(result.out).toBe(line({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: renderPending({ fresh: [], old: [A], resolved: [] }) } }));
  });

  it('Stop blocks once with decision block, and not with stop_hook_active', async () => {
    const { run, engine } = setup();
    await run('pre-tool-use', { tool_name: 'PowerShell', tool_input: { command: 'ni x.ts' } });
    engine.set([A]);
    expect((await run('stop', { stop_hook_active: false })).out).toBe(line({ decision: 'block', reason: renderStop([A]) }));
    expect((await run('stop', { stop_hook_active: true })).out).toBe('');
  });

  it('SubagentStop uses the state of the agent_id', async () => {
    const { run, engine, dir } = setup();
    await run('pre-tool-use', { tool_name: 'Bash', agent_id: 'sub1', tool_input: { command: 'touch x' } });
    expect(loadSession(sessionRef(dir, 's1', 'sub1')).dirty).toBe(true);
    engine.set([A]);
    expect((await run('subagent-stop', { agent_id: 'sub1', agent_type: 'Explore', stop_hook_active: false })).out).toBe(line({ decision: 'block', reason: renderStop([A]) }));
    expect(loadSession(sessionRef(dir, 's1', 'sub1')).stopBlocked).toBe(true);
  });

  it('PostCompact is silent and makes the next call show the list in full', async () => {
    const { run, file } = setup({ edits: { 'src/a.ts': [A] } });
    await run('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: file('src/a.ts'), content: '' } });
    expect((await run('post-compact', { trigger: 'auto', compact_summary: 's' })).out).toBe('');
    expect((await run('pre-tool-use', { tool_name: 'Grep', tool_input: {} })).out).toContain('[NEW]');
  });

  it('stays silent for a payload from Cursor or Devin, which also run the hooks of .claude/settings.json', async () => {
    const { run, engine, file } = setup({ edits: { 'src/a.ts': [A] }, violations: [A] });
    const write = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file('src/a.ts'), content: 'x' } };
    const cursor = { conversation_id: 'c1', generation_id: 'g1', cursor_version: '3.9.8', workspace_roots: [file('')] };
    const quiet = { code: 0, out: '', err: '' };
    expect(await run('pre-tool-use', { ...write, ...cursor })).toEqual(quiet);
    expect(await run('stop', { hook_event_name: 'stop', ...cursor, status: 'completed', loop_count: 0 })).toEqual(quiet);
    expect(await run('pre-tool-use', { ...write, prompt_id: 'p1', tool_provenance: 'builtin' })).toEqual(quiet);
    expect(await run('stop', { hook_event_name: 'Stop', stop_hook_active: false }, { DEVIN_PROJECT_DIR: file('') })).toEqual(quiet);
    expect(await run('pre-tool-use', { ...write, hook_event_name: 'preToolUse' })).toEqual(quiet);
    expect(engine.calls).toEqual([]);
    // The same Write from Claude Code runs.
    expect((await run('pre-tool-use', write)).out).toContain('additionalContext');
  });

  it('runs the check from CLAUDE_PROJECT_DIR when it is set', async () => {
    const { run, engine, dir } = setup();
    const sub = path.join(dir, 'packages', 'x');
    await run('pre-tool-use', { cwd: sub, tool_name: 'Bash', tool_input: { command: 'ls' } }, { CLAUDE_PROJECT_DIR: dir });
    engine.set([A]);
    await run('stop', { cwd: sub }, { CLAUDE_PROJECT_DIR: dir });
    expect(engine.calls).toEqual([{ method: 'checkAll', root: dir }]);
  });

  it('never prints allow, and survives invalid JSON and a crashing stdin', async () => {
    const { run, outputs, file, dir } = setup({ edits: { 'src/a.ts': [A] } });
    for (const tool of ['Write', 'Edit', 'Bash', 'Read', 'NotebookEdit', 'mcp__x__y']) {
      await run('pre-tool-use', { tool_name: tool, tool_input: { file_path: file('src/a.ts'), content: '', command: 'ls' } });
    }
    expect(outputs.join('')).not.toContain('allow');
    const io = fakeIo({ cwd: dir, stdin: 'not json' });
    expect(await runJson(testContext(), io, claudeAdapter, 'pre-tool-use')).toBe(0);
    expect(io.out).toBe('');
    io.readStdin = () => Promise.reject(new Error('closed'));
    expect(await runJson(testContext(), io, claudeAdapter, 'stop')).toBe(0);
    expect(io.err).toContain('closed');
  });
});

describe('claude install', () => {
  const CURRENT = {
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'buckets hook pre-tool-use', onFailure: 'continue' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'buckets hook stop' }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command: 'buckets hook subagent-stop' }] }],
      PostCompact: [{ hooks: [{ type: 'command', command: 'buckets hook post-compact' }] }],
    },
  };
  const settingsPath = (dir: string) => path.join(dir, '.claude', 'settings.json');
  const read = (dir: string) => JSON.parse(readFileSync(settingsPath(dir), 'utf8')) as unknown;
  const write = (dir: string, value: unknown) => {
    mkdirSync(path.dirname(settingsPath(dir)), { recursive: true });
    writeFileSync(settingsPath(dir), JSON.stringify(value));
  };

  it('installs the 2.0 hooks and keeps the file on a second run', () => {
    const dir = makeProject({}, false);
    expect(claudeAdapter.install(dir, { skill: null })).toEqual([
      { status: 'done', text: 'Installed Claude Code hooks in .claude/settings.json (PreToolUse, Stop, SubagentStop, PostCompact)' },
    ]);
    expect(read(dir)).toEqual(CURRENT);
    const text = readFileSync(settingsPath(dir), 'utf8');
    expect(claudeAdapter.install(dir, { skill: null })).toEqual([{ status: 'kept', text: 'Claude Code hooks are already in .claude/settings.json' }]);
    expect(readFileSync(settingsPath(dir), 'utf8')).toBe(text);
    expect(claudeHooks().entries.map((h) => h.event)).toEqual(['PreToolUse', 'Stop', 'SubagentStop', 'PostCompact']);
  });

  it("keeps the user's hooks and settings", () => {
    const dir = makeProject({}, false);
    const user = {
      model: 'x',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      },
    };
    write(dir, user);
    claudeAdapter.install(dir, { skill: null });
    const installed = read(dir) as { model: string; hooks: Record<string, unknown[]> };
    expect(installed.model).toBe('x');
    expect(installed.hooks.PreToolUse).toEqual([user.hooks.PreToolUse[0], CURRENT.hooks.PreToolUse[0]]);
    expect(installed.hooks.Stop).toEqual([user.hooks.Stop[0], CURRENT.hooks.Stop[0]]);
  });

  it('replaces an older install, keeping a user hook that shared a group, and is idempotent after', () => {
    const dir = makeProject({}, false);
    write(dir, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell',
            hooks: [
              { type: 'command', command: 'buckets hook pre-tool-use' },
              { type: 'command', command: 'my-guard' },
            ],
          },
        ],
        PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'buckets hook post-tool-use' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'buckets hook stop' }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command: 'buckets hook subagent-stop' }, { type: 'command', command: 'buckets hook subagent-stop' }] }],
      },
    });
    expect(claudeAdapter.install(dir, { skill: null })).toEqual([
      { status: 'done', text: 'Updated the Claude Code hooks in .claude/settings.json (PreToolUse, PostToolUse, SubagentStop, PostCompact)' },
    ]);
    expect(read(dir)).toEqual({
      hooks: {
        PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell', hooks: [{ type: 'command', command: 'my-guard' }] }, CURRENT.hooks.PreToolUse[0]],
        Stop: CURRENT.hooks.Stop,
        SubagentStop: CURRENT.hooks.SubagentStop,
        PostCompact: CURRENT.hooks.PostCompact,
      },
    });
    expect(claudeAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'kept' });
  });

  it('reports an update when only an old form of ours changes', () => {
    const dir = makeProject({}, false);
    write(dir, { hooks: { ...CURRENT.hooks, PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'buckets hook post-tool-use' }] }] } });
    expect(claudeAdapter.install(dir, { skill: null })).toEqual([{ status: 'done', text: 'Updated the Claude Code hooks in .claude/settings.json (PostToolUse)' }]);
    expect(read(dir)).toEqual(CURRENT);
  });

  it('refuses settings it cannot merge into, without changing them', () => {
    const dir = makeProject({}, false);
    for (const bad of [[1], { hooks: [] }, { hooks: { Stop: {} } }]) {
      write(dir, bad);
      const before = readFileSync(settingsPath(dir), 'utf8');
      expect(claudeAdapter.install(dir, { skill: null })).toEqual([expect.objectContaining({ status: 'failed' })]);
      expect(readFileSync(settingsPath(dir), 'utf8')).toBe(before);
    }
    expect(existsSync(settingsPath(dir))).toBe(true);
  });
});
