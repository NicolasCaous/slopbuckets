import { startBilling } from '@root/dmz/billing/.self';
import { logger } from '@root/dmz/log/.self';

logger.info('starting billing');
startBilling();
