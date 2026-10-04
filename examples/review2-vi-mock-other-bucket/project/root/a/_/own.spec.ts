declare const vi: { mock(path: string): void };

vi.mock('@root/a/_/own');
vi.mock('@root/b/_/secret');

export {};
