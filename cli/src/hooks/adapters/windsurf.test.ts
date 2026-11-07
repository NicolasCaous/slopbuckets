// The Windsurf Cascade adapter with Cascade payloads: pre_write_code only, refused with exit code 2 and stderr.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookDecision, HookInput } from '../../contract/hooks.js';
import { parseJson } from '../../files/json.js';
import { cleanupProjects, makeProject, readFile } from '../../testing/fixture.js';
import { installSuite, runAdapter } from './adapter-test-kit.js';
import { WINDSURF_FILE, WINDSURF_LEGACY_FILE, windsurfAdapter, windsurfTarget } from './windsurf.js';

const core = vi.hoisted(() => ({ decision: { kind: 'silent' } as HookDecision, inputs: [] as HookInput[], fail: false }));
vi.mock('../core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core.js')>()),
  hookCore: async (input: HookInput) => {
    core.inputs.push(input);
    if (core.fail) throw new Error('core crashed');
    return core.decision;
  },
}));

beforeEach(() => {
  core.decision = { kind: 'silent' };
  core.inputs = [];
  core.fail = false;
});
afterEach(cleanupProjects);

const QUIET = { code: 0, out: '', err: '' };

function write(file: string, edits: unknown[]) {
  return { agent_action_name: 'pre_write_code', trajectory_id: 'traj-7f3a', execution_id: 'exec-1', timestamp: '2026-10-04T12:00:00Z', model_name: 'SWE-1.5', tool_info: { file_path: file, edits } };
}

describe('windsurf pre-write-code', () => {
  it('sends the edit with its new text to the core as pre-edit', async () => {
    const dir = makeProject({ 'buckets.config.json': '{ "buckets": {} }\n' }, false);
    const file = path.join(dir, 'buckets.config.json');
    await runAdapter(windsurfAdapter, 'pre-write-code', write(file, [{ old_string: '{}', new_string: '{ "a": 1 }' }]), dir);
    expect(core.inputs[0]).toEqual({
      phase: 'pre-edit',
      sessionId: 'traj-7f3a',
      agentId: null,
      cwd: dir,
      root: dir,
      toolName: 'pre_write_code',
      edits: [{ path: file, content: '{ "buckets": { "a": 1 } }\n' }],
      isShell: false,
      stopHookActive: false,
    });
    await runAdapter(windsurfAdapter, 'pre-write-code', write('src/new.ts', [{ old_string: '', new_string: 'x\n' }]), dir);
    expect(core.inputs[1]!.edits).toEqual([{ path: path.join(dir, 'src/new.ts'), content: 'x\n' }]);
    await runAdapter(windsurfAdapter, 'pre-write-code', write(file, [{ old_string: 'missing', new_string: 'x' }]), dir);
    expect(core.inputs[2]!.edits).toEqual([{ path: file }]);
  });

  it('refuses with exit code 2 on deny and stays quiet on context and silent', async () => {
    const dir = makeProject({}, false);
    const edit = write(path.join(dir, 'a.ts'), [{ old_string: '', new_string: 'x' }]);
    expect(await runAdapter(windsurfAdapter, 'pre-write-code', edit, dir)).toEqual(QUIET);
    core.decision = { kind: 'context', text: 'buckets: 1 pending.' };
    expect(await runAdapter(windsurfAdapter, 'pre-write-code', edit, dir)).toEqual(QUIET);
    core.decision = { kind: 'deny', text: 'buckets: edit not applied, buckets.config.json would be invalid.' };
    expect(await runAdapter(windsurfAdapter, 'pre-write-code', edit, dir)).toEqual({ code: 2, out: '', err: 'buckets: edit not applied, buckets.config.json would be invalid.\n' });
  });

  it('fails open on a broken payload and on a crash', async () => {
    const dir = makeProject({}, false);
    expect(await runAdapter(windsurfAdapter, 'pre-write-code', 'not json', dir)).toEqual(QUIET);
    expect(core.inputs).toEqual([]);
    core.fail = true;
    const crashed = await runAdapter(windsurfAdapter, 'pre-write-code', write('a.ts', []), dir);
    expect(crashed).toMatchObject({ code: 0, out: '' });
    expect(crashed.err).toContain('core crashed');
  });
});

describe('windsurf install', () => {
  installSuite(windsurfAdapter, {
    file: WINDSURF_FILE,
    userText: '{\n  // team hooks\n  "hooks": {\n    "post_write_code": [{ "command": "npx prettier --write" }]\n  }\n}\n',
    fresh(json) {
      const hooks = json.hooks as Record<string, unknown[]>;
      expect(hooks).toEqual({
        pre_write_code: [
          { command: 'buckets hook --agent windsurf pre-write-code', powershell: 'buckets hook --agent windsurf pre-write-code; exit $LASTEXITCODE', show_output: true },
        ],
      });
    },
  });

  it('removes a hook of an event it no longer uses and keeps the user hooks', () => {
    const old = {
      hooks: {
        pre_write_code: [{ command: 'buckets hook --agent windsurf pre-write-code', powershell: 'buckets hook --agent windsurf pre-write-code; exit $LASTEXITCODE', show_output: true }],
        pre_run_command: [{ command: './audit.sh' }, { command: 'buckets hook --agent windsurf pre-run-command', powershell: 'x', show_output: true }],
      },
    };
    const dir = makeProject({ [WINDSURF_FILE]: JSON.stringify(old, null, 2) }, false);
    const steps = windsurfAdapter.install(dir, { skill: null });
    expect(steps[0]).toEqual({ status: 'done', text: 'Updated the Windsurf Cascade hooks in .devin/hooks.json (pre_run_command)' });
    const json = parseJson(readFile(dir, WINDSURF_FILE)) as { hooks: Record<string, unknown[]> };
    expect(json.hooks.pre_run_command).toEqual([{ command: './audit.sh' }]);
    expect(json.hooks.pre_write_code).toEqual(old.hooks.pre_write_code);
    expect(windsurfAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'kept' });
  });

  it('says that Cascade relies on AGENTS.md and the git hook', () => {
    expect(windsurfAdapter.install(makeProject({}, false), { skill: null }).at(-1)).toMatchObject({ status: 'todo', text: expect.stringContaining('buckets init --git-hook') });
  });

  it('merges into the legacy .windsurf/hooks.json when it is the file Cascade reads', () => {
    const dir = makeProject({ '.windsurf/hooks.json': '{ "hooks": { "post_write_code": [{ "command": "lint" }] } }\n' }, false);
    expect(windsurfTarget(dir)).toBe(WINDSURF_LEGACY_FILE);
    const steps = windsurfAdapter.install(dir, { skill: null });
    expect(steps[0]).toEqual({ status: 'done', text: 'Installed Windsurf Cascade hooks in .windsurf/hooks.json (pre_write_code)' });
    expect(steps.some((s) => s.status === 'todo' && s.text.includes('legacy'))).toBe(true);
    expect(existsSync(path.join(dir, WINDSURF_FILE))).toBe(false);
    expect(parseJson(readFile(dir, WINDSURF_LEGACY_FILE))).toMatchObject({ hooks: { post_write_code: [{ command: 'lint' }] } });
  });

  it('prefers .devin/hooks.json when it defines hooks', () => {
    const dir = makeProject({ '.devin/hooks.json': '{ "hooks": { "pre_read_code": [{ "command": "x" }] } }\n', '.windsurf/hooks.json': '{ "hooks": {} }\n' }, false);
    expect(windsurfTarget(dir)).toBe(WINDSURF_FILE);
    expect(windsurfTarget(makeProject({ '.devin/hooks.json': '{ "hooks": {} }\n', '.windsurf/hooks.json': '{}\n' }, false))).toBe(WINDSURF_LEGACY_FILE);
    expect(windsurfTarget(makeProject({}, false))).toBe(WINDSURF_FILE);
  });
});
