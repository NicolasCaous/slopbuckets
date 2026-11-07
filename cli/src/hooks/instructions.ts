// The instructions `buckets init` installs for every harness: a managed block in AGENTS.md, which most harnesses read,
// and the skill in .agents/skills/slopbuckets/SKILL.md, which Codex, Cursor, GitHub Copilot, OpenCode, Pi and Amp read.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { message } from '../output/index.js';
import type { InstallStep } from './adapter.js';
import { writeProjectFile } from './project-file.js';

export const BLOCK_START = '<!-- slopbuckets:start -->';
export const BLOCK_END = '<!-- slopbuckets:end -->';
export const AGENTS_FILE = 'AGENTS.md';
export const SHARED_SKILL = path.join('.agents', 'skills', 'slopbuckets', 'SKILL.md');
/** Every copy of the skill that `buckets init` writes, relative to the project with `/`: Claude Code's and the shared one. */
export const SKILL_COPIES = ['.claude/skills/slopbuckets/SKILL.md', '.agents/skills/slopbuckets/SKILL.md'];
/** The frontmatter key, under `metadata`, that records the CLI version that copied the skill. */
const VERSION_KEY = 'slopbuckets-version';

const DOCS_URL = 'https://nicolascaous.github.io/slopbuckets/';

/**
 * What an agent or a human types to run slopbuckets, for a command that the hooks run: `npx buckets` for the copy in
 * node_modules, which is not on PATH, the command itself otherwise, such as `buckets` or `node ./cli/dist/index.js`.
 */
export function typedCommand(command: string): string {
  return /\bnode_modules[\\/]/.test(command) ? 'npx buckets' : command;
}

/** The managed block for the command that runs slopbuckets, markers included, without a trailing newline. */
export function agentsBlock(command = 'buckets'): string {
  const check = `${typedCommand(command)} check`;
  return [
    BLOCK_START,
    '## slopbuckets',
    '',
    '- `buckets.config.json` holds the architecture of this project: the buckets, the job of each one, its public file, and which buckets it depends on and why.',
    '- slopbuckets hooks warn you when the code and `buckets.config.json` disagree, and stay silent while they match.',
    '- Fixing the code and editing `buckets.config.json` are both valid. Pick the one that fits the task. The skill says how.',
    `- Before you finish, run \`${check}\` unless you know a slopbuckets stop hook runs it, and fix the code or the config until it exits 0. If it exits 3, fix the problem if it is part of your task, otherwise show it to the human.`,
    '',
    `Read \`.agents/skills/slopbuckets/SKILL.md\` before you add files, imports or buckets. Docs: ${DOCS_URL}`,
    BLOCK_END,
  ].join('\n');
}

/** The managed block of a global install. */
export const AGENTS_BLOCK = agentsBlock();

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

/** The index of the line that closes the frontmatter, or -1 when the text has none. */
function frontmatterEnd(lines: readonly string[]): number {
  return lines[0] === '---' ? lines.indexOf('---', 1) : -1;
}

/**
 * The skill text with the CLI version in its frontmatter, as `slopbuckets-version` under `metadata`, the map the
 * Agent Skills format keeps for extra keys. A text without frontmatter stays as it is.
 */
export function stampSkill(skill: string, version: string): string {
  const eol = skill.includes('\r\n') ? '\r\n' : '\n';
  const lines = skill.split(eol);
  const end = frontmatterEnd(lines);
  if (end < 0) return skill;
  const line = `  ${VERSION_KEY}: "${version}"`;
  const at = lines.findIndex((l, i) => i < end && l.trimStart().startsWith(`${VERSION_KEY}:`));
  const metadata = lines.findIndex((l, i) => i < end && /^metadata:\s*$/.test(l));
  if (at > 0) lines[at] = line;
  else if (metadata > 0) lines.splice(metadata + 1, 0, line);
  else lines.splice(end, 0, 'metadata:', line);
  return lines.join(eol);
}

/** The CLI version in the frontmatter of a skill copy, or null when it has none. */
export function skillVersion(skill: string): string | null {
  const lines = skill.split(/\r?\n/);
  for (const line of lines.slice(1, Math.max(frontmatterEnd(lines), 1))) {
    const match = /^\s+slopbuckets-version:\s*"?([^"\s]+)"?\s*$/.exec(line);
    if (match !== null) return match[1]!;
  }
  return null;
}

/** The skill copies that exist in `projectDir`, with the version each one records. */
export function skillCopies(projectDir: string): { file: string; version: string | null }[] {
  return SKILL_COPIES.filter((file) => existsSync(path.join(projectDir, file))).map((file) => ({ file, version: skillVersion(readFileSync(path.join(projectDir, file), 'utf8')) }));
}

/**
 * Writes the AGENTS.md block and the shared skill. `skill` is null when init could not find the skill in the package.
 * `command` is the command the hooks run, which the block turns into the check command the agent types.
 */
export function installInstructions(projectDir: string, skill: string | null, command = 'buckets'): InstallStep[] {
  const steps: InstallStep[] = [];
  const agentsFile = path.join(projectDir, AGENTS_FILE);
  try {
    const exists = existsSync(agentsFile);
    const current = exists ? readFileSync(agentsFile, 'utf8') : '';
    const result = upsertBlock(current, agentsBlock(command));
    if (result.problem !== undefined) {
      steps.push({ status: 'todo', text: `Did not change AGENTS.md, because ${result.problem}. Fix the markers and run \`buckets init\` again.` });
    } else if (result.text === current) {
      steps.push({ status: 'kept', text: 'The slopbuckets rules in AGENTS.md are up to date' });
    } else {
      writeProjectFile(projectDir, agentsFile, result.text);
      const had = current.includes(BLOCK_START);
      steps.push({
        status: 'done',
        text: !exists ? 'Created AGENTS.md with the slopbuckets rules for every agent' : had ? 'Updated the slopbuckets rules in AGENTS.md' : 'Added the slopbuckets rules to the end of AGENTS.md',
      });
    }
  } catch (error) {
    steps.push({ status: 'failed', text: `Could not write AGENTS.md: ${message(error)}` });
  }

  if (skill === null) {
    steps.push({ status: 'failed', text: 'Could not find the slopbuckets skill in the installed package. Reinstall slopbuckets and run `buckets init` again.' });
    return steps;
  }
  const skillFile = path.join(projectDir, SHARED_SKILL);
  if (!existsSync(skillFile) || readFileSync(skillFile, 'utf8') !== skill) {
    try {
      writeProjectFile(projectDir, skillFile, skill);
    } catch (error) {
      steps.push({ status: 'failed', text: `Could not write .agents/skills/slopbuckets/SKILL.md: ${message(error)}` });
      return steps;
    }
    steps.push({ status: 'done', text: 'Installed the skill for other agents in .agents/skills/slopbuckets/SKILL.md' });
  } else {
    steps.push({ status: 'kept', text: 'The skill in .agents/skills/slopbuckets/SKILL.md is up to date' });
  }
  return steps;
}
