export interface Router {
  path: string;
}

export function route(path: string): Router {
  return { path };
}
