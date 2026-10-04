export function formatLegacy(level: string, message: string): string {
  const format = require('@root/log/_/format');
  return format.formatLine(level, message);
}
