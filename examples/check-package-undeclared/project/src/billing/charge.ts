import merge from 'lodash/merge';

export function charge(amount: number): number {
  return merge({}, { amount }).amount * 2;
}
