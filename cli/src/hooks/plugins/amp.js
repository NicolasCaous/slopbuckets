// @ts-check
// The plugin file for Amp.
//
// - pre-tool: `tool.call` asks the CLI, with the files the call modifies and the shell command it runs, as Amp's
//   helpers name them. A deny returns `reject-and-continue`. Context waits by tool use id and is appended to the output
//   in `tool.result`. Every other answer is `allow`: `tool.call` is a request event that must return a result, and
//   ToolCallResult (allow, reject-and-continue, modify, synthesize, error) has no neutral value (checked in the Amp
//   plugin API manual, 2026-11-07). Amp asks for no approval by default, so this skips no prompt there. Risk: Amp does
//   not document how the answers of several plugins combine, so with a permission plugin installed, this `allow` might
//   override its reject or confirm.
// - stop and subagent-stop: `agent.end` continues once per user turn when the CLI blocks, with `maxContinuations: 1`.
//   A thread with a parent is a subagent.
// - Amp has no compaction event.
import { decide, MARK } from "./runtime.js";

function threadOf(event) {
  return (event && event.thread && event.thread.id) || "default";
}

function notifier(ctx) {
  return function (message) {
    if (ctx && ctx.ui && typeof ctx.ui.notify === "function") return ctx.ui.notify("slopbuckets: " + message);
  };
}

/** Appends text to an Amp tool output, whose type depends on the tool. */
function appendOutput(output, text) {
  if (typeof output === "string") return output === "" ? text : output + "\n\n" + text;
  if (Array.isArray(output)) return output.concat([{ type: "text", text: text }]);
  if (output !== null && typeof output === "object") return Object.assign({}, output, { slopbuckets: text });
  return text;
}

/** True when the thread of ctx has a parent, which makes it a subagent. */
async function isSubagent(ctx) {
  try {
    return Boolean(ctx && ctx.thread && typeof ctx.thread.parentThreadID === "function" && (await ctx.thread.parentThreadID()));
  } catch (error) {
    return false;
  }
}

export default function slopbuckets(amp) {
  const cwd = process.cwd();
  // Threads whose current user turn already continued once.
  const continued = new Set();
  // Context of a tool call, by tool use id, until its tool.result.
  const notes = new Map();

  const filesOf = function (event) {
    try {
      const uris = amp.helpers.filesModifiedByToolCall(event);
      if (!uris) return [];
      return uris.map(function (uri) {
        return typeof amp.helpers.filePathFromURI === "function" ? amp.helpers.filePathFromURI(uri) : String(uri);
      });
    } catch (error) {
      return [];
    }
  };
  const shellOf = function (event) {
    try {
      return amp.helpers.shellCommandFromToolCall(event) || null;
    } catch (error) {
      return null;
    }
  };
  const ask = function (event, threadId, ctx, extra) {
    return decide(event, Object.assign({ cwd: cwd, sessionId: threadId }, extra), cwd, notifier(ctx));
  };

  amp.on("agent.start", function (event) {
    try {
      if (typeof event.message === "string" && event.message.indexOf(MARK) === 0) return undefined;
      continued.delete(threadOf(event));
    } catch (error) {
      // Keep the flag.
    }
    return undefined;
  });

  amp.on("tool.call", async function (event, ctx) {
    try {
      const shell = shellOf(event);
      const extra = { tool: event.tool, args: event.input || {} };
      if (shell) extra.command = shell.command;
      else extra.paths = filesOf(event);
      const answer = await ask("pre-tool", threadOf(event), ctx, extra);
      if (answer && answer.kind === "deny") return { action: "reject-and-continue", message: answer.text };
      if (answer && answer.kind === "context") notes.set(event.toolUseID, answer.text);
    } catch (error) {
      // Let the tool run.
    }
    return { action: "allow" };
  });

  amp.on("tool.result", function (event) {
    try {
      const text = notes.get(event.toolUseID);
      notes.delete(event.toolUseID);
      if (!text || event.status !== "done") return undefined;
      return { status: "done", output: appendOutput(event.output, text) };
    } catch (error) {
      return undefined;
    }
  });

  amp.on("agent.end", async function (event, ctx) {
    try {
      if (event.status !== "done") return undefined;
      const id = threadOf(event);
      const active = continued.has(id);
      const answer = await ask((await isSubagent(ctx)) ? "subagent-stop" : "stop", id, ctx, { stopHookActive: active });
      if (active || !answer || answer.kind !== "block") return undefined;
      continued.add(id);
      return { action: "continue", userMessage: MARK + answer.text, maxContinuations: 1 };
    } catch (error) {
      return undefined;
    }
  });
}
