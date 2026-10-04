// The harnesses slopbuckets knows, and the hook adapters it has for them. To add an adapter, write
// ./adapters/<name>.ts that exports a HookAdapter (see ./adapter.ts and ./adapters/claude.ts), import it here and add it
// to `adapters` below. Its entry in KNOWN then gains hooks: `buckets hook --agent <name> <event>` dispatches to it and
// `buckets init --agent <name>` installs it. Use ../core/jsonc.ts to merge into JSON files that may hold comments.
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { HarnessInfo, HookAdapter } from './adapter.js';
import { claudeAdapter } from './adapters/claude.js';
import { ampAdapter } from './adapters/amp.js';
import { opencodeAdapter } from './adapters/opencode.js';
import { piAdapter } from './adapters/pi.js';
import { codexAdapter } from './adapters/codex.js';
import { cursorAdapter } from './adapters/cursor.js';
import { geminiAdapter } from './adapters/gemini.js';
import { copilotAdapter } from './adapters/copilot.js';
import { factoryAdapter } from './adapters/factory.js';
import { qwenAdapter } from './adapters/qwen.js';
import { auggieAdapter } from './adapters/auggie.js';
import { devinAdapter } from './adapters/devin.js';
import { clineAdapter } from './adapters/cline.js';
import { windsurfAdapter } from './adapters/windsurf.js';
import { kiroAdapter } from './adapters/kiro.js';
import { gooseAdapter } from './adapters/goose.js';
import { crushAdapter } from './adapters/crush.js';
import { zedAdapter } from './adapters/zed.js';
import { aiderAdapter } from './adapters/aider.js';
import { continueAdapter } from './adapters/continue.js';

/** The adapters with hooks. Claude Code is the default of `buckets hook <event>` and of `buckets init`. */
const adapters: HookAdapter[] = [
  claudeAdapter,
  codexAdapter,
  cursorAdapter,
  geminiAdapter,
  copilotAdapter,
  factoryAdapter,
  qwenAdapter,
  auggieAdapter,
  devinAdapter,
  opencodeAdapter,
  piAdapter,
  ampAdapter,
  clineAdapter,
  windsurfAdapter,
  kiroAdapter,
  gooseAdapter,
  crushAdapter,
  zedAdapter,
  aiderAdapter,
  continueAdapter,
];
export const ADAPTERS: readonly HookAdapter[] = adapters;

/** Adds an adapter at run time, such as a test double, replacing one of the same name. Returns a function that removes it. */
export function registerAdapter(adapter: HookAdapter): () => void {
  const index = adapters.findIndex((a) => a.name === adapter.name);
  const previous = index === -1 ? undefined : adapters[index];
  if (index === -1) adapters.push(adapter);
  else adapters[index] = adapter;
  return () => {
    const at = adapters.indexOf(adapter);
    if (at === -1) return;
    if (previous === undefined) adapters.splice(at, 1);
    else adapters[at] = previous;
  };
}

export const DEFAULT_AGENT = 'claude';

/**
 * Every harness `buckets init --agent` accepts. A harness without an adapter still gets the managed block in AGENTS.md
 * and the skill in .agents/skills/, which most harnesses read. The markers are the folders or files that show a
 * project uses it; `.github` alone is not one, because most repositories have it for CI.
 */
const KNOWN: readonly HarnessInfo[] = [
  { name: 'codex', title: 'Codex CLI', markers: ['.codex'] },
  { name: 'cursor', title: 'Cursor', markers: ['.cursor', '.cursorrules'] },
  { name: 'gemini', title: 'Gemini CLI', markers: ['.gemini', 'GEMINI.md'] },
  { name: 'copilot', title: 'GitHub Copilot', markers: ['.github/hooks', '.github/copilot-instructions.md', '.github/instructions', '.github/skills'] },
  { name: 'factory', title: 'Factory Droid', markers: ['.factory'] },
  { name: 'opencode', title: 'OpenCode', markers: ['.opencode', 'opencode.json', 'opencode.jsonc'] },
  { name: 'pi', title: 'Pi', markers: ['.pi'] },
  { name: 'amp', title: 'Amp', markers: ['.amp'] },
  { name: 'cline', title: 'Cline', markers: ['.clinerules'] },
  { name: 'devin', title: 'Devin Desktop', markers: ['.devin'] },
  { name: 'windsurf', title: 'Windsurf', markers: ['.windsurf', '.windsurfrules'] },
  { name: 'kiro', title: 'Kiro', markers: ['.kiro'] },
  { name: 'qwen', title: 'Qwen Code', markers: ['.qwen'] },
  { name: 'auggie', title: 'Auggie', markers: ['.augment'] },
  { name: 'goose', title: 'Goose', markers: ['.goosehints'] },
];

/** Every known harness: the adapters first, then the harnesses without one. */
export function harnesses(): HarnessInfo[] {
  return [...adapters, ...KNOWN.filter((h) => !adapters.some((a) => a.name === h.name))];
}

export function findAdapter(name: string): HookAdapter | undefined {
  return adapters.find((adapter) => adapter.name === name.toLowerCase());
}

export function findHarness(name: string): HarnessInfo | undefined {
  return harnesses().find((harness) => harness.name === name.toLowerCase());
}

/** The harnesses with a marker in `projectDir`, adapters first. */
export function detectHarnesses(projectDir: string): HarnessInfo[] {
  return harnesses().filter((harness) => harness.markers.some((marker) => existsSync(path.join(projectDir, marker))));
}

/**
 * The harnesses an `--agent` value names: a comma separated list of names, `auto` for the detected ones, or both.
 * Unknown names come back in `unknown`, so the caller can refuse before it writes anything.
 */
export function resolveAgents(value: string, projectDir: string): { harnesses: HarnessInfo[]; unknown: string[]; auto: boolean } {
  const picked: HarnessInfo[] = [];
  const unknown: string[] = [];
  let auto = false;
  const add = (harness: HarnessInfo): void => {
    if (!picked.some((p) => p.name === harness.name)) picked.push(harness);
  };
  for (const raw of value.split(',')) {
    const name = raw.trim().toLowerCase();
    if (name === '') continue;
    if (name === 'auto') {
      auto = true;
      detectHarnesses(projectDir).forEach(add);
      continue;
    }
    const harness = findHarness(name);
    if (harness === undefined) unknown.push(raw.trim());
    else add(harness);
  }
  return { harnesses: picked, unknown, auto };
}
