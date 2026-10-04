import { logger, type Invoice } from '@root/billing/dmz/invoices/payments';

export interface Charge {
  invoiceId: string;
  amountCents: number;
}

export function chargeInvoice(invoice: Invoice): Charge {
  logger.info('charging ' + invoice.id);
  return { invoiceId: invoice.id, amountCents: invoice.amountCents };
}
