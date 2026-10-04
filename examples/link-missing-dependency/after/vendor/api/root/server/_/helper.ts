import pad from 'slopbuckets-example-missing-package';

export function prefix(path: string): string {
  return pad(`/api${path}`);
}
