import { logger } from '@root/billing/dmz/.parent/invoices';
import { renderPdf } from '@root/billing/invoices/dmz/pdf/.self';
import type { Invoice } from '@root/billing/invoices/_/invoice';

let nextId = 1;

export function createInvoice(customer: string, amountCents: number): Invoice {
  const invoice: Invoice = { id: 'inv-' + nextId++, customer, amountCents };
  logger.info('created invoice ' + invoice.id + ': ' + renderPdf(invoice.id));
  return invoice;
}
