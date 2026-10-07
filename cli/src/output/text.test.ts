import { describe, expect, it } from 'vitest';
import { SCRIPT_OUTPUT_CHANGED } from '../core/lock.js';
import type { CheckReport, LockChange } from '../core/types.js';
import { changedSubjects, formatReport } from './text.js';

const change = (kind: LockChange['kind'], message = 'm'): LockChange => ({ kind, path: 'p', message });

describe('the exit 2 step', () => {
  it('names the kinds of lock differences in the summary it asks for', () => {
    expect(changedSubjects([change('dmz-changed'), change('symbol-added')])).toBe('which DMZ files changed and why');
    expect(changedSubjects([change('bucket-added')])).toBe('which buckets changed and why');
    expect(changedSubjects([change('config-changed', 'buckets.config.json changed since the lock was approved: x.')])).toBe('which settings of buckets.config.json changed and why');
    expect(changedSubjects([change('config-changed', `${SCRIPT_OUTPUT_CHANGED} since the lock was approved: x.`)])).toBe('which script outputs changed and why');
    expect(changedSubjects([change('bucket-removed'), change('config-changed'), change('project-added'), change('link-drift')])).toBe(
      'which buckets, settings of buckets.config.json, nested projects and links changed and why',
    );
    expect(changedSubjects([change('lock-missing')])).toBe('what the first lock approves');
  });

  it('puts them in the report, and says nothing about DMZ files when only the layout changed', () => {
    const report: CheckReport = { exitCode: 2, violations: [], lockChanges: [change('config-changed', 'buckets.config.json changed.'), change('bucket-added')] };
    const text = formatReport(report);
    expect(text).toContain('send the link it prints to the human with a summary of which buckets and settings of buckets.config.json changed and why, and wait');
    expect(text).not.toContain('DMZ files');
  });
});
