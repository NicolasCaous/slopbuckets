export async function lazy(): Promise<number> {
  const billing = await import('../billing/index');
  return billing.charge(1);
}
