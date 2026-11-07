// Statistics, budgets, baseline comparison and the run loop of scripts/bench.mjs. No project or CLI knowledge here,
// so the tests drive it with fake scenarios.
import { spawn, spawnSync } from 'node:child_process';

export const BASELINE_VERSION = 1;
export const DEFAULT_TOLERANCE = 0.2;

/** Nearest-rank percentile of numbers. */
export function percentile(values, p) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const round = (x) => Math.round(x * 10) / 10;

/** Summary of samples ({ ms, bytes? }): run count, median, p95, min and max in ms, and the median output size. */
export function summarize(samples) {
  const ms = samples.map((s) => s.ms);
  const out = { runs: ms.length, median: round(median(ms)), p95: round(percentile(ms, 95)), min: round(Math.min(...ms)), max: round(Math.max(...ms)) };
  const bytes = samples.filter((s) => s.bytes !== undefined).map((s) => s.bytes);
  if (bytes.length) out.bytes = Math.round(median(bytes));
  return out;
}

/** The reasons a summary fails: p95 over the budget, or a median more than `tolerance` over the baseline median. */
export function judge(summary, budget, base, tolerance = DEFAULT_TOLERANCE) {
  const reasons = [];
  if (budget !== undefined && summary.p95 > budget) reasons.push(`p95 ${summary.p95} ms is over the budget of ${budget} ms`);
  if (base?.median > 0 && summary.median > base.median * (1 + tolerance)) {
    reasons.push(`median ${summary.median} ms is ${Math.round((summary.median / base.median - 1) * 100)}% over the baseline of ${base.median} ms`);
  }
  return reasons;
}

/** The baseline entry of a scenario for a platform, or undefined. */
export function baselineEntry(baseline, platform, id) {
  return baseline?.platforms?.[platform]?.[id];
}

/** A copy of the baseline with the medians and p95 of the measured results for one platform. */
export function updateBaseline(baseline, results, platform) {
  const next = { ...baseline, version: BASELINE_VERSION, platforms: { ...(baseline?.platforms ?? {}) } };
  const entries = { ...(next.platforms[platform] ?? {}) };
  for (const r of results) if (r.summary) entries[r.id] = { median: r.summary.median, p95: r.summary.p95 };
  next.platforms[platform] = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
  return next;
}

async function measure(s, runs) {
  await s.prepare?.();
  const samples = [];
  for (let i = 0; i < runs; i++) samples.push(...[await s.sample(i)].flat());
  return summarize(samples);
}

/**
 * Runs each scenario `runs` times. A scenario is { id, title?, budget?, skip?, prepare?(), sample(i) } where sample
 * returns { ms, bytes? } or a list of them. A failed budget or baseline is final only when a second measurement
 * fails too (confirm); an error is final at once. Returns the results in order.
 */
export async function runScenarios(scenarios, { runs = 15, baseline = null, platform = process.platform, confirm = true, log = () => {} } = {}) {
  const tolerance = baseline?.tolerance ?? DEFAULT_TOLERANCE;
  const results = [];
  for (const s of scenarios) {
    const r = { id: s.id, title: s.title ?? s.id, budget: s.budget, baseline: baselineEntry(baseline, platform, s.id) };
    results.push(r);
    if (s.skip) {
      r.status = 'skipped';
      r.reasons = [s.skip];
      log(r);
      continue;
    }
    try {
      r.summary = await measure(s, runs);
      r.reasons = judge(r.summary, s.budget, r.baseline, tolerance);
      if (r.reasons.length && confirm) {
        r.first = { summary: r.summary, reasons: r.reasons };
        r.summary = await measure(s, runs);
        r.reasons = judge(r.summary, s.budget, r.baseline, tolerance);
      }
      r.status = r.reasons.length ? 'fail' : 'ok';
    } catch (error) {
      r.status = 'error';
      r.reasons = [error instanceof Error ? error.message : String(error)];
    }
    log(r);
  }
  return results;
}

/** Runs a command and times it. Throws when the exit code is not in `ok`. */
export function timeProcess({ argv, cwd, env, input, ok = [0] }) {
  const start = performance.now();
  const p = spawnSync(process.execPath, argv, { cwd, env, input, encoding: 'utf8', maxBuffer: 1 << 28 });
  const ms = performance.now() - start;
  if (p.error) throw p.error;
  if (!ok.includes(p.status)) throw new Error(`node ${argv.join(' ')} exited with ${p.status}: ${(p.stderr || p.stdout).trim().slice(0, 400)}`);
  return { ms, status: p.status, stdout: p.stdout, stderr: p.stderr };
}

/** Like timeProcess, without blocking, so many commands can run at once. */
export function timeProcessAsync({ argv, cwd, env, input, ok = [0] }) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const p = spawn(process.execPath, argv, { cwd, env });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (status) => {
      const ms = performance.now() - start;
      if (!ok.includes(status)) reject(new Error(`node ${argv.join(' ')} exited with ${status}: ${(stderr || stdout).trim().slice(0, 400)}`));
      else resolve({ ms, status, stdout, stderr });
    });
    p.stdin.end(input ?? '');
  });
}

/** A plain text table of the results. */
export function formatTable(results) {
  const rows = [['scenario', 'runs', 'median', 'p95', 'budget', 'baseline', 'bytes', 'status']];
  for (const r of results) {
    const s = r.summary;
    rows.push([r.id, s?.runs ?? '', s?.median ?? '', s?.p95 ?? '', r.budget ?? '', r.baseline?.median ?? '', s?.bytes ?? '', r.status]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => String(row[i]).length)));
  const lines = rows.map((row) => row.map((cell, i) => (i === 0 || i === row.length - 1 ? String(cell).padEnd(widths[i]) : String(cell).padStart(widths[i]))).join('  ').trimEnd());
  lines.splice(1, 0, widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of results) for (const reason of r.status === 'ok' ? [] : (r.reasons ?? [])) lines.push(`${r.id}: ${reason}`);
  return lines.join('\n');
}
