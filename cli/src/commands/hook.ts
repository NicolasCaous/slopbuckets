// `buckets hook [--agent <name>] <event>`: runs one hook of an agent harness. Without `--agent` it is the Claude Code
// entry that `.claude/settings.json` calls. The decisions live in ../hooks/core.ts and each harness format in
// ../hooks/adapters/. The registry, with every adapter, loads only for `--agent`, so the Claude Code hook starts fast.
import type { Context, Io } from '../context/index.js';
import { EXIT_CODES } from '../contract/index.js';
import type { HookAdapter } from '../hooks/index.js';
import { claudeAdapter, runJson } from '../hooks/run.js';
import { unexpectedError } from '../output/index.js';
import { FAILED, parseCommand } from './io.js';

export { HOOK_EVENTS, type HookEvent } from '../hooks/run.js';

const USAGE = 'Usage: buckets hook [--agent <name>] <event>';

export async function hookCommand(ctx: Context, io: Io, args: string[]): Promise<number> {
  // The help lists the events of the agent, so it comes after the parse and not from parseCommand.
  const help = args.includes('--help') || args.includes('-h');
  const parsed = parseCommand(io, 'hook', USAGE, help ? args.filter((arg) => arg !== '--help' && arg !== '-h') : args, { agent: { type: 'string' } }, 1);
  if (typeof parsed === 'number') return parsed;
  const agent = parsed.values.agent as string | undefined;
  const prefix = agent === undefined ? 'buckets hook' : `buckets hook --agent ${agent}`;
  let adapter: HookAdapter | undefined = claudeAdapter;
  if (agent !== undefined || help) {
    const { ADAPTERS, findAdapter } = await import('../hooks/agents.js');
    const withHooks = ADAPTERS.filter((a) => a.events.length > 0).map((a) => a.name).join(', ');
    adapter = agent === undefined ? claudeAdapter : findAdapter(agent);
    if (adapter === undefined) {
      io.stderr(`buckets hook: unknown agent "${agent}". Agents with hooks: ${withHooks}. ${USAGE}\n`);
      return EXIT_CODES.usage;
    }
    if (help) {
      io.stdout(
        [
          USAGE,
          '',
          'Runs one hook of an agent, with the JSON the agent sends on stdin, and prints the answer in its format.',
          'Without --agent it runs the Claude Code hook. `buckets init` writes these calls into the agent config.',
          '',
          `Events of ${adapter.title}: ${adapter.events.length > 0 ? adapter.events.join(', ') : 'none'}.`,
          `Agents with hooks: ${withHooks}.`,
          '',
        ].join('\n'),
      );
      return EXIT_CODES.ok;
    }
  }
  if (adapter.events.length === 0) {
    io.stderr(`${prefix}: ${adapter.title} has no hooks. Run \`buckets init --git-hook\` and \`buckets check\` in CI to hold the rules for it.\n`);
    return FAILED;
  }
  const event = parsed.positionals[0];
  if (event === undefined) {
    io.stderr(`${prefix}: name an event. Events: ${adapter.events.join(', ')}. ${USAGE}\n`);
    return EXIT_CODES.usage;
  }
  if (!adapter.events.includes(event)) {
    // A hook file from an older install, such as 1.x calling post-tool-use. Exit 0 so the session goes on unchecked.
    const init = agent === undefined ? 'buckets init' : `buckets init --agent ${agent}`;
    io.stderr(`${prefix}: unknown event "${event}", so this hook did nothing. If the hooks come from an older slopbuckets, run \`${init}\` again. Events: ${adapter.events.join(', ')}.\n`);
    return EXIT_CODES.ok;
  }
  try {
    return await runJson(ctx, io, adapter, event);
  } catch (error) {
    // Adapters catch their own errors. This is the last guard, so a broken adapter never breaks the session.
    io.stderr(unexpectedError(`${prefix} ${event}`, error));
    return EXIT_CODES.ok;
  }
}
