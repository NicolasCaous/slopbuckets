// @ts-check
// The plugin file for OpenCode, both lines: V1 (npm `opencode-ai`, 1.18.29 and newer) calls the `server()` of the
// default export, and V2 (npm `@opencode/cli`) calls `setup()` with the same `id`.
//
// - pre-tool: the before hook asks the CLI. A deny throws, which fails that call with the reason. Context waits by call
//   id and is appended to the tool output in the after hook, because OpenCode has no context field before a tool.
// - subagent-stop: after a `task` (V1) or `subagent` (V2) call, the check of the child session is appended to its
//   output, so the parent reads it.
// - stop: OpenCode has no hook that keeps a turn going, so on `session.idle` the plugin re-prompts the session once
//   per user turn when the CLI blocks. Child sessions are skipped.
// - post-compact: V1 `session.compacted`, V2 `session.compaction.ended`.
import { decide, warnOnce, MARK } from "./runtime.js";

const SUBAGENT_TOOLS = ["task", "subagent"];

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

function joinText(first, second) {
  return first ? first + "\n\n" + second : second;
}

/** The child session id in the metadata of a task or subagent result. */
function childSession(metadata) {
  return (metadata && (metadata.sessionId || metadata.sessionID)) || null;
}

/** The logic both API lines share. */
function createGuard(directory, notify) {
  // Per session: continued after a re-prompt in this user turn, busy while a check runs, failed after a session error.
  const turns = new Map();
  // Context from a before hook, by call id, until the after hook of the same call.
  // ponytail: a V1 call that fails skips the after hook and leaves its note here; clear by session if that ever grows.
  const notes = new Map();
  const turn = function (sessionId) {
    let state = turns.get(sessionId);
    if (!state) {
      state = { continued: false, busy: false, failed: false };
      turns.set(sessionId, state);
    }
    return state;
  };
  const ask = function (event, sessionId, extra) {
    return decide(event, Object.assign({ cwd: directory, sessionId: sessionId }, extra), directory, notify);
  };
  return {
    /** Throws the reason when the CLI denies the call, which is how OpenCode blocks a tool. Nothing else throws. */
    async before(callId, tool, args, sessionId) {
      let answer = null;
      try {
        answer = await ask("pre-tool", sessionId, { tool: tool, args: args || {} });
        if (answer && answer.kind === "context" && callId) notes.set(callId, answer.text);
      } catch (error) {
        answer = null;
      }
      if (answer && answer.kind === "deny") throw new Error(answer.text);
    },
    /** The text to append to the output of a finished call: its context, then the check of a subagent it ran. */
    async after(callId, tool, metadata) {
      try {
        let text = notes.get(callId) || "";
        notes.delete(callId);
        const child = SUBAGENT_TOOLS.indexOf(tool) !== -1 ? childSession(metadata) : null;
        if (child) {
          const answer = await ask("subagent-stop", child, {});
          if (answer && answer.kind === "block") text = joinText(text, answer.text);
        }
        return text || null;
      } catch (error) {
        return null;
      }
    },
    forget(callId) {
      notes.delete(callId);
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
    /** Runs the stop check when the session goes idle and sends a block back as a new prompt, once per user turn. */
    async idle(sessionId, isSubagent, send) {
      if (!sessionId) return;
      const state = turn(sessionId);
      if (state.failed) {
        state.failed = false;
        return;
      }
      if (state.busy) return;
      state.busy = true;
      try {
        if (await isSubagent(sessionId)) return;
        const continued = state.continued;
        const answer = await ask("stop", sessionId, { stopHookActive: continued });
        if (continued || !answer || answer.kind !== "block") return;
        state.continued = true;
        await send(sessionId, MARK + answer.text);
      } catch (error) {
        warnOnce("idle:" + sessionId, "Could not send the slopbuckets report back to the session: " + String((error && error.message) || error), notify);
      } finally {
        state.busy = false;
      }
    },
    async compacted(sessionId) {
      if (sessionId) await ask("post-compact", sessionId, {});
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
  const guard = createGuard(directory, notify);
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
      if (!hook) return;
      await guard.before(hook.callID, hook.tool, output && output.args, hook.sessionID);
    },
    "tool.execute.after": async function (hook, output) {
      if (!hook || !output) return;
      const text = await guard.after(hook.callID, hook.tool, output.metadata);
      if (text) output.output = joinText(typeof output.output === "string" ? output.output : "", text);
    },
    "chat.message": async function (hook, output) {
      guard.userMessage(hook && hook.sessionID, firstText(output && output.parts));
    },
    event: async function (arg) {
      try {
        const event = arg && arg.event;
        if (!event) return;
        const props = event.properties || {};
        if (event.type === "session.error") guard.failed(props.sessionID);
        else if (event.type === "session.idle") await guard.idle(props.sessionID, isSubagent, send);
        else if (event.type === "session.compacted") await guard.compacted(props.sessionID);
      } catch (error) {
        // An event the plugin cannot read changes nothing.
      }
    },
  };
}

/** Appends text to a V2 tool result, whose content is a string, an array of parts or empty. */
function appendResult(result, text) {
  const value = result || {};
  const content = value.content;
  let next;
  if (typeof content === "string") next = joinText(content, text);
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
  const guard = createGuard(directory, null);
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
    if (!event) return;
    await guard.before(event.id, event.tool, event.input, event.sessionID);
  });
  // V2 does not catch a rejection here, so nothing in this handler may throw.
  await ctx.tool.hook("execute.after", async function (event) {
    try {
      if (!event) return;
      if (event.status !== "completed") {
        guard.forget(event.id);
        return;
      }
      const text = await guard.after(event.id, event.tool, event.result && event.result.metadata);
      if (text) event.result = appendResult(event.result, text);
    } catch (error) {
      // The result stays as it is.
    }
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
          else if (event.type === "session.compaction.ended") void guard.compacted(id);
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
