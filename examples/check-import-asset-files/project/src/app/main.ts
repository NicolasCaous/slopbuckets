import './App.css';
import styles from './card.module.css';
import data from './data.json';
import logo from './logo.svg';
import logoUrl from '@/app/logo.svg?url';
import raw from './App.css?raw';
import { charge } from '../billing/index';

console.log(charge(2), styles, data, logo, logoUrl, raw);
