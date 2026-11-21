export const USER_AGENT = 'web3-radar/1.0 (+https://github.com/katsugtgz/web3-data-dashboard)';
export const FETCH_TIMEOUT_MS = 15_000;

export function fmtUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '—';
  // Trillions boundary at the 2-decimal rounding edge: 999.995B rounds to $1.00T.
  if (amount >= 999_995_000_000) return `$${(amount / 1e12).toFixed(2)}T`;
  if (amount >= 999_995_000) return `$${(amount / 1e9).toFixed(2)}B`;
  if (amount >= 999_500) return `$${(amount / 1e6).toFixed(2)}M`;
  if (amount >= 999.5) return `$${(amount / 1e3).toFixed(0)}K`;
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(4)}`;
  // toPrecision(3) emits exponential notation below 1e-6 ($8.9e-8): fixed
  // decimals keep the cell ASCII-parseable for the sort contract.
  return `$${amount.toFixed(Math.min(12, 2 + Math.ceil(-Math.log10(amount))))}`;
}

export function fmtPrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return '—';
  if (price >= 1000) return `$${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (price >= 1) return `$${price.toFixed(2)}`;
  if (price >= 0.001) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(Math.min(12, 2 + Math.ceil(-Math.log10(price))))}`;
}

export function fmtPct(pct: number | null | undefined): string {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

export function fmtInt(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

export function fmtIsoDate(input?: string | number | null): string {
  // Nullish only: 0 is a valid (if epoch) timestamp and must not read as TBA.
  if (input == null) return 'TBA';
  const d = typeof input === 'number' ? new Date(input) : new Date(input);
  if (Number.isNaN(d.getTime())) return 'TBA';
  return d.toISOString().slice(0, 10);
}
