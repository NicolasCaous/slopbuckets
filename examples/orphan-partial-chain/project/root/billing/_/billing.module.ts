import { logger } from '@root/dmz/log/billing';
import { createInvoice } from '@root/billing/dmz/invoices/.self';
import { chargeInvoice } from '@root/billing/dmz/payments/.self';

export function startBilling(): void {
  const invoice = createInvoice('acme', 1200);
  const charge = chargeInvoice(invoice);
  logger.info('charged ' + charge.amountCents + ' cents for ' + charge.invoiceId);
}
