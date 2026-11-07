import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { charge } from '../billing/index';

console.log(charge(2), ts.version, readFileSync);
