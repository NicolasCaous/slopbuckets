// The Gemini CLI adapter with Gemini payloads: BeforeTool denies only, AfterTool carries the pending list (the
// post-tool fallback), AfterAgent blocks once.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject, readFile } from '../../testing/fixture.js';
import { line, runAdapter } from './adapter-test-kit.js';
import { geminiAdapter } from './gemini.js';
import { crashingCore, decisionCases, fakeCore, restoreCoreAfterEach, TEXT } from './json-test-kit.js';

afterEach(cleanupProjects);
restoreCoreAfterEach();

function payload(dir: string, event: string, extra: Record<string, unknown>) {
  return { session_id: 'g-1', transcript_path: path.join(dir, 't.json'), cwd: dir, hook_event_name: event, timestamp: '2026-10-24T10:00:00Z', ...extra };
}

const before = (dir: string, name: string, input: Record<string, unknown>) => payload(dir, 'BeforeTool', { tool_name: name, tool_input: input });
const after = (dir: string, name: string, input: Record<string, unknown>) => payload(dir, 'AfterTool', { tool_name: name, tool_input: input, tool_response: { llmContent: 'ok' } });
const project = () => makeProject({ 'src/a.ts': 'export const a = 1;\n' });

describe('gemini phases', () => {
  it('BeforeTool simulates an edit without a session, and skips calls that edit nothing', async () => {
    const dir = project();
    const calls = fakeCore();
    await runAdapter(geminiAdapter, 'before-tool', before(dir, 'replace', { file_path: path.join(dir, 'src/a.ts'), old_string: '1', new_string: '2', instruction: 'bump' }), dir);
    await runAdapter(geminiAdapter, 'before-tool', before(dir, 'run_shell_command', { command: 'ls' }), dir);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ phase: 'pre-edit', sessionId: null, edits: [{ path: path.join(dir, 'src', 'a.ts'), content: 'export const a = 2;\n' }] });
  });

  it('AfterTool runs a pre-edit of the files on disk, or a pre-tool, with the session', async () => {
    const dir = project();
    const calls = fakeCore();
    await runAdapter(geminiAdapter, 'after-tool', after(dir, 'write_file', { file_path: path.join(dir, 'src/a.ts'), content: 'ignored' }), dir, { GEMINI_PROJECT_DIR: dir });
    await runAdapter(geminiAdapter, 'after-tool', after(dir, 'run_shell_command', { command: 'npm test', is_background: false }), dir);
    await runAdapter(geminiAdapter, 'after-tool', after(dir, 'read_file', { file_path: 'src/a.ts' }), dir);
    expect(calls.map((c) => [c.phase, c.sessionId, c.edits, c.isShell])).toEqual([
      ['pre-edit', 'g-1', [{ path: path.join(dir, 'src', 'a.ts'), content: 'export const a = 1;\n' }], false],
      ['pre-tool', 'g-1', [], true],
      ['pre-tool', 'g-1', [], false],
    ]);
  });

  it('AfterAgent is the stop, with stop_hook_active', async () => {
    const dir = project();
    const calls = fakeCore();
    await runAdapter(geminiAdapter, 'after-agent', payload(dir, 'AfterAgent', { prompt: 'p', prompt_response: 'r', stop_hook_active: true }), dir);
    expect(calls.map((c) => [c.phase, c.stopHookActive])).toEqual([['stop', true]]);
  });
});

describe('gemini answers', () => {
  const edit = (dir: string) => before(dir, 'write_file', { file_path: 'src/c.ts', content: 'c' });
  decisionCases(geminiAdapter, 'before-tool', edit, project, { deny: { code: 0, out: line({ decision: 'deny', reason: TEXT }) } });
  const context = line({ hookSpecificOutput: { hookEventName: 'AfterTool', additionalContext: TEXT } });
  decisionCases(geminiAdapter, 'after-tool', (dir) => after(dir, 'write_file', { file_path: 'src/a.ts' }), project, { context: { code: 0, out: context } });
  decisionCases(geminiAdapter, 'after-tool', (dir) => after(dir, 'run_shell_command', { command: 'ls' }), project, { context: { code: 0, out: context } });
  decisionCases(geminiAdapter, 'after-agent', (dir) => payload(dir, 'AfterAgent', { stop_hook_active: false }), project, { block: { code: 0, out: line({ decision: 'deny', reason: TEXT }) } });
});

describe('gemini fails open', () => {
  it('exits with 0 and prints nothing when the core crashes', async () => {
    const dir = project();
    crashingCore();
    for (const event of geminiAdapter.events) {
      const result = await runAdapter(geminiAdapter, event, before(dir, 'write_file', { file_path: 'x.ts', content: '' }), dir);
      expect(result).toMatchObject({ code: 0, out: '' });
    }
  });

  it('ends every command with `; exit 0`, so a missing buckets command does not deny', () => {
    const dir = makeProject({}, false);
    geminiAdapter.install(dir, { skill: null });
    const json = JSON.parse(readFile(dir, '.gemini/settings.json'));
    const commands = Object.values(json.hooks as Record<string, { hooks: { command: string }[] }[]>).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
    expect(commands).toEqual(['buckets hook --agent gemini before-tool; exit 0', 'buckets hook --agent gemini after-tool; exit 0', 'buckets hook --agent gemini after-agent; exit 0']);
  });
});

describe('gemini install', () => {
  const FRESH = {
    hooks: {
      BeforeTool: [{ matcher: 'write_file|replace', hooks: [{ type: 'command', command: 'buckets hook --agent gemini before-tool; exit 0', name: 'slopbuckets-config-guard', timeout: 60000 }] }],
      AfterTool: [{ matcher: '.*', hooks: [{ type: 'command', command: 'buckets hook --agent gemini after-tool; exit 0', name: 'slopbuckets-pending', timeout: 60000 }] }],
      AfterAgent: [{ hooks: [{ type: 'command', command: 'buckets hook --agent gemini after-agent; exit 0', name: 'slopbuckets-check', timeout: 600000 }] }],
    },
    context: { fileName: ['AGENTS.md', 'GEMINI.md'] },
  };

  it('installs into a fresh project and runs a second time without changes', () => {
    const dir = makeProject({}, false);
    expect(geminiAdapter.install(dir, { skill: null }).map((s) => s.status)).toEqual(['done', 'done', 'todo']);
    const text = readFile(dir, '.gemini/settings.json');
    expect(JSON.parse(text)).toEqual(FRESH);
    expect(geminiAdapter.install(dir, { skill: null })).toEqual([{ status: 'kept', text: 'Gemini CLI hooks are already in .gemini/settings.json' }]);
    expect(readFile(dir, '.gemini/settings.json')).toBe(text);
  });

  it("keeps the user's hooks and comments", () => {
    const user = ['{', '  // mine', '  "context": { "fileName": "AGENTS.md" },', '  "hooks": { "AfterAgent": [{ "hooks": [{ "type": "command", "command": "say done" }] }] }', '}', ''].join('\n');
    const dir = makeProject({ '.gemini/settings.json': user }, false);
    expect(geminiAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'done' });
    expect(readFile(dir, '.gemini/settings.json')).toContain('// mine');
    expect(readFile(dir, '.gemini/settings.json')).toContain('say done');
  });

  it('migrates a 1.x install to the fail-open commands and the AfterTool fallback', () => {
    const v1 = {
      hooks: {
        BeforeTool: [{ matcher: 'write_file|replace|run_shell_command', hooks: [{ type: 'command', command: 'buckets hook --agent gemini before-tool', name: 'slopbuckets-guard', timeout: 30000 }] }],
        AfterTool: [{ matcher: 'write_file|replace', hooks: [{ type: 'command', command: 'buckets hook --agent gemini after-tool', name: 'slopbuckets-check-file', timeout: 300000 }] }],
        AfterAgent: [{ hooks: [{ type: 'command', command: 'buckets hook --agent gemini after-agent', name: 'slopbuckets-check', timeout: 600000 }] }],
      },
      context: { fileName: ['AGENTS.md', 'GEMINI.md'] },
    };
    const dir = makeProject({ '.gemini/settings.json': JSON.stringify(v1, null, 2) }, false);
    expect(geminiAdapter.install(dir, { skill: null })[0]).toEqual({ status: 'done', text: 'Updated the Gemini CLI hooks in .gemini/settings.json (BeforeTool, AfterTool, AfterAgent)' });
    expect(JSON.parse(readFile(dir, '.gemini/settings.json'))).toEqual(FRESH);
    expect(geminiAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'kept' });
  });

  it('refuses a config it cannot merge into', () => {
    const dir = makeProject({ '.gemini/settings.json': '[1]\n' }, false);
    expect(geminiAdapter.install(dir, { skill: null })).toEqual([expect.objectContaining({ status: 'failed' })]);
  });
});
