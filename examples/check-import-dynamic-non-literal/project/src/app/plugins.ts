export async function load(name: string): Promise<unknown> {
  return import(name);
}
