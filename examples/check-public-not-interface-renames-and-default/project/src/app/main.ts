import refund, { bill, type Invoice } from '../billing/index';

const invoice: Invoice = { total: bill(2) };
console.log(refund(invoice.total));
