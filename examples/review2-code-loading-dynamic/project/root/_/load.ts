declare const module: { constructor: { _load(id: string): unknown } };

const pages = (import.meta as unknown as { glob(pattern: string): unknown }).glob('./pages/*.ts');
const loaded = module.constructor._load('x');

export const all = [pages, loaded];
