import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, fileExists, makeProject, readFile, writeFile } from '../testing/fixture.js';
import { AGENTS_BLOCK, BLOCK_END, BLOCK_START, installInstructions, skillCopies, skillVersion, stampSkill, upsertBlock } from './instructions.js';

afterEach(cleanupProjects);

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('the managed block of AGENTS.md', () => {
  it('stays short, links the docs and the skill, and has no long dashes', () => {
    expect(AGENTS_BLOCK.startsWith(BLOCK_START)).toBe(true);
    expect(AGENTS_BLOCK.endsWith(BLOCK_END)).toBe(true);
    expect(AGENTS_BLOCK.split('\n').length).toBeLessThan(20);
    expect(AGENTS_BLOCK).toContain('https://nicolascaous.github.io/slopbuckets/');
    expect(AGENTS_BLOCK).toContain('.agents/skills/slopbuckets/SKILL.md');
    expect(AGENTS_BLOCK).toContain('`buckets.config.json`');
    expect(AGENTS_BLOCK).not.toMatch(new RegExp("[\u2013\u2014]"));
  });

  it('says the four things of 2.0: where the architecture lives, the warnings, both fixes, and the check without a stop hook', () => {
    const points = AGENTS_BLOCK.split('\n').filter((line) => line.startsWith('- '));
    expect(points).toHaveLength(4);
    expect(points[0]).toContain('`buckets.config.json` holds the architecture');
    expect(points[1]).toContain('warn you when the code and `buckets.config.json` disagree');
    expect(points[2]).toContain('both valid');
    expect(points[3]).toContain('run `buckets check` unless you know a slopbuckets stop hook runs it');
    expect(points[3]).toContain('If it exits 3, fix the problem if it is part of your task, otherwise show it to the human.');
    expect(points[3]).toContain('exits 0');
    expect(AGENTS_BLOCK).not.toMatch(/approv|lock/i);
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
    writeFile(dir, 'AGENTS.md', readFile(dir, 'AGENTS.md').replace('holds the architecture', 'OLD'));
    expect(installInstructions(dir, '# skill\n')[0]).toEqual({ status: 'done', text: 'Updated the slopbuckets rules in AGENTS.md' });
    expect(count(readFile(dir, 'AGENTS.md'), BLOCK_START)).toBe(1);
    expect(readFile(dir, 'AGENTS.md')).toContain('Use tabs.');
  });

  it('replaces a block written by an older version', () => {
    const old = `${BLOCK_START}\n## slopbuckets\n\n- Old rules.\n${BLOCK_END}\n`;
    const dir = makeProject({ 'AGENTS.md': `# Mine\n\n${old}` }, false);
    expect(installInstructions(dir, '# skill\n')[0]).toEqual({ status: 'done', text: 'Updated the slopbuckets rules in AGENTS.md' });
    expect(readFile(dir, 'AGENTS.md')).toBe(`# Mine\n\n${AGENTS_BLOCK}\n`);
  });

  it('tells the agent the check command it can type for the command the hooks run', () => {
    const dir = makeProject({}, false);
    installInstructions(dir, '# skill\n', 'node ./node_modules/slopbuckets/dist/index.js');
    expect(readFile(dir, 'AGENTS.md')).toContain('run `npx buckets check` unless');
    installInstructions(dir, '# skill\n', 'node ./cli/dist/index.js');
    expect(readFile(dir, 'AGENTS.md')).toContain('run `node ./cli/dist/index.js check` unless');
    installInstructions(dir, '# skill\n');
    expect(readFile(dir, 'AGENTS.md')).toBe(`${AGENTS_BLOCK}\n`);
    expect(AGENTS_BLOCK).toContain('run `buckets check` unless');
  });

  it('reports a missing skill once as a failure and still writes AGENTS.md', () => {
    const dir = makeProject({}, false);
    const steps = installInstructions(dir, null);
    expect(steps.map((s) => s.status)).toEqual(['done', 'failed']);
    expect(fileExists(dir, '.agents/skills/slopbuckets/SKILL.md')).toBe(false);
  });
});

describe('the version line of a skill copy', () => {
  const skill = '---\nname: slopbuckets\ndescription: How to work here.\n---\n\n# Skill\n';

  it('goes under metadata in the frontmatter, and is read back', () => {
    const stamped = stampSkill(skill, '2.0.0');
    expect(stamped).toBe('---\nname: slopbuckets\ndescription: How to work here.\nmetadata:\n  slopbuckets-version: "2.0.0"\n---\n\n# Skill\n');
    expect(skillVersion(stamped)).toBe('2.0.0');
    expect(skillVersion(skill)).toBeNull();
  });

  it('replaces an earlier version, joins an existing metadata map, and keeps CRLF', () => {
    expect(stampSkill(stampSkill(skill, '2.0.0'), '2.1.0')).toBe(stampSkill(skill, '2.1.0'));
    const withMetadata = '---\nname: x\nmetadata:\n  author: me\n---\nbody\n';
    expect(stampSkill(withMetadata, '2.0.0')).toBe('---\nname: x\nmetadata:\n  slopbuckets-version: "2.0.0"\n  author: me\n---\nbody\n');
    const crlf = skill.replace(/\n/g, '\r\n');
    expect(stampSkill(crlf, '2.0.0')).toBe(stampSkill(skill, '2.0.0').replace(/\n/g, '\r\n'));
    expect(skillVersion(stampSkill(crlf, '2.0.0'))).toBe('2.0.0');
  });

  it('leaves a text without frontmatter alone, and ignores the key in the body', () => {
    expect(stampSkill('# skill\n', '2.0.0')).toBe('# skill\n');
    expect(skillVersion('# skill\n  slopbuckets-version: "2.0.0"\n')).toBeNull();
  });

  it('lists the copies of a project with their versions', () => {
    const dir = makeProject({ '.claude/skills/slopbuckets/SKILL.md': stampSkill(skill, '2.0.0') }, false);
    expect(skillCopies(dir)).toEqual([{ file: '.claude/skills/slopbuckets/SKILL.md', version: '2.0.0' }]);
    writeFile(dir, '.agents/skills/slopbuckets/SKILL.md', skill);
    expect(skillCopies(dir)).toEqual([
      { file: '.claude/skills/slopbuckets/SKILL.md', version: '2.0.0' },
      { file: '.agents/skills/slopbuckets/SKILL.md', version: null },
    ]);
  });
});
