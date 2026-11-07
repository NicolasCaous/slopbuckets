// `buckets show <bucket> [--json]`: one bucket of buckets.config.json with its dependents and its pending violations,
// so an agent can read the part of the architecture it works on instead of the whole config. A bucket of a nested
// project is `<project>:<bucket>`, with the project folder as it is listed in `projects`.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { stderrStyle, type Context, type Io } from '../context/index.js';
import {
  CONFIG_FILE,
  EXIT_CODES,
  publicFiles,
  renderEnvironment,
  renderFull,
  violationBuckets,
  type BucketDef,
  type BucketsConfigV2,
  type DeclaredBy,
} from '../contract/index.js';
import { findProjectDir, parseJson } from '../files/index.js';
import { parseCommand } from './io.js';

const USAGE = 'Usage: buckets show <bucket> [--json], or <project>:<bucket> for a bucket of a nested project';

export async function showCommand(ctx: Context, io: Io, args: string[]): Promise<number> {
  const fail = (text: string, code: number): number => {
    io.stderr(`${stderrStyle(io).error('buckets show:')} ${text}\n`);
    return code;
  };
  const parsed = parseCommand(io, 'show', USAGE, args, { json: { type: 'boolean' } }, 1);
  if (typeof parsed === 'number') return parsed;
  if (parsed.positionals.length !== 1) return fail(`name one bucket. ${USAGE}`, EXIT_CODES.usage);
  const arg = parsed.positionals[0]!;
  const split = arg.lastIndexOf(':');
  const project = split === -1 ? '.' : arg.slice(0, split).replace(/\\/g, '/').replace(/\/+$/, '') || '.';
  const name = arg.slice(split + 1);

  const root = findProjectDir(io.cwd, io.env);
  if (root === null) return fail(`found no ${CONFIG_FILE} in ${io.cwd} or above it. Run buckets init first.`, EXIT_CODES.environment);
  const projectDir = path.join(root, project);
  const configFile = path.join(projectDir, CONFIG_FILE);
  let config: BucketsConfigV2;
  try {
    if (!existsSync(configFile)) return fail(`found no ${CONFIG_FILE} in the project ${project}.`, EXIT_CODES.usage);
    config = parseJson(readFileSync(configFile, 'utf8')) as BucketsConfigV2;
  } catch (error) {
    return fail(`cannot read ${path.relative(io.cwd, configFile) || CONFIG_FILE}: ${(error as Error).message}. Run buckets check to see the problem.`, EXIT_CODES.environment);
  }
  const buckets: Record<string, BucketDef> = config.buckets !== null && typeof config.buckets === 'object' ? config.buckets : {};
  const bucket = Object.hasOwn(buckets, name) ? buckets[name]! : undefined;
  if (bucket === undefined) {
    const known = Object.keys(buckets).sort();
    return fail(`${project === '.' ? '' : `${project} `}has no bucket "${name}". Buckets: ${known.length > 0 ? known.join(', ') : 'none yet'}.`, EXIT_CODES.usage);
  }

  const dependents: DeclaredBy[] = Object.entries(buckets)
    .filter(([, b]) => b?.dependsOn !== null && typeof b?.dependsOn === 'object' && Object.hasOwn(b.dependsOn, name))
    .map(([other, b]) => ({ bucket: other, reason: b.dependsOn[name]! }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
  const result = await ctx.engine.checkAll(projectDir, { recursive: false });
  const violations = result.violations.filter((v) => violationBuckets(v).includes(name));

  if (parsed.values.json) {
    io.stdout(`${JSON.stringify({ project, bucket: name, ...bucket, dependents, violations, environment: result.environment }, null, 2)}\n`);
    return result.environment.length > 0 ? EXIT_CODES.environment : EXIT_CODES.ok;
  }
  const map = (entries: Record<string, string> | undefined): string[] =>
    Object.keys(entries ?? {}).length === 0 ? ['    none'] : Object.entries(entries!).map(([k, reason]) => `    ${k}: ${reason}`);
  const list = (items: string[]): string[] => (items.length === 0 ? ['    none'] : items.map((item) => `    ${item}`));
  const lines = [
    `${project === '.' ? '' : `${project}:`}${name}`,
    `  purpose: ${bucket.purpose}`,
    '  files:',
    ...list(bucket.files ?? []),
    `  public:${bucket.public === null ? ' null (closed: no other bucket may import it)' : ''}`,
    ...(bucket.public === null ? [] : list(publicFiles(bucket.public))),
    '  dependsOn:',
    ...map(bucket.dependsOn),
    '  packages:',
    ...map(bucket.packages),
    ...(bucket.external === undefined ? [] : [`  external: ${bucket.external}`]),
    '  dependents:',
    ...map(Object.fromEntries(dependents.map((d) => [d.bucket, d.reason]))),
    `  violations: ${violations.length === 0 ? 'none' : violations.length}`,
  ];
  const blocks = [lines.join('\n'), ...violations.map(renderFull), ...result.environment.map(renderEnvironment)];
  io.stdout(`${blocks.join('\n\n')}\n`);
  return result.environment.length > 0 ? EXIT_CODES.environment : EXIT_CODES.ok;
}
