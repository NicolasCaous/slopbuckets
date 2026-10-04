import { logger } from '@root/billing/dmz/.parent/invoices';
import type { Invoice } from '@root/billing/invoices/_/invoice';

let nextId = 1;

export function createInvoice(customer: string, amountCents: number): Invoice {
  return { id: 'inv-' + nextId++, customer, amountCents };
}
