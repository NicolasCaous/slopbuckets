// The Zed adapter. Zed's own agent has no hooks: its only guard is the static `agent.tool_permissions` of the user
// settings, which cannot show the pending list. So install writes nothing. Zed reads AGENTS.md, whose slopbuckets block
// tells the agent to run `buckets check` before it finishes, and the git pre-commit hook checks every commit. Claude
// Code and other agents that run inside Zed through ACP keep their own hooks.
import { defineAdapter, type InstallStep } from '../adapter.js';

const TITLE = 'Zed';

function install(): InstallStep[] {
  return [
    {
      status: 'todo',
      text: 'Zed has no hooks, so slopbuckets wrote nothing for it. Its agent reads AGENTS.md, which tells it to run `buckets check` before it finishes; run `buckets init --git-hook` so every commit is checked too.',
    },
  ];
}

export const zedAdapter = defineAdapter({
  name: 'zed',
  title: TITLE,
  markers: ['.zed'],
  handlers: {},
  install,
  uninstall: () => [],
});
