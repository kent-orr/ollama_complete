import { formatPrice } from './pricing';

export function receiptLine(name: string, cents: number): string {
  const price = formatPrice(cents, );
  return name + ': ' + price;
}
