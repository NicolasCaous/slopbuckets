import type { Invoice } from '@root/billing/dmz/invoices/payments';

export interface Charge {
  invoiceId: string;
  amountCents: number;
}

const paid = new Set<string>();

export function chargeInvoice(invoice: Invoice): Charge {
  paid.add(invoice.id);
  return { invoiceId: invoice.id, amountCents: invoice.amountCents };
}

export function isPaid(invoiceId: string): boolean {
  return paid.has(invoiceId);
}
