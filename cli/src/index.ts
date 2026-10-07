import { spawn } from 'node:child_process';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { defaultContext } from './api.js';
import { main } from './cli.js';
import type { Io } from './commands/io.js';
import { updateCacheDir, type UpdateDeps } from './core/update.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Runs an install command through the shell, which finds npm.cmd and the other .cmd shims on Windows. */
function run(command: string, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const updates: UpdateDeps = {
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  cacheDir: updateCacheDir(process.env, process.platform, os.homedir()),
  // Like version.ts: src/index.ts and the bundled dist/index.js both sit one level below the package.json.
  packageDir: fileURLToPath(new URL('..', import.meta.url)),
  run,
};

const io: Io = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  readStdin,
  isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  openPrompt: () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return { ask: (question) => rl.question(question), close: () => rl.close() };
  },
  cwd: process.cwd(),
  env: process.env,
  terminal: { stdout: Boolean(process.stdout.isTTY), stderr: Boolean(process.stderr.isTTY), columns: process.stdout.columns ?? process.stderr.columns },
  updates,
};

main(defaultContext(), io, process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`buckets: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 3;
  },
);
