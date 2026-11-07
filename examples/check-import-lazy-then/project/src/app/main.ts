export const lazyCharge = () => import('../billing/index').then(({ charge }) => charge(2));

export async function lazyRefund() {
  const { refund } = await import('../billing/index');
  return refund(1);
}
