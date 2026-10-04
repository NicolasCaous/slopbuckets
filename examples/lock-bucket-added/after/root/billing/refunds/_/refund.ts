export interface Refund {
  invoiceId: string;
  amountCents: number;
}

export function refund(invoiceId: string, amountCents: number): Refund {
  return { invoiceId, amountCents };
}
