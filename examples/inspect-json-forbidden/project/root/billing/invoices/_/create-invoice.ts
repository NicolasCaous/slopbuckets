import { logger } from '@root/billing/dmz/.parent/invoices';
import type { Invoice } from '@root/billing/invoices/_/invoice';
import { formatCents } from '@root/billing/payments/_/money';

let nextId = 1;

export function createInvoice(customer: string, amountCents: number): Invoice {
  const invoice: Invoice = { id: 'inv-' + nextId++, customer, amountCents };
  logger.info('created invoice ' + invoice.id + ' of ' + formatCents(amountCents));
  return invoice;
}
