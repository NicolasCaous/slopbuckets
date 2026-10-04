import { createRequire } from 'node:module';

const load = createRequire(import.meta.url);

export const format = load('@root/log/_/format') as { formatLine(level: string, message: string): string };
