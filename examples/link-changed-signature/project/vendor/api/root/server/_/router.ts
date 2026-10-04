import { prefix } from '@api/server/_/helper';

export interface Router {
  path: string;
}

export function handle(path: string): Router {
  return { path: prefix(path) };
}
