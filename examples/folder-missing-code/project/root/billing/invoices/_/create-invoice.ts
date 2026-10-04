export interface Invoice {
  id: string;
  customer: string;
  amountCents: number;
}

export function createInvoice(customer: string, amountCents: number): Invoice {
  return { id: 'inv-1', customer, amountCents };
}
