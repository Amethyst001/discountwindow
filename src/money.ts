// Every amount in this system is an integer number of minor units. No float ever stores money.

export type Cents = number;

export function assertIntegerCents(n: number, what = 'amount'): Cents {
  if (!Number.isSafeInteger(n)) throw new Error(`${what} must be integer cents, got ${n}`);
  return n;
}

export function parseMoneyToCents(input: string, what = 'amount'): Cents {
  const s = String(input).trim().replace(/,/g, '');
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`${what} is not a decimal money value: ${input}`);
  const sign = m[1] ? -1 : 1;
  const whole = Number(m[2]);
  const frac = Number((m[3] || '').padEnd(2, '0'));
  return assertIntegerCents(sign * (whole * 100 + frac), what);
}

export function formatCents(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

export function toPayPalAmount(cents: Cents): string {
  const abs = Math.abs(cents);
  return `${abs % 100 === 0 ? Math.floor(abs / 100) : (abs / 100).toFixed(2)}`;
}

// Round half up, deterministically, on integers only.
export function mulRate(cents: Cents, numerator: number, denominator: number): Cents {
  assertIntegerCents(cents);
  const product = cents * numerator;
  return Math.floor((product + Math.floor(denominator / 2)) / denominator);
}
