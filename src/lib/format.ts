export const orDash = <T,>(v: T | null | undefined): T | string => (v == null ? '—' : v);

export function sortVal(s: string): number | null {
  const cleaned = s.replace(/[▲▼$,+%\s]/g, '');
  const m = cleaned.match(/^(-?\d+(?:\.\d+)?)([KMBT万亿]?)$/);
  if (!m) return null;
  const mult: Record<string, number> = {
    '': 1,
    K: 1e3,
    M: 1e6,
    B: 1e9,
    T: 1e12,
    万: 1e4,
    亿: 1e8,
  };
  const sign = /▼/.test(s) ? -1 : 1;
  return parseFloat(m[1]) * mult[m[2]] * sign;
}

export function cmpCells(a: string, b: string): number {
  const x = sortVal(a);
  const y = sortVal(b);
  return x !== null && y !== null ? x - y : a.localeCompare(b);
}

export function parseFunding(f: string, raiseNum?: number): number {
  if (typeof raiseNum === 'number' && Number.isFinite(raiseNum) && raiseNum > 0) return raiseNum;
  const v = sortVal(f);
  return v !== null && v > 0 ? v : -1;
}

export function parseCost(c: string, costNum?: number): number {
  if (typeof costNum === 'number' && Number.isFinite(costNum)) return costNum;
  if (/^free$/i.test(c.trim())) return 0;
  const v = sortVal(c);
  return v !== null ? v : Number.MAX_SAFE_INTEGER;
}

export function parseUpdatedDays(u: string, updatedTs?: number): number {
  if (typeof updatedTs === 'number' && updatedTs > 0) {
    return Math.max(0, (Date.now() / 1000 - updatedTs) / 86400);
  }
  const s = u.trim().toLowerCase();
  if (s === 'today') return 0;
  const d = s.match(/^(\d+)\s*d$/);
  if (d) return Number(d[1]);
  const mo = s.match(/^(\d+)\s*mo$/);
  if (mo) return Number(mo[1]) * 30;
  return Number.MAX_SAFE_INTEGER;
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function hostnameLabel(url: string): string {
  try {
    return new URL(url.trim()).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function parseMinutes(m: string): number | null {
  const match = m.trim().match(/^(\d+)\s*min$/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function formatRaiseShort(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '—';
  if (amount >= 999_995_000) return `$${(amount / 1e9).toFixed(2)}B`;
  if (amount >= 999_500) return `$${(amount / 1e6).toFixed(2)}M`;
  if (amount >= 999.5) return `$${(amount / 1e3).toFixed(0)}K`;
  return `$${amount.toFixed(0)}`;
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
