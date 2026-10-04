// The splash screen: the block-letter banner and the slop bucket from the website hero, sized to the terminal.
// Only `buckets` with no arguments and `buckets init` show it, and only when stdout is a terminal.
import { padEnd, type Style } from './style.js';

export const TAGLINE = 'Let the AI write slop. Keep it in buckets.';

/** The "SLOPBUCKETS" banner from site/index.html, 91 columns wide. */
const WIDE = [
  '███████╗██╗      ██████╗ ██████╗ ██████╗ ██╗   ██╗ ██████╗██╗  ██╗███████╗████████╗███████╗',
  '██╔════╝██║     ██╔═══██╗██╔══██╗██╔══██╗██║   ██║██╔════╝██║ ██╔╝██╔════╝╚══██╔══╝██╔════╝',
  '███████╗██║     ██║   ██║██████╔╝██████╔╝██║   ██║██║     █████╔╝ █████╗     ██║   ███████╗',
  '╚════██║██║     ██║   ██║██╔═══╝ ██╔══██╗██║   ██║██║     ██╔═██╗ ██╔══╝     ██║   ╚════██║',
  '███████║███████╗╚██████╔╝██║     ██████╔╝╚██████╔╝╚██████╗██║  ██╗███████╗   ██║   ███████║',
  '╚══════╝╚══════╝ ╚═════╝ ╚═╝     ╚═════╝  ╚═════╝  ╚═════╝╚═╝  ╚═╝╚══════╝   ╚═╝   ╚══════╝',
];
/** "SLOP" is the first 33 columns of each banner row, "BUCKETS" the rest (58 columns). */
const SLOP = WIDE.map((row) => [...row].slice(0, 33).join('').trimEnd());
const BUCKETS = WIDE.map((row) => [...row].slice(33).join(''));

/** The bucket from the site, at half size: bubbles, handle, green slop, rim and a banded body. 24 columns. */
const BUCKET = [
  '       O        o       ',
  '     _.-""""""""-._     ',
  "  .-' ▄▄▄ o  ▄▄▄▄  '-.  ",
  ' / ▄▓▓▓▓▓▄▄▄▓▓▓▓▓▓▄▄▄ \\ ',
  '▐██████████████████████▌',
  '  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ',
  '   ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒   ',
  '    ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀    ',
];

/** A smaller bucket for narrow terminals. 14 columns. */
const MINI_BUCKET = [
  '    O    o    ',
  '  _.-""""-._  ',
  ' / ▄▓▓▄▄▓▓▄ \\ ',
  '▐████████████▌',
  '  ▓▓▓▓▓▓▓▓▓▓  ',
  '   ▀▀▀▀▀▀▀▀   ',
];

// Site colors (true color) with a basic ANSI fallback.
const COLORS = {
  banner: ['#3dff74', '92'],
  bubble: ['#b8ffcc', '97'],
  handle: ['#a7d8b4', '37'],
  slop: ['#3dff74', '92'],
  rim: ['#8fb79a', '37'],
  body: ['#3d6b4b', '32'],
  band: ['#9fd1ad', '37'],
  tagline: ['#b8ffcc', '97'],
} as const;

type Role = keyof typeof COLORS;

function paint(style: Style, role: Role, text: string): string {
  const [hex, basic] = COLORS[role];
  return style.hex(hex, basic, text);
}

function roleOf(ch: string, belowRim: boolean): Role | null {
  if (ch === ' ') return null;
  if (ch === 'O' || ch === 'o') return 'bubble';
  if ('█▐▌'.includes(ch)) return 'rim';
  if (ch === '▒') return 'band';
  if ('▓▄▀'.includes(ch)) return belowRim ? 'body' : 'slop';
  return 'handle';
}

/** Colors one bucket row character by character, the way the site colors its spans. Spaces join the open run. */
function paintBucketRow(style: Style, row: string, belowRim: boolean): string {
  let out = '';
  let run = '';
  let runRole: Role | null = null;
  for (const ch of row.trimEnd()) {
    const role = roleOf(ch, belowRim);
    if (role !== null && runRole !== null && role !== runRole) {
      out += paint(style, runRole, run);
      run = '';
    }
    if (role !== null) runRole = role;
    run += ch;
  }
  return out + (runRole === null ? run : paint(style, runRole, run));
}

function paintBucket(style: Style, rows: string[]): string[] {
  const rim = rows.findIndex((row) => row.includes('█'));
  return rows.map((row, i) => paintBucketRow(style, row, i > rim));
}

function banner(style: Style, row: string): string {
  return style.bold(paint(style, 'banner', row));
}

/** Places `right` next to `left`, starting at column `at`, with `offset` rows of `right` above the first row of `left`. */
function sideBySide(left: string[], right: string[], at: number, offset: number): string[] {
  const top = Math.max(0, offset);
  const height = Math.max(left.length + top, right.length);
  const lines: string[] = [];
  for (let i = 0; i < height; i++) {
    const l = left[i - top] ?? '';
    const r = right[i] ?? '';
    lines.push(r === '' ? l : padEnd(l, at) + r);
  }
  return lines.map((line) => line.trimEnd());
}

function taglineLine(style: Style, version: string): string {
  return `${style.bold(paint(style, 'tagline', TAGLINE))}  ${style.dim(`v${version}`)}`;
}

/**
 * Renders the splash for a terminal `columns` wide:
 * 118 columns and up: the one-row banner with the bucket beside it;
 * 60 to 117: SLOP over BUCKETS with the bucket beside SLOP (59 columns);
 * 40 to 59: the small bucket next to the name and the tagline;
 * below 40: text only.
 */
export function renderSplash(version: string, columns: number | undefined, style: Style): string {
  const cols = columns ?? 80;
  const bucket = paintBucket(style, BUCKET);
  let lines: string[];
  if (cols >= 118) {
    lines = sideBySide(WIDE.map((row) => banner(style, row)), bucket, 93, BUCKET.length - WIDE.length);
    lines.push('', taglineLine(style, version));
  } else if (cols >= 60) {
    const slop = SLOP.map((row) => banner(style, row));
    lines = sideBySide([...slop, ''], bucket, 35, 1);
    lines.push(...BUCKETS.map((row) => banner(style, row)), '', taglineLine(style, version));
  } else if (cols >= 40) {
    const text = [
      '',
      `${banner(style, 'SLOPBUCKETS')}  ${style.dim(`v${version}`)}`,
      style.bold(paint(style, 'tagline', 'Let the AI write slop.')),
      style.bold(paint(style, 'tagline', 'Keep it in buckets.')),
    ];
    lines = paintBucket(style, MINI_BUCKET).map((row, i) => (text[i] ? padEnd(row, 18) + text[i] : row));
  } else {
    lines = [`${banner(style, 'SLOPBUCKETS')}  ${style.dim(`v${version}`)}`, ...TAGLINE.replace('. ', '.\n').split('\n').map((t) => paint(style, 'tagline', t))];
  }
  return `\n${lines.join('\n')}\n\n`;
}
