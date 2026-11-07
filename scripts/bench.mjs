#!/usr/bin/env node
// Benchmark of the check and the hooks, with the budgets of docs/guide/performance.md, "Budgets".
// Every sample is a fresh `node cli/dist/index.js ...` process, the way a hook runs, so the times include Node startup.
//
//   node scripts/bench.mjs [--runs N] [--only id,id] [--work DIR] [--json FILE] [--update]
//                          [--no-confirm]
//
// --runs       samples per scenario, 15 by default
// --only       scenario ids or id prefixes, such as pre-edit or hook-burst-50-10k
// --work       folder for the generated projects, <os temp>/slopbuckets-bench by default; a project is generated
//              once and reused while its options and commit match
// --json       where to write the results, <work>/results.json by default
// --update     write the medians and p95 of this platform into bench/baseline.json (npm run bench:update)
// --no-confirm a failed budget or baseline fails at once, without the second measurement
//
// Exit code 1 when a scenario errors or fails its budget or baseline twice in a row (once with --no-confirm).
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import { formatTable, runScenarios, timeProcess, timeProcessAsync, updateBaseline } from './bench/lib.mjs';
import { generate, PRESETS } from './stress-project.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(repo, 'bench', 'baseline.json');
const payloads = JSON.parse(readFileSync(path.join(repo, 'scripts', 'bench', 'claude-payloads.json'), 'utf8'));

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const runs = Number(opt('--runs', 15));
const only = opt('--only', null)?.split(',');
const work = path.resolve(opt('--work', path.join(os.tmpdir(), 'slopbuckets-bench')));
const jsonOut = path.resolve(opt('--json', path.join(work, 'results.json')));
const update = args.includes('--update');
const confirm = !args.includes('--no-confirm');
const cli = path.join(repo, 'cli', 'dist', 'index.js');

// ------------------------------------------------------------------ projects

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (list) => list[Math.floor(rnd() * list.length)];
const git = (root, ...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });

const projects = new Map();
/** The generated project of a preset, made once per work folder. */
function project(name) {
  if (projects.has(name)) return projects.get(name);
  const root = path.join(work, name);
  const marker = path.join(work, `${name}.json`);
  // The text of the generator counts too: a project from an older generator is generated again.
  const generator = createHash('sha1').update(readFileSync(path.join(repo, 'scripts', 'stress-project.mjs'))).digest('hex');
  const options = JSON.stringify({ preset: PRESETS[name], generator });
  let head;
  try {
    const m = JSON.parse(readFileSync(marker, 'utf8'));
    if (m.options === options && git(root, 'rev-parse', 'HEAD').trim() === m.head) head = m.head;
  } catch {
    // No marker or no repository: generate.
  }
  if (!head) {
    console.log(`generating the ${name} project in ${root}`);
    mkdirSync(work, { recursive: true });
    head = generate({ ...PRESETS[name], out: root }).head;
    writeFileSync(marker, JSON.stringify({ options, head }));
  }
  // A TypeScript project has typescript installed. git ignores node_modules, so restore() leaves the link alone.
  const ts = path.join(root, 'node_modules', 'typescript');
  if (!existsSync(ts)) {
    mkdirSync(path.dirname(ts), { recursive: true });
    symlinkSync(path.join(repo, 'node_modules', 'typescript'), ts, 'junction');
  }
  const modules = git(root, 'ls-files', '-z').split('\0').filter((f) => /^(m\d+|Module \d+)\.tsx?$/.test(path.posix.basename(f)));
  const p = { name, root, modules };
  projects.set(name, p);
  return p;
}

/** Puts the tracked files back as committed. .buckets/ is ignored by git, so the cache and sessions stay. */
function restore(p) {
  git(p.root, 'reset', '--hard', '-q');
  git(p.root, 'clean', '-fdq');
}

const read = (p, f) => readFileSync(path.join(p.root, f), 'utf8');
const append = (p, f, text) => writeFileSync(path.join(p.root, f), read(p, f) + text);
function distinct(p, n) {
  const set = new Set();
  while (set.size < Math.min(n, p.modules.length)) set.add(pick(p.modules));
  return [...set];
}

// ------------------------------------------------------------------ drivers

function payload(kind, p, session, toolInput) {
  const body = structuredClone(payloads[kind]);
  Object.assign(body, { session_id: session, cwd: p.root, transcript_path: path.join(work, 'transcripts', `${session}.jsonl`) });
  if (toolInput) body.tool_input = { ...body.tool_input, ...toolInput };
  return body;
}

/**
 * Turns each step into a command: { argv, input?, ok?, json? }. Claude Code runs `buckets hook <event>` with its JSON
 * on stdin and reads the decision as JSON on stdout, so every hook step is one of its four events.
 */
function driver() {
  if (!existsSync(cli)) throw new Error('cli/dist/index.js not found. Run "npm run build" first.');
  const hook = (event, body) => ({ argv: [cli, 'hook', event], input: JSON.stringify(body), json: true });
  const preToolUse = (kind, p, session, toolInput, extra) => hook('pre-tool-use', { ...payload(kind, p, session, toolInput), ...extra });
  return {
    check: () => ({ argv: [cli, 'check'], ok: [0, 1] }),
    // Write sends the whole new text.
    write: (p, session, file, content) => preToolUse('preToolUseWrite', p, session, { file_path: path.join(p.root, file), content }),
    // Edit sends a replacement that the hook applies to the text on disk: here the last line, which grows by `added`.
    edit: (p, session, file, added) => {
      const last = read(p, file).trimEnd().split('\n').at(-1);
      return preToolUse('preToolUseEdit', p, session, { file_path: path.join(p.root, file), old_string: last, new_string: `${last}${added}`, replace_all: true });
    },
    read: (p, session, file) => preToolUse('preToolUseRead', p, session, { file_path: path.join(p.root, file) }),
    // With an agent id the shell call comes from that subagent.
    bash: (p, session, agentId) => preToolUse('preToolUseBash', p, session, undefined, agentId && { agent_id: agentId }),
    stop: (p, session) => hook('stop', payload('stop', p, session)),
    subagentStop: (p, session) => hook('subagent-stop', payload('subagentStop', p, session)),
    postCompact: (p, session) => hook('post-compact', payload('postCompact', p, session)),
    inspect: () => ({ argv: [cli, 'inspect', '--json'], ok: [0, 1] }),
  };
}

const env = (p) => ({ ...process.env, CLAUDE_PROJECT_DIR: p.root, NO_COLOR: '1', SLOPBUCKETS_NO_UPDATE_CHECK: '1' });
function checked(cmd, r) {
  // A hook exits 0 even on an error or an unknown event, and says so on stderr only.
  if (cmd.json && r.stderr.trim()) throw new Error(`node ${cmd.argv.slice(1).join(' ')} wrote to stderr: ${r.stderr.slice(0, 400)}`);
  if (cmd.json && r.stdout.trim()) {
    try {
      JSON.parse(r.stdout);
    } catch {
      throw new Error(`node ${cmd.argv.slice(1).join(' ')} printed output that is not JSON: ${r.stdout.slice(0, 200)}`);
    }
  }
  return { ms: r.ms, bytes: Buffer.byteLength(r.stdout) };
}
const exec = (cmd, p) => checked(cmd, timeProcess({ ...cmd, cwd: p.root, env: env(p) }));
const execAsync = async (cmd, p) => checked(cmd, await timeProcessAsync({ ...cmd, cwd: p.root, env: env(p) }));

/** Every session file must still be valid JSON. */
function checkSessions(p) {
  for (const dir of ['.buckets/sessions', '.buckets/session']) {
    const full = path.join(p.root, dir);
    if (!existsSync(full)) continue;
    for (const f of readdirSync(full).filter((x) => x.endsWith('.json'))) {
      try {
        JSON.parse(readFileSync(path.join(full, f), 'utf8'));
      } catch (error) {
        throw new Error(`${dir}/${f} is corrupt after the parallel calls: ${error.message}`);
      }
    }
  }
}

/**
 * Makes the cache look like an older CLI wrote it. graph.bin (v8.serialize, see cli/src/engine/cache.ts) keeps
 * its data and gets the format version before this one and another CLI version, which is what an update leaves.
 */
function ageCache(dir) {
  const file = path.join(dir, 'graph.bin');
  const cache = v8.deserialize(readFileSync(file));
  writeFileSync(file, v8.serialize({ ...cache, v: cache.v - 1, cli: '1.0.0' }));
}

/** buckets.config.json with `n` dependencies changed: half of them removed, half added. */
function configEdit(p, n) {
  const cfg = JSON.parse(read(p, 'buckets.config.json'));
  const names = Object.keys(cfg.buckets);
  const declared = names.flatMap((a) => Object.keys(cfg.buckets[a].dependsOn).map((b) => [a, b]));
  for (let k = 0; k < n / 2; k++) {
    const [a, b] = declared.splice(Math.floor(rnd() * declared.length), 1)[0];
    delete cfg.buckets[a].dependsOn[b];
  }
  for (let k = 0; k < n / 2; ) {
    const a = pick(names);
    const b = pick(names);
    if (a === b || cfg.buckets[a].dependsOn[b]) continue;
    cfg.buckets[a].dependsOn[b] = 'Added by the benchmark';
    k++;
  }
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

// ------------------------------------------------------------------ scenarios

function scenarios(d) {
  const list = [];
  // def: { warm = true, prepare(p, session), sample(p, i, session) }
  const add = (id, projectName, title, budget, def) => {
    const session = `bench-${id}`;
    let p;
    list.push({
      id,
      title,
      budget,
      prepare: async () => {
        p = project(projectName);
        restore(p);
        rmSync(path.join(p.root, '.buckets', 'sessions'), { recursive: true, force: true });
        if (def.warm !== false) exec(d.check(p, false), p);
        await def.prepare?.(p, session);
      },
      sample: (i) => def.sample(p, i, session),
    });
  };
  const dirty = (p, session) => exec(d.bash(p, session), p);
  // A stop after a shell call leaves the project's pending list in the session, as in a real session.
  const fillSession = (p, session) => {
    dirty(p, session);
    exec(d.stop(p, session), p);
  };
  // Even samples send a Write, odd samples an Edit, both adding one export to a random module.
  const preEdit = (p, i, session) => {
    const f = pick(p.modules);
    const added = `\nexport const benchAdded${i} = ${i};\n`;
    return exec(i % 2 ? d.edit(p, session, f, added) : d.write(p, session, f, `${read(p, f)}${added}`), p);
  };
  const stopAfter = (n) => (p, i, session) => {
    for (const f of distinct(p, n)) append(p, f, `\nexport const benchTouched${i} = ${i};\n`);
    dirty(p, session);
    return exec(d.stop(p, session), p);
  };

  // Check paths, with the budgets of docs/guide/performance.md (p95, ms).
  add('pre-edit-10k', '10k', 'pre-edit, warm cache, 10k files', 150, { sample: preEdit });
  add('pre-edit-50k', '50k', 'pre-edit, warm cache, 50k files', 150, { sample: preEdit });
  add('pre-tool-10k', '10k', 'pre-tool without simulation, 10k files', 80, {
    prepare: fillSession,
    sample: (p, _i, session) => exec(d.read(p, session, pick(p.modules)), p),
  });
  add('pre-tool-after-shell-10k', '10k', 'pre-tool right after a shell command changed a file, 10k files', 80, {
    prepare: fillSession,
    sample: (p, i, session) => {
      dirty(p, session);
      append(p, pick(p.modules), `\nexport const benchShell${i} = ${i};\n`);
      return exec(d.read(p, session, pick(p.modules)), p);
    },
  });
  add('stop-20-10k', '10k', 'stop, 20 changed files of 10k', 300, { sample: stopAfter(20) });
  add('stop-1000-10k', '10k', 'stop, 1,000 changed files of 10k', 1000, { sample: stopAfter(1000) });
  add('cold-check-10k', '10k', 'buckets check, cold, 10k files', 2000, {
    warm: false,
    sample: (p) => {
      rmSync(path.join(p.root, '.buckets'), { recursive: true, force: true });
      return exec(d.check(p, true), p);
    },
  });

  // Hook paths. No budget in the docs: they report time, and output size where it matters.
  add('hook-burst-50-10k', '10k', '50 parallel pre-edit calls on one session file', undefined, {
    sample: async (p, i, session) => {
      const cmds = Array.from({ length: 50 }, (_, k) => {
        const f = pick(p.modules);
        return d.write(p, session, f, `${read(p, f)}\nexport const burst${i}x${k} = ${k};\n`);
      });
      const out = await Promise.all(cmds.map((c) => execAsync(c, p)));
      checkSessions(p);
      return out;
    },
  });
  add('hook-pending-200-10k', '10k', 'pre-tool in a session with 200 pending items', undefined, {
    prepare: (p, session) => {
      distinct(p, 200).forEach((f, k) => append(p, f, `\nexport const benchByName${k} = (name: string) => import(name);\n`));
      fillSession(p, session);
    },
    sample: (p, _i, session) => exec(d.read(p, session, pick(p.modules)), p),
  });
  add('hook-stop-move-1000-10k', '10k', 'stop after a shell command moved 1,000 files', undefined, {
    prepare: (p) => {
      p.moved = distinct(p, 1000).map((f) => [f, path.posix.join(path.posix.dirname(f), 'moved', path.posix.basename(f))]);
    },
    sample: (p, i, session) => {
      // Even runs move the files into moved/, odd runs move them back: every run is a move of 1,000 files.
      for (const [from, to] of p.moved) {
        const [a, b] = i % 2 ? [to, from] : [from, to];
        mkdirSync(path.dirname(path.join(p.root, b)), { recursive: true });
        renameSync(path.join(p.root, a), path.join(p.root, b));
      }
      dirty(p, session);
      return exec(d.stop(p, session), p);
    },
  });
  add('hook-config-100-deps-10k', '10k', 'pre-edit of buckets.config.json changing 100 dependencies', undefined, {
    prepare: (p) => {
      p.configEdit = configEdit(p, 100);
    },
    sample: (p, _i, session) => exec(d.write(p, session, 'buckets.config.json', p.configEdit), p),
  });
  add('hook-cache-deleted-10k', '10k', 'pre-edit after the cache was deleted mid-session', undefined, {
    prepare: fillSession,
    sample: (p, i, session) => {
      rmSync(path.join(p.root, '.buckets', 'cache'), { recursive: true, force: true });
      return preEdit(p, i, session);
    },
  });
  add('hook-cache-old-version-10k', '10k', 'pre-edit with a cache from an older CLI version', undefined, {
    prepare: fillSession,
    sample: (p, i, session) => {
      exec(d.check(p, false), p);
      ageCache(path.join(p.root, '.buckets', 'cache'));
      return preEdit(p, i, session);
    },
  });

  add('hook-subagent-stop-20-10k', '10k', 'subagent-stop after a subagent changed 20 files', undefined, {
    sample: (p, i, session) => {
      for (const f of distinct(p, 20)) append(p, f, `\nexport const benchSubagent${i} = ${i};\n`);
      exec(d.bash(p, session, payloads.subagentStop.agent_id), p);
      return exec(d.subagentStop(p, session), p);
    },
  });
  add('hook-post-compact-10k', '10k', 'post-compact in a session with the pending list of the project', undefined, {
    prepare: fillSession,
    sample: (p, _i, session) => exec(d.postCompact(p, session), p),
  });

  // inspect: the snapshot of 500 buckets and 50k files.
  add('inspect-json-50k', '50k', 'buckets inspect --json, warm cache, 500 buckets, 50k files', undefined, { sample: (p) => exec(d.inspect(p), p) });
  add('inspect-json-change-50k', '50k', 'buckets inspect --json after one file changed, 50k files', undefined, {
    sample: (p, i) => {
      append(p, pick(p.modules), `\nexport const benchInspect${i} = ${i};\n`);
      return exec(d.inspect(p), p);
    },
  });
  // The running server: the watcher names the changed file and the engine reads only that file. The sample ends when
  // the whole snapshot event has arrived, so it covers the debounce, the snapshot and sending 6 MB, not the page.
  add('inspect-live-change-50k', '50k', 'buckets inspect, one file changed to the snapshot event, 50k files', undefined, {
    prepare: async (p) => {
      p.live ??= await liveInspect(p);
      p.liveFile = p.modules.find((m) => m.startsWith('src/b010/')) ?? p.modules[0];
      p.liveText = read(p, p.liveFile);
      // An import of a bucket that src/b010 does not declare, so every sample changes the snapshot.
      p.liveImport = `import '${path.posix.relative(path.posix.dirname(p.liveFile), 'src/b300/index')}';\n`;
    },
    sample: async (p, i) => {
      const event = p.live.next();
      const start = performance.now();
      writeFileSync(path.join(p.root, p.liveFile), i % 2 === 0 ? p.liveImport + p.liveText : p.liveText);
      return { ms: (await event) - start };
    },
  });
  return list;
}

/**
 * Starts `buckets inspect` in the project and follows its /events stream. next() resolves with performance.now() at
 * the end of the next snapshot event. The server stops with this process.
 */
async function liveInspect(p) {
  const proc = spawn(process.execPath, [cli, 'inspect'], { cwd: p.root, env: env(p), stdio: ['ignore', 'pipe', 'pipe'] });
  process.once('exit', () => proc.kill());
  const url = await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      const m = /http:\/\/127\.0\.0\.1:\d+\//.exec(out);
      if (m) resolve(new URL(m[0]));
    });
    proc.on('exit', (code) => reject(new Error(`buckets inspect exited with ${code}`)));
  });
  const waiters = [];
  await new Promise((resolve, reject) => {
    const req = http.get(new URL('/events', url), (res) => {
      res.setEncoding('utf8');
      // An event ends with a blank line, and the JSON of a snapshot holds no newline: keep the chunks of the current
      // event and look for "\n\n" only in each new chunk, so 6 MB arrive without copying.
      let block = [];
      let lastNewline = false;
      res.on('data', (chunk) => {
        for (let from = 0; ; ) {
          // The blank line: "\n\n" in this chunk, or a "\n" that ended the last chunk and one that starts this one.
          const end = chunk.indexOf('\n\n', from);
          const after = from === 0 && lastNewline && chunk[0] === '\n' ? 1 : end >= 0 ? end + 2 : -1;
          lastNewline = false;
          if (after < 0) {
            if (from < chunk.length) block.push(chunk.slice(from));
            lastNewline = from < chunk.length && chunk.endsWith('\n');
            break;
          }
          const at = performance.now();
          block.push(chunk.slice(from, after));
          if (block.join('').startsWith('event: snapshot')) waiters.shift()?.(at);
          block = [];
          from = after;
        }
      });
      resolve();
    });
    req.on('error', reject);
  });
  return { next: () => new Promise((resolve) => waiters.push(resolve)) };
}

// ------------------------------------------------------------------ main

try {
  const d = driver();
  const selected = scenarios(d).filter((s) => !only || only.some((o) => s.id === o || s.id.startsWith(o)));
  if (!selected.length) throw new Error(`no scenario matches --only ${only.join(',')}`);
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  console.log(`bench: ${selected.length} scenarios, ${runs} runs each, node ${process.version}, ${process.platform}, ${os.cpus().length} CPUs`);
  const results = await runScenarios(selected, {
    runs,
    // While updating, only budgets count: the baseline is what is being replaced.
    baseline: update ? null : baseline,
    confirm,
    log: (r) => console.log(`${r.id}: ${r.summary ? `median ${r.summary.median} ms, p95 ${r.summary.p95} ms` : ''} ${r.status}${r.first ? (r.status === 'ok' ? ' (the first measurement failed, the second passed)' : ' (both measurements failed)') : ''}`),
  });
  console.log(`\n${formatTable(results)}`);
  mkdirSync(path.dirname(jsonOut), { recursive: true });
  writeFileSync(jsonOut, `${JSON.stringify({ version: 1, platform: process.platform, node: process.version, cpus: os.cpus().length, runs, date: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`\nresults: ${jsonOut}`);
  if (update) {
    writeFileSync(baselinePath, `${JSON.stringify(updateBaseline(baseline, results, process.platform), null, 2)}\n`);
    console.log(`baseline for ${process.platform} written to bench/baseline.json`);
  }
  process.exit(results.some((r) => r.status === 'fail' || r.status === 'error') ? 1 : 0);
} catch (error) {
  console.error(`bench: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(3);
}
