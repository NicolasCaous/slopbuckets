// `buckets uninstall`: removes what `buckets init` installed. Each adapter removes only its own hook entries and files;
// the AGENTS.md block, the shared skill, the .gitignore line, .buckets/, the git pre-commit block and the merge driver
// go when every agent is removed. The config stays unless --config is given.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { stderrStyle, stdoutStyle, type Context, type Io } from '../context/index.js';
import { CONFIG_FILE, EXIT_CODES } from '../contract/index.js';
import { ADAPTERS, findAdapter } from '../hooks/agents.js';
import {
  AGENTS_FILE,
  BLOCK_END,
  BLOCK_START,
  removeProjectFile,
  SHARED_SKILL,
  uninstallGitHook,
  writeProjectFile,
  type HookAdapter,
  type InstallStep,
} from '../hooks/index.js';
import { highlightCode, message, wrap, type Style } from '../output/index.js';
import { FAILED, parseCommand } from './io.js';
import { uninstallMergeDriver } from './merge-driver.js';

const USAGE = 'Usage: buckets uninstall [--agent <name>[,<name>...] | --all] [--config]';

const HELP = `${USAGE}

Removes what buckets init installed. With --all, the default, that is the hooks of every agent, the slopbuckets block
of AGENTS.md, both copies of the skill, .buckets/ in .gitignore, the .buckets/ folder, the slopbuckets lines of the
git pre-commit hook and the merge driver of buckets.config.json. With --agent, only the hooks and files of those
agents go, and what the other agents share stays. Every hook and setting of your own stays. --config also deletes
buckets.config.json, which stays by default.
`;

function remove(projectDir: string, rel: string, done: string): InstallStep[] {
  try {
    return removeProjectFile(projectDir, rel) ? [{ status: 'done', text: done }] : [];
  } catch (error) {
    return [{ status: 'failed', text: `Could not remove ${rel}: ${message(error)}` }];
  }
}

/** The AGENTS.md text without the slopbuckets block, the newline after it and the blank line init put before it. */
export function removeBlock(text: string): string {
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = text.replace(new RegExp(`${escape(BLOCK_START)}[\\s\\S]*?${escape(BLOCK_END)}(?:\\r?\\n)?`, 'g'), '');
  return out === text ? text : out.replace(/(\r?\n)(?:\r?\n)+$/, '$1');
}

function removeAgentsBlock(projectDir: string): InstallStep[] {
  const file = path.join(projectDir, AGENTS_FILE);
  if (!existsSync(file)) return [];
  try {
    const current = readFileSync(file, 'utf8');
    const next = removeBlock(current);
    if (next === current) return [];
    if (next.trim() === '') return remove(projectDir, AGENTS_FILE, `Removed ${AGENTS_FILE}, which held only the slopbuckets rules`);
    writeProjectFile(projectDir, file, next);
    return [{ status: 'done', text: `Removed the slopbuckets rules from ${AGENTS_FILE}` }];
  } catch (error) {
    return [{ status: 'failed', text: `Could not update ${AGENTS_FILE}: ${message(error)}` }];
  }
}

function removeGitignoreLine(projectDir: string): InstallStep[] {
  const file = path.join(projectDir, '.gitignore');
  if (!existsSync(file)) return [];
  try {
    const current = readFileSync(file, 'utf8');
    const lines = current.split(/\r?\n/);
    const kept = lines.filter((line) => !['.buckets', '.buckets/', '/.buckets', '/.buckets/'].includes(line.trim()));
    if (kept.length === lines.length) return [];
    if (kept.every((line) => line.trim() === '')) {
      rmSync(file, { force: true });
      return [{ status: 'done', text: 'Removed .gitignore, which held only .buckets/' }];
    }
    writeProjectFile(projectDir, file, kept.join(current.includes('\r\n') ? '\r\n' : '\n'));
    return [{ status: 'done', text: 'Removed .buckets/ from .gitignore' }];
  } catch (error) {
    return [{ status: 'failed', text: `Could not update .gitignore: ${message(error)}` }];
  }
}

/** Every step of an uninstall of `agents` in `projectDir`. `all` also removes what the agents share. */
export function uninstallSteps(projectDir: string, agents: readonly HookAdapter[], options: { all: boolean; config: boolean }): InstallStep[] {
  const steps = agents.flatMap((adapter) => adapter.uninstall(projectDir));
  if (options.all) {
    steps.push(
      ...removeAgentsBlock(projectDir),
      ...remove(projectDir, SHARED_SKILL, `Removed the skill from ${SHARED_SKILL.split(path.sep).join('/')}`),
      ...removeGitignoreLine(projectDir),
      ...remove(projectDir, '.buckets', 'Removed the .buckets/ folder with the cache and the hook sessions'),
      ...uninstallGitHook(projectDir),
      ...uninstallMergeDriver(projectDir),
    );
  }
  if (options.config) steps.push(...remove(projectDir, CONFIG_FILE, `Removed ${CONFIG_FILE}`));
  return steps;
}

function print(io: Io, steps: InstallStep[]): void {
  const out = stdoutStyle(io);
  const err = stderrStyle(io);
  const item = (style: Style, mark: string, text: string): string => {
    const lines = wrap(highlightCode(style, text), style.width, '    ');
    lines[0] = `  ${mark} ${lines[0]!.trimStart()}`;
    return `${lines.join('\n')}\n`;
  };
  for (const step of steps) {
    if (step.status === 'done') io.stdout(item(out, out.ok(out.tty ? '✓' : '+'), step.text));
    else if (step.status === 'kept') io.stdout(out.dim(item(out, out.tty ? '·' : '=', step.text)));
    else if (step.status === 'todo') io.stdout(item(out, out.warn(out.tty ? '!' : '-'), step.text));
    else io.stderr(item(err, err.error(err.tty ? '✗' : '!'), step.text));
  }
}

export async function uninstallCommand(_ctx: Context, io: Io, args: string[]): Promise<number> {
  const parsed = parseCommand(io, 'uninstall', USAGE, args, { agent: { type: 'string', multiple: true }, all: { type: 'boolean' }, config: { type: 'boolean' } }, 0, HELP);
  if (typeof parsed === 'number') return parsed;
  const values = parsed.values as { agent?: string[]; all?: boolean; config?: boolean };
  if (values.agent !== undefined && values.all === true) {
    io.stderr(`buckets uninstall: choose --agent or --all, not both. ${USAGE}\n`);
    return EXIT_CODES.usage;
  }
  const names = (values.agent ?? []).flatMap((value) => value.split(',')).map((name) => name.trim()).filter((name) => name !== '');
  const unknown = names.filter((name) => findAdapter(name) === undefined);
  if (values.agent !== undefined && (names.length === 0 || unknown.length > 0)) {
    const which = unknown.length > 0 ? `unknown agent ${unknown.map((name) => `"${name}"`).join(', ')}` : '--agent needs a value';
    io.stderr(`buckets uninstall: ${which}. Agents: ${ADAPTERS.map((a) => a.name).join(', ')}. Nothing was removed.\n`);
    return EXIT_CODES.usage;
  }
  const all = values.agent === undefined;
  const agents = all ? ADAPTERS : names.map((name) => findAdapter(name)!);
  const projectDir = io.cwd;
  io.stdout(`Removing slopbuckets from ${stdoutStyle(io).path(projectDir)}\n\n`);
  const steps = uninstallSteps(projectDir, agents, { all, config: values.config === true });
  if (steps.length === 0) steps.push({ status: 'kept', text: 'Found nothing that buckets init installed' });
  print(io, steps);
  if (!all) io.stdout(`\nThe files every agent shares stay. Run \`buckets uninstall --all\` to remove them too.\n`);
  else if (values.config !== true && existsSync(path.join(projectDir, CONFIG_FILE))) io.stdout(`\n${CONFIG_FILE} stays. Run \`buckets uninstall --config\` to delete it too.\n`);
  return steps.some((step) => step.status === 'failed') ? FAILED : EXIT_CODES.ok;
}
