import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { defaultContext } from './api.js';
import { main } from './cli.js';
import type { Io } from './commands/io.js';
import { findOnPath, updateCacheDir, windowsCommandLine, type RunResult, type UpdateDeps } from './core/update.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** How a program of `buckets update` starts: by name without a shell on POSIX, through cmd.exe on Windows for npm.cmd. */
function spawnProgram(argv: string[], cwd: string, stdio: StdioOptions): ChildProcess | null {
  if (process.platform !== 'win32') return spawn(argv[0] ?? '', argv.slice(1), { cwd, stdio });
  // cmd.exe prints its own error and exits with 1 for a program it cannot find, so look first, like `where`.
  const line = windowsCommandLine(argv);
  if (line === null || findOnPath(argv[0] ?? '', process.env, 'win32') === null) return null;
  return spawn(line, { cwd, shell: true, stdio });
}

/** Runs an install command with the terminal attached, and keeps the end of its stderr to recognize EACCES. */
function run(argv: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    let errorOutput = '';
    const child = spawnProgram(argv, cwd, ['inherit', 'inherit', 'pipe']);
    if (child === null) return resolve({ exitCode: 127, errorOutput });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      errorOutput = (errorOutput + chunk.toString('utf8')).slice(-65536);
    });
    child.on('error', (error: NodeJS.ErrnoException) => resolve({ exitCode: error.code === 'ENOENT' ? 127 : 1, errorOutput }));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, errorOutput }));
  });
}

/** Runs a query such as `npm prefix -g` and resolves with its trimmed stdout, or null when it fails. */
function output(argv: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    let text = '';
    const child = spawnProgram(argv, cwd, ['ignore', 'pipe', 'ignore']);
    if (child === null) return resolve(null);
    child.stdout?.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && text.trim() !== '' ? text.trim() : null));
  });
}

const updates: UpdateDeps = {
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  cacheDir: updateCacheDir(process.env, process.platform, os.homedir()),
  // Like version.ts: src/index.ts and the bundled dist/index.js both sit one level below the package.json.
  packageDir: fileURLToPath(new URL('..', import.meta.url)),
  platform: process.platform,
  run,
  output,
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
