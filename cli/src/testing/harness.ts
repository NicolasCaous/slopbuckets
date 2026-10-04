// Shared helpers for the unit tests: a context with the fake adapter, a fake process IO, and shortcuts.
import { runCheck, type CheckOptions, type CheckResult } from '../core/check.js';
import type { Io, Prompt } from '../commands/io.js';
import type { Context, Lock, Violation } from '../core/types.js';
import { writeLockFile } from '../core/lock.js';
import { fakeAdapter, type FakeAdapterOptions } from './fake-adapter.js';

export const TEST_CLI_VERSION = '1.0.0';

export function testContext(options: FakeAdapterOptions = {}): Context & { adapter: ReturnType<typeof fakeAdapter> } {
  return { adapter: fakeAdapter(options), cliVersion: TEST_CLI_VERSION };
}

export async function checkProject(dir: string, options: CheckOptions = {}, ctx: Context = testContext()): Promise<CheckResult> {
  return runCheck(ctx, dir, options);
}

/** Computes the lock of the current state and writes it, like the examples battery does. */
export async function approve(dir: string, ctx: Context = testContext()): Promise<Lock> {
  const result = await runCheck(ctx, dir, { ignoreVersions: true });
  if (!result.lock) throw new Error(`cannot compute lock: ${JSON.stringify(result.report)}`);
  await writeLockFile(dir, result.lock);
  return result.lock;
}

/** `(rule, file)` pairs, sorted, for set comparisons. */
export function pairs(violations: Violation[]): string[] {
  return [...new Set(violations.map((v) => `${v.rule} ${v.file}`))].sort();
}

export function rulesOf(violations: Violation[]): string[] {
  return [...new Set(violations.map((v) => v.rule))].sort();
}

export interface FakeIo extends Io {
  out: string;
  err: string;
  questions: string[];
}

export function fakeIo(options: { cwd: string; stdin?: string; interactive?: boolean; answers?: string[]; env?: Record<string, string>; terminal?: Io['terminal'] }): FakeIo {
  const answers = [...(options.answers ?? [])];
  const io: FakeIo = {
    out: '',
    err: '',
    questions: [],
    stdout: (text) => {
      io.out += text;
    },
    stderr: (text) => {
      io.err += text;
    },
    readStdin: async () => options.stdin ?? '',
    isInteractive: options.interactive ?? false,
    openPrompt: (): Prompt => ({
      ask: async (question) => {
        io.questions.push(question);
        return answers.shift() ?? '';
      },
      close: () => {},
    }),
    cwd: options.cwd,
    env: options.env ?? {},
    ...(options.terminal ? { terminal: options.terminal } : {}),
  };
  return io;
}

