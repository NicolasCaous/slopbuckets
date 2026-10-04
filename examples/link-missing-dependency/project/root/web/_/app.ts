import { handle, type Router } from '@api/dmz/server/.external';

export function describe(path: string): string {
  const router: Router = handle(path);
  return router.path;
}
