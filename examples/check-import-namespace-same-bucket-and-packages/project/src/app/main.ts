import * as path from 'node:path';
import { charge } from '../billing/index';
import * as format from './format';

console.log(path.join(format.label, String(charge(2))));
