export function assertIntCents(value: number, name: string): void {
  if (!Number.isInteger(value)) throw new Error(`${name} must be integer cents`);
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${sign}${euros}.${rest.toString().padStart(2, '0')}`;
}
