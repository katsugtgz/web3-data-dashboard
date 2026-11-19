export const orDash = <T,>(v: T | null | undefined): T | string => (v == null ? '—' : v);

export function sortVal(s: string): number | null {
  const m = s.replace(/[▲▼$,+%\s]/g, '').match(/^(-?\d+(?:\.\d+)?)([KMBT]?)$/);
  if (!m) return null;
  const mult: Record<string, number> = { '': 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return parseFloat(m[1]) * mult[m[2]] * (/▼/.test(s) ? -1 : 1);
}

export function cmpCells(a: string, b: string): number {
  const x = sortVal(a);
  const y = sortVal(b);
  return x !== null && y !== null ? x - y : a.localeCompare(b);
}
