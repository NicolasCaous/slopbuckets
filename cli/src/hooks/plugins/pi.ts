// The extension file for Pi (`@earendil-works/pi-coding-agent`). `tool_call` blocks with `{ block: true, reason }`,
// `tool_result` appends the check of an edited file, and `agent_before_settle` (Pi 0.87.0 and newer) continues the
// agent once per user turn when `buckets check` fails.
import { pluginHeader, RUNTIME } from './runtime.js';

const BODY = String.raw`
const BEFORE_TOOLS = ["bash", "powershell", "edit", "write"];
const AFTER_TOOLS = ["edit", "write"];

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

async function ask(event, ctx, extra) {
  const cwd = (ctx && ctx.cwd) || process.cwd();
  const sessionId = sessionOf(ctx);
  const payload = Object.assign({ cwd: cwd, projectDir: cwd, sessionId: sessionId }, extra);
  const result = await callBuckets(event, payload, cwd);
  if (!result.ok) {
    reportFailure(result, sessionId, notifier(ctx));
    return null;
  }
  return result.answer;
}

export default function slopbuckets(pi) {
  // Sessions whose current user turn already continued once after a failed check.
  const continued = new Set();

  pi.on("before_agent_start", function (event, ctx) {
    continued.delete(sessionOf(ctx) || "default");
  });

  // A tool_call handler that throws blocks the tool in Pi, so every path here catches and allows.
  pi.on("tool_call", async function (event, ctx) {
    try {
      if (BEFORE_TOOLS.indexOf(event.toolName) === -1) return undefined;
      const answer = await ask("pre-tool-use", ctx, { tool: event.toolName, args: event.input || {} });
      if (answer && answer.decision === "deny") return { block: true, reason: answer.reason || "slopbuckets denied this tool call." };
    } catch (error) {
      // Allow.
    }
    return undefined;
  });

  pi.on("tool_result", async function (event, ctx) {
    try {
      if (event.isError || AFTER_TOOLS.indexOf(event.toolName) === -1) return undefined;
      const answer = await ask("post-tool-use", ctx, { tool: event.toolName, args: event.input || {} });
      if (!answer || !answer.feedback) return undefined;
      const result = { content: (event.content || []).concat([{ type: "text", text: answer.feedback }]) };
      // Replacing content without structuredContent would drop it.
      if (event.structuredContent !== undefined) result.structuredContent = event.structuredContent;
      return result;
    } catch (error) {
      return undefined;
    }
  });

  try {
    pi.on("agent_before_settle", async function (event, ctx) {
      try {
        if (event.outcome && event.outcome !== "completed") return undefined;
        const key = sessionOf(ctx) || "default";
        if (continued.has(key)) return undefined;
        const answer = await ask("stop", ctx, {});
        if (!answer || !answer.block) return undefined;
        continued.add(key);
        const entry = { type: "custom_message", customType: "slopbuckets", content: answer.block, display: true };
        return { entries: (event.entries || []).concat([entry]), continue: true };
      } catch (error) {
        return undefined;
      }
    });
  } catch (error) {
    warnOnce("settle", "This Pi version has no agent_before_settle event (added in 0.87.0), so the end-of-turn check is off. Update Pi.", null);
  }
}
`;

export const PI_PLUGIN = pluginHeader('pi', 'Pi') + RUNTIME + BODY;
