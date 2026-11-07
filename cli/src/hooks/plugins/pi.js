// @ts-check
// The extension file for Pi (`@earendil-works/pi-coding-agent`).
//
// - pre-tool: `tool_call` asks the CLI. A deny returns `{ block: true, reason }`. Context goes out as a steering
//   message (`pi.sendMessage` with `deliverAs: "steer"`), which the model reads after the current tool batch. When
//   that call fails, the text is appended to the tool result in `tool_result` instead.
// - stop: `agent_before_settle` (Pi 0.87.0 and newer) continues the agent once per user turn when the CLI blocks.
// - post-compact: `session_compact`.
//
// A `tool_call` handler that throws blocks the tool in Pi, so every handler here catches everything.
import { decide, warnOnce } from "./runtime.js";

function sessionOf(ctx) {
  try {
    return ctx && ctx.sessionManager && typeof ctx.sessionManager.getSessionId === "function" ? ctx.sessionManager.getSessionId() : undefined;
  } catch (error) {
    return undefined;
  }
}

function notifier(ctx) {
  return function (message) {
    if (ctx && ctx.hasUI && ctx.ui && typeof ctx.ui.notify === "function") ctx.ui.notify("slopbuckets: " + message, "warning");
  };
}

function ask(event, ctx, extra) {
  const cwd = (ctx && ctx.cwd) || process.cwd();
  return decide(event, Object.assign({ cwd: cwd, sessionId: sessionOf(ctx) }, extra), cwd, notifier(ctx));
}

/** Sends text to the model as a hidden steering message. False when Pi refused it. */
function steer(pi, text) {
  try {
    const result = pi.sendMessage({ customType: "slopbuckets", content: text, display: false }, { deliverAs: "steer" });
    if (result && typeof result.catch === "function") result.catch(function () {});
    return true;
  } catch (error) {
    return false;
  }
}

/** Registers a handler, for events that older Pi versions do not have. */
function on(pi, name, handler) {
  try {
    pi.on(name, handler);
    return true;
  } catch (error) {
    return false;
  }
}

export default function slopbuckets(pi) {
  // Sessions whose current user turn already continued once.
  const continued = new Set();
  // Context that could not be sent as a steering message, by tool call id, until its tool_result.
  const notes = new Map();

  on(pi, "before_agent_start", function (event, ctx) {
    try {
      // Since Pi 1.2.0 runs started by an extension fire this event too, with messageType "custom".
      if (event && event.messageType && event.messageType !== "user") return;
      continued.delete(sessionOf(ctx) || "default");
    } catch (error) {
      // Keep the flag.
    }
  });

  on(pi, "tool_call", async function (event, ctx) {
    try {
      const answer = await ask("pre-tool", ctx, { tool: event.toolName, args: event.input || {} });
      if (answer && answer.kind === "deny") return { block: true, reason: answer.text };
      if (answer && answer.kind === "context" && !steer(pi, answer.text)) notes.set(event.toolCallId, answer.text);
    } catch (error) {
      // Let the tool run.
    }
    return undefined;
  });

  on(pi, "tool_result", function (event) {
    try {
      const text = notes.get(event.toolCallId);
      if (!text) return undefined;
      notes.delete(event.toolCallId);
      const result = { content: (event.content || []).concat([{ type: "text", text: text }]) };
      // Replacing content without structuredContent would drop it.
      if (event.structuredContent !== undefined) result.structuredContent = event.structuredContent;
      return result;
    } catch (error) {
      return undefined;
    }
  });

  const settle = on(pi, "agent_before_settle", async function (event, ctx) {
    try {
      if (event.outcome && event.outcome !== "completed") return undefined;
      const key = sessionOf(ctx) || "default";
      const active = continued.has(key);
      const answer = await ask("stop", ctx, { stopHookActive: active });
      if (active || !answer || answer.kind !== "block") return undefined;
      continued.add(key);
      const entry = { type: "custom_message", customType: "slopbuckets", content: answer.text, display: true };
      return { entries: (event.entries || []).concat([entry]), continue: true };
    } catch (error) {
      return undefined;
    }
  });
  if (!settle) warnOnce("settle", "This Pi version has no agent_before_settle event (added in 0.87.0), so the end-of-turn check is off. Update Pi.", null);

  on(pi, "session_compact", async function (event, ctx) {
    try {
      await ask("post-compact", ctx, {});
    } catch (error) {
      // Nothing to undo.
    }
  });
}
