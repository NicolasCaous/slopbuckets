// Temporary projects for unit tests, created under cli/.test-tmp/run-<pid>-<time>-<random>/ and removed after each
// test. Each test process gets its own run folder, so parallel or overlapping test runs never remove each other's files.
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeLinkFolder } from '../core/links.js';

const TMP_BASE = fileURLToPath(new URL('../../.test-tmp/', import.meta.url));

export const TMP_ROOT = path.join(TMP_BASE, `run-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`);

const created: string[] = [];

/** Writes `files` (project path to content) into a new temporary folder and returns its absolute path. */
export function makeProject(files: Record<string, string>, withDefaults = true): string {
  const dir = path.join(TMP_ROOT, randomUUID());
  created.push(dir);
  const all: Record<string, string> = withDefaults
    ? {
        'buckets.config.json': '{ "root": "root" }\n',
        'package.json': JSON.stringify({ name: 'fixture', dependencies: { axios: '1.0.0' } }),
        ...files,
      }
    : files;
  for (const [file, content] of Object.entries(all)) writeFile(dir, file, content);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Errors Windows returns for a moment while an antivirus or indexer scans a file that was just created. */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES', 'UNKNOWN']);

export function writeFile(dir: string, file: string, content: string): void {
  const abs = path.join(dir, file);
  mkdirSync(path.dirname(abs), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      writeFileSync(abs, content, 'utf8');
      return;
    } catch (error) {
      if (attempt >= 5 || !TRANSIENT.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
    }
  }
}

export function readFile(dir: string, file: string): string {
  return readFileSync(path.join(dir, file), 'utf8');
}

export function fileExists(dir: string, file: string): boolean {
  return existsSync(path.join(dir, file));
}

export function removeFile(dir: string, file: string): void {
  rmSync(path.join(dir, file), { recursive: true, force: true });
}

/** True when this machine lets the tests create a folder link (a junction on Windows needs no privilege). */
export function canLink(dir: string): boolean {
  const target = path.join(dir, 'probe-target');
  const link = path.join(dir, 'probe-link');
  try {
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    removeLinkFolder(link);
    return true;
  } catch {
    return false;
  }
}

/** Removes every folder created by makeProject, then this process's run folder and cli/.test-tmp/ when they are empty. */
export function cleanupProjects(): void {
  // Retries cover Windows, where a child process or a file watcher can hold a handle for a moment after it exits.
  // A folder that still cannot go, such as one a server of a timed out test still watches, stays in this process's run
  // folder. It is scratch space, so leaving it must not fail the next test.
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Left for the next run to ignore; cli/.test-tmp/ is gitignored.
    }
  }
  for (const dir of [TMP_ROOT, TMP_BASE]) {
    try {
      rmdirSync(dir);
    } catch {
      // Not empty: another test in this process, or another test process, still uses it.
    }
  }
}

/** The example from SPEC.md: invoices consumes `logger` from log through two DMZ files. */
export const LOGGER_PROJECT: Record<string, string> = {
  'root/_/main.ts': 'export const main = 1;\n',
  'root/log/_/logger.ts': 'export function logger(message: string): void {\n  console.log(message);\n}\n',
  'root/billing/_/billing.module.ts': 'export const billing = 1;\n',
  'root/billing/invoices/_/create-invoice.ts': "import { logger } from '@root/billing/dmz/.parent/invoices';\nlogger('created');\n",
  'root/billing/payments/_/pay.ts': 'export const pay = 1;\n',
  'root/dmz/log/billing.ts': "export { logger } from '@root/log/_/logger';\n",
  'root/billing/dmz/.parent/invoices.ts': "export { logger } from '@root/dmz/log/billing';\n",
};
