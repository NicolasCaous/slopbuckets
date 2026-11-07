// Shared helpers for the unit tests: a context with a fake engine and a fake process IO.
import { CEILING } from '@slopbuckets/adapter-ts/test-support';
import type { Context, Io, Prompt } from '../context/context.js';
import { createFakeEngine } from './fake-engine.js';

export const TEST_CLI_VERSION = '1.0.0';

export function testContext(): Context {
  return { cliVersion: TEST_CLI_VERSION, engine: createFakeEngine() };
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
    // `buckets` finds no config above a test project, and git no repository.
    env: { GIT_CEILING_DIRECTORIES: CEILING, ...options.env },
    ...(options.terminal ? { terminal: options.terminal } : {}),
  };
  return io;
}
