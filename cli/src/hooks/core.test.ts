// The hook core against the fake engine: the pending list across calls of one session, the stop block, post-compact,
// subagents, the config-invalid deny and the fail-open rule.
import { existsSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuleEngine } from '../contract/engine.js';
import type { HookDecision, HookInput, HookPhase } from '../contract/hooks.js';
import { adviceHeader, renderAdvice, renderAdviceNote, renderEnvironment, renderInterrupt, renderPending, renderStop } from '../contract/messages.js';
import type { Violation } from '../contract/violation.js';
import { createFakeEngine, type FakeEngineScript } from '../testing/fake-engine.js';
import { cleanupProjects, makeProject } from '../testing/fixture.js';
import { ADVICE_SAMPLES, SAMPLES } from '../testing/samples.js';
import { hookCore, SHELL_NOTE } from './core.js';
import { loadSession, sessionRef } from './session.js';

afterEach(cleanupProjects);

const A = SAMPLES['import-private'];
const B = SAMPLES['file-unowned'];
const BAD = SAMPLES['config-invalid'];
const BAD2: Violation = { rule: 'config-invalid', project: '.', problem: { kind: 'missing', at: ['buckets', 'billing'], field: 'purpose' } };

function setup(script: FakeEngineScript = {}) {
  const root = makeProject({});
  const engine = createFakeEngine(script);
  const call = (phase: HookPhase, extra: Partial<HookInput> = {}): Promise<HookDecision> =>
    hookCore({ phase, sessionId: 's1', agentId: null, cwd: root, root, toolName: null, edits: [], isShell: false, stopHookActive: false, ...extra }, engine);
  const edit = (file: string, extra: Partial<HookInput> = {}) => call('pre-edit', { toolName: 'Write', edits: [{ path: path.join(root, file), content: 'x' }], ...extra });
  const read = (extra: Partial<HookInput> = {}) => call('pre-tool', { toolName: 'Read', ...extra });
  return { root, engine, call, edit, read };
}

const context = (fresh: Violation[], old: Violation[] = [], resolved: Violation[] = []): HookDecision => ({ kind: 'context', text: renderPending({ fresh, old, resolved }) });
const SILENT = { kind: 'silent' };

describe('the pending list', () => {
  it('shows a new violation in full, then as a reminder, then once as resolved, then nothing', async () => {
    const { edit, read } = setup({ edits: { 'src/a.ts': [A], 'src/fix.ts': [] } });
    expect(await edit('src/a.ts')).toEqual(context([A]));
    expect(await read()).toEqual(context([], [A]));
    expect(await edit('src/fix.ts')).toEqual(context([], [], [A]));
    expect(await read()).toEqual(SILENT);
  });

  it('is silent with nothing pending, without asking the engine', async () => {
    const { read, engine } = setup();
    expect(await read()).toEqual(SILENT);
    expect(engine.calls).toEqual([]);
  });

  it('drops a violation that a shell command fixed, on the next tool call', async () => {
    const { edit, read, engine } = setup({ edits: { 'src/a.ts': [A, B] } });
    await edit('src/a.ts');
    engine.set([B]);
    expect(await read()).toEqual(context([], [B], [A]));
  });

  it('says under the header that the list may be partial after a shell command, until the stop checks every file', async () => {
    const { edit, read, call, engine } = setup({ edits: { 'src/a.ts': [A, B] } });
    await edit('src/a.ts');
    // The shell call itself shows the list as it was before the command runs.
    expect(await read({ toolName: 'Bash', isShell: true })).toEqual(context([], [A, B]));
    engine.set([B]);
    const partial = (d: HookDecision) => (d.kind === 'context' ? d.text.replace(/\n|$/, (end) => `\n${SHELL_NOTE}${end}`) : '');
    expect(await read()).toEqual({ kind: 'context', text: partial(context([], [B], [A])) });
    expect(await edit('src/a.ts')).toMatchObject({ kind: 'context', text: expect.stringContaining(SHELL_NOTE) });
    await call('stop');
    const after = await read();
    expect(after.kind).toBe('context');
    expect(after.kind === 'context' && after.text).not.toContain(SHELL_NOTE);
  });

  it('treats an edit with unknown content as a tool call that changes files', async () => {
    const { call, engine } = setup();
    expect(await call('pre-edit', { toolName: 'NotebookEdit', edits: [{ path: 'a.ipynb' }] })).toEqual(SILENT);
    expect(engine.calls).toEqual([]);
    engine.set([A]);
    expect(await call('stop')).toEqual({ kind: 'block', text: renderStop([A]) });
  });

  it('shows every pending violation in full again after a compaction', async () => {
    const { edit, read, call } = setup({ edits: { 'src/a.ts': [A, B] } });
    await edit('src/a.ts');
    expect(await read()).toEqual(context([], [A, B]));
    expect(await call('post-compact')).toEqual(SILENT);
    expect(await read()).toEqual(context([A, B]));
    expect(await read()).toEqual(context([], [A, B]));
  });

  it('keeps a separate list for a subagent, and the main session checks at its stop', async () => {
    const { edit, read, call } = setup({ edits: { 'src/a.ts': [A] } });
    expect(await edit('src/a.ts', { agentId: 'sub1' })).toEqual(context([A]));
    expect(await read()).toEqual(SILENT);
    expect(await read({ agentId: 'sub1' })).toEqual(context([], [A]));
    expect(await call('subagent-stop', { agentId: 'sub1' })).toEqual({ kind: 'block', text: renderStop([A]) });
    expect(await call('stop')).toEqual({ kind: 'block', text: renderStop([A]) });
  });

  it('without a session id, shows everything in full every time and writes no state', async () => {
    const { root, edit, call } = setup({ edits: { 'src/a.ts': [A] } });
    expect(await edit('src/a.ts', { sessionId: null })).toEqual(context([A]));
    expect(await edit('src/a.ts', { sessionId: null })).toEqual(context([A]));
    expect(await call('stop', { sessionId: null })).toEqual({ kind: 'block', text: renderStop([A]) });
    expect(await call('stop', { sessionId: null, stopHookActive: true })).toEqual(SILENT);
    expect(existsSync(path.join(root, '.buckets'))).toBe(false);
  });

  it('keeps no memory for a session id that could leave the sessions folder', async () => {
    const { root, edit } = setup({ edits: { 'src/a.ts': [A] } });
    expect(await edit('src/a.ts', { sessionId: '../x' })).toEqual(context([A]));
    expect(await edit('src/a.ts', { sessionId: '../x' })).toEqual(context([A]));
    expect(existsSync(path.join(root, '.buckets'))).toBe(false);
  });

  it('writes no state through a .buckets junction and stays silent', async () => {
    const { root, edit, read } = setup({ edits: { 'src/fix.ts': [] } });
    const outside = makeProject({}, false);
    symlinkSync(outside, path.join(root, '.buckets'), 'junction');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await edit('src/fix.ts')).toEqual(SILENT);
      expect(await read()).toEqual(SILENT);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe('pre-edit deny', () => {
  it('denies an edit that makes the config invalid and leaves the session as it was', async () => {
    const { root, edit, read } = setup({ edits: { 'src/a.ts': [A], 'buckets.config.json': [BAD, A] } });
    await edit('src/a.ts');
    const before = loadSession(sessionRef(root, 's1'));
    expect(await edit('buckets.config.json')).toEqual({ kind: 'deny', text: renderInterrupt([BAD]) });
    expect(loadSession(sessionRef(root, 's1'))).toEqual(before);
    expect(await read()).toEqual(context([], [A]));
  });

  it('after the tool (applied), says the config is now invalid as context and keeps it pending', async () => {
    const { edit, read, call, engine } = setup({ edits: { 'buckets.config.json': [BAD] } });
    expect(await edit('buckets.config.json', { applied: true })).toEqual({ kind: 'context', text: renderInterrupt([BAD], { applied: true }) });
    // The fake engine keeps a config-invalid edit off its disk state; this one landed.
    engine.set([BAD]);
    expect(await read()).toEqual(context([], [BAD]));
    expect(await call('stop')).toEqual({ kind: 'block', text: renderStop([BAD]) });
  });

  it('lets an edit of another file through when the config on disk is already invalid, and keeps the problem pending', async () => {
    const { edit, read, engine } = setup({ violations: [BAD] });
    expect(await edit('src/a.ts')).toEqual(context([BAD]));
    expect(engine.calls.map((c) => c.method)).toEqual(['checkEdit']);
    expect(await read()).toEqual(context([], [BAD]));
  });

  it('lets a config edit through that fixes one of two problems, and denies one that adds a problem', async () => {
    const { edit, engine } = setup({ violations: [BAD, BAD2], edits: { 'buckets.config.json': [BAD] } });
    expect(await edit('buckets.config.json')).toEqual(context([BAD]));
    engine.set([BAD]);
    const worse = setup({ violations: [BAD], edits: { 'buckets.config.json': [BAD, BAD2] } });
    expect(await worse.edit('buckets.config.json')).toEqual({ kind: 'deny', text: renderInterrupt([BAD, BAD2]) });
  });

  it('drops edits of files outside the project before anything else', async () => {
    const { root, call, engine } = setup({ edits: { 'src/a.ts': [A] } });
    const outside = path.join(path.dirname(root), 'other', 'a.ts');
    for (const file of [outside, '\\\\host\\share\\a.ts', '//host/share/a.ts']) {
      expect(await call('pre-edit', { toolName: 'Write', edits: [{ path: file, content: 'x' }] })).toEqual(SILENT);
    }
    expect(engine.calls).toEqual([]);
  });
});

describe('stop', () => {
  it('is silent for a session that changed nothing, without running the check', async () => {
    const { call, engine } = setup({ violations: [A] });
    expect(await call('stop')).toEqual(SILENT);
    expect(engine.calls).toEqual([]);
  });

  it('blocks once, not again with stop_hook_active, and not again for the same list', async () => {
    const { edit, call } = setup({ edits: { 'src/a.ts': [A], 'src/b.ts': [A, B] } });
    await edit('src/a.ts');
    expect(await call('stop')).toEqual({ kind: 'block', text: renderStop([A]) });
    expect(await call('stop', { stopHookActive: true })).toEqual(SILENT);
    expect(await call('stop')).toEqual(SILENT);
    await edit('src/b.ts');
    expect(await call('stop')).toEqual({ kind: 'block', text: renderStop([A, B]) });
  });

  it('runs after a shell command, which marks the session dirty', async () => {
    const { call, engine } = setup();
    expect(await call('pre-tool', { toolName: 'Bash', isShell: true })).toEqual(SILENT);
    engine.set([B]);
    expect(await call('stop')).toEqual({ kind: 'block', text: renderStop([B]) });
  });

  it('is silent when the check passes', async () => {
    const { edit, call } = setup({ edits: { 'src/a.ts': [] } });
    await edit('src/a.ts');
    expect(await call('stop')).toEqual(SILENT);
  });

  it('reports an environment error once in the block text', async () => {
    const { call } = setup({ environment: [{ code: 'no-config', project: '.', message: 'Run buckets init.' }] });
    await call('pre-tool', { toolName: 'Bash', isShell: true });
    expect(await call('stop')).toEqual({ kind: 'block', text: 'buckets: cannot check (no-config): Run buckets init.' });
    await call('pre-tool', { toolName: 'Read' });
    expect(await call('stop')).toEqual(SILENT);
  });
});

describe('obligations of R2', () => {
  const NEWER = { code: 'config-newer' as const, project: '.', message: 'buckets.config.json has version "2.9".' };

  it('shows config-newer once as context, never denies an edit for it and never blocks a stop for it', async () => {
    const { edit, call } = setup({ environment: [NEWER] });
    expect(await edit('buckets.config.json')).toEqual({ kind: 'context', text: `buckets: ${renderEnvironment(NEWER)}` });
    expect(await edit('src/a.ts')).toEqual(SILENT);
    expect(await call('stop')).toEqual(SILENT);
  });

  it('denies a rename edit with the bucket-renamed problem', async () => {
    const renamed: Violation = { rule: 'config-invalid', project: '.', problem: { kind: 'bucket-renamed', from: 'billing', to: 'invoicing', referencedBy: ['api'] } };
    const { edit } = setup({ edits: { 'buckets.config.json': [renamed] } });
    const decision = await edit('buckets.config.json');
    expect(decision).toEqual({ kind: 'deny', text: renderInterrupt([renamed as never]) });
    expect(decision.kind === 'deny' && decision.text).toContain('invoicing');
  });

  it('passes the advice to a blocking stop, marks a list left at an earlier stop as repeated, and never blocks for advice alone', async () => {
    const advice = [ADVICE_SAMPLES['reason-generic']];
    const { edit, call, engine } = setup({ advice, edits: { 'src/a.ts': [A], 'src/b.ts': [A], 'src/c.ts': [] } });
    await edit('src/a.ts');
    expect(await call('stop')).toEqual({ kind: 'block', text: renderStop([A], { advice, repeated: false }) });
    expect(await call('stop', { stopHookActive: true })).toEqual(SILENT);
    // The next turn edits again and stops with the same list.
    await edit('src/b.ts');
    expect(await call('stop')).toEqual({ kind: 'block', text: renderStop([A], { advice, repeated: true }) });
    await edit('src/c.ts');
    engine.set([]);
    expect(await call('stop')).toEqual(SILENT);
  });

  it('notes once, without blocking, the advice on a reason the session wrote, and not the advice the config had before', async () => {
    const advice = [ADVICE_SAMPLES['reason-generic']];
    const weak = JSON.stringify({ buckets: { billing: { dependsOn: { log: 'Uses log' } }, log: {} } });
    const fresh = setup({ advice });
    await fresh.read();
    writeFileSync(path.join(fresh.root, 'buckets.config.json'), weak);
    await fresh.edit('src/a.ts');
    expect(await fresh.call('stop')).toEqual({ kind: 'note', text: [adviceHeader(1), renderAdvice(advice[0]!)].join('\n\n') });
    await fresh.edit('src/a.ts');
    expect(await fresh.call('stop')).toEqual(SILENT);

    const old = setup({ advice });
    writeFileSync(path.join(old.root, 'buckets.config.json'), weak);
    await old.read();
    await old.edit('src/a.ts');
    expect(await old.call('stop')).toEqual(SILENT);
  });

  it('shows once, after the pending list of the next pre-tool, the advice on a reason a config edit wrote', async () => {
    const advice = [ADVICE_SAMPLES['reason-generic']];
    const config = (log: string) => JSON.stringify({ buckets: { billing: { purpose: 'Bills', dependsOn: { log: 'Uses log' } }, log: { purpose: log } } });
    const { root, edit, read, call, engine } = setup({ advice, edits: { 'src/a.ts': [A] } });
    // The config already has advice on billing.purpose when the session first sees it, so only the new reason shows.
    writeFileSync(path.join(root, 'buckets.config.json'), JSON.stringify({ buckets: { billing: { purpose: 'Bills' }, log: { purpose: 'Writes the logs' } } }));
    expect(await edit('src/a.ts')).toEqual(context([A]));
    const writeConfig = async (text: string) => {
      const decision = await call('pre-edit', { toolName: 'Edit', edits: [{ path: path.join(root, 'buckets.config.json'), content: text }] });
      writeFileSync(path.join(root, 'buckets.config.json'), text);
      return decision;
    };
    // The edit has not landed when its own pre-edit runs, so the advice waits for the next call.
    expect(await writeConfig(config('Writes the logs'))).toEqual(context([], [A]));
    expect(await read()).toEqual({ kind: 'context', text: [renderPending({ fresh: [], old: [A], resolved: [] }), renderAdviceNote(advice)].join('\n\n') });
    expect(await read()).toEqual(context([], [A]));
    // An edit that writes no weak text adds nothing.
    await writeConfig(config('Formats and writes the application logs'));
    expect(await read()).toEqual(context([], [A]));
    // The clean stop still notes the advice for the user.
    engine.set([]);
    expect(await call('stop')).toEqual({ kind: 'note', text: renderAdviceNote(advice) });
  });

  it('checks a project again when its config changed on disk, even with nothing pending', async () => {
    const { root, read, engine } = setup();
    expect(await read()).toEqual(SILENT);
    expect(engine.calls).toEqual([]);
    engine.set([B]);
    // Another agent rewrites the config: a different size is enough.
    writeFileSync(path.join(root, 'buckets.config.json'), '{ "buckets": {}, "ignore": [] }\n');
    expect(await read()).toEqual(context([B]));
    expect(engine.calls.map((c) => c.method)).toEqual(['checkAll']);
    expect(await read()).toEqual(context([], [B]));
    expect(engine.calls.map((c) => c.method)).toEqual(['checkAll', 'recheck']);
  });

  it('takes its own config edit without a check, and sees another agent overwrite the config right after it', async () => {
    const { root, read, edit, engine } = setup();
    const file = path.join(root, 'buckets.config.json');
    const mine = '{ "buckets": {}, "ignore": ["dist/**"] }\n';
    await read();
    await edit('buckets.config.json', { edits: [{ path: file, content: mine }] });
    writeFileSync(file, mine);
    expect(await read()).toEqual(SILENT);
    expect(engine.calls.map((c) => c.method)).toEqual(['checkEdit']);

    await edit('buckets.config.json', { edits: [{ path: file, content: mine.replace('dist', 'out') }] });
    writeFileSync(file, mine.replace('dist', 'out'));
    engine.set([B]);
    // Another agent writes its own config before this session's next call.
    writeFileSync(file, '{ "buckets": {}, "ignore": ["tmp/**"] }\n');
    expect(await read()).toEqual(context([B]));
    expect(engine.calls.map((c) => c.method)).toEqual(['checkEdit', 'checkEdit', 'checkAll']);
  });

  it('checks an edit in the project of the nearest config, for a session at a root without one', async () => {
    const root = makeProject({ 'cli/buckets.config.json': '{}\n', 'packages/x/buckets.config.json': '{}\n' }, false);
    const engine = createFakeEngine({ edits: { 'src/a.ts': [A] } });
    const base: HookInput = { phase: 'pre-edit', sessionId: 's1', agentId: null, cwd: root, root, toolName: 'Write', edits: [], isShell: false, stopHookActive: false };
    const inCli = { ...A, project: 'cli' };
    const inX = { ...A, project: 'packages/x' };
    expect(await hookCore({ ...base, edits: [{ path: path.join(root, 'cli', 'src', 'a.ts'), content: 'x' }] }, engine)).toEqual(context([inCli]));
    expect(engine.calls[0]).toMatchObject({ method: 'checkEdit', root: path.join(root, 'cli') });
    expect(await hookCore({ ...base, edits: [{ path: path.join(root, 'packages', 'x', 'src', 'a.ts'), content: 'x' }] }, engine)).toEqual(context([inX], [inCli]));
    expect(await hookCore({ ...base, phase: 'pre-tool', toolName: 'Read' }, engine)).toEqual(context([], [inCli, inX]));
    expect(engine.calls.filter((c) => c.method === 'recheck').map((c) => c.root).sort()).toEqual([path.join(root, 'cli'), path.join(root, 'packages', 'x')]);
    expect(await hookCore({ ...base, phase: 'stop', toolName: null }, engine)).toEqual({ kind: 'block', text: renderStop([inCli, inX], { advice: [], repeated: false }) });
    expect(engine.calls.filter((c) => c.method === 'checkAll').map((c) => c.root)).toEqual([path.join(root, 'cli'), path.join(root, 'packages', 'x')]);
    // A file in no project changes nothing the check sees.
    expect(await hookCore({ ...base, edits: [{ path: path.join(root, 'README.md'), content: 'x' }] }, engine)).toEqual(context([], [inCli, inX]));
  });
});

describe('fail open', () => {
  it('turns an engine error into silence and the error on stderr', async () => {
    const root = makeProject({});
    const broken: RuleEngine = { ...createFakeEngine(), checkAll: () => Promise.reject(new Error('boom')) };
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const input: HookInput = { phase: 'stop', sessionId: null, agentId: null, cwd: root, root, toolName: null, edits: [], isShell: false, stopHookActive: false };
      expect(await hookCore(input, broken)).toEqual(SILENT);
      expect(write).toHaveBeenCalledWith(expect.stringMatching(/^buckets hook stop: unexpected error: Error: boom\n {4}at /));
    } finally {
      write.mockRestore();
    }
  });
});
