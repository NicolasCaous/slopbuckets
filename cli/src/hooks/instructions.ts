// The instructions `buckets init` installs for every harness: a managed block in AGENTS.md, which most harnesses read,
// and the skill in .agents/skills/slopbuckets/SKILL.md, which Codex, Cursor, GitHub Copilot, OpenCode, Pi and Amp read.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { InstallStep } from './adapter.js';

export const BLOCK_START = '<!-- slopbuckets:start -->';
export const BLOCK_END = '<!-- slopbuckets:end -->';
export const AGENTS_FILE = 'AGENTS.md';
export const SHARED_SKILL = path.join('.agents', 'skills', 'slopbuckets', 'SKILL.md');

const DOCS_URL = 'https://nicolascaous.github.io/slopbuckets/';

/** The managed block, markers included, without a trailing newline. It stays short: the skill and the docs hold the detail. */
export const AGENTS_BLOCK = [
  BLOCK_START,
  '## slopbuckets',
  '',
  `This project uses slopbuckets. \`buckets.config.json\` names the root bucket folder and the import alias. Read \`.agents/skills/slopbuckets/SKILL.md\` before you edit files under the root bucket folder or add an import between folders. Docs: ${DOCS_URL}`,
  '',
  '- A bucket holds only `_/`, `dmz/` and child buckets. Put code in `_/`. Any other folder in a bucket is a child bucket, and a new bucket needs human approval.',
  '- Import internal code through the alias, never with a relative path.',
  "- Code reaches another bucket only through DMZ files, which hold nothing but `export { x } from '<alias>/...'` and `export type { T } from '<alias>/...'`.",
  '- Never write any `buckets.lock.json`, under any name, and never run `buckets refresh` without exactly the `--web` flag. Read the lock with a file reading tool, not a shell command.',
  '- Run `buckets check` before you finish. With exit code 1, fix what it reports. With exit code 2, run `buckets refresh --web` in the background, send the human the link it prints with a summary of what changed and why, and wait for it to finish. With exit code 3, stop and show the message to the human.',
  '- `buckets inspect --json` prints the buckets, contracts and imports of the project.',
  BLOCK_END,
].join('\n');

const BLOCK = new RegExp(`${escapeRegex(BLOCK_START)}[\\s\\S]*?${escapeRegex(BLOCK_END)}`, 'g');

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * The text with the managed block created or replaced in place. The first block is replaced and any later one is
 * removed, so the block never appears twice. Text outside the markers stays as it was, and the block uses the line
 * endings of the file. `problem` is set, and the text left alone, when a marker has no partner.
 */
export function upsertBlock(text: string, block: string = AGENTS_BLOCK): { text: string; problem?: string } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = block.split('\n').join(eol);
  const matches = [...text.matchAll(BLOCK)];
  if (countOf(text, BLOCK_START) !== matches.length || countOf(text, BLOCK_END) !== matches.length) {
    return { text, problem: `it has a ${BLOCK_START} or ${BLOCK_END} marker without its partner` };
  }
  if (matches.length === 0) {
    if (text === '') return { text: `${body}${eol}` };
    const separator = text.endsWith(`${eol}${eol}`) ? '' : text.endsWith(eol) ? eol : `${eol}${eol}`;
    return { text: `${text}${separator}${body}${eol}` };
  }
  let first = true;
  const out = text.replace(new RegExp(`${BLOCK.source}(?:\\r?\\n)?`, 'g'), (match) => {
    if (!first) return '';
    first = false;
    const newline = /\r?\n$/.exec(match)?.[0] ?? '';
    return body + newline;
  });
  return { text: out };
}

/** The text without the managed block and the newline after it. */
export function removeBlock(text: string): string {
  return text.replace(new RegExp(`${BLOCK.source}(?:\\r?\\n)?`, 'g'), '');
}

/** Writes the AGENTS.md block and the shared skill. `skill` is null when init could not find the skill in the package. */
export function installInstructions(projectDir: string, skill: string | null): InstallStep[] {
  const steps: InstallStep[] = [];
  const agentsFile = path.join(projectDir, AGENTS_FILE);
  try {
    const exists = existsSync(agentsFile);
    const current = exists ? readFileSync(agentsFile, 'utf8') : '';
    const result = upsertBlock(current);
    if (result.problem !== undefined) {
      steps.push({ status: 'todo', text: `Did not change AGENTS.md, because ${result.problem}. Fix the markers and run \`buckets init\` again.` });
    } else if (result.text === current) {
      steps.push({ status: 'kept', text: 'The slopbuckets rules in AGENTS.md are up to date' });
    } else {
      writeFileSync(agentsFile, result.text, 'utf8');
      const had = current.includes(BLOCK_START);
      steps.push({
        status: 'done',
        text: !exists ? 'Created AGENTS.md with the slopbuckets rules for every agent' : had ? 'Updated the slopbuckets rules in AGENTS.md' : 'Added the slopbuckets rules to the end of AGENTS.md',
      });
    }
  } catch (error) {
    steps.push({ status: 'failed', text: `Could not write AGENTS.md: ${error instanceof Error ? error.message : String(error)}` });
  }

  if (skill === null) {
    steps.push({ status: 'failed', text: 'Could not find the slopbuckets skill in the installed package. Reinstall slopbuckets and run `buckets init` again.' });
    return steps;
  }
  const skillFile = path.join(projectDir, SHARED_SKILL);
  if (!existsSync(skillFile) || readFileSync(skillFile, 'utf8') !== skill) {
    mkdirSync(path.dirname(skillFile), { recursive: true });
    writeFileSync(skillFile, skill, 'utf8');
    steps.push({ status: 'done', text: 'Installed the skill for other agents in .agents/skills/slopbuckets/SKILL.md' });
  } else {
    steps.push({ status: 'kept', text: 'The skill in .agents/skills/slopbuckets/SKILL.md is up to date' });
  }
  return steps;
}

/** Removes the AGENTS.md block (and AGENTS.md, when nothing else is left in it) and the shared skill. */
export function uninstallInstructions(projectDir: string): InstallStep[] {
  const steps: InstallStep[] = [];
  const agentsFile = path.join(projectDir, AGENTS_FILE);
  if (existsSync(agentsFile)) {
    const current = readFileSync(agentsFile, 'utf8');
    const next = removeBlock(current);
    if (next !== current) {
      if (next.trim() === '') {
        rmSync(agentsFile, { force: true });
        steps.push({ status: 'done', text: 'Removed AGENTS.md, which held only the slopbuckets rules' });
      } else {
        writeFileSync(agentsFile, next, 'utf8');
        steps.push({ status: 'done', text: 'Removed the slopbuckets rules from AGENTS.md' });
      }
    }
  }
  const skillFile = path.join(projectDir, SHARED_SKILL);
  if (existsSync(skillFile)) {
    rmSync(skillFile, { force: true });
    try {
      if (readdirSync(path.dirname(skillFile)).length === 0) rmdirSync(path.dirname(skillFile));
    } catch {
      // A folder that cannot be listed or removed stays.
    }
    steps.push({ status: 'done', text: 'Removed the skill from .agents/skills/slopbuckets/SKILL.md' });
  }
  return steps;
}
