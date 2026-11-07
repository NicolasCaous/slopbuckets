import { describe, expect, it } from 'vitest';
import { SAMPLES } from '../testing/samples.js';
import { emptySessionState, parseSessionState, sessionFile } from './session.js';

const a = SAMPLES['import-private'];

describe('sessionFile', () => {
  it('builds the path from the session and agent ids', () => {
    expect(sessionFile('00000000-0000-4000-8000-000000000000')).toBe('.buckets/sessions/00000000-0000-4000-8000-000000000000.json');
    expect(sessionFile('abc', 'agent_1')).toBe('.buckets/sessions/abc-agent_1.json');
    expect(sessionFile('abc', null)).toBe('.buckets/sessions/abc.json');
  });

  it('rejects ids that could leave the folder', () => {
    for (const id of ['', '..', '.', '../x', 'a/b', 'a\\b', 'C:x', 'x'.repeat(129)]) expect(sessionFile(id)).toBeNull();
    expect(sessionFile('abc', '../x')).toBeNull();
  });
});

describe('parseSessionState', () => {
  it('reads a valid state', () => {
    const state = { ...emptySessionState(), shown: ['k'], pending: [a], dirty: true };
    expect(parseSessionState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('returns an empty state for another version or a wrong shape', () => {
    for (const raw of [null, 3, [], { version: 2 }, { ...emptySessionState(), shown: [1] }, { ...emptySessionState(), pending: [{}] }]) {
      expect(parseSessionState(raw)).toEqual(emptySessionState());
    }
  });
});
