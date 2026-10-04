// The projects an agent session touched, for sessions opened in a folder above the projects. The hooks record each
// project in a small file outside the projects, keyed by the session id, and the stop hooks check those projects.
// Every function here swallows its errors: a broken or missing state file means "nothing recorded", never a crash.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_FILE } from '../core/paths.js';

/** The folder under the system temp folder that holds one state file per session. */
export const SESSION_DIR_NAME = 'slopbuckets-sessions';

/** A larger state file is malformed: no real session touches that many projects. */
export const MAX_STATE_BYTES = 64 * 1024;

/** The most projects one state file records. A project past the cap is not recorded. */
export const MAX_SESSION_PROJECTS = 256;

/** Session ids are UUIDs or similar tokens. Anything that could leave the folder or name a device is refused. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The state file of a session: `<temp>/slopbuckets-sessions/<session_id>.jsonl`, with one JSON string per line, the
 * absolute folder of a project. Lines are appended, so two hooks that run at the same time do not lose a project.
 * Null when the id is missing or is not a safe file name, which turns tracking off.
 */
export function sessionStateFile(sessionId: unknown, baseDir: string = os.tmpdir()): string | null {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
  return path.join(baseDir, SESSION_DIR_NAME, `${sessionId}.jsonl`);
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The recorded projects, in the order they were first recorded. `ok` is false when the file is too large or has a
 * line that is not a JSON string with an absolute path; such a file counts as empty and the next record replaces it.
 * A missing file is ok and empty.
 */
export function readSessionProjects(file: string): { ok: boolean; projects: string[] } {
  let text: string;
  try {
    if (statSync(file).size > MAX_STATE_BYTES) return { ok: false, projects: [] };
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: (error as NodeJS.ErrnoException).code === 'ENOENT', projects: [] };
  }
  const projects: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return { ok: false, projects: [] };
    }
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) return { ok: false, projects: [] };
    if (!projects.some((p) => samePath(p, value))) projects.push(value);
  }
  return { ok: projects.length <= MAX_SESSION_PROJECTS, projects: projects.slice(0, MAX_SESSION_PROJECTS) };
}

/** Replaces the state file through a temporary file and a rename, so a reader never sees half a file. */
export function writeSessionProjects(file: string, projects: string[]): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, projects.map((p) => `${JSON.stringify(p)}\n`).join(''), { encoding: 'utf8', mode: 0o600 });
    try {
      renameSync(temp, file);
    } catch {
      rmSync(temp, { force: true });
    }
  } catch {
    // Tracking is best effort.
  }
}

/** Adds a project folder to the session's state file, unless it is already there. Never throws. */
export function recordSessionProject(file: string | null, projectDir: string): void {
  if (file === null) return;
  try {
    const dir = path.resolve(projectDir);
    const state = readSessionProjects(file);
    if (state.projects.some((p) => samePath(p, dir))) return;
    if (!state.ok) {
      writeSessionProjects(file, [dir]);
      return;
    }
    if (state.projects.length >= MAX_SESSION_PROJECTS) return;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(dir)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Tracking is best effort.
  }
}

/**
 * The recorded projects that still exist. A project whose folder or buckets.config.json is gone is removed from the
 * file. Empty when tracking is off or the file is missing or malformed.
 */
export function liveSessionProjects(file: string | null): string[] {
  if (file === null) return [];
  const state = readSessionProjects(file);
  if (!state.ok) return [];
  const live = state.projects.filter((dir) => {
    try {
      return statSync(path.join(dir, CONFIG_FILE)).isFile();
    } catch {
      return false;
    }
  });
  if (live.length !== state.projects.length) writeSessionProjects(file, live);
  return live;
}

/** Folder names the scan for projects never enters. */
const SKIP_DIRS = new Set(['node_modules']);

/**
 * The projects in and below `dir`, found by looking for buckets.config.json. The scan does not enter a project
 * (its nested projects are listed in its lock), dot folders, node_modules or linked folders, stops at `maxDepth`
 * levels below `dir` and reads at most `maxDirs` folders, so it stays fast on a large tree.
 */
export function projectsBelow(dir: string, maxDepth = 3, maxDirs = 500): string[] {
  const found: string[] = [];
  let level = [path.resolve(dir)];
  let read = 0;
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (const current of level) {
      if (read++ >= maxDirs) return found;
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      if (entries.some((e) => e.name === CONFIG_FILE && e.isFile())) {
        found.push(current);
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) next.push(path.join(current, entry.name));
      }
    }
    level = next;
  }
  return found;
}
