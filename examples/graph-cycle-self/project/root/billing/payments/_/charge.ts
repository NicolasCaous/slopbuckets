export interface Charge {
  invoiceId: string;
  amountCents: number;
}

export function chargeInvoice(invoice: { id: string; amountCents: number }): Charge {
  return { invoiceId: invoice.id, amountCents: invoice.amountCents };
}
