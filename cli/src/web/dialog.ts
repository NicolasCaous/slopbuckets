// Native confirmation dialogs. `buckets refresh --web` writes the lock only after a human types, in a window of the
// operating system, the confirmation code shown on the review page. An AI agent that has the page link can call the
// approve endpoint, but it cannot type into a native window unless it drives the desktop, which SPEC.md lists in the
// threat model. The code ties the window to the state the human saw: if the project changed after the page loaded,
// the page still shows the old code and the server refuses it.
//
// The programs run through execFile, never a shell, with the text passed as data: base64 for PowerShell and argv
// for osascript, zenity and kdialog. Every program is found at a fixed absolute path, never through PATH, so a
// program planted in a PATH folder cannot answer for the human. Detection happens before the server starts, so a
// machine without a GUI is refused up front.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface DialogRequest {
  title: string;
  /** The text above the input box. Line breaks separate paragraphs. */
  message: string;
}

/** The text the human typed, or null when they cancelled or closed the window. */
export type DialogAnswer = string | null;

export interface ConfirmDialog {
  /** The program that shows the dialog, for messages. */
  name: string;
  /**
   * Shows the dialog with an input box and resolves with what the human typed, or null for Cancel. Aborting the
   * signal closes the dialog and resolves with null.
   */
  confirm(request: DialogRequest, signal?: AbortSignal): Promise<DialogAnswer>;
}

export type DialogSupport = { ok: true; dialog: ConfirmDialog } | { ok: false; reason: string };

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a program without a shell. Tests replace it to see the exact arguments without opening a window. */
export type CommandRunner = (file: string, args: string[], options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv }) => Promise<RunResult>;

export interface DetectOptions {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exists?: (file: string) => boolean;
  runner?: CommandRunner;
}

export const runCommand: CommandRunner = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { maxBuffer: 1024 * 1024, encoding: 'utf8', ...(options.signal ? { signal: options.signal } : {}), ...(options.env ? { env: options.env } : {}) },
      (error, stdout, stderr) => {
        // execFile reports the exit code as a number, and a spawn failure (ENOENT) as a string code.
        const exit = error ? (error as { code?: unknown }).code : 0;
        resolve({ code: typeof exit === 'number' ? exit : null, stdout: String(stdout), stderr: String(stderr || (error && typeof exit !== 'number' ? error.message : '')) });
      },
    );
  });

/**
 * Characters that can hide or reorder text: C0 and C1 controls (line breaks included), the line and paragraph
 * separators, bidirectional controls (U+202A to U+202E, U+2066 to U+2069, the marks U+200E, U+200F and U+061C) and
 * zero-width characters (U+200B to U+200D, U+2060 to U+2064, U+FEFF, U+180E).
 */
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200f\u061c\u2060-\u2064\ufeff\u180e]/g;

/**
 * Makes text from the project safe to show in a dialog: hidden characters become spaces, runs of spaces collapse,
 * and the result is cut at `max` characters with "..." at the end. Use it for every string an agent can control,
 * such as a project, file or symbol name.
 */
export function sanitizeDialogText(text: string, max = 120): string {
  const flat = text.replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 3)).join('')}...` : flat;
}

/** Removes hidden characters from a whole message but keeps its line breaks, which the dialog text itself uses. */
function clean(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(HIDDEN, ' ').replace(/[ \t]+$/, ''))
    .join('\n');
}

function base64(text: string): string {
  return Buffer.from(clean(text), 'utf8').toString('base64');
}

/** What the dialog programs print when the human approves: a prefix and the typed text, so stray output is ignored. */
const ANSWER_PREFIX = 'code:';

/**
 * The PowerShell script for a small topmost WinForms window: the message, a text box and Approve and Cancel
 * buttons. The texts are decoded from base64 literals, whose alphabet cannot end a single-quoted PowerShell
 * string, so nothing in the message can become code. The typed text comes back as base64 too. The script has no
 * double quotes and no line breaks, because Windows passes it to PowerShell through one command-line string.
 */
export function windowsScript(request: DialogRequest): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    `$title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${base64(request.title)}'))`,
    `$message = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${base64(request.message)}'))`,
    '$form = New-Object System.Windows.Forms.Form',
    '$form.Text = $title',
    '$form.TopMost = $true',
    "$form.FormBorderStyle = 'FixedDialog'",
    '$form.MaximizeBox = $false',
    '$form.MinimizeBox = $false',
    "$form.StartPosition = 'CenterScreen'",
    '$form.AutoSize = $true',
    "$form.AutoSizeMode = 'GrowAndShrink'",
    '$form.Padding = New-Object System.Windows.Forms.Padding(12)',
    '$panel = New-Object System.Windows.Forms.FlowLayoutPanel',
    "$panel.FlowDirection = 'TopDown'",
    '$panel.WrapContents = $false',
    '$panel.AutoSize = $true',
    '$label = New-Object System.Windows.Forms.Label',
    '$label.Text = $message',
    '$label.UseMnemonic = $false',
    '$label.AutoSize = $true',
    '$label.MaximumSize = New-Object System.Drawing.Size(560, 0)',
    '$box = New-Object System.Windows.Forms.TextBox',
    '$box.Width = 220',
    '$box.MaxLength = 32',
    "$box.CharacterCasing = 'Upper'",
    "$box.Font = New-Object System.Drawing.Font('Consolas', 14)",
    '$buttons = New-Object System.Windows.Forms.FlowLayoutPanel',
    "$buttons.FlowDirection = 'RightToLeft'",
    '$buttons.AutoSize = $true',
    "$buttons.Anchor = 'Right'",
    '$ok = New-Object System.Windows.Forms.Button',
    "$ok.Text = 'Approve'",
    '$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK',
    '$cancel = New-Object System.Windows.Forms.Button',
    "$cancel.Text = 'Cancel'",
    '$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel',
    '$buttons.Controls.Add($cancel)',
    '$buttons.Controls.Add($ok)',
    '$panel.Controls.Add($label)',
    '$panel.Controls.Add($box)',
    '$panel.Controls.Add($buttons)',
    '$form.Controls.Add($panel)',
    '$form.AcceptButton = $ok',
    '$form.CancelButton = $cancel',
    '$form.Add_Shown({ $form.Activate(); [void]$box.Focus() })',
    '$answer = $form.ShowDialog()',
    '$typed = $box.Text',
    '$form.Dispose()',
    `if ($answer -eq [System.Windows.Forms.DialogResult]::OK) { '${ANSWER_PREFIX}' + [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($typed)) } else { 'cancel' }`,
  ].join('; ');
}

/** Reads the typed text from the Windows script output, or null for cancel or anything unexpected. */
function windowsAnswer(stdout: string): DialogAnswer {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith(ANSWER_PREFIX) || l === 'cancel');
  if (line === undefined || line === 'cancel') return null;
  const encoded = line.slice(ANSWER_PREFIX.length);
  if (!/^[A-Za-z0-9+/=]*$/.test(encoded)) return null;
  return Buffer.from(encoded, 'base64').toString('utf8');
}

/** osascript reads the texts from argv inside a run handler, so they are never parsed as AppleScript. */
export const MAC_SCRIPT = [
  'on run argv',
  'activate',
  `display dialog (item 1 of argv) with title (item 2 of argv) default answer "" buttons {"Cancel", "Approve"} default button "Approve" cancel button "Cancel" with icon caution`,
  `return "${ANSWER_PREFIX}" & (text returned of result)`,
  'end run',
];

/** The typed text after the answer prefix on the first line that has it, or null. */
function prefixedAnswer(stdout: string): DialogAnswer {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith(ANSWER_PREFIX));
  return line === undefined ? null : line.slice(ANSWER_PREFIX.length);
}

/** zenity parses Pango markup in --text, so the message is escaped. */
function pango(text: string): string {
  return clean(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** kdialog may render text with a tag as rich text, so angle brackets are replaced. */
function plainForQt(text: string): string {
  return clean(text).replace(/</g, '\u2039').replace(/>/g, '\u203a');
}

function windowsPowerShell(env: Record<string, string | undefined>): string {
  const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** The only folders where the Linux dialog programs are looked for. PATH is ignored on purpose. */
export const UNIX_PROGRAM_DIRS = ['/usr/bin', '/usr/local/bin', '/bin', '/snap/bin'];

/** Looks for a program in the fixed system folders, never in PATH. */
function findUnixProgram(name: string, exists: (file: string) => boolean): string | null {
  for (const dir of UNIX_PROGRAM_DIRS) {
    const file = path.posix.join(dir, name);
    if (exists(file)) return file;
  }
  return null;
}

const TERMINAL_HINT = 'Ask the human to run `buckets refresh` in a terminal instead.';

/**
 * Decides whether this machine can show a native dialog, and which program shows it. It refuses in an SSH
 * session, in a container, on Linux without DISPLAY or WAYLAND_DISPLAY, and when no dialog program exists.
 */
export function detectDialog(options: DetectOptions): DialogSupport {
  const { platform, env } = options;
  const exists = options.exists ?? existsSync;
  const runner = options.runner ?? runCommand;
  const refuse = (why: string): DialogSupport => ({ ok: false, reason: `${why} ${TERMINAL_HINT}` });
  const failed = (result: RunResult): Error => new Error(`the confirmation window failed (exit code ${result.code ?? 'none'}): ${result.stderr.trim()}`);

  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) {
    return refuse('This is an SSH session, so a confirmation window would not reach the human at this machine.');
  }

  if (platform === 'win32') {
    const shell = windowsPowerShell(env);
    if (!exists(shell)) return refuse(`Windows PowerShell was not found at ${shell}, so the confirmation window cannot open.`);
    return {
      ok: true,
      dialog: {
        name: 'Windows PowerShell',
        async confirm(request, signal) {
          const result = await runner(shell, ['-NoProfile', '-NonInteractive', '-Command', windowsScript(request)], signalOption(signal));
          if (signal?.aborted) return null;
          if (result.code !== 0) throw failed(result);
          return windowsAnswer(result.stdout);
        },
      },
    };
  }

  if (platform === 'darwin') {
    const osascript = '/usr/bin/osascript';
    if (!exists(osascript)) return refuse('osascript was not found, so the confirmation window cannot open.');
    return {
      ok: true,
      dialog: {
        name: 'osascript',
        async confirm(request, signal) {
          const args = [...MAC_SCRIPT.flatMap((line) => ['-e', line]), clean(request.message), clean(request.title)];
          const result = await runner(osascript, args, signalOption(signal));
          if (signal?.aborted) return null;
          // Cancel makes display dialog raise error -128 (User canceled), so osascript exits with 1.
          if (result.code === 0) return prefixedAnswer(result.stdout);
          if (/-128|cancel/i.test(result.stderr)) return null;
          throw failed(result);
        },
      },
    };
  }

  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    if (exists('/.dockerenv') || exists('/run/.containerenv')) {
      return refuse('This looks like a container, so there is no desktop to show a confirmation window.');
    }
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
      return refuse('Neither DISPLAY nor WAYLAND_DISPLAY is set, so there is no desktop to show a confirmation window.');
    }
    const zenity = findUnixProgram('zenity', exists);
    if (zenity !== null) {
      return {
        ok: true,
        dialog: {
          name: 'zenity',
          async confirm(request, signal) {
            const args = ['--entry', `--title=${clean(request.title)}`, `--text=${pango(request.message)}`, '--entry-text=', '--ok-label=Approve', '--cancel-label=Cancel', '--width=520'];
            const result = await runner(zenity, args, signalOption(signal));
            if (signal?.aborted) return null;
            if (result.code === 0) return result.stdout.replace(/\r?\n$/, '');
            if (result.code === 1 || result.code === 5) return null;
            throw failed(result);
          },
        },
      };
    }
    const kdialog = findUnixProgram('kdialog', exists);
    if (kdialog !== null) {
      return {
        ok: true,
        dialog: {
          name: 'kdialog',
          async confirm(request, signal) {
            const args = ['--title', clean(request.title), '--ok-label', 'Approve', '--cancel-label', 'Cancel', '--inputbox', plainForQt(request.message), ''];
            const result = await runner(kdialog, args, signalOption(signal));
            if (signal?.aborted) return null;
            if (result.code === 0) return result.stdout.replace(/\r?\n$/, '');
            if (result.code === 1) return null;
            throw failed(result);
          },
        },
      };
    }
    return refuse(`Neither zenity nor kdialog is installed in ${UNIX_PROGRAM_DIRS.join(', ')}, so the confirmation window cannot open.`);
  }

  return refuse(`There is no confirmation window for the platform "${platform}".`);
}

function signalOption(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal ? { signal } : {};
}
