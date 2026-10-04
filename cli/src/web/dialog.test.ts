import { describe, expect, it } from 'vitest';
import { detectDialog, MAC_SCRIPT, sanitizeDialogText, UNIX_PROGRAM_DIRS, windowsScript, type CommandRunner, type DetectOptions, type RunResult } from './dialog.js';

interface Call {
  file: string;
  args: string[];
}

function fakeRunner(result: Partial<RunResult> = {}): CommandRunner & { calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    return { code: 0, stdout: '', stderr: '', ...result };
  };
  return Object.assign(run, { calls });
}

function detect(options: Partial<DetectOptions> & { files?: string[] }): ReturnType<typeof detectDialog> {
  const files = new Set(options.files ?? []);
  return detectDialog({ platform: 'linux', env: {}, exists: (f) => files.has(f), ...options });
}

const REQUEST = { title: 'slopbuckets approval', message: 'Approve 2 contract changes in demo?' };
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

describe('detectDialog', () => {
  it.each([
    ['an SSH session on Windows', { platform: 'win32' as const, env: { SSH_CONNECTION: '1 2 3 4', SystemRoot: 'C:\\Windows' }, files: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'] }, 'SSH'],
    ['an SSH session on macOS', { platform: 'darwin' as const, env: { SSH_TTY: '/dev/ttys001' }, files: ['/usr/bin/osascript'] }, 'SSH'],
    ['Linux without a display', { env: {}, files: ['/usr/bin/zenity'] }, 'DISPLAY'],
    ['a Docker container', { env: { DISPLAY: ':0' }, files: ['/.dockerenv', '/usr/bin/zenity'] }, 'container'],
    ['a Podman container', { env: { DISPLAY: ':0' }, files: ['/run/.containerenv', '/usr/bin/zenity'] }, 'container'],
    ['Linux without zenity or kdialog', { env: { WAYLAND_DISPLAY: 'wayland-0' }, files: [] }, 'zenity nor kdialog'],
    ['Windows without PowerShell', { platform: 'win32' as const, env: { SystemRoot: 'C:\\Windows' }, files: [] }, 'PowerShell'],
    ['macOS without osascript', { platform: 'darwin' as const, env: {}, files: [] }, 'osascript'],
    ['an unknown platform', { platform: 'aix' as const, env: {}, files: [] }, 'aix'],
  ])('refuses in %s and points to the terminal', (_, options, why) => {
    const support = detect(options);
    expect(support.ok).toBe(false);
    if (!support.ok) {
      expect(support.reason).toContain(why);
      expect(support.reason).toContain('buckets refresh');
    }
  });

  it('prefers zenity over kdialog and looks only in fixed system folders, never in PATH', () => {
    const both = detect({ env: { DISPLAY: ':0' }, files: ['/usr/bin/zenity', '/usr/bin/kdialog'] });
    expect(both.ok && both.dialog.name).toBe('zenity');
    const snap = detect({ env: { DISPLAY: ':0' }, files: ['/snap/bin/kdialog'] });
    expect(snap.ok && snap.dialog.name).toBe('kdialog');
    // A program planted in a PATH folder is not used.
    const planted = detect({ env: { DISPLAY: ':0', PATH: '/home/dev/.local/bin:/tmp/evil' }, files: ['/home/dev/.local/bin/zenity', '/tmp/evil/kdialog'] });
    expect(planted.ok).toBe(false);
    expect(UNIX_PROGRAM_DIRS).toEqual(['/usr/bin', '/usr/local/bin', '/bin', '/snap/bin']);
  });

  it('runs the found program by its absolute path', async () => {
    const runner = fakeRunner({ code: 0, stdout: 'ABC123\n' });
    const support = detect({ env: { DISPLAY: ':0' }, files: ['/usr/local/bin/zenity'], runner });
    if (!support.ok) throw new Error(support.reason);
    await support.dialog.confirm(REQUEST);
    expect(runner.calls[0]!.file).toBe('/usr/local/bin/zenity');
  });
});

describe('sanitizeDialogText', () => {
  it('removes control, line separator, bidi and zero-width characters', () => {
    expect(sanitizeDialogText('a\nb\r\nc\u0007d\u001b[31m')).toBe('a b c d [31m');
    expect(sanitizeDialogText('x\u2028y\u2029z')).toBe('x y z');
    expect(sanitizeDialogText('safe\u202eexe.ts\u202c')).toBe('safe exe.ts');
    expect(sanitizeDialogText('a\u2066b\u2067c\u2068d\u2069e\u202af\u202bg\u202dh')).toBe('a b c d e f g h');
    expect(sanitizeDialogText('in\u200bvis\u200cib\u200dle\ufeff\u2060!')).toBe('in vis ib le !');
    expect(sanitizeDialogText('\u200e\u200f\u061cx')).toBe('x');
  });

  it('cuts long text at the limit', () => {
    expect(sanitizeDialogText('x'.repeat(100), 60)).toBe(`${'x'.repeat(57)}...`);
    expect([...sanitizeDialogText('é'.repeat(70), 60)]).toHaveLength(60);
    expect(sanitizeDialogText('short', 60)).toBe('short');
  });
});

describe('Windows dialog', () => {
  const env = { SystemRoot: 'D:\\Win' };
  const shell = 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

  it('runs Windows PowerShell by absolute path with a topmost WinForms window and a text box', async () => {
    const runner = fakeRunner({ stdout: `code:${b64('K7MRPX')}\r\n` });
    const support = detectDialog({ platform: 'win32', env, exists: (f) => f === shell, runner });
    expect(support.ok).toBe(true);
    if (!support.ok) return;
    expect(await support.dialog.confirm(REQUEST)).toBe('K7MRPX');
    const [call] = runner.calls;
    expect(call!.file).toBe(shell);
    expect(call!.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    const script = call!.args[3]!;
    expect(script).toContain('System.Windows.Forms.Form');
    expect(script).toContain('System.Windows.Forms.TextBox');
    expect(script).toContain('$form.TopMost = $true');
    expect(script).toContain("$ok.Text = 'Approve'");
    expect(script).toContain('$form.CancelButton = $cancel');
    expect(script).toContain('ToBase64String');
  });

  it('answers null for cancel or unexpected output and throws when PowerShell fails', async () => {
    const no = detectDialog({ platform: 'win32', env, exists: () => true, runner: fakeRunner({ stdout: 'cancel' }) });
    expect(no.ok && (await no.dialog.confirm(REQUEST))).toBeNull();
    const odd = detectDialog({ platform: 'win32', env, exists: () => true, runner: fakeRunner({ stdout: 'approve' }) });
    expect(odd.ok && (await odd.dialog.confirm(REQUEST))).toBeNull();
    const garbage = detectDialog({ platform: 'win32', env, exists: () => true, runner: fakeRunner({ stdout: 'code:not base64!' }) });
    expect(garbage.ok && (await garbage.dialog.confirm(REQUEST))).toBeNull();
    const empty = detectDialog({ platform: 'win32', env, exists: () => true, runner: fakeRunner({ stdout: 'code:' }) });
    expect(empty.ok && (await empty.dialog.confirm(REQUEST))).toBe('');
    const broken = detectDialog({ platform: 'win32', env, exists: () => true, runner: fakeRunner({ code: 1, stderr: 'boom' }) });
    if (broken.ok) await expect(broken.dialog.confirm(REQUEST)).rejects.toThrow('boom');
  });

  it('passes every text as base64, so quotes and PowerShell syntax in a project name stay data', () => {
    const evil = "x'); Remove-Item -Recurse C:\\ ; ('\n$(calc)\"`";
    const script = windowsScript({ title: evil, message: `Approve 1 change in ${evil}?` });
    expect(script).not.toContain('Remove-Item');
    expect(script).not.toContain('$(calc)');
    expect(script).not.toContain('"');
    expect(script).not.toContain('\n');
    const literals = [...script.matchAll(/FromBase64String\('([^']*)'\)/g)].map((m) => Buffer.from(m[1]!, 'base64').toString('utf8'));
    expect(literals).toHaveLength(2);
    expect(literals[0]).toBe("x'); Remove-Item -Recurse C:\\ ; ('\n$(calc)\"`");
    for (const m of script.matchAll(/FromBase64String\('([^']*)'\)/g)) expect(m[1]).toMatch(/^[A-Za-z0-9+/=]*$/);
  });

  it('removes hidden characters from the texts but keeps the line breaks', () => {
    const script = windowsScript({ title: 'a\u0007b', message: 'one\r\ntwo\u001b[31m\u202e!' });
    const literals = [...script.matchAll(/FromBase64String\('([^']*)'\)/g)].map((m) => Buffer.from(m[1]!, 'base64').toString('utf8'));
    expect(literals).toEqual(['a b', 'one\ntwo [31m !']);
  });
});

describe('macOS dialog', () => {
  it('asks for the code with a default answer and passes the texts through argv', async () => {
    const runner = fakeRunner({ stdout: 'code:K7MRPX\n' });
    const support = detectDialog({ platform: 'darwin', env: {}, exists: (f) => f === '/usr/bin/osascript', runner });
    if (!support.ok) throw new Error(support.reason);
    expect(await support.dialog.confirm({ title: 'T "quoted"', message: 'M" & do shell script "rm' })).toBe('K7MRPX');
    const [call] = runner.calls;
    expect(call!.file).toBe('/usr/bin/osascript');
    expect(call!.args).toEqual([...MAC_SCRIPT.flatMap((line) => ['-e', line]), 'M" & do shell script "rm', 'T "quoted"']);
    expect(MAC_SCRIPT.join('\n')).toContain('default answer ""');
    expect(MAC_SCRIPT.join('\n')).toContain('cancel button "Cancel"');
  });

  it('maps the Cancel button (error -128) to null', async () => {
    const support = detectDialog({ platform: 'darwin', env: {}, exists: () => true, runner: fakeRunner({ code: 1, stderr: 'execution error: User canceled. (-128)' }) });
    expect(support.ok && (await support.dialog.confirm(REQUEST))).toBeNull();
  });
});

describe('Linux dialogs', () => {
  it('zenity: an entry dialog with escaped markup and Approve and Cancel labels', async () => {
    const runner = fakeRunner({ code: 0, stdout: 'k7mrpx\n' });
    const support = detectDialog({ platform: 'linux', env: { DISPLAY: ':0' }, exists: (f) => f === '/usr/bin/zenity', runner });
    if (!support.ok) throw new Error(support.reason);
    expect(await support.dialog.confirm({ title: 'T', message: 'in <b>a&b</b>' })).toBe('k7mrpx');
    expect(runner.calls[0]!.args).toEqual(['--entry', '--title=T', '--text=in &lt;b&gt;a&amp;b&lt;/b&gt;', '--entry-text=', '--ok-label=Approve', '--cancel-label=Cancel', '--width=520']);
    const cancel = detectDialog({ platform: 'linux', env: { DISPLAY: ':0' }, exists: (f) => f === '/usr/bin/zenity', runner: fakeRunner({ code: 1 }) });
    expect(cancel.ok && (await cancel.dialog.confirm(REQUEST))).toBeNull();
  });

  it('kdialog: an input box with Approve and Cancel labels', async () => {
    const runner = fakeRunner({ code: 1 });
    const support = detectDialog({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, exists: (f) => f === '/usr/bin/kdialog', runner });
    if (!support.ok) throw new Error(support.reason);
    expect(await support.dialog.confirm({ title: 'T', message: 'M <i>' })).toBeNull();
    expect(runner.calls[0]!.args).toEqual(['--title', 'T', '--ok-label', 'Approve', '--cancel-label', 'Cancel', '--inputbox', 'M \u2039i\u203a', '']);
    const typed = detectDialog({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, exists: (f) => f === '/usr/bin/kdialog', runner: fakeRunner({ code: 0, stdout: 'ABC123\n' }) });
    expect(typed.ok && (await typed.dialog.confirm(REQUEST))).toBe('ABC123');
  });

  it('answers null when the signal aborts the dialog', async () => {
    const controller = new AbortController();
    const runner: CommandRunner = async () => {
      controller.abort();
      return { code: null, stdout: '', stderr: 'killed' };
    };
    const support = detectDialog({ platform: 'linux', env: { DISPLAY: ':0' }, exists: (f) => f === '/usr/bin/zenity', runner });
    expect(support.ok && (await support.dialog.confirm(REQUEST, controller.signal))).toBeNull();
  });
});
