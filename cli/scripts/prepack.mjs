// Copies the files that live at the repository root into the CLI package before npm packs it.
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('..', import.meta.url));
const repo = fileURLToPath(new URL('../..', import.meta.url));

cpSync(`${repo}/README.md`, `${cli}/README.md`);
cpSync(`${repo}/LICENSE`, `${cli}/LICENSE`);
rmSync(`${cli}/skill`, { recursive: true, force: true });
cpSync(`${repo}/skill`, `${cli}/skill`, { recursive: true });
