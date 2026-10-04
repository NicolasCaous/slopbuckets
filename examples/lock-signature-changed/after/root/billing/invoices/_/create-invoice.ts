import { logger } from '@root/billing/dmz/.parent/invoices';
import type { Invoice } from '@root/billing/invoices/_/invoice';

let nextId = 1;

export function createInvoice(customer: { id: string; name: string }, amountCents: number): Invoice {
  const invoice: Invoice = { id: 'inv-' + nextId++, customer: customer.name, amountCents };
  logger.info('created invoice ' + invoice.id + ' for ' + customer.id);
  return invoice;
}
