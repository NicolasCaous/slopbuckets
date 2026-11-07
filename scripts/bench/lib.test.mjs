// node --test "scripts/bench/*.test.mjs"
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatTable, judge, median, percentile, runScenarios, summarize, timeProcess, timeProcessAsync, updateBaseline } from './lib.mjs';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

describe('statistics', () => {
  test('median and nearest-rank p95', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    assert.equal(percentile(xs, 95), 19);
    assert.equal(percentile(xs, 100), 20);
    assert.equal(percentile([7], 95), 7);
    assert.equal(percentile(Array.from({ length: 15 }, (_, i) => i + 1), 95), 15);
  });

  test('summarize rounds to 0.1 ms and keeps the median output size', () => {
    const s = summarize([{ ms: 10.04, bytes: 100 }, { ms: 20, bytes: 300 }, { ms: 30.06, bytes: 200 }]);
    assert.deepEqual(s, { runs: 3, median: 20, p95: 30.1, min: 10, max: 30.1, bytes: 200 });
    assert.equal(summarize([{ ms: 1 }]).bytes, undefined);
  });
});

describe('budgets and baseline', () => {
  const s = { median: 100, p95: 150 };
  test('p95 over the budget fails, equal passes', () => {
    assert.deepEqual(judge(s, 150, undefined), []);
    assert.match(judge(s, 149, undefined)[0], /p95 150 ms is over the budget of 149 ms/);
  });
  test('a median more than 20% over the baseline fails', () => {
    assert.deepEqual(judge(s, undefined, { median: 84 }), []);
    assert.match(judge(s, undefined, { median: 83 })[0], /20% over the baseline of 83 ms/);
    assert.deepEqual(judge(s, undefined, { median: 50 }, 1), []);
    assert.deepEqual(judge(s, undefined, {}), []);
  });
  test('updateBaseline writes one platform and keeps the others', () => {
    const before = { version: 1, tolerance: 0.2, platforms: { linux: { a: { median: 1, p95: 2 } }, win32: { a: { median: 5, p95: 6 } } } };
    const after = updateBaseline(before, [{ id: 'b', summary: { median: 3, p95: 4 } }, { id: 'c', status: 'error' }], 'linux');
    assert.deepEqual(after.platforms.linux, { a: { median: 1, p95: 2 }, b: { median: 3, p95: 4 } });
    assert.deepEqual(after.platforms.win32, before.platforms.win32);
    assert.equal(after.tolerance, 0.2);
    assert.deepEqual(before.platforms.linux, { a: { median: 1, p95: 2 } });
  });
});

describe('runScenarios', () => {
  const steady = (id, ms, extra = {}) => ({ id, sample: () => ({ ms }), ...extra });

  test('a failure that the second measurement does not repeat passes', async () => {
    let calls = 0;
    const [r] = await runScenarios([{ id: 'noisy', budget: 100, sample: () => ({ ms: calls++ < 3 ? 500 : 50 }) }], { runs: 3 });
    assert.equal(r.status, 'ok');
    assert.equal(r.first.summary.p95, 500);
    assert.equal(r.summary.p95, 50);
  });

  test('a failure confirmed twice is final, and --no-confirm fails at once', async () => {
    let prepared = 0;
    const [r] = await runScenarios([steady('slow', 500, { budget: 100, prepare: () => prepared++ })], { runs: 2 });
    assert.equal(r.status, 'fail');
    assert.equal(prepared, 2);
    const [once] = await runScenarios([steady('slow', 500, { budget: 100 })], { runs: 2, confirm: false });
    assert.equal(once.status, 'fail');
    assert.equal(once.first, undefined);
  });

  test('the baseline of the current platform counts, with its tolerance', async () => {
    const baseline = { tolerance: 0.5, platforms: { linux: { x: { median: 100, p95: 100 } }, win32: { x: { median: 10, p95: 10 } } } };
    const [ok] = await runScenarios([steady('x', 140)], { runs: 1, baseline, platform: 'linux' });
    assert.equal(ok.status, 'ok');
    const [bad] = await runScenarios([steady('x', 140)], { runs: 1, baseline, platform: 'win32' });
    assert.equal(bad.status, 'fail');
    assert.match(bad.reasons[0], /over the baseline of 10 ms/);
  });

  test('errors are final without a second run, skips do not run, list samples are flattened', async () => {
    let runs = 0;
    const results = await runScenarios(
      [
        { id: 'boom', sample: () => (runs++, Promise.reject(new Error('exit 3'))) },
        { id: 'skip', skip: 'no inspect', sample: () => assert.fail('must not run') },
        { id: 'burst', sample: () => [{ ms: 1 }, { ms: 2 }, { ms: 3 }] },
      ],
      { runs: 2 },
    );
    assert.deepEqual(results.map((r) => r.status), ['error', 'skipped', 'ok']);
    assert.equal(runs, 1);
    assert.deepEqual(results[0].reasons, ['exit 3']);
    assert.equal(results[2].summary.runs, 6);
    const table = formatTable(results);
    assert.match(table, /boom: exit 3/);
    assert.match(table, /skip: no inspect/);
  });
});

describe('processes', () => {
  test('timeProcess times a fake command, passes stdin and checks the exit code', () => {
    const r = timeProcess({ argv: [fake, '60', '0', '-'], input: '{"a":1}' });
    assert.ok(r.ms >= 55, `took ${r.ms} ms`);
    assert.equal(r.stdout, '{"a":1}');
    assert.equal(timeProcess({ argv: [fake, '0', '1'], ok: [0, 1] }).status, 1);
    assert.throws(() => timeProcess({ argv: [fake, '0', '3', 'not implemented'] }), /exited with 3: not implemented/);
  });

  test('timeProcessAsync runs commands at the same time', async () => {
    const start = performance.now();
    const out = await Promise.all(Array.from({ length: 8 }, () => timeProcessAsync({ argv: [fake, '300', '0', 'x'] })));
    assert.ok(performance.now() - start < 8 * 300, 'the calls ran one after another');
    assert.ok(out.every((r) => r.stdout === 'x' && r.ms >= 290));
    await assert.rejects(timeProcessAsync({ argv: [fake, '0', '2'] }), /exited with 2/);
  });

  test('a fake CLI over its budget fails the run, under it passes', async () => {
    const scenario = (id, ms, budget) => ({ id, budget, sample: () => timeProcess({ argv: [fake, String(ms)] }) });
    const results = await runScenarios([scenario('fast', 0, 5000), scenario('slow', 200, 100)], { runs: 3 });
    assert.deepEqual(results.map((r) => r.status), ['ok', 'fail']);
    assert.ok(results[1].summary.median >= 200);
  });
});
