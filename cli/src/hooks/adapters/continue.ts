// The Continue adapter. The Continue CLI loads Claude Code style hooks from `.claude/settings.json` and five other
// files, but nothing in its source ever fires them, and its Stop helper always sends `stop_hook_active: true`. So
// slopbuckets installs no hooks for Continue. It reads AGENTS.md, whose slopbuckets block tells the agent to run
// `buckets check` before it finishes, and the git pre-commit hook checks every commit.
import { defineAdapter, type InstallStep } from '../adapter.js';

const TITLE = 'Continue';

function install(): InstallStep[] {
  return [
    {
      status: 'todo',
      text: 'Continue runs no hooks, so slopbuckets wrote nothing for it. It reads AGENTS.md, which tells it to run `buckets check` before it finishes; run `buckets init --git-hook` so every commit is checked too.',
    },
  ];
}

export const continueAdapter = defineAdapter({
  name: 'continue',
  title: TITLE,
  markers: ['.continue', '.continuerc.json'],
  handlers: {},
  install,
  uninstall: () => [],
});
