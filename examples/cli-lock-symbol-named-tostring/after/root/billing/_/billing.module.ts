import { createInvoice } from '@root/billing/dmz/invoices/.self';
import { chargeInvoice } from '@root/billing/dmz/payments/.self';
import { toString, constructor } from '@root/dmz/log/billing';

export function startBilling(): void {
  const invoice = createInvoice('acme', 1200);
  const charge = chargeInvoice(invoice);
  console.log('charged ' + charge.amountCents + ' cents for ' + charge.invoiceId + ' by ' + toString() + ' ' + constructor);
}
