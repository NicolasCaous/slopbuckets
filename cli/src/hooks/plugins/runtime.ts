// The shared part of the plugin files that slopbuckets writes for OpenCode, Pi and Amp: finding and spawning the
// `buckets` command, reading its JSON answer and warning once when it cannot run. Each plugin file is self-contained
// (it imports only Node built-ins, which Bun also provides), because it lives in the user's project without
// dependencies. The code below is text, not compiled here: ./plugins.test.ts transpiles and runs every plugin.
//
// The plugin code is kept in String.raw literals, so it must never contain a backtick or a dollar sign followed by a
// brace. Backslashes in it are written once, as in a normal source file.
import { PLUGIN_MARKER } from '../plugin-file.js';

export const DOCS_BASE = 'https://nicolascaous.github.io/slopbuckets/docs/guide/agents/';

/** The first lines of a plugin file: the ownership marker, what the file does and the imports. */
export function pluginHeader(agent: string, title: string): string {
  return `// @ts-nocheck
// ${PLUGIN_MARKER}: the slopbuckets plugin for ${title}. "buckets init --agent ${agent}" wrote this file and rewrites
// it on the next run, so local edits are lost. Docs: ${DOCS_BASE}${agent}.html
//
// The plugin holds no rules. For each guarded tool call it runs "buckets hook --agent ${agent} <event>" with a JSON object
// on stdin and applies the JSON answer. When the buckets command cannot run, the plugin allows everything and warns
// once per session. Set SLOPBUCKETS_BIN to the path of the buckets command (or of its index.js) to choose it.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

const AGENT = "${agent}";
const TITLE = "${title}";
`;
}

/** Finds and runs the CLI. Defines callBuckets(event, payload, cwd), reportFailure and warnOnce. */
export const RUNTIME = String.raw`
// Milliseconds before a call is abandoned. A timed out call counts as a failure: the tool runs and a warning shows.
const TIMEOUT_MS = { "pre-tool-use": 10000, "post-tool-use": 30000, "stop": 60000, "subagent-stop": 60000 };
// The text the plugin puts before every message it sends as the user, so it can tell them from the human's.
const MARK = "[slopbuckets] ";
const warned = new Set();

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch (error) {
    return false;
  }
}

function cliEntryNear(dir) {
  const entry = path.join(dir, "node_modules", "slopbuckets", "dist", "index.js");
  return isFile(entry) ? entry : null;
}

/** The CLI installed in the project or a folder above it. */
function localEntry(start) {
  let dir = path.resolve(start);
  for (;;) {
    const entry = cliEntryNear(dir);
    if (entry !== null) return entry;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findOnPath(name) {
  const value = process.env.PATH || process.env.Path || "";
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".com"] : [""];
  for (const dir of value.split(path.delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      if (isFile(file)) return file;
    }
  }
  return null;
}

/** OpenCode and Amp run on Bun, so the CLI runs with the node on PATH. Pi runs on Node and can reuse its binary. */
function nodeCommand() {
  const onPath = findOnPath("node");
  if (onPath !== null) return onPath;
  if (/^node(\.exe)?$/i.test(path.basename(process.execPath || ""))) return process.execPath;
  return "node";
}

function commandFor(file) {
  if (/\.[cm]?js$/i.test(file)) return { file: nodeCommand(), args: [file], shell: false };
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    // npm installs buckets.cmd on Windows, and spawn cannot start a .cmd file without a shell. When the real entry sits
    // next to the shim, as with npm i -g, run it with node instead; otherwise go through cmd.exe.
    const entry = cliEntryNear(path.dirname(file));
    if (entry !== null) return { file: nodeCommand(), args: [entry], shell: false };
    return { file: '"' + file + '"', args: [], shell: true };
  }
  return { file: file, args: [], shell: false };
}

/** SLOPBUCKETS_BIN first, then the CLI of the project, then buckets on PATH. Null when none exists. */
function resolveCommand(cwd) {
  const override = process.env.SLOPBUCKETS_BIN;
  if (override) return commandFor(override);
  const local = localEntry(cwd);
  if (local !== null) return commandFor(local);
  const global = findOnPath("buckets");
  if (global !== null) return commandFor(global);
  return null;
}

/**
 * Runs "buckets hook --agent AGENT <event>" with the payload on stdin. Resolves to { ok: true, answer } with the JSON
 * object of the last stdout line, or { ok: false, missing, detail }. It never rejects.
 */
function callBuckets(event, payload, cwd) {
  return new Promise(function (resolve) {
    let command;
    try {
      command = resolveCommand(cwd);
    } catch (error) {
      command = null;
    }
    if (command === null) {
      resolve({ ok: false, missing: true, detail: "no buckets command on PATH or in node_modules" });
      return;
    }
    let child;
    try {
      const argv = command.args.concat(["hook", "--agent", AGENT, event]);
      const options = { cwd: cwd, shell: command.shell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] };
      // Through a shell, the command is one string. Every word in argv is a fixed name, so nothing needs quoting.
      child = command.shell ? spawn([command.file].concat(argv).join(" "), options) : spawn(command.file, argv, options);
    } catch (error) {
      resolve({ ok: false, missing: true, detail: String((error && error.message) || error) });
      return;
    }
    let out = "";
    let err = "";
    let done = false;
    const finish = function (result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const limit = TIMEOUT_MS[event] || 30000;
    const timer = setTimeout(function () {
      try {
        child.kill();
      } catch (error) {
        // The process is already gone.
      }
      finish({ ok: false, missing: false, detail: "buckets hook " + event + " took more than " + limit / 1000 + " seconds" });
    }, limit);
    child.stdout.on("data", function (chunk) {
      out += chunk;
    });
    child.stderr.on("data", function (chunk) {
      err += chunk;
    });
    child.on("error", function (error) {
      finish({ ok: false, missing: error && error.code === "ENOENT", detail: String((error && error.message) || error) });
    });
    child.on("close", function (code) {
      const lines = out.trim().split(/\r?\n/);
      try {
        const answer = JSON.parse(lines[lines.length - 1]);
        if (answer !== null && typeof answer === "object" && !Array.isArray(answer)) {
          finish({ ok: true, answer: answer });
          return;
        }
      } catch (error) {
        // Not JSON: an old CLI, a crash or a shell error. Reported below.
      }
      // 9009 is cmd.exe's "is not recognized" and 127 is a POSIX shell's "command not found".
      const missing = command.shell && (code === 9009 || code === 127);
      const text = (err.trim() || out.trim()).slice(0, 600);
      finish({ ok: false, missing: missing, detail: "buckets hook " + event + " exited with code " + code + (text ? ": " + text : "") });
    });
    child.stdin.on("error", function () {
      // The process ended before it read stdin. Its exit code tells what happened.
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Shows a warning once per key: on stderr, and in the harness UI when notify is given. */
function warnOnce(key, message, notify) {
  if (warned.has(key)) return;
  warned.add(key);
  try {
    console.error("[slopbuckets] " + message);
  } catch (error) {
    // No console.
  }
  if (typeof notify !== "function") return;
  try {
    const result = notify(message);
    if (result && typeof result.catch === "function") result.catch(function () {});
  } catch (error) {
    // The harness UI is not available in this mode.
  }
}

/** Warns once per session that a call ran without its check, and why. */
function reportFailure(result, sessionId, notify) {
  const session = sessionId || "default";
  if (result.missing) {
    warnOnce(
      "missing:" + session,
      "The buckets command was not found, so the lock guard, the feedback after edits and the end-of-turn check are off in this " +
        TITLE + " session. Install slopbuckets in the project (npm i -D slopbuckets) or globally (npm i -g slopbuckets), or set " +
        "SLOPBUCKETS_BIN to the path of the buckets command, then restart " + TITLE + ". Detail: " + result.detail,
      notify,
    );
    return;
  }
  warnOnce("failed:" + session, "A slopbuckets check could not run, so the tool call went ahead without it. " + result.detail, notify);
}
`;
