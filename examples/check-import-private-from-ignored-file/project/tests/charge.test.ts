import { charge } from '../src/billing/charge';

if (charge(1) !== 2) throw new Error('charge');
