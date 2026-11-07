import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../testing/fixture.js';
import { fakeIo, testContext } from '../testing/harness.js';
import { hookCommand, HOOK_EVENTS } from './hook.js';

afterEach(cleanupProjects);

async function runHook(args: string[], input: unknown, dir: string) {
  const io = fakeIo({ cwd: dir, stdin: JSON.stringify(input) });
  const code = await hookCommand(testContext(), io, args);
  return { code, out: io.out, err: io.err };
}

const QUIET = { code: 0, out: '', err: '' };

describe('buckets hook', () => {
  it('runs the Claude Code events by default, silently when nothing is pending', async () => {
    const dir = makeProject({});
    expect(HOOK_EVENTS).toEqual(['pre-tool-use', 'stop', 'subagent-stop', 'post-compact']);
    for (const input of [
      { session_id: 's', cwd: dir, tool_name: 'Bash', tool_input: { command: 'buckets update' } },
      { session_id: 's', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'buckets.config.json'), content: '{}' } },
    ]) {
      expect(await runHook(['pre-tool-use'], input, dir)).toEqual(QUIET);
    }
    for (const event of ['stop', 'subagent-stop', 'post-compact']) expect(await runHook([event], { session_id: 's', cwd: dir }, dir)).toEqual(QUIET);
  });

  it('lets a 1.x event through with a note, and refuses a missing event and an unknown agent', async () => {
    const dir = makeProject({});
    expect(await runHook(['post-tool-use'], {}, dir)).toEqual({
      code: 0,
      out: '',
      err: 'buckets hook: unknown event "post-tool-use", so this hook did nothing. If the hooks come from an older slopbuckets, run `buckets init` again. Events: pre-tool-use, stop, subagent-stop, post-compact.\n',
    });
    expect((await runHook(['--agent', 'cursor', 'before-shell-execution'], {}, dir)).err).toContain('run `buckets init --agent cursor` again');
    expect((await runHook([], {}, dir)).code).toBe(64);
    const unknown = await runHook(['--agent', 'nope', 'stop'], {}, dir);
    expect(unknown.code).toBe(64);
    expect(unknown.err).toContain('unknown agent "nope"');
    for (const [args, problem] of [
      [['--nope', 'stop'], 'unknown option "--nope"'],
      [['stop', 'extra'], 'unexpected argument "extra"'],
      [['--agent'], '--agent needs a value'],
    ] as const) {
      const result = await runHook([...args], {}, dir);
      expect(result.code).toBe(64);
      expect(result.err).toContain(problem);
      expect(result.err).toContain('Usage: buckets hook');
    }
  });

  it('prints the usage with --help and -h, and exits 0 without the older-install note', async () => {
    const dir = makeProject({});
    for (const args of [['--help'], ['-h'], ['--agent', 'gemini', '--help']]) {
      const result = await runHook(args, {}, dir);
      expect(result.code).toBe(0);
      expect(result.err).toBe('');
      expect(result.out).toContain('Usage: buckets hook [--agent <name>] <event>');
    }
    expect((await runHook(['--help'], {}, dir)).out).toContain('Events of Claude Code: pre-tool-use, stop, subagent-stop, post-compact.');
    expect((await runHook(['--agent', 'gemini', '-h'], {}, dir)).out).toContain('Events of Gemini CLI: before-tool, after-tool, after-agent.');
  });

  it('survives invalid JSON on stdin and a crashing stdin', async () => {
    const dir = makeProject({});
    const io = fakeIo({ cwd: dir, stdin: 'not json' });
    expect(await hookCommand(testContext(), io, ['pre-tool-use'])).toBe(0);
    expect(io.out).toBe('');
    io.readStdin = async () => {
      throw new Error('stdin is closed');
    };
    expect(await hookCommand(testContext(), io, ['pre-tool-use'])).toBe(0);
    expect(io.out).toBe('');
    expect(io.err).toContain('stdin is closed');
  });
});
