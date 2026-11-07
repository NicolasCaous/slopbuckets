// Temporary folders for the unit tests of both packages. The CLI imports this module as
// @slopbuckets/adapter-ts/test-support, so the two packages share one definition.
//
// Every folder lives under .test-tmp/ at the top of the repository, where the repository's own `typescript` resolves,
// or under OUTSIDE_BASE in the temp folder of the OS for a test that needs nothing of the repository to resolve. Each
// test file gets its own run-<pid>-<time>-<random>/ folder, so overlapping test runs never remove each other's files.
// The run folder stays until the test file ends, and the bases stay until the whole run ends (test-global-setup.ts).
// Removing either one while a test still creates folders in it fails on Windows: a folder that was just removed can
// linger for a moment while another program holds a handle on it, and creating anything inside it then fails with EPERM.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';

/** The base inside the repository. */
export const TMP_BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.test-tmp');
/** The base outside the repository, where no node_modules of the repository is above a test project. */
export const OUTSIDE_BASE = path.join(os.tmpdir(), 'slopbuckets-test-tmp');

// Git must not find this repository above a test project, and `buckets` must not find a buckets.config.json there:
// both stop below these folders. A test that needs a repository runs `git init` in its project.
export const CEILING = [TMP_BASE, OUTSIDE_BASE].join(path.delimiter);
process.env.GIT_CEILING_DIRECTORIES = CEILING;

/** A new run folder under `base` for the test file that calls it, removed when that file ends. */
export function runFolder(base: string = TMP_BASE): string {
  const dir = path.join(base, `run-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`);
  // Registered when a test file calls it, so it runs once at the end of that file, after its own hooks.
  afterAll(() => removeFolder(dir));
  return dir;
}

/** Errors Windows returns for a moment while an antivirus or indexer scans a file or folder that was just created. */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES', 'UNKNOWN']);

/** Runs `action` again, up to 5 times with a growing pause, while it fails with one of the TRANSIENT errors. */
export function retry<T>(action: () => T): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return action();
    } catch (error) {
      if (attempt >= 5 || !TRANSIENT.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }
}

/** Creates a new folder named `prefix` plus random characters inside `base`, creating `base` first when needed. */
export function makeTempDir(base: string, prefix: string): string {
  retry(() => mkdirSync(base, { recursive: true }));
  return retry(() => mkdtempSync(path.join(base, prefix)));
}

/** Removes a scratch folder. One that still cannot go after the retries stays, since .test-tmp/ is gitignored. */
export function removeFolder(dir: string): void {
  // Retries cover Windows, where a child process, the compiler or a file watcher can hold a handle for a moment.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Left for a later run to ignore. A server of a timed out test can still watch it, for example.
  }
}
