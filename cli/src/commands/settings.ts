// Merges the slopbuckets hooks into .claude/settings.json without duplicating existing entries, and removes them.

export interface HookSpec {
  event: 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SubagentStop';
  matcher?: string;
  command: string;
}

export const HOOKS: HookSpec[] = [
  { event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell', command: 'buckets hook pre-tool-use' },
  { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit', command: 'buckets hook post-tool-use' },
  { event: 'Stop', command: 'buckets hook stop' },
  { event: 'SubagentStop', command: 'buckets hook subagent-stop' },
];

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasCommand(groups: unknown[], command: string): boolean {
  return groups.some(
    (group) =>
      isObject(group) &&
      Array.isArray(group.hooks) &&
      group.hooks.some((hook) => isObject(hook) && typeof hook.command === 'string' && hook.command.trim() === command),
  );
}

/**
 * Returns a copy of the settings with every missing slopbuckets hook added, and the events that changed.
 * Throws when the existing settings have a shape this function cannot merge into safely.
 */
export function mergeHooks(settings: unknown): { settings: Json; added: string[] } {
  if (!isObject(settings)) throw new Error('.claude/settings.json must contain a JSON object');
  const out: Json = structuredClone(settings);
  if (out.hooks === undefined) out.hooks = {};
  if (!isObject(out.hooks)) throw new Error('"hooks" in .claude/settings.json must be an object');
  const hooks = out.hooks;
  const added: string[] = [];
  for (const spec of HOOKS) {
    if (hooks[spec.event] === undefined) hooks[spec.event] = [];
    const groups = hooks[spec.event];
    if (!Array.isArray(groups)) throw new Error(`"hooks.${spec.event}" in .claude/settings.json must be an array`);
    if (hasCommand(groups, spec.command)) continue;
    groups.push({ ...(spec.matcher ? { matcher: spec.matcher } : {}), hooks: [{ type: 'command', command: spec.command }] });
    added.push(spec.event);
  }
  return { settings: out, added };
}

/**
 * Returns a copy of the settings without the slopbuckets hooks, and the events that changed. A group that held only
 * slopbuckets hooks is dropped, and so is an event left without groups. Every other hook and setting stays.
 */
export function removeHooks(settings: unknown): { settings: Json; removed: string[] } {
  if (!isObject(settings)) throw new Error('.claude/settings.json must contain a JSON object');
  const out: Json = structuredClone(settings);
  const removed: string[] = [];
  if (!isObject(out.hooks)) return { settings: out, removed };
  const hooks = out.hooks;
  const ours = new Set(HOOKS.map((spec) => spec.command));
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    let changed = false;
    const kept: unknown[] = [];
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const rest = group.hooks.filter((hook) => !(isObject(hook) && typeof hook.command === 'string' && ours.has(hook.command.trim())));
      if (rest.length === group.hooks.length) kept.push(group);
      else {
        changed = true;
        if (rest.length > 0) kept.push({ ...group, hooks: rest });
      }
    }
    if (!changed) continue;
    removed.push(event);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (removed.length > 0 && Object.keys(hooks).length === 0) delete out.hooks;
  return { settings: out, removed };
}
