/** Formats an amount in cents for display, e.g. 1999 -> "$19.99". */
export function formatPrice(amountCents: number, currency: 'USD' | 'EUR' = 'USD'): string {
  const symbol = currency === 'USD' ? '$' : '€';
  return symbol + (amountCents / 100).toFixed(2);
}
