import { charge } from '../src/billing/index';
import { env } from './env';

console.log(env, charge(1));
