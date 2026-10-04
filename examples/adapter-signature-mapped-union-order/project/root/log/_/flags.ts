export type Order = 'x' | 'y';

export type Flags<T> = { readonly [K in keyof T]?: 'on' | 'off' };
