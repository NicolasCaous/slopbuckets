// The paths of the protocol and the source files the adapter reads.
import path from 'node:path';

/** The file extensions the adapter reads, with the dot. info() reports them, and the CLI lists files by them. */
export const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Matches a path that ends in one of EXTENSIONS. */
export const SOURCE = sourcePattern(EXTENSIONS);

/** A pattern that matches a path ending in one of `extensions`, such as ['.ts', '.js']. */
export function sourcePattern(extensions: readonly string[]): RegExp {
  return new RegExp(`(?:${extensions.map((e) => e.replaceAll('.', '\\.')).join('|')})$`);
}

/** An OS path with `/` between its segments, the form every path of the protocol takes. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
