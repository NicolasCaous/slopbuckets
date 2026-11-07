import { charge } from '../billing/index';
import type { Invoice } from '../billing/index';

const invoice: Invoice = { total: charge(2) };
console.log(invoice.total);
