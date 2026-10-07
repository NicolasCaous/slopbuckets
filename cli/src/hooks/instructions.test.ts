import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, fileExists, makeProject, readFile, writeFile } from '../testing/fixture.js';
import { AGENTS_BLOCK, BLOCK_END, BLOCK_START, installInstructions, removeBlock, uninstallInstructions, upsertBlock } from './instructions.js';

afterEach(cleanupProjects);

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('the managed block of AGENTS.md', () => {
  it('stays short, links the docs and the skill, and has no long dashes', () => {
    expect(AGENTS_BLOCK.startsWith(BLOCK_START)).toBe(true);
    expect(AGENTS_BLOCK.endsWith(BLOCK_END)).toBe(true);
    expect(AGENTS_BLOCK.split('\n').length).toBeLessThan(20);
    expect(AGENTS_BLOCK).toContain('https://nicolascaous.github.io/slopbuckets/');
    expect(AGENTS_BLOCK).toContain('.agents/skills/slopbuckets/SKILL.md');
    expect(AGENTS_BLOCK).toContain('buckets refresh --web');
    expect(AGENTS_BLOCK).toContain('Never write any `buckets.lock.json` or `buckets.config.json`');
    expect(AGENTS_BLOCK).toMatch(/`access-denied` or `access-ambiguous`[^\n]*stop and ask the human/);
    expect(AGENTS_BLOCK).not.toMatch(new RegExp("[\u2013\u2014]"));
  });

  it('creates the block in an empty file and appends it after user content', () => {
    expect(upsertBlock('').text).toBe(`${AGENTS_BLOCK}\n`);
    expect(upsertBlock('# Rules\n\nBe nice.\n').text).toBe(`# Rules\n\nBe nice.\n\n${AGENTS_BLOCK}\n`);
    expect(upsertBlock('# Rules').text).toBe(`# Rules\n\n${AGENTS_BLOCK}\n`);
    expect(upsertBlock('# Rules\n\n').text).toBe(`# Rules\n\n${AGENTS_BLOCK}\n`);
  });

  it('updates the block in place, keeps the text around it and is idempotent', () => {
    const before = `# Top\n\n${BLOCK_START}\nold rules\n${BLOCK_END}\n\n## Mine\nkeep me\n`;
    const once = upsertBlock(before).text;
    expect(once).toBe(`# Top\n\n${AGENTS_BLOCK}\n\n## Mine\nkeep me\n`);
    expect(upsertBlock(once).text).toBe(once);
  });

  it('never duplicates the block: a second copy is removed', () => {
    const text = `${BLOCK_START}\na\n${BLOCK_END}\nmiddle\n${BLOCK_START}\nb\n${BLOCK_END}\nend\n`;
    const out = upsertBlock(text).text;
    expect(count(out, BLOCK_START)).toBe(1);
    expect(out).toBe(`${AGENTS_BLOCK}\nmiddle\nend\n`);
  });

  it('keeps CRLF line endings and refuses a marker without its partner', () => {
    const out = upsertBlock('# Rules\r\n').text;
    expect(out).toBe(`# Rules\r\n\r\n${AGENTS_BLOCK.split('\n').join('\r\n')}\r\n`);
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    const broken = `# Rules\n${BLOCK_START}\nhalf\n`;
    expect(upsertBlock(broken)).toEqual({ text: broken, problem: expect.stringContaining('without its partner') });
  });

  it('removes the block and leaves the rest', () => {
    expect(removeBlock(`# Top\n${AGENTS_BLOCK}\n## Mine\n`)).toBe('# Top\n## Mine\n');
  });
});

describe('installInstructions', () => {
  it('creates AGENTS.md and the shared skill, then keeps both', () => {
    const dir = makeProject({}, false);
    const first = installInstructions(dir, '# skill\n');
    expect(first).toEqual([
      { status: 'done', text: 'Created AGENTS.md with the slopbuckets rules for every agent' },
      { status: 'done', text: 'Installed the skill for other agents in .agents/skills/slopbuckets/SKILL.md' },
    ]);
    expect(readFile(dir, 'AGENTS.md')).toBe(`${AGENTS_BLOCK}\n`);
    expect(readFile(dir, '.agents/skills/slopbuckets/SKILL.md')).toBe('# skill\n');
    expect(installInstructions(dir, '# skill\n').map((s) => s.status)).toEqual(['kept', 'kept']);
  });

  it('adds to an existing AGENTS.md without touching user content, and updates an old block', () => {
    const dir = makeProject({ 'AGENTS.md': '# Project rules\n\nUse tabs.\n' }, false);
    expect(installInstructions(dir, '# skill\n')[0]).toEqual({ status: 'done', text: 'Added the slopbuckets rules to the end of AGENTS.md' });
    expect(readFile(dir, 'AGENTS.md').startsWith('# Project rules\n\nUse tabs.\n\n')).toBe(true);
    writeFile(dir, 'AGENTS.md', readFile(dir, 'AGENTS.md').replace('Import internal code', 'OLD'));
    expect(installInstructions(dir, '# skill\n')[0]).toEqual({ status: 'done', text: 'Updated the slopbuckets rules in AGENTS.md' });
    expect(count(readFile(dir, 'AGENTS.md'), BLOCK_START)).toBe(1);
    expect(readFile(dir, 'AGENTS.md')).toContain('Use tabs.');
  });

  it('adds the config and access rules to a block written by 1.0.0, which named only the lock', () => {
    const old = `${BLOCK_START}\n## slopbuckets\n\n- Never write any \`buckets.lock.json\`, under any name, and never run \`buckets refresh\` without exactly the \`--web\` flag. Read the lock with a file reading tool, not a shell command.\n${BLOCK_END}\n`;
    const dir = makeProject({ 'AGENTS.md': `# Mine\n\n${old}` }, false);
    expect(installInstructions(dir, '# skill\n')[0]).toEqual({ status: 'done', text: 'Updated the slopbuckets rules in AGENTS.md' });
    expect(readFile(dir, 'AGENTS.md')).toBe(`# Mine\n\n${AGENTS_BLOCK}\n`);
    expect(readFile(dir, 'AGENTS.md')).toContain('`buckets.config.json`, nested ones included');
  });

  it('reports a missing skill once as a failure and still writes AGENTS.md', () => {
    const dir = makeProject({}, false);
    const steps = installInstructions(dir, null);
    expect(steps.map((s) => s.status)).toEqual(['done', 'failed']);
    expect(fileExists(dir, '.agents/skills/slopbuckets/SKILL.md')).toBe(false);
  });

  it('uninstalls the block and the skill, and deletes AGENTS.md only when nothing else is in it', () => {
    const dir = makeProject({ 'AGENTS.md': '# Mine\n' }, false);
    installInstructions(dir, '# skill\n');
    uninstallInstructions(dir);
    expect(readFile(dir, 'AGENTS.md')).toBe('# Mine\n\n');
    expect(fileExists(dir, '.agents/skills/slopbuckets/SKILL.md')).toBe(false);
    const empty = makeProject({}, false);
    installInstructions(empty, '# skill\n');
    uninstallInstructions(empty);
    expect(fileExists(empty, 'AGENTS.md')).toBe(false);
  });
});
