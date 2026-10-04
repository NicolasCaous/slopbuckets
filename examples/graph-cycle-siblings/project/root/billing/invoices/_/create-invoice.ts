import { logger } from '@root/billing/dmz/.parent/invoices';
import { isPaid } from '@root/billing/dmz/payments/invoices';
import type { Invoice } from '@root/billing/invoices/_/invoice';

let nextId = 1;

export function createInvoice(customer: string, amountCents: number): Invoice {
  const invoice: Invoice = { id: 'inv-' + nextId++, customer, amountCents };
  logger.info('created invoice ' + invoice.id + ' for ' + customer);
  return invoice;
}

export function invoiceStatus(invoice: Invoice): string {
  return isPaid(invoice.id) ? 'paid' : 'open';
}
