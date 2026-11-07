import { charge } from '../billing/index';
import type { Invoice } from '../billing/invoice';

const i: Invoice = { total: charge(2) };
console.log(i);
