import { createInvoice } from '@root/billing/dmz/invoices/.self';

export function startBilling(): void {
  const invoice = createInvoice('acme', 1200);
  console.log('created ' + invoice.id);
}
