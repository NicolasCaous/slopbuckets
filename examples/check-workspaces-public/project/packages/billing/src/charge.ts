export const rate = 3;

export function charge(amount: number): number {
  return amount * rate;
}
