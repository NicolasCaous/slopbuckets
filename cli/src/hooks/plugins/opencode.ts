// The plugin file for OpenCode, both lines: V1 (npm `opencode-ai`, 1.18.10 and newer) calls the `server()` of the
// default export, and V2 (npm `@opencode/cli`) calls `setup()` with the same `id`. Neither line has a hook for the end
// of a turn, so the plugin re-prompts the session once on `session.idle` when `buckets check` fails.
import { pluginHeader, RUNTIME } from './runtime.js';

const BODY = String.raw`
// The tools whose calls go to the CLI, which maps their arguments. Other tools run without a call.
const TOOLS = {
  v1: { before: ["edit", "write", "multiedit", "patch", "apply_patch", "bash"], after: ["edit", "write", "multiedit", "patch", "apply_patch"], subagent: "task" },
  v2: { before: ["edit", "write", "patch", "shell"], after: ["edit", "write", "patch"], subagent: "subagent" },
};

function firstText(parts) {
  if (!Array.isArray(parts)) return "";
  for (const part of parts) if (part && part.type === "text" && typeof part.text === "string") return part.text;
  return "";
}

/** Calls a function of the harness and ignores both a throw and a rejected promise. */
function quiet(call) {
  try {
    const result = call();
    if (result && typeof result.catch === "function") result.catch(function () {});
  } catch (error) {
    // Not available in this OpenCode version.
  }
}

/** The logic both API lines share. api is "v1" or "v2". */
function createGuard(api, directory, notify) {
  const tools = TOOLS[api];
  // Per session: continued after a re-prompt in this user turn, busy while a check runs, failed after a session error.
  const turns = new Map();
  const turn = function (sessionId) {
    let state = turns.get(sessionId);
    if (!state) {
      state = { continued: false, busy: false, failed: false };
      turns.set(sessionId, state);
    }
    return state;
  };
  const ask = async function (event, sessionId, extra) {
    const payload = Object.assign({ api: api, cwd: directory, projectDir: directory, sessionId: sessionId }, extra);
    const result = await callBuckets(event, payload, directory);
    if (!result.ok) {
      reportFailure(result, sessionId, notify);
      return null;
    }
    return result.answer;
  };
  return {
    /** Throws the reason when the CLI denies the call, which is how OpenCode blocks a tool. */
    async before(tool, args, sessionId) {
      let answer = null;
      try {
        if (tools.before.indexOf(tool) === -1) return;
        answer = await ask("pre-tool-use", sessionId, { tool: tool, args: args || {} });
      } catch (error) {
        answer = null;
      }
      if (answer && answer.decision === "deny") throw new Error(answer.reason || "slopbuckets denied this tool call.");
    },
    /** The text to append to the tool output: the check of an edited file, or the check after a subagent. */
    async after(tool, args, sessionId) {
      try {
        if (tool === tools.subagent) {
          const answer = await ask("subagent-stop", sessionId, {});
          return answer && answer.block ? answer.block : null;
        }
        if (tools.after.indexOf(tool) === -1) return null;
        const answer = await ask("post-tool-use", sessionId, { tool: tool, args: args || {} });
        return answer && answer.feedback ? answer.feedback : null;
      } catch (error) {
        return null;
      }
    },
    /** A message from the human starts a new turn, so the next idle may re-prompt again. */
    userMessage(sessionId, text) {
      if (!sessionId) return;
      if (typeof text === "string" && text.indexOf(MARK) === 0) return;
      turns.delete(sessionId);
    },
    failed(sessionId) {
      if (sessionId) turn(sessionId).failed = true;
    },
    /** Runs the check when the session goes idle and sends the report as a new prompt, once per user turn. */
    async idle(sessionId, isSubagent, send) {
      if (!sessionId) return;
      const state = turn(sessionId);
      if (state.failed) {
        state.failed = false;
        return;
      }
      if (state.continued || state.busy) return;
      state.busy = true;
      try {
        if (await isSubagent(sessionId)) return;
        const answer = await ask("stop", sessionId, {});
        if (!answer || !answer.block) return;
        state.continued = true;
        await send(sessionId, MARK + answer.block);
      } catch (error) {
        warnOnce("idle:" + sessionId, "Could not send the buckets check report back to the session: " + String((error && error.message) || error), notify);
      } finally {
        state.busy = false;
      }
    },
  };
}

/** OpenCode V1: a server plugin that returns hooks by name. */
async function server(input) {
  const directory = (input && (input.directory || input.worktree)) || process.cwd();
  const client = input && input.client;
  const notify = function (message) {
    quiet(function () {
      return client.app.log({ body: { service: "slopbuckets", level: "warn", message: message } });
    });
    quiet(function () {
      return client.tui.showToast({ body: { message: "slopbuckets: " + message, variant: "warning" } });
    });
  };
  const guard = createGuard("v1", directory, notify);
  const isSubagent = async function (id) {
    try {
      const response = await client.session.get({ path: { id: id } });
      const info = response && response.data ? response.data : response;
      return Boolean(info && info.parentID);
    } catch (error) {
      return false;
    }
  };
  const send = async function (id, text) {
    const response = await client.session.prompt({ path: { id: id }, body: { parts: [{ type: "text", text: text }] } });
    if (response && response.error) throw new Error(JSON.stringify(response.error));
  };
  return {
    "tool.execute.before": async function (hook, output) {
      await guard.before(hook && hook.tool, output && output.args, hook && hook.sessionID);
    },
    "tool.execute.after": async function (hook, output) {
      const text = await guard.after(hook && hook.tool, hook && hook.args, hook && hook.sessionID);
      if (text && output) output.output = (typeof output.output === "string" && output.output !== "" ? output.output + "\n\n" : "") + text;
    },
    "chat.message": async function (hook, output) {
      guard.userMessage(hook && hook.sessionID, firstText(output && output.parts));
    },
    event: async function (arg) {
      const event = arg && arg.event;
      if (!event) return;
      const props = event.properties || {};
      if (event.type === "session.error") guard.failed(props.sessionID);
      if (event.type === "session.idle") await guard.idle(props.sessionID, isSubagent, send);
    },
  };
}

/** Appends text to a V2 tool result, whose content is a string, an array of parts or empty. */
function appendResult(result, text) {
  const value = result || {};
  const content = value.content;
  let next;
  if (typeof content === "string") next = content === "" ? text : content + "\n\n" + text;
  else if (Array.isArray(content) && content.length > 0) next = content.concat([{ type: "text", text: text }]);
  else if (value.output !== undefined) next = [{ type: "text", text: typeof value.output === "string" ? value.output : JSON.stringify(value.output) }, { type: "text", text: text }];
  else next = text;
  return Object.assign({}, value, { content: next });
}

function isIdleEvent(event, props) {
  if (event.type === "session.idle") return true;
  const status = props.status;
  return event.type === "session.status" && (status === "idle" || (status && status.type === "idle"));
}

/** OpenCode V2: registers hooks on the plugin context. */
async function setup(ctx) {
  const directory = (ctx && ctx.location && ctx.location.directory) || process.cwd();
  const guard = createGuard("v2", directory, null);
  const isSubagent = async function (id) {
    try {
      const info = await ctx.session.get({ sessionID: id });
      return Boolean(info && (info.parentID || info.parentId));
    } catch (error) {
      return false;
    }
  };
  const send = async function (id, text) {
    await ctx.session.prompt({ sessionID: id, text: text });
  };
  await ctx.tool.hook("execute.before", async function (event) {
    await guard.before(event.tool, event.input, event.sessionID);
  });
  await ctx.tool.hook("execute.after", async function (event) {
    if (event.status !== "completed") return;
    const text = await guard.after(event.tool, event.input, event.sessionID);
    if (text) event.result = appendResult(event.result, text);
  });
  if (ctx.session && typeof ctx.session.hook === "function") {
    await ctx.session.hook("prompt", function (event) {
      guard.userMessage(event && event.sessionID, event && event.prompt && event.prompt.text);
    });
  }
  const controller = new AbortController();
  if (ctx.event && typeof ctx.event.subscribe === "function") {
    (async function () {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const props = (event && (event.properties || event.data)) || {};
          const id = props.sessionID || props.sessionId;
          if (event.type === "session.error") guard.failed(id);
          else if (isIdleEvent(event, props)) void guard.idle(id, isSubagent, send);
        }
      } catch (error) {
        // The stream ends when the plugin unloads.
      }
    })();
  }
  return function () {
    controller.abort();
  };
}

// V1 reads id and server(), V2 reads id and setup(). Keep this the only export: older V1 releases load every export.
export default { id: "slopbuckets", setup: setup, server: server };
`;

export const OPENCODE_PLUGIN = pluginHeader('opencode', 'OpenCode') + RUNTIME + BODY;
