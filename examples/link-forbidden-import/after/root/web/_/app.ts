import { prefix } from '@api/server/_/helper';

export function describe(path: string): string {
  return prefix(path);
}
