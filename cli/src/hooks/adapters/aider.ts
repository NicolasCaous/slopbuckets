// The Aider adapter. Aider has no hooks. Install makes it load AGENTS.md as a read-only file through `read:` in
// `.aider.conf.yml`, merged into the user's config, and suggests the two settings that bring the checks closer: a
// `lint-cmd` that runs `buckets check --file` on each edited file, and `git-commit-verify: true`, so Aider's own commits
// run the pre-commit hook of `buckets init --git-hook`.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HookAdapter, InstallStep } from '../adapter.js';
import { AGENTS_FILE } from '../instructions.js';
import { noHooksRun } from './no-hooks.js';

const TITLE = 'Aider';
export const AIDER_CONFIG = '.aider.conf.yml';
/** The comment on every line install adds, so uninstall removes those lines and no others. */
const MARK = '# slopbuckets';

export type ReadMerge = { kind: 'added' | 'present'; text: string } | { kind: 'unsupported'; text: string; problem: string };

/** A YAML scalar without its quotes and trailing comment. */
function scalar(raw: string): string {
  const text = raw.trim();
  const quoted = /^(['"])(.*?)\1/.exec(text);
  if (quoted !== null) return quoted[2]!;
  return text.replace(/\s+#.*$/, '').trim();
}

function isAgents(raw: string): boolean {
  return scalar(raw) === AGENTS_FILE;
}

const READ_KEY = /^read[ \t]*:(.*)$/;
const LIST_ITEM = /^([ \t]*)-[ \t]+(.*)$/;

/**
 * The text of an `.aider.conf.yml` with AGENTS.md added to its top-level `read` key. A missing key becomes
 * `read: AGENTS.md`; a single file becomes a list of both; a list gets one more item. Every added line ends with
 * `# slopbuckets`. Text this function cannot edit safely, such as a flow list with quotes, comes back unchanged.
 */
export function addAgentsRead(text: string): ReadMerge {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  const trailing = lines.length > 0 && lines[lines.length - 1] === '';
  if (trailing) lines.pop();
  const join = (out: string[]): string => (out.length === 0 ? '' : `${out.join(eol)}${eol}`);
  const keyLines = lines.flatMap((line, index) => (READ_KEY.test(line) ? [index] : []));
  if (keyLines.length > 1) return { kind: 'unsupported', text, problem: 'it has more than one top-level "read" key' };
  const added = `- ${AGENTS_FILE}  ${MARK}`;
  if (keyLines.length === 0) return { kind: 'added', text: join([...lines, `read: ${AGENTS_FILE}  ${MARK}`]) };

  const at = keyLines[0]!;
  const value = READ_KEY.exec(lines[at]!)![1]!.trim();
  const valueNoComment = value.startsWith('#') ? '' : value;
  if (valueNoComment === '') {
    // A block list, possibly empty, in the lines below the key.
    let last = at;
    let indent = '  ';
    for (let i = at + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      const item = LIST_ITEM.exec(line);
      if (item === null) break;
      if (isAgents(item[2]!)) return { kind: 'present', text };
      indent = item[1]!;
      last = i;
    }
    return { kind: 'added', text: join([...lines.slice(0, last + 1), `${indent}${added}`, ...lines.slice(last + 1)]) };
  }
  if (valueNoComment.startsWith('[')) {
    const body = /^\[(.*)\]\s*(?:#.*)?$/.exec(valueNoComment);
    if (body === null || /['"[\]{}]/.test(body[1]!)) return { kind: 'unsupported', text, problem: 'its "read" key holds a list this command cannot edit safely' };
    const items = body[1]!.split(',').map((item) => item.trim()).filter((item) => item !== '');
    if (items.some(isAgents)) return { kind: 'present', text };
    return { kind: 'added', text: join([...lines.slice(0, at), 'read:', ...items.map((item) => `  - ${item}`), `  ${added}`, ...lines.slice(at + 1)]) };
  }
  if (isAgents(valueNoComment)) return { kind: 'present', text };
  if (/^[|>&*!{]/.test(valueNoComment)) return { kind: 'unsupported', text, problem: 'its "read" key holds a value this command cannot edit safely' };
  return { kind: 'added', text: join([...lines.slice(0, at), 'read:', `  - ${value}`, `  ${added}`, ...lines.slice(at + 1)]) };
}

/** The text without the lines install added. */
export function removeAgentsRead(text: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const ours = new RegExp(`^(?:read[ \\t]*:[ \\t]*|[ \\t]*-[ \\t]+)${AGENTS_FILE.replace('.', '\\.')}[ \\t]+${MARK}[ \\t]*$`);
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((line) => !ours.test(line));
  return kept.length === lines.length ? text : kept.join(eol);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function install(projectDir: string): InstallStep[] {
  const file = path.join(projectDir, AIDER_CONFIG);
  const steps: InstallStep[] = [];
  try {
    const exists = existsSync(file);
    const current = exists ? readFileSync(file, 'utf8') : '';
    const result = addAgentsRead(current);
    if (result.kind === 'unsupported') {
      steps.push({ status: 'todo', text: `Did not change ${AIDER_CONFIG}, because ${result.problem}. Add ${AGENTS_FILE} to its "read" list by hand.` });
    } else if (result.kind === 'present') {
      steps.push({ status: 'kept', text: `${AIDER_CONFIG} already loads ${AGENTS_FILE}` });
    } else {
      writeFileSync(file, result.text, 'utf8');
      steps.push({ status: 'done', text: exists ? `Added "read: ${AGENTS_FILE}" to ${AIDER_CONFIG}` : `Created ${AIDER_CONFIG} with "read: ${AGENTS_FILE}"` });
    }
  } catch (error) {
    steps.push({ status: 'failed', text: `Could not update ${AIDER_CONFIG}: ${message(error)}` });
  }
  steps.push({
    status: 'todo',
    text: `Aider has no hooks. For a report after each edit, add \`lint-cmd: "buckets check --file"\` to ${AIDER_CONFIG}. To check Aider's own commits, add \`git-commit-verify: true\` and run \`buckets init --git-hook\`.`,
  });
  return steps;
}

function uninstall(projectDir: string): InstallStep[] {
  const file = path.join(projectDir, AIDER_CONFIG);
  if (!existsSync(file)) return [];
  try {
    const current = readFileSync(file, 'utf8');
    const next = removeAgentsRead(current);
    if (next === current) return [];
    if (next.trim() === '') {
      rmSync(file, { force: true });
      return [{ status: 'done', text: `Removed ${AIDER_CONFIG}, which held only the slopbuckets line` }];
    }
    writeFileSync(file, next, 'utf8');
    return [{ status: 'done', text: `Removed "read: ${AGENTS_FILE}" from ${AIDER_CONFIG}` }];
  } catch (error) {
    return [{ status: 'failed', text: `Could not update ${AIDER_CONFIG}: ${message(error)}` }];
  }
}

export const aiderAdapter: HookAdapter = {
  name: 'aider',
  title: TITLE,
  markers: [AIDER_CONFIG],
  events: [],
  run: noHooksRun(TITLE),
  install,
  uninstall,
};
