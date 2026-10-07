// The Windsurf Cascade adapter with Cascade payloads: pre_write_code and pre_run_command, exit code 2 with stderr.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../../testing/fixture.js';
import { parseJson } from '../../core/json.js';
import { installSuite, LOCK_DENY_REASON, guardedNames, REFRESH_ALLOWED, REFRESH_DENIED, runAdapter, violationProject, asUpdateDeny, UPDATE_ALLOWED, UPDATE_DENIED } from './adapter-test-kit.js';
import { WINDSURF_FILE, WINDSURF_LEGACY_FILE, windsurfAdapter, windsurfTarget } from './windsurf.js';

afterEach(cleanupProjects);

const DENIED = { code: 2, out: '', err: `${LOCK_DENY_REASON}\n` };
const ALLOWED = { code: 0, out: '', err: '' };

function base(action: string) {
  return { agent_action_name: action, trajectory_id: 'traj-7f3a', execution_id: 'exec-1', timestamp: '2026-10-04T12:00:00Z', model_name: 'SWE-1.5' };
}

const write = (file: string) => ({ ...base('pre_write_code'), tool_info: { file_path: file, edits: [{ old_string: 'a', new_string: 'b' }] } });
const run = (command: string, cwd: string) => ({ ...base('pre_run_command'), tool_info: { command_line: command, cwd } });

describe('windsurf hooks', () => {
  it('allows ordinary writes and commands silently', async () => {
    const dir = violationProject();
    expect(await runAdapter(windsurfAdapter, 'pre-write-code', write(path.join(dir, 'root/_/main.ts')), dir)).toEqual(ALLOWED);
    expect(await runAdapter(windsurfAdapter, 'pre-run-command', run('npm test', dir), dir)).toEqual(ALLOWED);
  });

  it('blocks a write to the lock under any name with exit code 2 and the reason on stderr', async () => {
    const dir = violationProject();
    for (const [name, as] of guardedNames(dir)) expect(await runAdapter(windsurfAdapter, 'pre-write-code', write(name), dir)).toEqual(as(DENIED));
  });

  it('blocks plain buckets refresh or an installing buckets update and lets buckets refresh --web through', async () => {
    const dir = violationProject();
    for (const command of REFRESH_DENIED) expect(await runAdapter(windsurfAdapter, 'pre-run-command', run(command, dir), dir)).toEqual(DENIED);
    for (const command of REFRESH_ALLOWED) expect(await runAdapter(windsurfAdapter, 'pre-run-command', run(command, dir), dir)).toEqual(ALLOWED);
    for (const command of UPDATE_DENIED) expect(await runAdapter(windsurfAdapter, 'pre-run-command', run(command, dir), dir)).toEqual(asUpdateDeny(DENIED));
    for (const command of UPDATE_ALLOWED) expect(await runAdapter(windsurfAdapter, 'pre-run-command', run(command, dir), dir)).toEqual(ALLOWED);
    expect(await runAdapter(windsurfAdapter, 'pre-run-command', run('type buckets.lock.json', dir), dir)).toEqual(DENIED);
  });

  it('allows a broken payload', async () => {
    const dir = makeProject({});
    expect(await runAdapter(windsurfAdapter, 'pre-write-code', 'not json', dir)).toEqual(ALLOWED);
  });
});

describe('windsurf install', () => {
  installSuite(windsurfAdapter, {
    file: WINDSURF_FILE,
    userText: '{\n  // team hooks\n  "hooks": {\n    "post_write_code": [{ "command": "npx prettier --write" }]\n  }\n}\n',
    fresh(json) {
      const hooks = json.hooks as Record<string, { command: string; powershell: string }[]>;
      expect(hooks.pre_write_code![0]).toEqual({
        command: 'buckets hook --agent windsurf pre-write-code',
        powershell: 'buckets hook --agent windsurf pre-write-code; exit $LASTEXITCODE',
        show_output: true,
      });
      expect(hooks.pre_run_command![0]!.command).toBe('buckets hook --agent windsurf pre-run-command');
    },
    freshUninstallDeletes: true,
  });

  it('merges into the legacy .windsurf/hooks.json when it is the file Cascade reads', () => {
    const dir = makeProject({ '.windsurf/hooks.json': '{ "hooks": { "post_write_code": [{ "command": "lint" }] } }\n' }, false);
    expect(windsurfTarget(dir)).toBe(WINDSURF_LEGACY_FILE);
    const steps = windsurfAdapter.install(dir, { skill: null });
    expect(steps[0]).toEqual({ status: 'done', text: 'Installed Windsurf Cascade hooks in .windsurf/hooks.json (pre_write_code, pre_run_command)' });
    expect(steps.some((s) => s.status === 'todo')).toBe(true);
    expect(existsSync(path.join(dir, WINDSURF_FILE))).toBe(false);
    const json = parseJson(readFileSync(path.join(dir, WINDSURF_LEGACY_FILE), 'utf8')) as { hooks: Record<string, unknown[]> };
    expect(json.hooks.post_write_code).toEqual([{ command: 'lint' }]);
    expect(windsurfAdapter.uninstall(dir)[0]).toMatchObject({ status: 'done' });
    expect(parseJson(readFileSync(path.join(dir, WINDSURF_LEGACY_FILE), 'utf8'))).toEqual({ hooks: { post_write_code: [{ command: 'lint' }] } });
  });

  it('prefers .devin/hooks.json when it defines hooks', () => {
    const dir = makeProject({ '.devin/hooks.json': '{ "hooks": { "pre_read_code": [{ "command": "x" }] } }\n', '.windsurf/hooks.json': '{ "hooks": {} }\n' }, false);
    expect(windsurfTarget(dir)).toBe(WINDSURF_FILE);
    expect(windsurfTarget(makeProject({ '.devin/hooks.json': '{ "hooks": {} }\n', '.windsurf/hooks.json': '{}\n' }, false))).toBe(WINDSURF_LEGACY_FILE);
    expect(windsurfTarget(makeProject({}, false))).toBe(WINDSURF_FILE);
  });
});
