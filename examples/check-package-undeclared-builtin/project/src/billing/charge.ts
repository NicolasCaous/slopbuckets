import { readFile } from 'fs/promises';

export const template = readFile;
export function charge(amount: number): number {
  return amount * 2;
}
