// The `run` of an adapter for a harness without hooks. `buckets hook` refuses such an agent before it gets here,
// because the adapter lists no events; this is the last answer if it is called anyway.
import type { Io } from '../../commands/io.js';
import type { Context } from '../../core/types.js';

export function noHooksRun(title: string): (ctx: Context, io: Io, event: string) => Promise<number> {
  return async (_ctx, io, event) => {
    io.stderr(`buckets hook: ${title} has no hooks, so there is no "${event}" event. Run \`buckets init --git-hook\` and \`buckets check\` in CI instead.\n`);
    return 1;
  };
}
