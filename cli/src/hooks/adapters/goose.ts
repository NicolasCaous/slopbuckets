// The Goose adapter. Goose loads plugin hooks from `<project>/.agents/plugins/<name>/hooks/hooks.json`, in Claude
// Code's group shape, and runs each command with `sh -c`. The payload has `event`, `session_id`, `tool_name`,
// `tool_input` and `working_dir`. PreToolUse blocks with `{"decision": "block", "reason": "..."}`. Stop accepts the
// same block, which Goose turns into a message that keeps the agent working. Every hook fails open: Goose's default
// `on_failure: "allow"` lets the call through when the hook cannot run, such as on a machine without the CLI, and CI
// holds the rules there. There is no hook after an edit that talks to the model, and the Stop payload has no
// `stop_hook_active`, so a mark in the temp folder makes the stop hook block at most once in a row.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HookAdapter, InstallStep } from '../adapter.js';
import { normalizeHarnessPath, str } from '../input.js';
import { groupEntries, installHookFile, jsonLine, runHook, snakeToolCall, uninstallHookFile, type HookFile, type RunConfig, type ToolKind } from './hook-kit.js';

const AGENT = 'goose';
const TITLE = 'Goose';
export const GOOSE_EVENTS = ['pre-tool-use', 'stop'] as const;

/** Goose's built-in tools, and the names of the older developer extension. */
const TOOLS: Record<string, ToolKind> = {
  shell: 'shell',
  write: 'write',
  edit: 'write',
  developer__shell: 'shell',
  developer__text_editor: 'write',
  text_editor: 'write',
  tree: 'other',
  read_image: 'other',
};

/** A regular expression over the tool name: the tools above, with or without an extension prefix. */
export const GOOSE_MATCHER = '(?:^|__)(?:shell|write|edit|text_editor)$';

const config: RunConfig = {
  agent: AGENT,
  phases: { 'pre-tool-use': 'pre-tool', stop: 'stop' },
  scope(input, io) {
    const dir = str(input.working_dir);
    const root = dir === undefined ? io.cwd : normalizeHarnessPath(dir);
    const sessionId = str(input.session_id);
    return { projectDir: root, cwd: root, ...(sessionId === undefined ? {} : { sessionId }) };
  },
  // Exit 0 with nothing on stdout is an allow for Goose, so the allow path prints nothing.
  call: (input) => snakeToolCall(input, TOOLS),
  deny(io, reason) {
    io.stdout(jsonLine({ decision: 'block', reason }));
    return 0;
  },
  feedback() {},
  block(io, text) {
    io.stdout(jsonLine({ decision: 'block', reason: text }));
  },
  stopActive: () => undefined,
};

// ---------------------------------------------------------------------------------------------------------------
// Install

export const GOOSE_PLUGIN_DIR = '.agents/plugins/slopbuckets';
export const GOOSE_HOOKS_FILE = `${GOOSE_PLUGIN_DIR}/hooks/hooks.json`;
export const GOOSE_MANIFEST = `${GOOSE_PLUGIN_DIR}/plugin.json`;

const MANIFEST = {
  name: 'slopbuckets',
  version: '1.0.0',
  description: 'Keeps the agent from writing buckets.lock.json or running buckets refresh, and runs buckets check before a turn ends. Written by `buckets init --agent goose`.',
};

export const GOOSE_HOOKS: HookFile = {
  agent: AGENT,
  title: TITLE,
  file: GOOSE_HOOKS_FILE,
  container: ['hooks'],
  layout: 'groups',
  owned: true,
  // Older installs set `on_failure: "block"` on the PreToolUse hook. Install removes it, so the hook fails open.
  staleKeys: ['on_failure'],
  entries: groupEntries(AGENT, [
    { event: 'PreToolUse', name: 'pre-tool-use', matcher: GOOSE_MATCHER, extra: { timeout: 60 } },
    { event: 'Stop', name: 'stop', extra: { timeout: 300 } },
  ]),
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function install(projectDir: string): InstallStep[] {
  const steps = installHookFile(projectDir, GOOSE_HOOKS);
  if (steps.some((step) => step.status === 'failed')) return steps;
  const manifest = path.join(projectDir, GOOSE_MANIFEST);
  try {
    if (!existsSync(manifest)) {
      mkdirSync(path.dirname(manifest), { recursive: true });
      writeFileSync(manifest, `${JSON.stringify(MANIFEST, null, 2)}\n`, 'utf8');
      steps.push({ status: 'done', text: `Wrote the Goose plugin manifest ${GOOSE_MANIFEST}` });
    }
  } catch (error) {
    steps.push({ status: 'failed', text: `Could not write ${GOOSE_MANIFEST}: ${message(error)}` });
  }
  if (steps[0]?.status === 'done') {
    steps.push({
      status: 'todo',
      text: 'Goose runs hooks with sh, so on Windows it needs sh on the PATH (Git for Windows has one). On a machine without the buckets command the hooks do nothing, so keep `buckets check` in CI.',
    });
  }
  return steps;
}

function removeIfEmpty(dir: string): void {
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // A folder that cannot be listed or removed stays.
  }
}

function uninstall(projectDir: string): InstallStep[] {
  const steps = uninstallHookFile(projectDir, GOOSE_HOOKS).filter((step) => step.status !== 'kept');
  const manifest = path.join(projectDir, GOOSE_MANIFEST);
  const hooksFile = path.join(projectDir, GOOSE_HOOKS_FILE);
  try {
    // The manifest goes with the plugin, unless the user keeps other hooks in it.
    if (existsSync(manifest) && !existsSync(hooksFile) && JSON.parse(readFileSync(manifest, 'utf8')).name === MANIFEST.name) {
      rmSync(manifest, { force: true });
      steps.push({ status: 'done', text: `Removed the Goose plugin manifest ${GOOSE_MANIFEST}` });
    }
  } catch {
    // A manifest that cannot be read stays.
  }
  removeIfEmpty(path.dirname(hooksFile));
  removeIfEmpty(path.join(projectDir, GOOSE_PLUGIN_DIR));
  return steps;
}

export const gooseAdapter: HookAdapter = {
  name: AGENT,
  title: TITLE,
  markers: ['.goosehints', GOOSE_PLUGIN_DIR],
  events: GOOSE_EVENTS,
  run: (ctx, io, event) => runHook(ctx, io, event, config),
  install,
  uninstall,
};
