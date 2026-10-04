// `buckets hook [--agent <name>] <event>`: runs one hook of an agent harness. Without `--agent` it is the Claude Code
// entry that `.claude/settings.json` calls. The decisions live in ../hooks/core.ts and each harness format in
// ../hooks/adapters/.
import type { Context } from '../core/types.js';
import { ADAPTERS, DEFAULT_AGENT, findAdapter } from '../hooks/registry.js';
import type { Io } from './io.js';

export { LOCK_DENY_REASON, STOP_INTRO } from '../hooks/core.js';
export { HOOK_EVENTS, touchesLock, type HookEvent } from '../hooks/adapters/claude.js';
export { mentionsLock, normalizeTargetPath, runsForbiddenRefresh, touchesLockAboveProjects } from '../hooks/lock-guard.js';

export async function hookCommand(ctx: Context, io: Io, args: string[]): Promise<number> {
  let agent: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--agent') {
      agent = args[++i] ?? '';
    } else if (arg.startsWith('--agent=')) {
      agent = arg.slice('--agent='.length);
    } else rest.push(arg);
  }
  const prefix = agent === undefined ? 'buckets hook' : `buckets hook --agent ${agent}`;
  const adapter = findAdapter(agent ?? DEFAULT_AGENT);
  if (adapter === undefined) {
    io.stderr(`buckets hook: unknown agent "${agent ?? ''}". Agents with hooks: ${ADAPTERS.filter((a) => a.events.length > 0).map((a) => a.name).join(', ')}.\n`);
    return 1;
  }
  if (adapter.events.length === 0) {
    io.stderr(`${prefix}: ${adapter.title} has no hooks. Run \`buckets init --git-hook\` and \`buckets check\` in CI to hold the rules for it.\n`);
    return 1;
  }
  const event = rest[0];
  if (event === undefined || !adapter.events.includes(event)) {
    io.stderr(`${prefix}: unknown event "${event ?? ''}". Events: ${adapter.events.join(', ')}.\n`);
    return 1;
  }
  try {
    return await adapter.run(ctx, io, event);
  } catch (error) {
    // Adapters catch their own errors. This is the last guard, so a broken adapter never breaks the session.
    io.stderr(`${prefix} ${event}: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return 0;
  }
}
