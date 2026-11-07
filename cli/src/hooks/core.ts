// The hook core of slopbuckets 2.0, for any agent harness. An adapter parses the harness payload into a HookInput,
// calls hookCore with the rule engine and prints the HookDecision in the harness format. Nothing here reads stdin,
// writes stdout or knows a tool name.
//
// pre-edit simulates the edit and shows the pending list, or denies an edit that makes a config worse. pre-tool shows
// the last pending list, rechecked against the disk, and checks a project again when its buckets.config.json changed.
// After an edit of a config, the next pre-edit or pre-tool also shows once the reason-generic advice on what it wrote.
// stop and subagent-stop run the full check and block once. post-compact forgets what was shown. The session state
// lives in <root>/.buckets/sessions/ (./session.ts).
//
// A session can span several projects, such as a monorepo opened at its root. Each edited file belongs to the project
// of the nearest buckets.config.json at or above it, inside the session root, and the engine checks that project from
// its own folder. Every violation, environment error and advice then carries its project relative to the session root.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  CONFIG_FILE,
  reasonAdvice,
  renderAdviceNote,
  renderEnvironment,
  renderInterrupt,
  renderPending,
  renderStop,
  sortAdvice,
  sortViolations,
  violationKey,
  type Advice,
  type AdviceOf,
  type CheckResult,
  type ConfigInvalidViolation,
  type ConfigPath,
  type EnvironmentError,
  type FileEdit,
  type HookCore,
  type HookDecision,
  type HookInput,
  type RuleEngine,
  type Violation,
} from '../contract/index.js';
import { unexpectedError } from '../output/index.js';
import { isRecord, parseJson } from '../files/index.js';
import { projectPath } from './edit-text.js';
import { advance, environmentKey, loadSession, markSessionDirty, resetShown, saveSession, sessionRef, type HookState, type SessionRef } from './session.js';

const SILENT: HookDecision = { kind: 'silent' };

// ---------------------------------------------------------------------------------------------------------------
// Projects inside the session root. A project is named by its folder relative to the root, with `/`, `.` for the root.

function join(project: string, inner: string): string {
  if (project === '.') return inner;
  return inner === '.' ? project : `${project}/${inner}`;
}

function under(project: string, inner: string): boolean {
  return project === '.' || inner === project || inner.startsWith(`${project}/`);
}

function folder(root: string, project: string): string {
  return project === '.' ? root : path.join(root, ...project.split('/'));
}

function isConfig(file: string): boolean {
  return path.basename(file).toLowerCase() === CONFIG_FILE;
}

/** The project of a file: the nearest folder at or above it, inside `root`, with a config. An edited config is one. */
function projectOf(root: string, file: string): string | null {
  const abs = path.resolve(root, file);
  let dir = path.dirname(abs);
  for (;;) {
    const rel = path.relative(root, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if ((dir === path.dirname(abs) && isConfig(abs)) || existsSync(path.join(dir, CONFIG_FILE))) return rel === '' ? '.' : rel.split(path.sep).join('/');
    if (rel === '') return null;
    dir = path.dirname(dir);
  }
}

/** The mtime and size of a project's config, so that a change by another agent or a shell shows. */
function configStamp(root: string, project: string): string {
  try {
    const stat = statSync(path.join(folder(root, project), CONFIG_FILE));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

type ReasonAdvice = AdviceOf<'reason-generic'>;

/** The id of one purpose or reason with its text, for HookState.adviceSeen and HookState.adviceShown. */
function reasonAdviceKey(at: ConfigPath, text: string): string {
  return createHash('sha256').update(JSON.stringify([at, text])).digest('hex').slice(0, 16);
}

/**
 * The reason-generic advice on every purpose and reason in a project's config on disk, read the way the engine reads
 * them (engine/rules.ts, computeAdvice), with `project` relative to the session root. None when the config is missing
 * or not JSON.
 */
function configAdvice(root: string, project: string): ReasonAdvice[] {
  let value: unknown;
  try {
    value = parseJson(readFileSync(path.join(folder(root, project), CONFIG_FILE), 'utf8'));
  } catch {
    return [];
  }
  if (!isRecord(value) || !isRecord(value.buckets)) return [];
  const names = Object.keys(value.buckets);
  const out: ReasonAdvice[] = [];
  const check = (at: ConfigPath, text: unknown): void => {
    const why = typeof text === 'string' ? reasonAdvice(text, names) : null;
    if (why !== null) out.push({ advice: 'reason-generic', project, at, text: text as string, why });
  };
  for (const [name, bucket] of Object.entries(value.buckets)) {
    if (!isRecord(bucket)) continue;
    check(['buckets', name, 'purpose'], bucket.purpose);
    for (const field of ['dependsOn', 'packages'] as const) {
      const map = bucket[field];
      if (isRecord(map)) for (const [key, reason] of Object.entries(map)) check(['buckets', name, field, key], reason);
    }
    check(['buckets', name, 'external'], bucket.external);
  }
  return out;
}

function adviceKeyOf(a: ReasonAdvice): string {
  return reasonAdviceKey(a.at, a.text);
}

/** `state` with the advice baseline of every project in `projects` that has none yet. */
function withAdviceBaseline(root: string, state: HookState, projects: readonly string[]): HookState {
  const missing = projects.filter((p) => state.adviceSeen[p] === undefined);
  if (missing.length === 0) return state;
  return { ...state, adviceSeen: { ...state.adviceSeen, ...Object.fromEntries(missing.map((p) => [p, configAdvice(root, p).map(adviceKeyOf)])) } };
}

/**
 * The reason-generic advice that the configs of `projects` on disk have now and that is neither in the baseline of the
 * project nor shown by an earlier pre-tool, with `state` that counts it as shown. A project without a baseline gets none,
 * as at the stop. The pre-tool after an edit of a config calls it, so the agent reads the advice on what it wrote.
 */
function freshAdvice(root: string, state: HookState, projects: readonly string[]): { advice: Advice[]; state: HookState } {
  const advice: Advice[] = [];
  const adviceShown = { ...state.adviceShown };
  for (const p of projects) {
    const seen = state.adviceSeen[p];
    if (seen === undefined) continue;
    const old = new Set([...seen, ...(adviceShown[p] ?? [])]);
    const found = configAdvice(root, p).filter((a) => !old.has(adviceKeyOf(a)));
    if (found.length === 0) continue;
    advice.push(...found);
    adviceShown[p] = [...(adviceShown[p] ?? []), ...found.map(adviceKeyOf)];
  }
  return advice.length === 0 ? { advice, state } : { advice, state: { ...state, adviceShown } };
}

/** Marks a HookState.configs entry that holds the hash of the config text an edit of this session wrote. */
const WRITTEN = 'written:';

/** The WRITTEN stamp of a config text, or `missing` for a deleted config, as configStamp names a missing one. */
function writtenStamp(content: string | null): string {
  return content === null ? 'missing' : `${WRITTEN}${createHash('sha256').update(content).digest('hex').slice(0, 32)}`;
}

/** The WRITTEN stamp of a project's config on disk now. */
function diskWrittenStamp(root: string, project: string): string {
  try {
    return writtenStamp(readFileSync(path.join(folder(root, project), CONFIG_FILE), 'utf8'));
  } catch {
    return 'missing';
  }
}

/**
 * True when the config of `project` changed since the hook last saw it. After an edit of this session the stamp is the
 * hash of the text the edit wrote, so another agent that overwrites the config right after it still shows. A project
 * seen for the first time, or with the null of an older state, only gets its stamp.
 */
function configChanged(root: string, project: string, seen: string | null | undefined, stamp: string): boolean {
  if (typeof seen !== 'string') return false;
  return seen.startsWith(WRITTEN) ? seen !== diskWrittenStamp(root, project) : seen !== stamp;
}

/** The projects the session knows: the root when it has a config, and every project it checked. Shortest first. */
function knownProjects(root: string, state: HookState): string[] {
  const set = new Set(Object.keys(state.configs));
  if (existsSync(path.join(root, CONFIG_FILE))) set.add('.');
  return [...set].sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a.split('/').length - b.split('/').length || a.localeCompare(b)));
}

/** A result of the engine run in `project`, with every project relative to the session root. */
function rooted(project: string, result: CheckResult): CheckResult {
  if (project === '.') return result;
  return {
    ...result,
    violations: result.violations.map((v) => ({ ...v, project: join(project, v.project) }) as Violation),
    environment: result.environment.map((e) => ({ ...e, project: join(project, e.project) })),
    advice: result.advice.map((a) => ({ ...a, project: join(project, a.project) }) as Advice),
    projects: result.projects.map((p) => join(project, p)),
  };
}

/** `list` with the violations of the projects `result` covers replaced by the ones it found. */
function merge(list: readonly Violation[], result: CheckResult, found: readonly Violation[] = result.violations): Violation[] {
  const covered = new Set(result.projects);
  return sortViolations([...list.filter((v) => !covered.has(v.project)), ...found]);
}

/** Rechecks each violation from the folder of the deepest known project that holds it. */
async function recheckAll(engine: RuleEngine, root: string, projects: readonly string[], list: readonly Violation[]): Promise<Violation[]> {
  const groups = new Map<string, Violation[]>();
  for (const v of list) {
    const owner = [...projects].reverse().find((p) => under(p, v.project)) ?? '.';
    groups.set(owner, [...(groups.get(owner) ?? []), v]);
  }
  const out: Violation[] = [];
  for (const [project, group] of groups) {
    const local = group.map((v) => ({ ...v, project: v.project === project ? '.' : project === '.' ? v.project : v.project.slice(project.length + 1) }) as Violation);
    out.push(...(await engine.recheck(folder(root, project), local)).map((v) => ({ ...v, project: join(project, v.project) }) as Violation));
  }
  return groups.size > 1 ? sortViolations(out) : out;
}

// ---------------------------------------------------------------------------------------------------------------
// Phases

/** The edits of a pre-edit input when every one has known content, else null. */
function knownEdits(input: HookInput): FileEdit[] | null {
  if (input.edits.length === 0 || input.edits.some((e) => e.content === undefined)) return null;
  return input.edits.map((e) => ({ path: e.path, content: e.content as string | null }));
}

function configInvalid(violations: readonly Violation[]): ConfigInvalidViolation[] {
  return violations.filter((v): v is ConfigInvalidViolation => v.rule === 'config-invalid');
}

function environmentLine(e: EnvironmentError): string {
  return `buckets: ${renderEnvironment(e)}`;
}

/** `state` after showing `current`: fresh violations count as shown, gone ones leave. */
function advanced(state: HookState, current: readonly Violation[]): HookState {
  return { ...state, ...advance(state, current).next };
}

/**
 * The line under the pending header after a shell command. A full check of a 10,000-file project takes about 150 ms,
 * over the 80 ms of a pre-tool call, so until the stop the hooks recheck only the pending files, and pre-edit the
 * folders of the edit.
 */
export const SHELL_NOTE = 'A shell command ran since the last full check, so this list may miss problems it caused. The stop at the end of the turn checks every file.';

/**
 * Shows `current` against the session state, and every environment error not shown yet in this session, saves the new
 * state and returns the context or silence. `partial` adds SHELL_NOTE under the header of a list it shows. `advice`
 * goes last, under its own header, which says that it does not block.
 */
function show(
  ref: SessionRef,
  state: HookState,
  current: readonly Violation[],
  environment: readonly EnvironmentError[] = [],
  partial = false,
  advice: readonly Advice[] = [],
): HookDecision {
  const { diff } = advance(state, current);
  const fresh = environment.filter((e) => !state.environmentShown.includes(environmentKey(e)));
  const next = advanced(state, current);
  saveSession(ref, fresh.length === 0 ? next : { ...next, environmentShown: [...next.environmentShown, ...fresh.map(environmentKey)] });
  const pending = renderPending(diff);
  const list = partial && pending !== '' ? pending.replace(/\n|$/, (end) => `\n${SHELL_NOTE}${end}`) : pending;
  const text = [list, ...fresh.map(environmentLine), renderAdviceNote(advice)].filter((part) => part !== '').join('\n\n');
  return text === '' ? SILENT : { kind: 'context', text };
}

/** A tool may change files: this session, and the main session of a subagent, must check at the next stop. */
function dirtied(input: HookInput, state: HookState): HookState {
  if (input.agentId !== null) markSessionDirty(sessionRef(input.root, input.sessionId));
  return { ...state, dirty: true, stopBlocked: false };
}

/**
 * Shows the pending list rechecked against the disk. A project whose config changed since the hook last saw it, by
 * another agent or a shell command, is checked again in full, even when nothing is pending. After an edit of a config
 * or a change on disk, the list also shows once the reason-generic advice on purposes and reasons that are new.
 */
async function onPreTool(input: HookInput, engine: RuleEngine, ref: SessionRef, state: HookState, changesFiles: boolean): Promise<HookDecision> {
  if (changesFiles) state = dirtied(input, state);
  // This call runs before its own shell command, so its list is as complete as before; the next ones are not.
  const shellRan = state.shellRan;
  if (input.isShell) state = { ...state, shellRan: true };
  const projects = knownProjects(input.root, state);
  const stamps = Object.fromEntries(projects.map((p) => [p, configStamp(input.root, p)]));
  const changed = projects.filter((p) => configChanged(input.root, p, state.configs[p], stamps[p]!));
  const restamped = projects.some((p) => state.configs[p] !== stamps[p]);
  const touched = projects.filter((p) => changed.includes(p) || state.configs[p]?.startsWith(WRITTEN) === true);
  const fresh = freshAdvice(input.root, withAdviceBaseline(input.root, state, projects), touched);
  state = { ...fresh.state, configs: { ...state.configs, ...stamps } };
  if (state.pending.length === 0 && changed.length === 0 && fresh.advice.length === 0) {
    if (changesFiles || restamped) saveSession(ref, state);
    return SILENT;
  }
  let current: Violation[] = [];
  const environment: EnvironmentError[] = [];
  const covered = new Set<string>();
  for (const project of changed) {
    const result = rooted(project, await engine.checkAll(folder(input.root, project), { recursive: false }));
    for (const p of result.projects) covered.add(p);
    current.push(...result.violations);
    environment.push(...result.environment);
  }
  const rechecked = await recheckAll(engine, input.root, projects, state.pending.filter((v) => !covered.has(v.project)));
  current = changed.length === 0 ? rechecked : sortViolations([...rechecked, ...current]);
  return show(ref, state, current, environment, shellRan && projects.some((p) => !covered.has(p)), fresh.advice);
}

/**
 * The deny reason when the edits make a config worse than it is on disk: a config problem that was not there, or more
 * of them. When a config is already invalid (a shell command, a checkout or a merge broke it), only an edit that adds a
 * problem is denied, so the agent can edit other files and fix the config one problem at a time; its problems show in
 * the pending list.
 */
async function worseConfig(engine: RuleEngine, root: string, project: string, after: ConfigInvalidViolation[]): Promise<string | undefined> {
  if (after.length === 0) return undefined;
  const before = new Set(configInvalid(rooted(project, await engine.checkEdit(folder(root, project), [])).violations).map(violationKey));
  const added = after.filter((v) => !before.has(violationKey(v)));
  if (added.length === 0 && after.length <= before.size) return undefined;
  const bad = (added[0] ?? after[0]!).project;
  return renderInterrupt(after.filter((v) => v.project === bad));
}

async function onPreEdit(input: HookInput, engine: RuleEngine, ref: SessionRef, state: HookState): Promise<HookDecision> {
  const edits = knownEdits(input);
  // An edit whose new content is unknown still changes the file.
  if (edits === null) return onPreTool(input, engine, ref, state, input.edits.length > 0);
  const groups = new Map<string, FileEdit[]>();
  for (const edit of edits) {
    const project = projectOf(input.root, edit.path);
    if (project !== null) groups.set(project, [...(groups.get(project) ?? []), edit]);
  }
  // A file outside every project changes nothing the check sees.
  if (groups.size === 0) return onPreTool(input, engine, ref, state, true);
  // The advice baseline comes from the config on disk before the edit lands. An earlier config edit that no pre-tool
  // followed has landed by now, so its advice shows here.
  const written = Object.keys(state.configs).filter((p) => state.configs[p]?.startsWith(WRITTEN) === true);
  const fresh = freshAdvice(input.root, withAdviceBaseline(input.root, state, [...groups.keys()]), written);
  state = fresh.state;
  let pending = state.pending;
  const environment: EnvironmentError[] = [];
  const configs = { ...state.configs };
  for (const [project, list] of groups) {
    const result = rooted(project, await engine.checkEdit(folder(input.root, project), list));
    const after = configInvalid(result.violations);
    const configEdit = list.find((e) => isConfig(e.path));
    const editsConfig = configEdit !== undefined;
    // The edit changes the stamp of the config, so the next pre-tool compares the text on disk with what it wrote.
    configs[project] = configEdit !== undefined ? writtenStamp(configEdit.content) : configStamp(input.root, project);
    if (input.applied === true && after.length > 0 && editsConfig) {
      // The edit already landed: the config on disk is invalid now, and later calls recheck it.
      const bad = after.filter((v) => v.project === after[0]!.project);
      saveSession(ref, advanced({ ...dirtied(input, state), configs }, merge(pending, result, bad)));
      return { kind: 'context', text: [renderInterrupt(bad, { applied: true }), renderAdviceNote(fresh.advice)].filter((part) => part !== '').join('\n\n') };
    }
    const reason = input.applied === true || !editsConfig ? undefined : await worseConfig(engine, input.root, project, after);
    // A denied edit does not land, so the session state stays as it was.
    if (reason !== undefined) return { kind: 'deny', text: reason };
    pending = merge(pending, result);
    environment.push(...result.environment);
  }
  return show(ref, { ...dirtied(input, state), configs }, pending, environment, state.shellRan, fresh.advice);
}

function sameKeys(a: readonly Violation[], b: readonly Violation[]): boolean {
  const left = a.map(violationKey).sort();
  const right = b.map(violationKey).sort();
  return left.length === right.length && left.every((key, i) => key === right[i]);
}

/** checkAll of the root and of every project the session checked that the root does not cover. */
async function checkSession(engine: RuleEngine, root: string, projects: readonly string[]): Promise<CheckResult> {
  const violations: Violation[] = [];
  const environment: EnvironmentError[] = [];
  const advice: Advice[] = [];
  const covered: string[] = [];
  for (const project of projects) {
    if (covered.includes(project)) continue;
    const result = rooted(project, await engine.checkAll(folder(root, project)));
    violations.push(...result.violations);
    environment.push(...result.environment);
    advice.push(...result.advice);
    covered.push(...result.projects);
  }
  return { exitCode: 0, violations: sortViolations(violations), environment, advice: sortAdvice(advice), projects: covered };
}

async function onStop(input: HookInput, engine: RuleEngine, ref: SessionRef, state: HookState): Promise<HookDecision> {
  if (!state.dirty && state.pending.length === 0) return SILENT;
  const projects = knownProjects(input.root, state);
  const result = await checkSession(engine, input.root, projects);
  const list = result.violations;
  // config-newer means the CLI is older than the config. It never blocks: updating the CLI is the human's call.
  const blocking = result.environment.filter((e) => e.code !== 'config-newer');
  // The reason-generic advice on a purpose or reason this session wrote: not in the baseline of a project it knew.
  const flagged = new Map<string, string[]>();
  for (const a of result.advice) if (a.advice === 'reason-generic') flagged.set(a.project, [...(flagged.get(a.project) ?? []), reasonAdviceKey(a.at, a.text)]);
  const caused = result.advice.filter((a) => a.advice === 'reason-generic' && state.adviceSeen[a.project]?.includes(reasonAdviceKey(a.at, a.text)) === false);
  // Every stop shows that advice or passes it, so the advice the config has now becomes the baseline.
  const adviceSeen = Object.fromEntries(Object.keys(state.adviceSeen).map((p) => [p, flagged.get(p) ?? []]));
  // Stop shows every violation in full, so all of them count as shown.
  const base = { ...advanced(state, list), configs: { ...state.configs, ...Object.fromEntries(projects.map((p) => [p, configStamp(input.root, p)])) }, adviceSeen, adviceShown: {}, dirty: false, shellRan: false };
  const nothing = list.length === 0 && blocking.length === 0;
  const repeat = input.stopHookActive || (state.stopBlocked && sameKeys(state.pending, list));
  if (nothing || repeat) {
    const stopBlocked = nothing ? false : state.stopBlocked || input.stopHookActive;
    saveSession(ref, { ...base, stopBlocked, stopKeys: list.length === 0 ? [] : state.stopKeys }, { clearDirty: true });
    // A clean stop does not block, but it shows once the advice on what this session wrote, which no check showed yet.
    if (nothing && caused.length > 0) return { kind: 'note', text: renderAdviceNote(caused) };
    return SILENT;
  }
  const keys = list.map(violationKey);
  const repeated = keys.length > 0 && keys.every((key) => state.stopKeys.includes(key));
  const shown = [...new Set([...state.environmentShown, ...result.environment.map(environmentKey)])];
  saveSession(ref, { ...base, stopBlocked: true, stopKeys: keys, environmentShown: shown }, { clearDirty: true });
  const parts = list.length > 0 ? [renderStop(list, { advice: result.advice, repeated })] : [];
  parts.push(...result.environment.map(environmentLine));
  return { kind: 'block', text: parts.join('\n\n') };
}

async function decide(input: HookInput, engine: RuleEngine): Promise<HookDecision> {
  const ref = sessionRef(input.root, input.sessionId, input.agentId);
  let state = loadSession(ref);
  // Without a session id nothing is remembered, so a stop cannot know the session is clean and always checks.
  if (ref.file === null) state = { ...state, dirty: true };
  switch (input.phase) {
    case 'pre-edit':
      return onPreEdit(input, engine, ref, state);
    case 'pre-tool':
      return onPreTool(input, engine, ref, state, input.isShell);
    case 'stop':
    case 'subagent-stop':
      return onStop(input, engine, ref, state);
    case 'post-compact':
      saveSession(ref, { ...state, ...resetShown(state) });
      return SILENT;
  }
}

/**
 * The 2.0 hook core that every harness adapter calls after parsing its payload. Edits of files outside the session
 * root are dropped first, since the check never sees them. It never throws: an internal error writes its stack to
 * stderr and comes back as silent, which every adapter prints as its fail-open answer.
 */
export const hookCore: HookCore = async (input, engine) => {
  try {
    const edits = input.edits.filter((e) => projectPath(input.root, e.path) !== null);
    return await decide(edits.length === input.edits.length ? input : { ...input, edits }, engine);
  } catch (error) {
    process.stderr.write(unexpectedError(`buckets hook ${input.phase}`, error));
    return SILENT;
  }
};
