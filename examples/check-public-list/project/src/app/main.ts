import { charge } from '../billing/index';
import { refund } from '../billing/server';

console.log(charge(2), refund(1));
