// The install-time half of the JSON hook adapters: the hook commands for every way slopbuckets is installed, and
// merging slopbuckets entries into a config and removing them again.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject, writeFile } from '../../testing/fixture.js';
import { resolveCommand } from '../../commands/doctor.js';
import { anchoredCommand, failOpenPowerShell, failOpenSh, groupEntries, hookCommand, installHooks, isAgentCommand, uninstallHooks, unwrapFailOpen, type JsonHookFile } from './json-install.js';

afterEach(cleanupProjects);

const LOCAL = 'node ./node_modules/slopbuckets/dist/index.js';

describe('hook commands', () => {
  it('run buckets by default, or the command init passes', () => {
    expect(hookCommand('codex', 'stop')).toBe('buckets hook --agent codex stop');
    expect(hookCommand('codex', 'stop', LOCAL)).toBe(`${LOCAL} hook --agent codex stop`);
  });

  it('name the project copy by the project folder variable of the harness, which works from any folder in bash', () => {
    const anchored = 'node "$CLAUDE_PROJECT_DIR/node_modules/slopbuckets/dist/index.js"';
    expect(anchoredCommand(LOCAL, 'CLAUDE_PROJECT_DIR')).toBe(anchored);
    expect(anchoredCommand('node ../../node_modules/slopbuckets/dist/index.js', 'X')).toBe('node "$X/../../node_modules/slopbuckets/dist/index.js"');
    for (const cli of [undefined, 'buckets', "node './a b/dist/index.js'"]) expect(anchoredCommand(cli, 'X')).toBe(cli);
    expect(isAgentCommand(null, `${anchored} hook stop`)).toBe(true);
    // The project folder may hold a space; the variable keeps it one word.
    const dir = makeProject({ 'node_modules/slopbuckets/dist/index.js': 'console.log("ran " + process.argv.slice(2).join(" "));\n', 'src/a.ts': '' }, false);
    const spaced = path.join(dir, 'my project');
    writeFile(spaced, 'node_modules/slopbuckets/dist/index.js', 'console.log("ran " + process.argv.slice(2).join(" "));\n');
    expect(resolveCommand(anchored, spaced, {}, process.platform)?.file).toBe(path.join(spaced, 'node_modules', 'slopbuckets', 'dist', 'index.js'));
    const bash = spawnSync('bash', ['-c', `${anchored} hook stop`], { cwd: path.join(dir, 'src'), env: { ...process.env, CLAUDE_PROJECT_DIR: spaced }, encoding: 'utf8' });
    if (bash.error !== undefined) return; // no bash on this machine
    expect(bash.stdout.trim()).toBe('ran hook stop');
  });

  it('count as ours with either command, inside a fail-open guard too, and not for another agent', () => {
    for (const cli of ['buckets', LOCAL, 'node "C:/a b/node_modules/slopbuckets/dist/index.js"']) {
      const command = hookCommand('codex', 'stop', cli);
      expect(isAgentCommand('codex', command)).toBe(true);
      expect(isAgentCommand('codex', failOpenSh(command, cli))).toBe(true);
      expect(isAgentCommand('codex', failOpenPowerShell(command, cli))).toBe(true);
      expect(isAgentCommand('cursor', command)).toBe(false);
    }
    expect(isAgentCommand(null, 'buckets hook stop')).toBe(true);
    expect(isAgentCommand(null, `${LOCAL} hook --agent claude stop`)).toBe(true);
    expect(isAgentCommand('codex', './mine.sh hook --agent codex stop')).toBe(false);
  });

  it('guard a local install by its script file', () => {
    const command = hookCommand('copilot', 'agent-stop', LOCAL);
    expect(failOpenSh(command, LOCAL)).toBe(`if command -v node >/dev/null 2>&1 && [ -f ./node_modules/slopbuckets/dist/index.js ]; then ${command}; fi`);
    expect(failOpenPowerShell(command, LOCAL)).toBe(`if ((Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path ./node_modules/slopbuckets/dist/index.js)) { ${command} }`);
    expect(unwrapFailOpen(failOpenSh(command, LOCAL))).toBe(command);
    expect(unwrapFailOpen(failOpenPowerShell(command, LOCAL))).toBe(command);
    expect(failOpenSh('buckets hook --agent copilot x')).toBe('if command -v buckets >/dev/null 2>&1; then buckets hook --agent copilot x; fi');
  });
});

describe('installHooks', () => {
  const spec: JsonHookFile = {
    agent: 'demo',
    title: 'Demo',
    file: '.demo/hooks.json',
    container: ['hooks'],
    layout: 'groups',
    entries: groupEntries('demo', [
      { event: 'PreToolUse', name: 'pre-tool-use', extra: { timeout: 60 } },
      { event: 'Stop', name: 'stop' },
    ]),
  };
  const read = (dir: string) => readFileSync(path.join(dir, spec.file), 'utf8');

  it('replaces older entries, removes events no longer used, and keeps the user hooks and comments', () => {
    const old = [
      '{',
      '  // my hooks',
      '  "hooks": {',
      '    "PreToolUse": [',
      '      { "matcher": "Bash|Write", "hooks": [{ "type": "command", "command": "buckets hook --agent demo pre-tool-use" }] },',
      '      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "./mine.sh" }, { "type": "command", "command": "buckets hook --agent demo pre-tool-use" }] }',
      '    ],',
      '    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "buckets hook --agent demo post-tool-use" }] }],',
      '    "Stop": [{ "hooks": [{ "type": "command", "command": "buckets hook --agent demo stop" }] }]',
      '  }',
      '}',
      '',
    ].join('\n');
    const dir = makeProject({ [spec.file]: old }, false);
    expect(installHooks(dir, spec)).toEqual([{ status: 'done', text: 'Updated the Demo hooks in .demo/hooks.json (PreToolUse, PostToolUse)' }]);
    const text = read(dir);
    expect(text).toContain('// my hooks');
    expect(text).toContain('"./mine.sh"');
    expect(text).not.toContain('post-tool-use');
    expect(text.match(/buckets hook --agent demo pre-tool-use/g)).toHaveLength(1);
    expect(installHooks(dir, spec)).toEqual([{ status: 'kept', text: 'Demo hooks are already in .demo/hooks.json' }]);
    expect(read(dir)).toBe(text);
  });

  it('refuses an entry that holds a comment, without changing the file', () => {
    const text = '{ "hooks": { "Stop": [{ "hooks": [{ "command": "buckets hook --agent demo old" /* note */ }] }] } }\n';
    const dir = makeProject({ [spec.file]: text }, false);
    expect(installHooks(dir, spec)).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(read(dir)).toBe(text);
  });

  it('replaces the entries of another command, so a switch to a local install leaves one hook per event', () => {
    const dir = makeProject({}, false);
    installHooks(dir, spec);
    const local: JsonHookFile = { ...spec, entries: groupEntries('demo', [{ event: 'PreToolUse', name: 'pre-tool-use', extra: { timeout: 60 } }, { event: 'Stop', name: 'stop' }], LOCAL) };
    expect(installHooks(dir, local)[0]).toMatchObject({ status: 'done' });
    const text = read(dir);
    expect(text).not.toContain('"buckets hook');
    expect(text.match(/hook --agent demo/g)).toHaveLength(2);
  });

  it('uninstall removes only the slopbuckets entries, and the file when nothing else is left', () => {
    const dir = makeProject({ [spec.file]: '{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "./mine.sh" }] }] } }\n' }, false);
    installHooks(dir, spec);
    expect(uninstallHooks(dir, spec)).toEqual([{ status: 'done', text: 'Removed the slopbuckets hooks from .demo/hooks.json (Stop, PreToolUse)' }]);
    expect(JSON.parse(read(dir))).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: './mine.sh' }] }] } });
    expect(uninstallHooks(dir, spec)).toEqual([]);

    const fresh = makeProject({}, false);
    installHooks(fresh, spec);
    expect(uninstallHooks(fresh, spec)).toEqual([{ status: 'done', text: 'Removed .demo/hooks.json, which held only the slopbuckets hooks' }]);
    expect(existsSync(path.join(fresh, spec.file))).toBe(false);
    expect(uninstallHooks(makeProject({}, false), spec)).toEqual([]);
  });
});
