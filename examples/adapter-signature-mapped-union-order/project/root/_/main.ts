import type { Flags, Order } from '@root/dmz/log/.self';

const order: Order = 'x';
const flags: Flags<{ debug: true }> = { debug: 'on' };

console.log(order, flags);
