import { createInterface } from 'node:readline/promises';
import { defaultContext } from './api.js';
import { main } from './cli.js';
import type { Io } from './commands/io.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

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
