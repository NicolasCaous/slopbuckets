import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hookCommand } from '../../commands/hook.js';
import { approve, fakeIo, testContext } from '../../testing/harness.js';
import { cleanupProjects, fileExists, LOGGER_PROJECT, makeProject, readFile, writeFile } from '../../testing/fixture.js';
import { LOCK_DENY_REASON } from '../core.js';
import { PLUGIN_MARKER } from '../plugin-file.js';
import { LOWERCASE_READ_DENY_REASON, parsePluginInput } from '../plugin-protocol.js';
import { findAdapter } from '../registry.js';
import { AMP_PLUGIN_FILE, ampToolCall } from './amp.js';
import { OPENCODE_PLUGIN_FILE, opencodeToolCall } from './opencode.js';
import { PI_PLUGIN_FILE, piToolCall } from './pi.js';

afterEach(cleanupProjects);

async function hook(agent: string, event: string, input: unknown, dir: string) {
  const io = fakeIo({ cwd: dir, stdin: typeof input === 'string' ? input : JSON.stringify(input) });
  const code = await hookCommand(testContext(), io, ['--agent', agent, event]);
  const lines = io.out.trim().split('\n');
  return { code, answer: JSON.parse(lines[lines.length - 1]!) as Record<string, string>, lines: lines.length, err: io.err };
}

const input = (raw: Record<string, unknown>) => parsePluginInput(JSON.stringify(raw)).input;

/** For each harness: a call that writes the lock, a shell call, a call that edits a file and the deny reason. */
const CASES = [
  {
    name: 'opencode V1',
    agent: 'opencode',
    write: (file: string) => ({ api: 'v1', tool: 'write', args: { filePath: file, content: '{}' } }),
    shell: (command: string) => ({ api: 'v1', tool: 'bash', args: { command } }),
    reason: LOWERCASE_READ_DENY_REASON,
  },
  {
    name: 'opencode V2',
    agent: 'opencode',
    write: (file: string) => ({ api: 'v2', tool: 'edit', args: { path: file, oldString: 'a', newString: 'b' } }),
    shell: (command: string) => ({ api: 'v2', tool: 'shell', args: { command } }),
    reason: LOWERCASE_READ_DENY_REASON,
  },
  {
    name: 'pi',
    agent: 'pi',
    write: (file: string) => ({ tool: 'write', args: { path: file, content: '{}' } }),
    shell: (command: string) => ({ tool: 'bash', args: { command } }),
    reason: LOWERCASE_READ_DENY_REASON,
  },
  {
    name: 'amp',
    agent: 'amp',
    write: (file: string) => ({ tool: 'edit_file', paths: [file] }),
    shell: (command: string) => ({ tool: 'Bash', command }),
    reason: LOCK_DENY_REASON,
  },
];

describe.each(CASES)('buckets hook --agent $agent ($name)', ({ agent, write, shell, reason }) => {
  it('denies a write to the lock with the reason, and allows other writes', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    expect(await hook(agent, 'pre-tool-use', { cwd: dir, ...write(path.join(dir, 'buckets.lock.json')) }, dir)).toEqual({
      code: 0,
      answer: { decision: 'deny', reason },
      lines: 1,
      err: '',
    });
    expect((await hook(agent, 'pre-tool-use', { cwd: dir, ...write('buckets.lock.json') }, dir)).answer.decision).toBe('deny');
    expect((await hook(agent, 'pre-tool-use', { cwd: dir, ...write(path.join(dir, 'root/_/main.ts')) }, dir)).answer).toEqual({ decision: 'allow' });
  });

  it('denies plain buckets refresh and allows buckets refresh --web', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    expect((await hook(agent, 'pre-tool-use', { cwd: dir, ...shell('buckets refresh') }, dir)).answer.decision).toBe('deny');
    expect((await hook(agent, 'pre-tool-use', { cwd: dir, ...shell('cat buckets.lock.json') }, dir)).answer.decision).toBe('deny');
    expect((await hook(agent, 'pre-tool-use', { cwd: dir, ...shell('buckets refresh --web > refresh.log 2>&1 &') }, dir)).answer).toEqual({ decision: 'allow' });
    expect((await hook(agent, 'pre-tool-use', { cwd: dir, ...shell('ls') }, dir)).answer).toEqual({ decision: 'allow' });
  });

  it('returns the check of an edited file with a violation, and nothing for a clean one', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/_/main.ts': "import x from './x';\n" });
    const bad = await hook(agent, 'post-tool-use', { cwd: dir, ...write(path.join(dir, 'root/_/main.ts')) }, dir);
    expect(bad.code).toBe(0);
    expect(bad.answer.feedback).toContain('root/_/main.ts');
    expect(bad.answer.feedback).toContain('import-relative');
    expect((await hook(agent, 'post-tool-use', { cwd: dir, ...write(path.join(dir, 'root/log/_/logger.ts')) }, dir)).answer).toEqual({});
    expect((await hook(agent, 'post-tool-use', { cwd: dir, ...shell('ls') }, dir)).answer).toEqual({});
  });

  it('blocks the stop when the check fails, and not when it passes or is already active', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const failing = await hook(agent, 'stop', { cwd: dir }, dir);
    expect(failing.answer.block).toContain('lock-missing');
    expect((await hook(agent, 'stop', { cwd: dir, active: true }, dir)).answer).toEqual({});
    await approve(dir);
    expect((await hook(agent, 'stop', { cwd: dir }, dir)).answer).toEqual({});
  });

  it('allows on invalid input and always answers with one JSON line', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    expect((await hook(agent, 'pre-tool-use', 'not json', dir)).answer).toEqual({ decision: 'allow' });
    expect((await hook(agent, 'post-tool-use', '[]', dir)).answer).toEqual({});
  });
});

describe('opencode tool mapping', () => {
  it('reads V1 filePath, patchText and bash workdir', () => {
    expect(opencodeToolCall(input({ tool: 'edit', args: { filePath: 'a.ts' } }))).toEqual({ action: { kind: 'write', paths: ['a.ts'] }, edited: ['a.ts'] });
    expect(opencodeToolCall(input({ api: 'v1', tool: 'edit', args: { path: 'a.ts' } }))).toEqual({ action: { kind: 'write', paths: [] }, edited: [] });
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n@@\n-a\n+b\n*** Delete File: buckets.lock.json\n*** End Patch';
    expect(opencodeToolCall(input({ api: 'v1', tool: 'apply_patch', args: { patchText: patch } }))).toEqual({
      action: { kind: 'write', paths: ['src/a.ts', 'src/b.ts', 'buckets.lock.json'] },
      edited: ['src/b.ts'],
    });
    expect(opencodeToolCall(input({ api: 'v1', tool: 'bash', args: { command: 'ls', workdir: 'sub' } })).action).toEqual({ kind: 'shell', command: 'ls', cwd: 'sub' });
    expect(opencodeToolCall(input({ api: 'v1', tool: 'shell', args: { command: 'ls' } })).action).toEqual({ kind: 'other' });
  });

  it('reads V2 path, patch and shell', () => {
    expect(opencodeToolCall(input({ api: 'v2', tool: 'write', args: { path: 'a.ts' } })).edited).toEqual(['a.ts']);
    expect(opencodeToolCall(input({ api: 'v2', tool: 'write', args: { filePath: 'a.ts' } })).edited).toEqual([]);
    expect(opencodeToolCall(input({ api: 'v2', tool: 'patch', args: { patchText: '*** Add File: x.ts\n+1' } })).edited).toEqual(['x.ts']);
    expect(opencodeToolCall(input({ api: 'v2', tool: 'apply_patch', args: { patchText: '*** Add File: x.ts\n+1' } })).action).toEqual({ kind: 'other' });
    expect(opencodeToolCall(input({ api: 'v2', tool: 'shell', args: { command: 'ls' } })).action).toEqual({ kind: 'shell', command: 'ls' });
    expect(opencodeToolCall(input({ api: 'v2', tool: 'read', args: { path: 'buckets.lock.json' } })).action).toEqual({ kind: 'other' });
  });

  it('denies a patch that deletes the lock through the CLI', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const patchText = '*** Begin Patch\n*** Delete File: buckets.lock.json\n*** End Patch';
    expect((await hook('opencode', 'pre-tool-use', { cwd: dir, api: 'v1', tool: 'apply_patch', args: { patchText } }, dir)).answer.decision).toBe('deny');
    expect((await hook('opencode', 'pre-tool-use', { cwd: dir, api: 'v2', tool: 'patch', args: { patchText } }, dir)).answer.decision).toBe('deny');
  });

  it('runs the subagent check on subagent-stop', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    expect((await hook('opencode', 'subagent-stop', { cwd: dir }, dir)).answer.block).toContain('lock-missing');
  });
});

describe('pi and amp tool mapping', () => {
  it('maps Pi bash, powershell, edit and write', () => {
    expect(piToolCall(input({ tool: 'powershell', args: { command: 'Get-Content buckets.lock.json' } })).action).toEqual({ kind: 'shell', command: 'Get-Content buckets.lock.json' });
    expect(piToolCall(input({ tool: 'edit', args: { path: 'a.ts', edits: [] } })).edited).toEqual(['a.ts']);
    expect(piToolCall(input({ tool: 'read', args: { path: 'buckets.lock.json' } })).action).toEqual({ kind: 'other' });
  });

  it('maps the paths and the command the Amp plugin extracted', () => {
    expect(ampToolCall(input({ tool: 'x', paths: ['file:///tmp/a.ts', 3] })).edited).toEqual([path.normalize('/tmp/a.ts').replace(/\\/g, '/')]);
    expect(ampToolCall(input({ tool: 'x', command: 'ls', commandCwd: 'sub' })).action).toEqual({ kind: 'shell', command: 'ls', cwd: 'sub' });
    expect(ampToolCall(input({ tool: 'x' })).action).toEqual({ kind: 'other' });
  });

  it('refuses events a harness does not have', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const io = fakeIo({ cwd: dir, stdin: '{}' });
    expect(await hookCommand(testContext(), io, ['--agent', 'pi', 'subagent-stop'])).toBe(1);
    expect(io.err).toContain('Events: pre-tool-use, post-tool-use, stop.');
  });
});

describe.each([
  { agent: 'opencode', spec: OPENCODE_PLUGIN_FILE },
  { agent: 'pi', spec: PI_PLUGIN_FILE },
  { agent: 'amp', spec: AMP_PLUGIN_FILE },
])('$agent install and uninstall', ({ agent, spec }) => {
  const adapter = findAdapter(agent)!;
  const primary = `${spec.dir}/${spec.name}`;
  const alt = `${spec.dir}/${spec.altName}`;
  const fileSteps = (steps: { status: string; text: string }[]) => steps.filter((s) => s.status !== 'todo');

  it('writes the plugin once and keeps it on the second run', () => {
    const dir = makeProject({}, false);
    const first = fileSteps(adapter.install(dir, { skill: null }));
    expect(first).toEqual([{ status: 'done', text: `Installed the slopbuckets plugin for ${spec.title} in ${primary}` }]);
    expect(readFile(dir, primary)).toBe(spec.content);
    expect(spec.content).toContain(PLUGIN_MARKER);
    expect(fileSteps(adapter.install(dir, { skill: null }))).toEqual([{ status: 'kept', text: `The slopbuckets plugin for ${spec.title} in ${primary} is up to date` }]);
  });

  it('updates an outdated copy of its own plugin in place', () => {
    const dir = makeProject({ [primary]: `// ${PLUGIN_MARKER} old\n` }, false);
    expect(fileSteps(adapter.install(dir, { skill: null }))[0]!.status).toBe('done');
    expect(readFile(dir, primary)).toBe(spec.content);
    expect(fileExists(dir, alt)).toBe(false);
  });

  it('never clobbers a user file with the same name', () => {
    const dir = makeProject({ [primary]: 'export default function mine() {}\n' }, false);
    const steps = fileSteps(adapter.install(dir, { skill: null }));
    expect(steps).toEqual([{ status: 'done', text: `Installed the slopbuckets plugin for ${spec.title} in ${alt}, because ${primary} is your own file and stays as it is` }]);
    expect(readFile(dir, primary)).toBe('export default function mine() {}\n');
    expect(readFile(dir, alt)).toBe(spec.content);
    expect(fileSteps(adapter.install(dir, { skill: null }))[0]!.status).toBe('kept');
    // Uninstall removes only the plugin of slopbuckets.
    expect(adapter.uninstall(dir)).toEqual([{ status: 'done', text: `Removed the slopbuckets plugin for ${spec.title} from ${alt}` }]);
    expect(readFile(dir, primary)).toBe('export default function mine() {}\n');
  });

  it('fails without writing when both names hold user files', () => {
    const dir = makeProject({ [primary]: 'a\n', [alt]: 'b\n' }, false);
    const steps = adapter.install(dir, { skill: null });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.status).toBe('failed');
    expect(readFile(dir, primary)).toBe('a\n');
    expect(readFile(dir, alt)).toBe('b\n');
  });

  it('uninstalls its plugin and the empty folder, and does nothing the second time', () => {
    const dir = makeProject({}, false);
    adapter.install(dir, { skill: null });
    expect(adapter.uninstall(dir)).toEqual([{ status: 'done', text: `Removed the slopbuckets plugin for ${spec.title} from ${primary}` }]);
    expect(fileExists(dir, spec.dir)).toBe(false);
    expect(adapter.uninstall(dir)).toEqual([]);
  });

  it('keeps the plugin folder when it holds other files', () => {
    const dir = makeProject({}, false);
    writeFile(dir, `${spec.dir}/other.ts`, 'x\n');
    adapter.install(dir, { skill: null });
    adapter.uninstall(dir);
    expect(fileExists(dir, `${spec.dir}/other.ts`)).toBe(true);
  });
});

describe('pi install', () => {
  it('reminds the human about project trust', () => {
    const dir = makeProject({}, false);
    const steps = findAdapter('pi')!.install(dir, { skill: null });
    expect(steps[1]).toMatchObject({ status: 'todo' });
    expect(steps[1]!.text).toContain('/trust');
  });
});
