// `buckets merge-driver %O %A %B`: the git merge driver of buckets.config.json. It merges the base, ours and theirs
// as maps, so two branches that each add a dependsOn entry, a bucket or a glob merge cleanly, and writes the result to
// %A in the form of `buckets fmt`. Only a key that both sides changed differently is a conflict: the driver then puts
// conflict markers around the top-level key or the bucket that holds it, and exits with 1.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Context, Io } from '../context/index.js';
import { CONFIG_FILE, EXIT_CODES } from '../contract/index.js';
import { isRecord, parseJson } from '../files/index.js';
import { writeProjectFile, type InstallStep } from '../hooks/index.js';
import { message } from '../output/index.js';
import { Conflict, formatConfig } from './fmt.js';
import { FAILED, parseCommand } from './io.js';

const USAGE = 'Usage: buckets merge-driver <base> <ours> <theirs>';
export const MERGE_DRIVER = 'slopbuckets';
export const ATTRIBUTES_LINE = `${CONFIG_FILE} merge=${MERGE_DRIVER}`;

const isFlat = (v: unknown): v is unknown[] => Array.isArray(v) && v.every((item) => typeof item !== 'object' || item === null);

interface Merged {
  value: unknown;
  conflict: boolean;
}

/**
 * Three-way merge of one value. `undefined` stands for a missing key. Objects merge per key; arrays of plain values
 * merge as sets, keeping what either side added and dropping what either side removed.
 */
function merge(base: unknown, ours: unknown, theirs: unknown): Merged {
  if (isDeepStrictEqual(ours, theirs) || isDeepStrictEqual(base, theirs)) return { value: ours, conflict: false };
  if (isDeepStrictEqual(base, ours)) return { value: theirs, conflict: false };
  if (isRecord(ours) && isRecord(theirs) && (base === undefined || isRecord(base))) {
    const value: Record<string, unknown> = {};
    let conflict = false;
    for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
      const m = merge((base as Record<string, unknown> | undefined)?.[key], ours[key], theirs[key]);
      conflict ||= m.conflict;
      if (m.value !== undefined) value[key] = m.value;
    }
    return { value, conflict };
  }
  if (isFlat(ours) && isFlat(theirs) && (base === undefined || isFlat(base))) {
    const removed = (side: unknown[]) => ((base as unknown[] | undefined) ?? []).filter((item) => !side.some((x) => isDeepStrictEqual(x, item)));
    const gone = [...removed(ours), ...removed(theirs)];
    const value: unknown[] = [];
    for (const item of [...ours, ...theirs]) {
      if (!gone.some((x) => isDeepStrictEqual(x, item)) && !value.some((x) => isDeepStrictEqual(x, item))) value.push(item);
    }
    return { value, conflict: false };
  }
  return { value: undefined, conflict: true };
}

/** Merges per top-level key and per bucket, and turns each key or bucket with a conflict inside into a Conflict. */
export function mergeConfigs(base: unknown, ours: unknown, theirs: unknown): { value: Record<string, unknown>; conflicts: number } {
  const [b, o, t] = [base, ours, theirs].map((v) => (isRecord(v) ? v : {})) as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
  const value: Record<string, unknown> = {};
  let conflicts = 0;
  const put = (target: Record<string, unknown>, key: string, bv: unknown, ov: unknown, tv: unknown): void => {
    const m = merge(bv, ov, tv);
    if (m.conflict) {
      conflicts++;
      target[key] = new Conflict(ov, tv);
    } else if (m.value !== undefined) target[key] = m.value;
  };
  for (const key of new Set([...Object.keys(o), ...Object.keys(t)])) {
    if (key === 'buckets' && isRecord(o.buckets) && isRecord(t.buckets)) {
      const bb = isRecord(b.buckets) ? b.buckets : {};
      const buckets: Record<string, unknown> = {};
      for (const name of new Set([...Object.keys(o.buckets), ...Object.keys(t.buckets)])) put(buckets, name, bb[name], o.buckets[name], t.buckets[name]);
      value.buckets = buckets;
    } else put(value, key, b[key], o[key], t[key]);
  }
  return { value, conflicts };
}

export async function mergeDriverCommand(_ctx: Context, io: Io, args: string[]): Promise<number> {
  const parsed = parseCommand(io, 'merge-driver', USAGE, args, {}, 3);
  if (typeof parsed === 'number') return parsed;
  if (parsed.positionals.length !== 3) {
    io.stderr(`buckets merge-driver: needs three files, the base, ours and theirs, as git passes them with %O %A %B. ${USAGE}\n`);
    return EXIT_CODES.usage;
  }
  const [basePath, oursPath, theirsPath] = parsed.positionals.map((a) => path.resolve(io.cwd, a)) as [string, string, string];
  const texts = [basePath, oursPath, theirsPath].map((file) => (existsSync(file) ? readFileSync(file, 'utf8') : ''));
  let values: unknown[];
  try {
    values = texts.map((text) => (text.trim() === '' ? {} : parseJson(text)));
  } catch (error) {
    // Not JSON on some side: the plain line conflict of the whole file, for a human to resolve.
    writeFileSync(oursPath, `<<<<<<< ours\n${texts[1]}=======\n${texts[2]}>>>>>>> theirs\n`, 'utf8');
    io.stderr(`buckets merge-driver: ${CONFIG_FILE} is not valid JSON on one side (${message(error)}), so the whole file is a conflict.\n`);
    return FAILED;
  }
  const { value, conflicts } = mergeConfigs(values[0], values[1], values[2]);
  writeFileSync(oursPath, formatConfig(value), 'utf8');
  if (conflicts === 0) return EXIT_CODES.ok;
  io.stderr(`buckets merge-driver: ${conflicts} ${conflicts === 1 ? 'key or bucket' : 'keys or buckets'} of ${CONFIG_FILE} changed on both sides. Resolve the conflict markers, then run buckets fmt.\n`);
  return FAILED;
}

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, out: (result.stdout ?? '').trim() };
}

/**
 * Sets up the merge driver for the project at `projectDir`: the line of .gitattributes, committed with the project,
 * and `merge.slopbuckets.driver` in the git config of this clone. `command` starts the CLI, such as `buckets`.
 */
export function installMergeDriver(projectDir: string, command: string): InstallStep[] {
  const steps: InstallStep[] = [];
  const file = path.join(projectDir, '.gitattributes');
  try {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (current.split(/\r?\n/).some((line) => line.trim().split(/\s+/).join(' ') === ATTRIBUTES_LINE)) {
      steps.push({ status: 'kept', text: `.gitattributes already sends ${CONFIG_FILE} to the slopbuckets merge driver` });
    } else {
      const eol = current.includes('\r\n') ? '\r\n' : '\n';
      const separator = current === '' || current.endsWith('\n') ? '' : eol;
      writeProjectFile(projectDir, file, `${current}${separator}${ATTRIBUTES_LINE}${eol}`);
      steps.push({ status: 'done', text: `${current === '' ? 'Created' : 'Updated'} .gitattributes so git merges ${CONFIG_FILE} with buckets merge-driver` });
    }
  } catch (error) {
    return [{ status: 'failed', text: `Could not update .gitattributes: ${message(error)}` }];
  }
  const driver = `${command} merge-driver %O %A %B`;
  if (!git(['rev-parse', '--git-dir'], projectDir).ok) {
    steps.push({ status: 'todo', text: `This folder is not a git work tree, so the merge driver is not set up in the git config. Run \`buckets init\` again after \`git init\`.` });
  } else if (git(['config', '--local', '--get', `merge.${MERGE_DRIVER}.driver`], projectDir).out === driver) {
    steps.push({ status: 'kept', text: `The git config already has the slopbuckets merge driver` });
  } else if (
    git(['config', '--local', `merge.${MERGE_DRIVER}.name`, `slopbuckets ${CONFIG_FILE}`], projectDir).ok &&
    git(['config', '--local', `merge.${MERGE_DRIVER}.driver`, driver], projectDir).ok
  ) {
    steps.push({ status: 'done', text: `Set merge.${MERGE_DRIVER}.driver in the git config of this clone. Each clone needs it once: run \`buckets init\` there too.` });
  } else {
    steps.push({ status: 'failed', text: `Could not set merge.${MERGE_DRIVER}.driver in the git config` });
  }
  return steps;
}

/** Undoes installMergeDriver: the .gitattributes line, the file if that line was all it held, and the git config section. */
export function uninstallMergeDriver(projectDir: string): InstallStep[] {
  const steps: InstallStep[] = [];
  const file = path.join(projectDir, '.gitattributes');
  try {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const lines = current.split(/\r?\n/);
    const kept = lines.filter((line) => line.trim().split(/\s+/).join(' ') !== ATTRIBUTES_LINE);
    if (kept.length !== lines.length) {
      if (kept.every((line) => line.trim() === '')) {
        rmSync(file, { force: true });
        steps.push({ status: 'done', text: `Removed .gitattributes, which held only the slopbuckets merge driver line` });
      } else {
        writeProjectFile(projectDir, file, kept.join(current.includes('\r\n') ? '\r\n' : '\n'));
        steps.push({ status: 'done', text: `Removed the slopbuckets merge driver line from .gitattributes` });
      }
    }
  } catch (error) {
    steps.push({ status: 'failed', text: `Could not update .gitattributes: ${message(error)}` });
  }
  if (git(['config', '--local', '--get-regexp', `^merge\\.${MERGE_DRIVER}\\.`], projectDir).ok) {
    steps.push(
      git(['config', '--local', '--remove-section', `merge.${MERGE_DRIVER}`], projectDir).ok
        ? { status: 'done', text: `Removed merge.${MERGE_DRIVER} from the git config of this clone` }
        : { status: 'failed', text: `Could not remove merge.${MERGE_DRIVER} from the git config` },
    );
  }
  return steps;
}
