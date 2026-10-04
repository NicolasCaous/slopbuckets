import type { Invoice } from '@root/billing/invoices/_/invoice';

export function voidInvoice(invoice: Invoice): Invoice {
  return { ...invoice, amountCents: 0 };
}
