export type Order = 'x' | 'y' | 'off' | 'on';

export type Flags<T> = { readonly [K in keyof T]?: 'on' | 'off' };
