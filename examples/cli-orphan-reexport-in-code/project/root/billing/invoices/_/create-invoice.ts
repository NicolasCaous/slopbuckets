import type { Invoice } from '@root/billing/invoices/_/invoice';

export { logger } from '@root/billing/dmz/.parent/invoices';

let nextId = 1;

export function createInvoice(customer: string, amountCents: number): Invoice {
  return { id: 'inv-' + nextId++, customer, amountCents };
}
