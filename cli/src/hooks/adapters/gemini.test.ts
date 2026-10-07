// The Gemini CLI adapter with Gemini payloads: BeforeTool, AfterTool and AfterAgent.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject, readFile } from '../../testing/fixture.js';
import {
  cleanProject,
  feedbackFor,
  installSuite,
  line,
  LOCK_DENY_REASON,
  guardedNames,
  newSessionId,
  REFRESH_ALLOWED,
  REFRESH_DENIED,
  runAdapter,
  stopReportFor,
  violationProject,
  asUpdateDeny,
  UPDATE_ALLOWED,
  UPDATE_DENIED,
} from './adapter-test-kit.js';
import { geminiAdapter } from './gemini.js';

afterEach(cleanupProjects);

const DENY = line({ decision: 'deny', reason: LOCK_DENY_REASON });

function payload(dir: string, event: string, extra: Record<string, unknown>) {
  return { session_id: newSessionId(), transcript_path: path.join(dir, '.gemini', 'chat.json'), cwd: dir, hook_event_name: event, timestamp: '2026-10-04T12:00:00.000Z', ...extra };
}

const tool = (dir: string, event: string, name: string, input: Record<string, unknown>) => payload(dir, event, { tool_name: name, tool_input: input });

describe('gemini before-tool', () => {
  it('allows ordinary calls with no output', async () => {
    const dir = violationProject();
    expect(await runAdapter(geminiAdapter, 'before-tool', tool(dir, 'BeforeTool', 'write_file', { file_path: path.join(dir, 'root/_/x.ts'), content: 'x' }), dir)).toEqual({ code: 0, out: '', err: '' });
    expect(await runAdapter(geminiAdapter, 'before-tool', tool(dir, 'BeforeTool', 'run_shell_command', { command: 'npm test', dir_path: 'root' }), dir)).toEqual({ code: 0, out: '', err: '' });
  });

  it('denies write_file and replace on the lock under any name', async () => {
    const dir = violationProject();
    for (const [name, as] of guardedNames(dir)) {
      expect(await runAdapter(geminiAdapter, 'before-tool', tool(dir, 'BeforeTool', 'write_file', { file_path: name, content: '{}' }), dir)).toEqual(as({ code: 0, out: DENY, err: '' }));
      const replace = tool(dir, 'BeforeTool', 'replace', { file_path: name, old_string: '"a"', new_string: '"b"', expected_replacements: 1 });
      expect(await runAdapter(geminiAdapter, 'before-tool', replace, dir)).toEqual(as({ code: 0, out: DENY, err: '' }));
    }
  });

  it('denies plain buckets refresh or an installing buckets update and allows buckets refresh --web', async () => {
    const dir = violationProject();
    const run = (command: string) => runAdapter(geminiAdapter, 'before-tool', tool(dir, 'BeforeTool', 'run_shell_command', { command, description: 'approve', dir_path: '.' }), dir);
    for (const command of REFRESH_DENIED) expect(await run(command)).toEqual({ code: 0, out: DENY, err: '' });
    for (const command of REFRESH_ALLOWED) expect(await run(command)).toEqual({ code: 0, out: '', err: '' });
    for (const command of UPDATE_DENIED) expect(await run(command)).toEqual(asUpdateDeny({ code: 0, out: DENY, err: '' }));
    for (const command of UPDATE_ALLOWED) expect(await run(command)).toEqual({ code: 0, out: '', err: '' });
  });

  it('takes the session folder from GEMINI_PROJECT_DIR', async () => {
    const dir = violationProject();
    const input = tool(dir, 'BeforeTool', 'write_file', { file_path: 'buckets.lock.json', content: '{}' });
    delete (input as Record<string, unknown>).cwd;
    expect((await runAdapter(geminiAdapter, 'before-tool', input, makeProject({}, false), { GEMINI_PROJECT_DIR: dir })).out).toBe(DENY);
  });
});

describe('gemini after-tool', () => {
  it('reports the violations of an edited file in additionalContext', async () => {
    const dir = violationProject();
    const feedback = await feedbackFor(dir, 'root/_/main.ts');
    const replace = tool(dir, 'AfterTool', 'replace', { file_path: path.join(dir, 'root', '_', 'main.ts'), old_string: 'a', new_string: 'b' });
    const out = line({ hookSpecificOutput: { hookEventName: 'AfterTool', additionalContext: feedback } });
    expect(await runAdapter(geminiAdapter, 'after-tool', { ...replace, tool_response: { llmContent: 'ok' } }, dir)).toEqual({ code: 0, out, err: '' });
    const clean = tool(dir, 'AfterTool', 'write_file', { file_path: 'root/log/_/logger.ts', content: 'x' });
    expect(await runAdapter(geminiAdapter, 'after-tool', clean, dir)).toEqual({ code: 0, out: '', err: '' });
  });
});

describe('gemini after-agent', () => {
  it('denies the end of the turn once with the report, and lets the retry finish', async () => {
    const dir = violationProject();
    const report = await stopReportFor(dir);
    const first = payload(dir, 'AfterAgent', { prompt: 'fix it', prompt_response: 'Done.', stop_hook_active: false });
    expect(await runAdapter(geminiAdapter, 'after-agent', first, dir)).toEqual({ code: 0, out: line({ decision: 'deny', reason: report }), err: '' });
    expect(await runAdapter(geminiAdapter, 'after-agent', { ...first, stop_hook_active: true }, dir)).toEqual({ code: 0, out: '', err: '' });
  });

  it('says nothing for a clean project', async () => {
    const dir = await cleanProject();
    expect(await runAdapter(geminiAdapter, 'after-agent', payload(dir, 'AfterAgent', { stop_hook_active: false }), dir)).toEqual({ code: 0, out: '', err: '' });
  });
});

describe('gemini install', () => {
  installSuite(geminiAdapter, {
    file: '.gemini/settings.json',
    userText: [
      '{',
      '  // Team settings',
      '  "context": { "fileName": ["AGENTS.md", "GEMINI.md"] },',
      '  "hooks": {',
      '    "BeforeTool": [',
      '      // our own guard',
      '      { "matcher": "run_shell_command", "hooks": [{ "name": "audit", "type": "command", "command": "node audit.js", "timeout": 5000 }] }',
      '    ]',
      '  }',
      '}',
      '',
    ].join('\n'),
    freshUninstallDeletes: false,
    fresh(json) {
      expect(json).toEqual({
        hooks: {
          BeforeTool: [{ matcher: 'write_file|replace|run_shell_command', hooks: [{ type: 'command', command: 'buckets hook --agent gemini before-tool', name: 'slopbuckets-guard', timeout: 30000 }] }],
          AfterTool: [{ matcher: 'write_file|replace', hooks: [{ type: 'command', command: 'buckets hook --agent gemini after-tool', name: 'slopbuckets-check-file', timeout: 300000 }] }],
          AfterAgent: [{ hooks: [{ type: 'command', command: 'buckets hook --agent gemini after-agent', name: 'slopbuckets-check', timeout: 600000 }] }],
        },
        context: { fileName: ['AGENTS.md', 'GEMINI.md'] },
      });
    },
  });

  it('points context.fileName at AGENTS.md only when the user has not set it', () => {
    const fresh = makeProject({}, false);
    expect(geminiAdapter.install(fresh, { skill: null }).map((s) => s.status)).toEqual(['done', 'done', 'todo']);
    const own = makeProject({ '.gemini/settings.json': '{ "context": { "fileName": "GEMINI.md" } }\n' }, false);
    const steps = geminiAdapter.install(own, { skill: null });
    expect(steps.map((s) => s.status)).toEqual(['done', 'todo', 'todo']);
    expect(steps[1]!.text).toContain('Add "AGENTS.md" to "context.fileName"');
    expect(JSON.parse(readFile(own, '.gemini/settings.json')).context).toEqual({ fileName: 'GEMINI.md' });
  });
});
