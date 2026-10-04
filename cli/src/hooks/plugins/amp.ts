// The plugin file for Amp. Amp's helpers name the files a tool call modifies and the shell command it runs, so the
// plugin sends those instead of the raw tool input. `tool.call` rejects with `reject-and-continue`, `tool.result`
// appends the check of the edited files, and `agent.end` continues once per user turn when `buckets check` fails.
import { pluginHeader, RUNTIME } from './runtime.js';

const BODY = String.raw`
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

export default function slopbuckets(amp) {
  const cwd = process.cwd();
  // Threads whose current user turn already continued once after a failed check.
  const continued = new Set();
  // The files of each tool call, from tool.call to its tool.result.
  const pending = new Map();

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
  const ask = async function (event, threadId, ctx, extra) {
    const payload = Object.assign({ cwd: cwd, projectDir: cwd, sessionId: threadId }, extra);
    const result = await callBuckets(event, payload, cwd);
    if (!result.ok) {
      reportFailure(result, threadId, notifier(ctx));
      return null;
    }
    return result.answer;
  };

  amp.on("agent.start", function (event) {
    if (typeof event.message === "string" && event.message.indexOf(MARK) === 0) return undefined;
    continued.delete(threadOf(event));
    return undefined;
  });

  amp.on("tool.call", async function (event, ctx) {
    try {
      const paths = filesOf(event);
      const shell = shellOf(event);
      if (paths.length > 0) pending.set(event.toolUseID, paths);
      if (paths.length === 0 && !shell) return { action: "allow" };
      const extra = { tool: event.tool, paths: paths };
      if (shell) {
        extra.command = shell.command;
        if (shell.dir) extra.commandCwd = shell.dir;
      }
      const answer = await ask("pre-tool-use", threadOf(event), ctx, extra);
      if (answer && answer.decision === "deny") {
        pending.delete(event.toolUseID);
        return { action: "reject-and-continue", message: answer.reason || "slopbuckets denied this tool call." };
      }
    } catch (error) {
      // Allow.
    }
    return { action: "allow" };
  });

  amp.on("tool.result", async function (event, ctx) {
    try {
      const paths = pending.get(event.toolUseID) || filesOf(event);
      pending.delete(event.toolUseID);
      if (event.status !== "done" || paths.length === 0) return undefined;
      const answer = await ask("post-tool-use", threadOf(event), ctx, { tool: event.tool, paths: paths });
      if (!answer || !answer.feedback) return undefined;
      return { status: "done", output: appendOutput(event.output, answer.feedback) };
    } catch (error) {
      return undefined;
    }
  });

  amp.on("agent.end", async function (event, ctx) {
    try {
      if (event.status !== "done") return undefined;
      const id = threadOf(event);
      if (continued.has(id)) return undefined;
      const answer = await ask("stop", id, ctx, {});
      if (!answer || !answer.block) return undefined;
      continued.add(id);
      return { action: "continue", userMessage: MARK + answer.block, maxContinuations: 1 };
    } catch (error) {
      return undefined;
    }
  });
}
`;

export const AMP_PLUGIN = pluginHeader('amp', 'Amp') + RUNTIME + BODY;
