import { createInvoice, voidInvoice } from '@root/billing/dmz/invoices/.self';
import { chargeInvoice } from '@root/billing/dmz/payments/.self';

export function startBilling(): void {
  const invoice = createInvoice('acme', 1200);
  const charge = chargeInvoice(invoice.amountCents > 1000 ? voidInvoice(invoice) : invoice);
  console.log('charged ' + charge.amountCents + ' cents for ' + charge.invoiceId);
}
