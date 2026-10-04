import { existsSync } from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from '../core/cache.js';
import { runCheck } from '../core/check.js';
import { diskCase, relativeToProject, toPosix } from '../core/paths.js';
import { findProjectDir } from '../core/project.js';
import { joinReports, runRecursiveCheck } from '../core/recursive.js';
import type { Context } from '../core/types.js';
import { formatReport } from '../output/text.js';
import { stdoutStyle, type Io } from './io.js';

export const CHECK_USAGE = 'Usage: buckets check [--json] [--no-recursive] [--file <path>]\n';

/** The path of `dir` relative to `base` for the `project` field, `.` when they are the same folder. */
export function projectLabel(base: string, dir: string): string {
  const rel = path.relative(base, dir);
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? '.' : toPosix(rel);
}

export async function checkCommand(ctx: Context, io: Io, args: string[]): Promise<number> {
  let json = false;
  let recursive = true;
  let file: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--no-recursive') recursive = false;
    else if (arg === '--file') {
      file = args[++i];
      if (file === undefined) {
        io.stderr(`buckets check: --file needs a path.\n${CHECK_USAGE}`);
        return 1;
      }
    } else if (arg.startsWith('--file=')) file = arg.slice('--file='.length);
    else {
      io.stderr(`buckets check: unknown option "${arg}".\n${CHECK_USAGE}`);
      return 1;
    }
  }

  const projectDir = findProjectDir(io.cwd) ?? io.cwd;
  const cacheDir = path.join(projectDir, CACHE_DIR);

  if (file !== undefined) {
    // A single file belongs to the nearest project above it, which can be a project nested in the current one.
    const absolute = path.resolve(io.cwd, file);
    // A mistyped path would otherwise "pass every bucket rule", because no rule applies to a file that is not there.
    if (!existsSync(absolute)) {
      io.stderr(`buckets check --file: ${file} does not exist (looked for ${absolute}). Pass the path of an existing file, relative to the current folder.\n`);
      return 1;
    }
    const fileProject = findProjectDir(path.dirname(absolute)) ?? projectDir;
    const result = await runCheck(ctx, fileProject, { file: absolute, cacheDir });
    const label = projectLabel(projectDir, fileProject);
    const report = joinReports([{ path: label, report: result.report }]);
    if (json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    else {
      const typed = relativeToProject(fileProject, absolute);
      const relative = typed === null ? file : diskCase(fileProject, typed);
      // The paths of the report are relative to the file's project, so name it when it is not the current one.
      if (label !== '.') io.stdout(`== Project ${label} (nested, paths below are relative to it)\n\n`);
      io.stdout(formatReport(result.report, result.orphanChains, { style: stdoutStyle(io), file: relative }));
    }
    return report.exitCode;
  }

  const { report, runs } = await runRecursiveCheck(ctx, projectDir, { recursive, cacheDir });
  if (json) {
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const chains = runs.flatMap((run) => run.result.orphanChains.map((chain) => ({ ...chain, project: run.path })));
    io.stdout(formatReport(report, chains, { style: stdoutStyle(io) }));
  }
  return report.exitCode;
}
