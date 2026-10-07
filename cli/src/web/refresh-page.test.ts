import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, LOGGER_PROJECT, makeProject, removeFile, writeFile } from '../testing/fixture.js';
import { approve, testContext } from '../testing/harness.js';
import { serializeLock } from '../core/lock.js';
import { lockConfigHash } from '../core/lock-config.js';
import { escapeHtml, html, raw } from './html.js';
import { CODE_ALPHABET, CODE_LENGTH, confirmationCode, evaluateLockState, normalizeTypedCode, type LockReview } from './lock-review.js';
import { describeDmzPath, renderBlockedPage, renderClosedPage, renderCurrentPage, renderReviewPage } from './refresh-page.js';

afterEach(cleanupProjects);

const CTX = { token: 'tok', projectName: 'fixture' };

async function review(dir: string): Promise<LockReview> {
  const state = await evaluateLockState(testContext({ toolchain: 'typescript@5.9.3' }), dir);
  if (state.kind !== 'review') throw new Error(`expected a review, got ${state.kind}`);
  return state.review;
}

/** The text of the page without tags, with whitespace collapsed, for readable assertions. */
function textOf(page: string): string {
  return page
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&#62;/g, '>')
    .replace(/&#60;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

describe('html', () => {
  it('escapes interpolated text and keeps SafeHtml', () => {
    const name = '<img src=x onerror="alert(1)">';
    expect(html`<p title="${name}">${name}</p>`.value).toBe(`<p title="${escapeHtml(name)}">${escapeHtml(name)}</p>`);
    expect(escapeHtml(`<>&"'`)).toBe('&#60;&#62;&#38;&#34;&#39;');
    expect(html`<ul>${['a', raw('<li>b</li>'), null, false, 3]}</ul>`.value).toBe('<ul>a<li>b</li>3</ul>');
  });
});

describe('describeDmzPath', () => {
  it.each([
    ['root/dmz/log/billing.ts', 'root/billing uses these symbols from root/log.'],
    ['root/billing/dmz/.parent/invoices.ts', 'root/billing/invoices uses these symbols, which come from outside root/billing.'],
    ['root/billing/dmz/invoices/.parent.ts', 'root/billing/invoices provides these symbols to code outside root/billing.'],
    ['root/billing/dmz/.self/invoices.ts', 'root/billing/invoices uses these symbols from root/billing/_.'],
    ['root/billing/dmz/invoices/.self.ts', 'root/billing/_ uses these symbols from root/billing/invoices.'],
    ['root/x.ts', null],
  ])('%s', (file, expected) => {
    expect(describeDmzPath(file)).toBe(expected);
  });
});

describe('renderReviewPage', () => {
  it('shows every kind of change: versions, buckets, DMZ files, symbols and signatures', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir, { ...testContext({ toolchain: 'typescript@5.8.0' }), cliVersion: '0.0.0' });
    writeFile(dir, 'root/log/_/logger.ts', 'export function logger(message: string, level: number): void {}\nexport const level = 1;\n');
    writeFile(dir, 'root/mail/_/m.ts', "import { level } from '@root/dmz/log/mail';\nexport const m = level;\n");
    writeFile(dir, 'root/dmz/log/mail.ts', "export { level } from '@root/log/_/logger';\n");
    removeFile(dir, 'root/billing/payments');
    writeFile(dir, 'buckets.config.json', '{ "root": "root", "maxDepth": 3 }\n');

    const r = await review(dir);
    const page = renderReviewPage(CTX, r);
    const text = textOf(page);

    expect(text).toContain('Approve contract changes');
    expect(text).toMatch(/CLI version 0\.0\.0 1\.0\.0/);
    expect(text).toMatch(/Toolchain typescript@5\.8\.0 typescript@5\.9\.3/);
    expect(text).toContain('+ bucket created root/mail');
    expect(text).toContain('- bucket removed root/billing/payments');
    expect(text).toContain('~ maxDepth 2 to 3');
    expect(text).toContain('+ root/dmz/log/mail.ts new file');
    expect(text).toContain('root/mail uses these symbols from root/log.');
    expect(text).toContain('+ level exported');
    expect(text).toContain("export { level } from '@root/log/_/logger';");
    expect(text).toContain('~ root/dmz/log/billing.ts text unchanged');
    expect(text).toContain('~ logger signature changed at its declaration in _/ code');
    expect(text).toContain(`${r.counts.total} changes to approve`);
    expect(page).toContain(`data-hash="${r.hash}"`);
    expect(page).toContain('<meta name="buckets-token" content="tok">');
    expect(page).toContain('id="approve"');
    expect(page).toContain('id="cancel"');
    // No inline script: the CSP allows only scripts from the server.
    expect(page).not.toMatch(/<script>(?!<\/script>)/);
    expect([...page.matchAll(/<script([^>]*)>/g)].every((m) => /src="\/assets\//.test(m[1]!))).toBe(true);
  });

  it('lists each access line and value that changed in buckets.config.json', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'buckets.config.json': JSON.stringify({ root: 'root', access: { default: 'allow', deny: ['root/billing/** -> root/zz*'] } }) });
    await approve(dir);
    writeFile(dir, 'buckets.config.json', JSON.stringify({ root: 'root', maxDepth: 3, access: { default: 'allow', deny: ['root/log/** -> root/zz*'] } }));
    const r = await review(dir);
    expect(r.config).toMatchObject({ changed: true, recorded: true });
    const page = renderReviewPage(CTX, r);
    const text = textOf(page);
    expect(text).toContain('buckets.config.json 3 changes Config');
    expect(text).toContain('- deny line removed root/billing/** -> root/zz*');
    expect(text).toContain('+ deny line added root/log/** -> root/zz*');
    expect(text).toContain('~ maxDepth 2 to 3');
    expect(page).toContain('<ul class="diff" aria-label="Config changes">');
  });

  it('shows the config being approved when the approved lock kept only its hash', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const lock = await approve(dir);
    writeFile(dir, 'buckets.lock.json', serializeLock({ ...lock, lockVersion: 3, config: lockConfigHash(lock.config) }));
    writeFile(dir, 'buckets.config.json', JSON.stringify({ root: 'root', maxDepth: 3 }));
    const text = textOf(renderReviewPage(CTX, await review(dir)));
    expect(text).toContain('so the old values were not recorded. These are the values approving records:');
    expect(text).toContain('maxDepth 3');
  });

  it('lists the whole state for a first lock', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const text = textOf(renderReviewPage(CTX, await review(dir)));
    expect(text).toContain('Approve the first lock');
    expect(text).toContain('+ bucket root/billing/invoices');
    expect(text).toContain('+ root/billing/dmz/.parent/invoices.ts new file');
  });

  it('shows a deleted DMZ file and says its text is gone', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/dmz/log/.self.ts': "export { logger } from '@root/log/_/logger';\n", 'root/_/main.ts': "import { logger } from '@root/dmz/log/.self';\nlogger('x');\n" });
    await approve(dir);
    writeFile(dir, 'root/_/main.ts', 'export const main = 1;\n');
    removeFile(dir, 'root/dmz/log/.self.ts');
    const text = textOf(renderReviewPage(CTX, await review(dir)));
    expect(text).toContain('- root/dmz/log/.self.ts deleted');
    expect(text).toContain('- logger was exported');
    expect(text).toContain('the deleted text cannot be shown');
  });

  it('shows the confirmation code of the rendered state and a hidden stale banner', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    writeFile(dir, 'root/log/_/logger.ts', 'export function logger(message: string, level: number): void {}\n');
    const r = await review(dir);
    expect(r.code).toBe(confirmationCode(r.hash));
    expect(r.code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`));
    const page = renderReviewPage(CTX, r);
    const text = textOf(page);
    expect(text).toContain(`Confirmation code ${r.code}`);
    expect(page).toContain(`data-code="${r.code}"`);
    expect(page).toContain(`<strong class="code" translate="no">${r.code}</strong>`);
    expect(page).toMatch(/<div class="stale-banner callout warn" id="stale-banner" role="status" hidden>/);
    expect(text).toContain('Reload to review the current changes and get their code');
    expect(page).toContain('data-project="."');
    expect(text).toContain('asks for the confirmation code above');
  });

  it('derives stable codes from the hash with an unambiguous alphabet', () => {
    expect(confirmationCode('sha256:0000000000000000000000000000000000000000000000000000000000000000')).toBe('AAAAAA');
    const a = confirmationCode(`sha256:${'ab'.repeat(32)}`);
    expect(a).toBe(confirmationCode(`sha256:${'ab'.repeat(32)}`));
    expect(a).not.toBe(confirmationCode(`sha256:${'ac'.repeat(32)}`));
    for (const ch of '01OIL2Z5S6G8BUV') expect(CODE_ALPHABET).not.toContain(ch);
    expect(normalizeTypedCode(' k7m-rpx ')).toBe('K7MRPX');
  });

  it('escapes names from the project', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'package.json': JSON.stringify({ name: '<script>alert(1)</script>' }) });
    const r = await review(dir);
    const page = renderReviewPage({ token: 'tok', projectName: r.project.name }, r);
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('&#60;script&#62;alert(1)&#60;/script&#62;');
  });
});

describe('other refresh pages', () => {
  it('shows the violations when the rules break after the server started', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/_/main.ts': "import x from './x';\n" });
    const state = await evaluateLockState(testContext(), dir);
    if (state.kind !== 'violations') throw new Error(state.kind);
    const text = textOf(renderBlockedPage(CTX, state));
    expect(text).toContain('Nothing to approve yet');
    expect(text).toContain('import-relative');
    expect(text).toContain('Reload');
  });

  it('renders the up to date and closed pages', () => {
    expect(textOf(renderCurrentPage(CTX))).toContain('already matches the project');
    expect(textOf(renderClosedPage(CTX, { title: 'Approved', text: 'buckets.lock.json is written.' }))).toContain('Approved buckets.lock.json is written.');
  });
});

describe('browser scripts', () => {
  it('parse as JavaScript', async () => {
    const { CLIENT_JS } = await import('./assets/client.js');
    const { REFRESH_JS } = await import('./assets/refresh.js');
    for (const code of [CLIENT_JS, REFRESH_JS]) expect(() => new Function(code)).not.toThrow();
  });
});
