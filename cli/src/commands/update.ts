// `buckets update`: parses the command line and calls runUpdate() of the update module.
import { stderrStyle, type Context, type Io } from '../context/index.js';
import { EXIT_CODES } from '../contract/index.js';
import { runUpdate } from '../update/run.js';
import { isVersion } from '../update/index.js';
import { parseCommand } from './io.js';

export const UPDATE_USAGE = 'Usage: buckets update [<version>] [--check] [--json] [--yes]\n';

const OPTIONS = { check: { type: 'boolean' }, json: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' } } as const;

export async function updateCommand(ctx: Context, io: Io, args: string[]): Promise<number> {
  const parsed = parseCommand(io, 'update', UPDATE_USAGE.trimEnd(), args, OPTIONS, 1);
  if (typeof parsed === 'number') return parsed;
  const wanted = parsed.positionals[0]?.replace(/^v(?=\d)/, '');
  if (wanted !== undefined && !isVersion(wanted)) {
    io.stderr(`${stderrStyle(io).error('buckets update:')} "${wanted}" is not a version. Pass a full version such as 1.1.0.\n${UPDATE_USAGE}`);
    return EXIT_CODES.usage;
  }
  return runUpdate(ctx, io, { check: parsed.values.check === true, json: parsed.values.json === true, yes: parsed.values.yes === true, wanted });
}
