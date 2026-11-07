import type { Stripe } from 'stripe';

export type Client = Stripe;
export function charge(amount: number): number {
  return amount * 2;
}
