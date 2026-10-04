import { createInvoice } from '@root/dmz/billing/.self';

console.log(createInvoice('acme', 1200).id);
