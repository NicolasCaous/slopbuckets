// Temporary projects for the unit tests of the CLI, in a run folder of the shared test support of the adapter
// package (adapters/ts/src/test-support.ts), removed after each test.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { removeFolder, retry, runFolder } from '@slopbuckets/adapter-ts/test-support';

export const TMP_ROOT = runFolder();

const created: string[] = [];

/** Writes `files` (project path to content) into a new temporary folder and returns its absolute path. */
export function makeProject(files: Record<string, string>, withDefaults = true): string {
  const dir = path.join(TMP_ROOT, randomUUID());
  created.push(dir);
  const all: Record<string, string> = withDefaults
    ? {
        'buckets.config.json': '{ "buckets": {} }\n',
        'package.json': JSON.stringify({ name: 'fixture', dependencies: { axios: '1.0.0' } }),
        ...files,
      }
    : files;
  for (const [file, content] of Object.entries(all)) writeFile(dir, file, content);
  retry(() => mkdirSync(dir, { recursive: true }));
  return dir;
}

export function writeFile(dir: string, file: string, content: string): void {
  const abs = path.join(dir, file);
  retry(() => mkdirSync(path.dirname(abs), { recursive: true }));
  retry(() => writeFileSync(abs, content, 'utf8'));
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

/** Removes every folder created by makeProject. The run folder itself goes when the test file ends. */
export function cleanupProjects(): void {
  for (const dir of created.splice(0)) removeFolder(dir);
}
