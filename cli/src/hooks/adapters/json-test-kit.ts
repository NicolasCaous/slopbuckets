// Test helpers for the adapters built on json-run.ts: a fake hook core that records every input, the four decisions,
// and a check that runs every decision through an event and compares the exact output.
import { afterEach, expect, it } from 'vitest';
import type { HookDecision, HookInput } from '../../contract/hooks.js';
import type { HookAdapter } from '../adapter.js';
import { runAdapter, testCore } from './adapter-test-kit.js';

export const TEXT = 'buckets: 1 pending. Fix the code or edit buckets.config.json. Either is valid. Full detail: buckets check';

export const DECISIONS: Record<HookDecision['kind'], HookDecision> = {
  silent: { kind: 'silent' },
  context: { kind: 'context', text: TEXT },
  deny: { kind: 'deny', text: TEXT },
  block: { kind: 'block', text: TEXT },
  note: { kind: 'note', text: TEXT },
};

/** Puts the real core back after each test of the file. */
export function restoreCoreAfterEach(): void {
  afterEach(() => {
    delete testCore.current;
  });
}

/** Replaces the core with one that answers `answer` and records every input. */
export function fakeCore(answer: HookDecision | ((input: HookInput) => HookDecision) = DECISIONS.silent): HookInput[] {
  const calls: HookInput[] = [];
  testCore.current = async (input) => {
    calls.push(input);
    return typeof answer === 'function' ? answer(input) : answer;
  };
  return calls;
}

export function crashingCore(): void {
  testCore.current = async () => {
    throw new Error('core crashed');
  };
}

export interface Expected {
  code: number;
  out: string;
  err?: string;
}

/**
 * One test per decision kind: the event's exact stdout, stderr and exit code when the core answers it. A kind left out
 * of `expected` must print nothing and exit with 0. No answer may hold an allow or approve.
 */
export function decisionCases(adapter: HookAdapter, event: string, payload: (dir: string) => unknown, dir: () => string, expected: Partial<Record<HookDecision['kind'], Expected>>, env: Record<string, string> = {}): void {
  for (const kind of Object.keys(DECISIONS) as HookDecision['kind'][]) {
    it(`${event}: ${kind}`, async () => {
      const d = dir();
      fakeCore(DECISIONS[kind]);
      const result = await runAdapter(adapter, event, payload(d), d, env);
      const want = expected[kind] ?? { code: 0, out: '' };
      expect(result).toEqual({ code: want.code, out: want.out, err: want.err ?? '' });
      expect(result.out).not.toMatch(/"(allow|approve)"/);
    });
  }
}
