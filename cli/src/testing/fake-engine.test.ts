import { describe, expect, it } from 'vitest';
import { createFakeEngine } from './fake-engine.js';
import { SAMPLES } from './samples.js';

describe('createFakeEngine', () => {
  it('returns scripted results and commits edits unless the config would be invalid', async () => {
    const engine = createFakeEngine({
      violations: [SAMPLES['file-unowned']],
      edits: {
        'src/billing/invoice.ts': [SAMPLES['file-unowned'], SAMPLES['import-private']],
        'buckets.config.json': [SAMPLES['config-invalid']],
      },
    });
    expect((await engine.checkAll('/p')).exitCode).toBe(1);
    const denied = await engine.checkEdit('/p', { path: '/p/buckets.config.json', content: '{' });
    expect(denied.violations).toEqual([SAMPLES['config-invalid']]);
    expect(engine.current()).toEqual([SAMPLES['file-unowned']]);
    const edited = await engine.checkEdit('C:\\p', [{ path: 'C:\\p\\src\\billing\\invoice.ts', content: 'x' }]);
    expect(edited.violations).toHaveLength(2);
    expect(await engine.recheck('/p', [SAMPLES['import-private'], SAMPLES['import-dynamic']])).toEqual([SAMPLES['import-private']]);
    engine.set([], [{ code: 'no-tsconfig', project: '.', message: 'No tsconfig.json.' }]);
    expect((await engine.checkAll('/p')).exitCode).toBe(3);
    expect(engine.calls.map((c) => c.method)).toEqual(['checkAll', 'checkEdit', 'checkEdit', 'recheck', 'checkAll']);
    await engine.checkAll('/p', { recursive: false });
    expect(engine.calls.at(-1)).toEqual({ method: 'checkAll', root: '/p', recursive: false });
  });

  it('records the changed paths a snapshot call names', async () => {
    const engine = createFakeEngine({ snapshot: { snapshotVersion: 2, projects: [] } });
    await engine.snapshot('/p');
    await engine.snapshot('/p', { changed: ['src/a.ts'] });
    expect(engine.calls).toEqual([
      { method: 'snapshot', root: '/p' },
      { method: 'snapshot', root: '/p', changed: ['src/a.ts'] },
    ]);
  });
});
