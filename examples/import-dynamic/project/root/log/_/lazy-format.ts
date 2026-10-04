export async function formatLazy(level: string, message: string): Promise<string> {
  const { formatLine } = await import('@root/log/_/format');
  return formatLine(level, message);
}
