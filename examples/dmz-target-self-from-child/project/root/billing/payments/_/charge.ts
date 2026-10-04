import type { Invoice } from '@root/billing/dmz/.self/payments';

export interface Charge {
  invoiceId: string;
  amountCents: number;
}

export function chargeInvoice(invoice: Invoice): Charge {
  return { invoiceId: invoice.id, amountCents: invoice.amountCents };
}
