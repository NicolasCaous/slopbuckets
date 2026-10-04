import { currency } from '@root/billing/dmz/.self/invoices';
import { logger } from '@root/billing/dmz/.parent/invoices';
import type { Invoice } from '@root/billing/invoices/_/invoice';

let nextId = 1;

export function createInvoice(customer: string, amountCents: number): Invoice {
  const invoice: Invoice = { id: 'inv-' + nextId++, customer, amountCents };
  logger.info('created invoice ' + invoice.id + ' in ' + currency);
  return invoice;
}
