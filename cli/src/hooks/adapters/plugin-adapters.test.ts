import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hookCommand } from '../../commands/hook.js';
import { HOOK_PHASES, type HookCore, type HookDecision, type HookInput, type HookPhase } from '../../contract/hooks.js';
import { cleanupProjects, fileExists, makeProject, readFile } from '../../testing/fixture.js';
import { fakeIo, testContext } from '../../testing/harness.js';
import { normalizeHarnessPath, parseHookInput } from '../input.js';
import { PLUGIN_MARKER } from '../plugin-file.js';
import { pluginHandlers, type ToolTable } from '../plugin-protocol.js';
import { ampPlugin, opencodePlugin, piPlugin } from '../plugins/sources.js';
import { findAdapter } from '../registry.js';
import { AMP_PLUGIN_FILE, AMP_TOOLS } from './amp.js';
import { OPENCODE_PLUGIN_FILE, OPENCODE_TOOLS } from './opencode.js';
import { PI_PLUGIN_FILE, PI_TOOLS } from './pi.js';

afterEach(cleanupProjects);

/** Runs one protocol call with a core that records its input and answers `decision`. */
async function call(table: ToolTable, event: string, stdin: unknown, decision: HookDecision | Error = { kind: 'silent' }, dir = makeProject({}, false)) {
  const inputs: HookInput[] = [];
  const core: HookCore = async (input) => {
    inputs.push(input);
    if (decision instanceof Error) throw decision;
    return decision;
  };
  const io = fakeIo({ cwd: dir, stdin: typeof stdin === 'string' ? stdin : JSON.stringify(stdin) });
  const handler = pluginHandlers(table, ...HOOK_PHASES)[event as HookPhase];
  const code = await handler({ ...testContext(), hookCore: core }, io, parseHookInput(await io.readStdin()));
  return { code, out: io.out, err: io.err, input: inputs[0]!, dir };
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const at = (dir: string, file: string) => path.resolve(dir, file);

describe('plugin protocol round trips', () => {
  it('pre-tool: a call that edits nothing reaches the core as pre-tool and answers its context', async () => {
    const dir = makeProject({}, false);
    const r = await call(OPENCODE_TOOLS, 'pre-tool', { cwd: dir, sessionId: 's1', tool: 'read', args: { filePath: 'a.ts' } }, { kind: 'context', text: 'buckets: 1 pending' }, dir);
    expect(r).toMatchObject({ code: 0, out: line({ kind: 'context', text: 'buckets: 1 pending' }), err: '' });
    expect(r.input).toEqual({ phase: 'pre-tool', sessionId: 's1', agentId: null, cwd: normalizeHarnessPath(dir), root: normalizeHarnessPath(dir), toolName: 'read', edits: [], isShell: false, stopHookActive: false });
  });

  it('pre-tool: a write becomes pre-edit with the new text, and a deny comes back', async () => {
    const r = await call(OPENCODE_TOOLS, 'pre-tool', { tool: 'write', args: { filePath: 'buckets.config.json', content: '{' } }, { kind: 'deny', text: 'config invalid' });
    expect(r.out).toBe(line({ kind: 'deny', text: 'config invalid' }));
    expect(r.input).toMatchObject({ phase: 'pre-edit', toolName: 'write', edits: [{ path: at(r.dir, 'buckets.config.json'), content: '{' }], isShell: false });
  });

  it('pre-edit is handled like pre-tool, so a read stays pre-tool', async () => {
    const r = await call(PI_TOOLS, 'pre-edit', { tool: 'read', args: { path: 'a.ts' } });
    expect(r.input.phase).toBe('pre-tool');
    expect(r.out).toBe(line({ kind: 'silent' }));
  });

  it('pre-tool: a shell call is marked, and silent comes back as silent', async () => {
    for (const [table, tool] of [
      [OPENCODE_TOOLS, 'bash'],
      [OPENCODE_TOOLS, 'shell'],
      [PI_TOOLS, 'powershell'],
    ] as const) {
      const r = await call(table, 'pre-tool', { tool, args: { command: 'rm src/a.ts' } });
      expect(r.input).toMatchObject({ phase: 'pre-tool', isShell: true, edits: [] });
      expect(r.out).toBe(line({ kind: 'silent' }));
    }
  });

  it('stop and subagent-stop: carry stopHookActive and answer a block', async () => {
    const stop = await call(PI_TOOLS, 'stop', { sessionId: 's1', stopHookActive: true, tool: 'ignored' }, { kind: 'block', text: 'buckets: 2 remain' });
    expect(stop.out).toBe(line({ kind: 'block', text: 'buckets: 2 remain' }));
    expect(stop.input).toMatchObject({ phase: 'stop', toolName: null, edits: [], isShell: false, stopHookActive: true, sessionId: 's1' });
    const sub = await call(AMP_TOOLS, 'subagent-stop', { sessionId: 'T-2', agentId: 'a1' }, { kind: 'block', text: 'x' });
    expect(sub.out).toBe(line({ kind: 'block', text: 'x' }));
    expect(sub.input).toMatchObject({ phase: 'subagent-stop', sessionId: 'T-2', agentId: 'a1', stopHookActive: false });
  });

  it('post-compact: reaches the core and answers silent', async () => {
    const r = await call(OPENCODE_TOOLS, 'post-compact', { sessionId: 's1' });
    expect(r.input.phase).toBe('post-compact');
    expect(r.out).toBe(line({ kind: 'silent' }));
  });

  it('uses root when the plugin sends one, else cwd', async () => {
    const r = await call(PI_TOOLS, 'stop', { cwd: '/repo/sub', root: '/repo' });
    expect(r.input).toMatchObject({ cwd: '/repo/sub', root: '/repo' });
  });

  it('answers silent for a decision the phase does not allow', async () => {
    expect((await call(PI_TOOLS, 'stop', {}, { kind: 'deny', text: 'no' })).out).toBe(line({ kind: 'silent' }));
    expect((await call(PI_TOOLS, 'post-compact', {}, { kind: 'context', text: 'no' })).out).toBe(line({ kind: 'silent' }));
    expect((await call(PI_TOOLS, 'pre-tool', { tool: 'read' }, { kind: 'block', text: 'no' })).out).toBe(line({ kind: 'silent' }));
  });

  it('fails open: a crash of the core answers silent with exit code 0 and a note on stderr', async () => {
    const r = await call(PI_TOOLS, 'pre-tool', { tool: 'write', args: { path: 'a.ts', content: '' } }, new Error('boom'));
    expect(r.code).toBe(0);
    expect(r.out).toBe(line({ kind: 'silent' }));
    expect(r.err).toContain('buckets hook pre-tool: unexpected error: Error: boom');
  });

  it('reads malformed input as an empty call', async () => {
    for (const stdin of ['not json', '[]', '']) {
      const r = await call(PI_TOOLS, 'pre-tool', stdin);
      expect(r.input).toMatchObject({ phase: 'pre-tool', toolName: null, sessionId: null, edits: [] });
      expect(r.out).toBe(line({ kind: 'silent' }));
    }
  });
});

describe('edits and their new text', () => {
  const edits = async (table: ToolTable, call_: Record<string, unknown>, files: Record<string, string> = {}) => {
    const dir = makeProject(files, false);
    const r = await call(table, 'pre-tool', { cwd: dir, ...call_ }, { kind: 'silent' }, dir);
    return { edits: r.input.edits, dir, isShell: r.input.isShell };
  };

  it('OpenCode edit: applies oldString and newString to the file on disk, both lines', async () => {
    const v1 = await edits(OPENCODE_TOOLS, { tool: 'edit', args: { filePath: 'src/a.ts', oldString: 'one', newString: 'two' } }, { 'src/a.ts': 'one one\n' });
    expect(v1.edits).toEqual([{ path: at(v1.dir, 'src/a.ts'), content: 'two one\n' }]);
    const v2 = await edits(OPENCODE_TOOLS, { tool: 'edit', args: { path: 'src/a.ts', oldString: 'one', newString: 'two', replaceAll: true } }, { 'src/a.ts': 'one one\n' });
    expect(v2.edits).toEqual([{ path: at(v2.dir, 'src/a.ts'), content: 'two two\n' }]);
    const created = await edits(OPENCODE_TOOLS, { tool: 'edit', args: { filePath: 'src/new.ts', oldString: '', newString: 'x' } });
    expect(created.edits).toEqual([{ path: at(created.dir, 'src/new.ts'), content: 'x' }]);
  });

  it('leaves the text out when the edit would not apply', async () => {
    const r = await edits(OPENCODE_TOOLS, { tool: 'edit', args: { filePath: 'src/a.ts', oldString: 'missing', newString: 'two' } }, { 'src/a.ts': 'one\n' });
    expect(r.edits).toEqual([{ path: at(r.dir, 'src/a.ts') }]);
    const noFile = await edits(PI_TOOLS, { tool: 'edit', args: { path: 'gone.ts', edits: [{ oldText: 'a', newText: 'b' }] } });
    expect(noFile.edits).toEqual([{ path: at(noFile.dir, 'gone.ts') }]);
  });

  it('Pi edit: applies the edits list in order, and the legacy top-level pair', async () => {
    const r = await edits(PI_TOOLS, { tool: 'edit', args: { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] } }, { 'a.ts': 'a c\n' });
    expect(r.edits).toEqual([{ path: at(r.dir, 'a.ts'), content: 'b d\n' }]);
    const legacy = await edits(PI_TOOLS, { tool: 'edit', args: { path: 'a.ts', oldText: 'a', newText: 'z' } }, { 'a.ts': 'a\n' });
    expect(legacy.edits[0]!.content).toBe('z\n');
    const write = await edits(PI_TOOLS, { tool: 'write', args: { path: 'b.ts', content: 'new' } });
    expect(write.edits).toEqual([{ path: at(write.dir, 'b.ts'), content: 'new' }]);
  });

  it('Amp: takes the paths and command the plugin sends, and the text from the raw arguments', async () => {
    const edit = await edits(AMP_TOOLS, { tool: 'edit_file', paths: ['src/a.ts'], args: { path: 'src/a.ts', old_str: 'a', new_str: 'b' } }, { 'src/a.ts': 'a\n' });
    expect(edit.edits).toEqual([{ path: at(edit.dir, 'src/a.ts'), content: 'b\n' }]);
    const create = await edits(AMP_TOOLS, { tool: 'create_file', paths: ['n.ts'], args: { path: 'n.ts', content: 'x' } });
    expect(create.edits).toEqual([{ path: at(create.dir, 'n.ts'), content: 'x' }]);
    const two = await edits(AMP_TOOLS, { tool: 'x', paths: ['a.ts', 'b.ts', 7], args: {} });
    expect(two.edits).toEqual([{ path: at(two.dir, 'a.ts') }, { path: at(two.dir, 'b.ts') }]);
    const shell = await edits(AMP_TOOLS, { tool: 'Bash', command: 'sed -i s/a/b/ a.ts', paths: ['a.ts'] });
    expect(shell).toMatchObject({ edits: [], isShell: true });
    const read = await edits(AMP_TOOLS, { tool: 'Read', paths: [], args: { path: 'a.ts' } });
    expect(read).toMatchObject({ edits: [], isShell: false });
  });

  it('apply_patch: adds, updates with an anchor, deletes and moves', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+export const n = 1;',
      '*** Update File: src/a.ts',
      '@@ function f() {',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '*** Delete File: src/old.ts',
      '*** Update File: src/m.ts',
      '*** Move to: src/moved.ts',
      '@@',
      '-x',
      '+y',
      '*** End Patch',
    ].join('\n');
    const files = { 'src/a.ts': 'const b = 2;\nfunction f() {\nconst a = 1;\nconst b = 2;\n}\n', 'src/old.ts': '', 'src/m.ts': 'x\n' };
    const r = await edits(OPENCODE_TOOLS, { tool: 'apply_patch', args: { patchText: patch } }, files);
    expect(r.edits).toEqual([
      { path: at(r.dir, 'src/new.ts'), content: 'export const n = 1;\n' },
      { path: at(r.dir, 'src/a.ts'), content: 'const b = 2;\nfunction f() {\nconst a = 1;\nconst b = 3;\n}\n' },
      { path: at(r.dir, 'src/old.ts'), content: null },
      { path: at(r.dir, 'src/m.ts'), content: null },
      { path: at(r.dir, 'src/moved.ts'), content: 'y\n' },
    ]);
  });

  it('apply_patch: keeps CRLF line ends and leaves the text out when a hunk does not match', async () => {
    const crlf = await edits(OPENCODE_TOOLS, { tool: 'patch', args: { patchText: '*** Begin Patch\n*** Update File: a.ts\n@@\n a\n-b\n+c\n*** End Patch' } }, { 'a.ts': 'a\r\nb\r\n' });
    expect(crlf.edits).toEqual([{ path: at(crlf.dir, 'a.ts'), content: 'a\r\nc\r\n' }]);
    const miss = await edits(OPENCODE_TOOLS, { tool: 'patch', args: { patchText: '*** Update File: a.ts\n@@\n-zzz\n+c' } }, { 'a.ts': 'a\n' });
    expect(miss.edits).toEqual([{ path: at(miss.dir, 'a.ts') }]);
  });
});

describe.each([
  { agent: 'opencode', events: ['pre-edit', 'pre-tool', 'stop', 'subagent-stop', 'post-compact'], missing: ['pre-tool-use'] },
  { agent: 'pi', events: ['pre-edit', 'pre-tool', 'stop', 'post-compact'], missing: ['subagent-stop', 'post-tool-use'] },
  { agent: 'amp', events: ['pre-edit', 'pre-tool', 'stop', 'subagent-stop'], missing: ['post-compact'] },
])('buckets hook --agent $agent', ({ agent, events, missing }) => {
  it('lists its events and answers each with one JSON decision line', async () => {
    expect(findAdapter(agent)!.events).toEqual(events);
    const dir = makeProject({}, false);
    for (const event of events) {
      const io = fakeIo({ cwd: dir, stdin: JSON.stringify({ cwd: dir, sessionId: 's1', tool: 'read', args: {} }) });
      expect(await hookCommand(testContext(), io, ['--agent', agent, event])).toBe(0);
      const lines = io.out.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(typeof JSON.parse(lines[0]!).kind).toBe('string');
    }
  });

  it('lets events it does not have through with a note, the 1.x names included', async () => {
    const dir = makeProject({}, false);
    for (const event of missing) {
      const io = fakeIo({ cwd: dir, stdin: '{}' });
      expect(await hookCommand(testContext(), io, ['--agent', agent, event])).toBe(0);
      expect(io.err).toContain(`Events: ${events.join(', ')}.`);
    }
  });
});

/** The start of a plugin file as slopbuckets 1.x wrote it. */
const PLUGIN_1X = `// @ts-nocheck\n// ${PLUGIN_MARKER}: the slopbuckets plugin. It runs "buckets hook --agent x pre-tool-use".\nexport default {};\n`;

describe.each([
  { agent: 'opencode', spec: { ...OPENCODE_PLUGIN_FILE, content: opencodePlugin() }, plugin: opencodePlugin },
  { agent: 'pi', spec: { ...PI_PLUGIN_FILE, content: piPlugin() }, plugin: piPlugin },
  { agent: 'amp', spec: { ...AMP_PLUGIN_FILE, content: ampPlugin() }, plugin: ampPlugin },
])('$agent install', ({ agent, spec, plugin }) => {
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

  it('migrates a 1.x plugin in place, under either name, and is idempotent after that', () => {
    for (const name of [primary, alt]) {
      const dir = makeProject({ [name]: PLUGIN_1X }, false);
      expect(fileSteps(adapter.install(dir, { skill: null }))).toEqual([{ status: 'done', text: `Updated the slopbuckets plugin for ${spec.title} in ${name}` }]);
      expect(readFile(dir, name)).toBe(spec.content);
      expect(readFile(dir, name)).not.toContain('pre-tool-use');
      expect(fileExists(dir, name === primary ? alt : primary)).toBe(false);
      expect(fileSteps(adapter.install(dir, { skill: null }))[0]!.status).toBe('kept');
    }
  });

  it('never clobbers a user file with the same name', () => {
    const dir = makeProject({ [primary]: 'export default function mine() {}\n' }, false);
    const steps = fileSteps(adapter.install(dir, { skill: null }));
    expect(steps).toEqual([{ status: 'done', text: `Installed the slopbuckets plugin for ${spec.title} in ${alt}, because ${primary} is your own file and stays as it is` }]);
    expect(readFile(dir, primary)).toBe('export default function mine() {}\n');
    expect(readFile(dir, alt)).toBe(spec.content);
    expect(fileSteps(adapter.install(dir, { skill: null }))[0]!.status).toBe('kept');
  });

  it('writes the command of a local install into the plugin, and switches back on the next install', () => {
    const dir = makeProject({}, false);
    const local = 'node ./node_modules/slopbuckets/dist/index.js';
    expect(fileSteps(adapter.install(dir, { skill: null, command: local }))[0]!.status).toBe('done');
    expect(readFile(dir, primary)).toBe(plugin(local));
    expect(readFile(dir, primary)).toContain(`const COMMAND = ${JSON.stringify(local)};`);
    expect(fileSteps(adapter.install(dir, { skill: null }))).toEqual([{ status: 'done', text: `Updated the slopbuckets plugin for ${spec.title} in ${primary}` }]);
    expect(readFile(dir, primary)).toBe(spec.content);
  });

  it('uninstall removes only its own plugin file, and the folder it left empty', () => {
    const dir = makeProject({}, false);
    adapter.install(dir, { skill: null });
    expect(adapter.uninstall(dir)).toEqual([{ status: 'done', text: `Removed the slopbuckets plugin for ${spec.title} from ${primary}` }]);
    expect(fileExists(dir, spec.dir)).toBe(false);
    expect(adapter.uninstall(dir)).toEqual([]);
    const mine = makeProject({ [primary]: 'export default function mine() {}\n' }, false);
    adapter.install(mine, { skill: null });
    expect(adapter.uninstall(mine)).toEqual([{ status: 'done', text: `Removed the slopbuckets plugin for ${spec.title} from ${alt}` }]);
    expect(readFile(mine, primary)).toBe('export default function mine() {}\n');
  });

  it('fails without writing when both names hold user files', () => {
    const dir = makeProject({ [primary]: 'a\n', [alt]: 'b\n' }, false);
    const steps = adapter.install(dir, { skill: null });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.status).toBe('failed');
    expect(readFile(dir, primary)).toBe('a\n');
    expect(readFile(dir, alt)).toBe('b\n');
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
