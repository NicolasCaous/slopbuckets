import { createInvoice } from '@root/billing/dmz/invoices/.self';
import { chargeInvoice } from '@root/billing/dmz/payments/.self';

export function startBilling(): void {
  const invoice = createInvoice({ id: 'c-1', name: 'acme' }, 1200);
  const charge = chargeInvoice(invoice);
  console.log('charged ' + charge.amountCents + ' cents for ' + charge.invoiceId);
}
