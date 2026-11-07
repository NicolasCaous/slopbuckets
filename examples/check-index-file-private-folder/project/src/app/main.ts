import { charge } from '../billing';
import { secret } from '../billing/internal';

console.log(charge(secret));
