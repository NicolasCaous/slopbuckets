export function renderPdf(invoiceId: string): string {
  return '%PDF ' + invoiceId;
}
