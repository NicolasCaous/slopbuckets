import { refund } from '../src/billing/index';

if (refund(1) !== -1) throw new Error('refund');
