import { prefix } from '@api/server/_/helper';

export interface Router {
  path: string;
}

export function handle(path: string, method: string): Router {
  return { path: `${method} ${prefix(path)}` };
}
