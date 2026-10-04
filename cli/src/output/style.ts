// Terminal styling without dependencies: ANSI colors, color detection and word wrapping.
// Machine output (--json, hook JSON) never goes through a colored Style.

export type ColorLevel = 'none' | 'basic' | 'truecolor';

type Paint = (text: string) => string;

export interface Style {
  level: ColorLevel;
  /** Wrap width for long messages, or undefined to print each message on one line. */
  width: number | undefined;
  /** True when the output goes to a terminal, so Unicode marks and the splash are safe to print. */
  tty: boolean;
  ok: Paint;
  warn: Paint;
  error: Paint;
  path: Paint;
  rule: Paint;
  dim: Paint;
  bold: Paint;
  /** Bright phosphor green, for the banner and headings. */
  phos: Paint;
  /** Paints with a site color when the terminal has true color, or with a basic ANSI code otherwise. */
  hex(color: string, basic: string, text: string): string;
}

const identity: Paint = (text) => text;

function sgr(open: string, close: string): Paint {
  return (text) => (text === '' ? '' : `\u001b[${open}m${text}\u001b[${close}m`);
}

function rgb(hex: string): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return `38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}

export function createStyle(level: ColorLevel, options: { width?: number; tty?: boolean } = {}): Style {
  const on = level !== 'none';
  const paint = (code: string): Paint => (on ? sgr(code, '39') : identity);
  return {
    level,
    width: options.width,
    tty: options.tty ?? false,
    ok: paint('32'),
    warn: paint('33'),
    error: paint('31'),
    path: paint('36'),
    rule: paint('36'),
    dim: on ? sgr('2', '22') : identity,
    bold: on ? sgr('1', '22') : identity,
    phos: level === 'truecolor' ? sgr(rgb('#3dff74'), '39') : paint('92'),
    hex: (color, basic, text) => (level === 'truecolor' ? sgr(rgb(color), '39')(text) : on ? sgr(basic, '39')(text) : text),
  };
}

/** No color, no wrapping. Used for hook reasons, files and anything an AI agent reads through JSON. */
export const PLAIN: Style = createStyle('none');

/**
 * Decides the color level from the environment, following the FORCE_COLOR and NO_COLOR conventions:
 * FORCE_COLOR wins when set (0 or false turns color off, 3 asks for true color), then a non-empty NO_COLOR
 * turns color off, then TERM=dumb, and otherwise color follows whether the stream is a terminal.
 */
export function colorLevel(env: Record<string, string | undefined>, isTTY: boolean): ColorLevel {
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === '0' || force.toLowerCase() === 'false') return 'none';
    return force === '3' || trueColorTerminal(env) ? 'truecolor' : 'basic';
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  if (!isTTY || env.TERM === 'dumb') return 'none';
  return trueColorTerminal(env) ? 'truecolor' : 'basic';
}

function trueColorTerminal(env: Record<string, string | undefined>): boolean {
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return true;
  if (env.WT_SESSION !== undefined) return true;
  return ['iTerm.app', 'vscode', 'WezTerm', 'ghostty'].includes(env.TERM_PROGRAM ?? '');
}

/** Messages wrap at this width at most, even on a wide terminal, so lines stay easy to read. */
const MAX_WRAP = 100;

/** The style for one output stream. Wrapping happens only on a terminal; pipes and files get one message per line. */
export function styleFor(env: Record<string, string | undefined>, stream: { isTTY?: boolean; columns?: number }): Style {
  const tty = stream.isTTY === true;
  const width = tty ? Math.min(stream.columns ?? 80, MAX_WRAP) : undefined;
  return createStyle(colorLevel(env, tty), { tty, ...(width !== undefined ? { width } : {}) });
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Visible width in terminal columns. Every character the CLI prints is one column wide. */
export function visibleWidth(text: string): number {
  return [...stripAnsi(text)].length;
}

export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
}

/**
 * Wraps plain text into lines of at most `width` columns, each prefixed with `indent`.
 * Without a width it returns the text on one line. Words longer than a line stay whole.
 */
export function wrap(text: string, width: number | undefined, indent: string): string[] {
  if (width === undefined) return [indent + text];
  const room = Math.max(20, width - indent.length);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    if (line === '') line = word;
    else if (visibleWidth(line) + 1 + visibleWidth(word) <= room) line += ` ${word}`;
    else {
      lines.push(indent + line);
      line = word;
    }
  }
  if (line !== '' || lines.length === 0) lines.push(indent + line);
  return lines;
}

/** A command or code span: in backticks for plain text, in color without backticks on a terminal. */
export function code(style: Style, text: string): string {
  return style.level === 'none' ? `\`${text}\`` : style.path(text);
}

/** Colors the `code spans` of a message on a terminal and drops their backticks. Plain text is left as it is. */
export function highlightCode(style: Style, text: string): string {
  return style.level === 'none' ? text : text.replace(/`([^`]+)`/g, (_, span: string) => style.path(span));
}
