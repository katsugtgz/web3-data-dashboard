const BARE_DOMAIN_URL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]+)+\.[a-z]{2,}(?:[/?#].*)?$/i;
const SIMPLE_BARE_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z]{2,}(?:[/?#].*)?$/i;
const FORBIDDEN_URL_CHARS_RE = /[\s\u0000-\u001F\u007F]/;
const IPV4_HOST_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export interface SafeUrlOptions {
  /** Upgrade scheme-less bare domains (e.g. `t.me/channel`) to `https://`. */
  allowBareDomain?: boolean;
}

/**
 * Parses an untrusted external URL strictly: requires `http:` or `https:`,
 * rejects whitespace/control chars and embedded userinfo (`user:pass@host`).
 */
export function parseSafeHttpUrl(raw?: string | null, opts: SafeUrlOptions = {}): URL | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || FORBIDDEN_URL_CHARS_RE.test(trimmed)) return null;

  let candidate: string;
  if (/^https?:\/\//i.test(trimmed)) {
    candidate = trimmed;
  } else if (opts.allowBareDomain && (BARE_DOMAIN_URL_RE.test(trimmed) || SIMPLE_BARE_DOMAIN_RE.test(trimmed))) {
    candidate = `https://${trimmed}`;
  } else {
    return null;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (!parsed.hostname) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function safeHttpUrl(raw?: string | null, opts: SafeUrlOptions = {}): string | null {
  return parseSafeHttpUrl(raw, opts)?.toString() ?? null;
}

/**
 * Strictly validates an external `https://` asset/image URL: rejects plain
 * `http://`, userinfo, whitespace/control chars, localhost/.local, dotless
 * hosts, and raw IPv4/IPv6 literals while preserving safe query parameters.
 */
export function safeHttpsUrl(raw?: string | null): string | null {
  const parsed = parseSafeHttpUrl(raw);
  if (!parsed || parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  if (!host || !host.includes('.') || host === 'localhost' || host.endsWith('.local')) return null;
  if ((host.startsWith('[') && host.endsWith(']')) || IPV4_HOST_RE.test(host)) return null;
  return parsed.toString();
}
