// The Goose adapter. Goose loads plugin hooks from `<project>/.agents/plugins/<name>/hooks/hooks.json`, in Claude
// Code's group shape, and runs each command with `sh -c`. The payload has `session_id`, `tool_name`, `tool_input` and
// `working_dir`. The tools are write (`path`, `content`), edit (`path`, `before`, `after`) and shell, with or without
// an extension prefix such as `developer__`.
//
// Goose reads no context from any hook, before or after a tool, so the pending list cannot reach the model. The
// PreToolUse hook still runs the core: on an edit it denies one that would make buckets.config.json invalid, with
// `{"decision": "block"}`, and on a shell command it marks the session, so the stop check knows files may have
// changed. Stop blocks with `{"decision": "block"}`, which Goose turns into a message that keeps the agent working. The
// Stop payload has no stop_hook_active, so a mark per session blocks once. A subagent most likely fires the same Stop
// with its own session id, so the mark covers it too. Goose has no compaction event.
//
// Exit 0 with nothing on stdout lets the call run. A hook that fails, such as on a machine without the CLI, allows the
// call under Goose's default `on_failure: "allow"`, and a failing Stop hook always lets the turn end.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Io } from '../../context/index.js';
import type { JsonRecord } from '../../files/index.js';
import { message } from '../../output/index.js';
import { defineAdapter, type HookHandler, type InstallOptions, type InstallStep } from '../adapter.js';
import { normalizeHarnessPath, str } from '../input.js';
import { removeEmptyFolders, removeProjectFile, writeProjectFile } from '../project-file.js';
import { DEFAULT_COMMAND, groupEntries, installHooks, type JsonHookFile, uninstallHooks } from './json-install.js';
import { beforeTool, decide, decideStopByMark, eventInput, jsonLine, kindOf, snakeCall, type ToolKind, type Where, whereOf } from './json-run.js';

const AGENT = 'goose';
const TITLE = 'Goose';

/** Goose's built-in tools, and text_editor of the older developer extension. */
const TOOLS: Record<string, ToolKind> = { shell: 'shell', write: 'write', edit: 'write', text_editor: 'write', tree: 'other', read_image: 'other' };

/** A regular expression over the tool name: the tools that write or run commands, with or without an extension prefix. */
export const GOOSE_MATCHER = '(?:^|__)(?:shell|write|edit|text_editor)$';

function where(payload: JsonRecord, io: Io): Where {
  const dir = str(payload.working_dir);
  return whereOf(payload, io, dir === undefined ? undefined : normalizeHarnessPath(dir));
}

const preToolUse: HookHandler = async (ctx, io, payload) => {
  // Goose names extension tools `<extension>__<tool>`; the kind comes from the part after the last `__`.
  const call = snakeCall(payload, TOOLS);
  const decision = await decide(ctx, beforeTool(where(payload, io), { ...call, kind: kindOf(call.name.replace(/^.*__/, ''), TOOLS) }));
  if (decision.kind === 'deny') io.stdout(jsonLine({ decision: 'block', reason: decision.text }));
  return 0;
};

const stop: HookHandler = async (ctx, io, payload) => {
  const at = where(payload, io);
  const decision = await decideStopByMark(ctx, eventInput(at, 'stop'), `${AGENT}:stop:${at.sessionId ?? at.cwd}`);
  if (decision.kind === 'block') io.stdout(jsonLine({ decision: 'block', reason: decision.text }));
  return 0;
};

// ---------------------------------------------------------------------------------------------------------------
// Install

export const GOOSE_PLUGIN_DIR = '.agents/plugins/slopbuckets';
export const GOOSE_HOOKS_FILE = `${GOOSE_PLUGIN_DIR}/hooks/hooks.json`;
export const GOOSE_MANIFEST = `${GOOSE_PLUGIN_DIR}/plugin.json`;

const MANIFEST = {
  name: 'slopbuckets',
  version: '2.0.0',
  description: 'The slopbuckets hooks. Written by `buckets init --agent goose`.',
};

export function gooseHooks(cli: string = DEFAULT_COMMAND): JsonHookFile {
  return {
    agent: AGENT,
    title: TITLE,
    file: GOOSE_HOOKS_FILE,
    container: ['hooks'],
    layout: 'groups',
    owned: true,
    entries: groupEntries(
      AGENT,
      [
        { event: 'PreToolUse', name: 'pre-tool-use', matcher: GOOSE_MATCHER, extra: { timeout: 60 } },
        { event: 'Stop', name: 'stop', extra: { timeout: 600 } },
      ],
      cli,
    ),
  };
}

function install(projectDir: string, options: InstallOptions): InstallStep[] {
  const steps = installHooks(projectDir, gooseHooks(options.command));
  if (steps.some((step) => step.status === 'failed')) return steps;
  const manifest = path.join(projectDir, GOOSE_MANIFEST);
  try {
    if (!existsSync(manifest)) {
      writeProjectFile(projectDir, GOOSE_MANIFEST, `${JSON.stringify(MANIFEST, null, 2)}\n`);
      steps.push({ status: 'done', text: `Wrote the Goose plugin manifest ${GOOSE_MANIFEST}` });
    }
  } catch (error) {
    steps.push({ status: 'failed', text: `Could not write ${GOOSE_MANIFEST}: ${message(error)}` });
  }
  if (steps[0]?.status === 'done') {
    steps.push({
      status: 'todo',
      text: 'Goose runs hooks with sh, so on Windows it needs sh on the PATH (Git for Windows has one). Goose shows hook text to no one, so the agent sees the structure problems only when the stop hook blocks, and on a machine without the buckets command the hooks do nothing: keep `buckets check` in CI.',
    });
  }
  return steps;
}

function uninstall(projectDir: string): InstallStep[] {
  const steps = uninstallHooks(projectDir, gooseHooks());
  try {
    // The manifest goes with the plugin, unless the user keeps other hooks next to it.
    const manifest = path.join(projectDir, GOOSE_MANIFEST);
    if (existsSync(manifest) && !existsSync(path.join(projectDir, GOOSE_HOOKS_FILE)) && JSON.parse(readFileSync(manifest, 'utf8')).name === MANIFEST.name) {
      removeProjectFile(projectDir, GOOSE_MANIFEST);
      steps.push({ status: 'done', text: `Removed the Goose plugin manifest ${GOOSE_MANIFEST}` });
    }
  } catch (error) {
    steps.push({ status: 'failed', text: `Could not remove ${GOOSE_MANIFEST}: ${message(error)}` });
  }
  removeEmptyFolders(projectDir, path.dirname(path.join(projectDir, GOOSE_HOOKS_FILE)));
  return steps;
}

export const gooseAdapter = defineAdapter({
  name: AGENT,
  title: TITLE,
  markers: ['.goosehints', GOOSE_PLUGIN_DIR],
  handlers: { 'pre-tool-use': preToolUse, stop },
  install,
  uninstall,
});
