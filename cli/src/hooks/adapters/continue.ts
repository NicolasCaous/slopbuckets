// The Continue adapter. The Continue CLI loads hooks from `.claude/settings.json`, but nothing shows that it ever runs
// them, so slopbuckets does not count on them. Continue gets the shared AGENTS.md block and the skill, like every
// harness, and nothing else.
import type { HookAdapter, InstallStep } from '../adapter.js';
import { noHooksRun } from './no-hooks.js';

const TITLE = 'Continue';

function install(): InstallStep[] {
  return [
    {
      status: 'todo',
      text: 'slopbuckets installs no hooks for Continue: its CLI loads hooks from .claude/settings.json, but they may never run. Continue gets the rules from AGENTS.md and the skill; run `buckets init --git-hook` and `buckets check` in CI to hold them.',
    },
  ];
}

export const continueAdapter: HookAdapter = {
  name: 'continue',
  title: TITLE,
  markers: ['.continue', '.continuerc.json'],
  events: [],
  run: noHooksRun(TITLE),
  install,
  uninstall: () => [],
};
