const DEV_LOOPBACK_CONNECT_SOURCES = [
  'http://localhost:*',
  'http://127.0.0.1:*',
  'ws://localhost:*',
  'ws://127.0.0.1:*',
] as const;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

const HTML_COMMENT_OR_META_RE = /(<!--[\s\S]*?-->)|(<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>)/gi;
const ATTR_RE = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const CONNECT_SRC_DIRECTIVE_RE = /^(\s*)(connect-src)(?=\s|$)([\s\S]*)$/i;

interface ContentAttrSpan {
  value: string;
  start: number;
  end: number;
}

function extractLoopbackHttpOrigin(apiBase?: string): string | null {
  const trimmed = apiBase?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:') return null;
    if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function findCspMetaContentSpan(metaTag: string): ContentAttrSpan | null {
  const bodyStart = 5; // length of "<meta"
  const bodyEnd = metaTag.endsWith('/>') ? metaTag.length - 2 : metaTag.length - 1;
  const body = metaTag.slice(bodyStart, bodyEnd);

  let isCsp = false;
  let contentSpan: ContentAttrSpan | null = null;

  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(body)) !== null) {
    const attrName = match[1].toLowerCase();
    const doubleQuoted = match[2];
    const singleQuoted = match[3];
    const unquoted = match[4];
    const attrValue = doubleQuoted ?? singleQuoted ?? unquoted;

    if (attrName === 'http-equiv' && attrValue !== undefined) {
      if (attrValue.trim().toLowerCase() === 'content-security-policy') {
        isCsp = true;
      }
    } else if (attrName === 'content' && attrValue !== undefined && contentSpan === null) {
      const attrOffset = bodyStart + match.index;
      let start: number;
      if (doubleQuoted !== undefined) {
        start = attrOffset + match[0].indexOf('"') + 1;
      } else if (singleQuoted !== undefined) {
        start = attrOffset + match[0].indexOf("'") + 1;
      } else {
        const eqIndex = attrOffset + match[0].indexOf('=');
        start = metaTag.indexOf(attrValue, eqIndex + 1);
      }
      contentSpan = { value: attrValue, start, end: start + attrValue.length };
    }
  }

  return isCsp ? contentSpan : null;
}

function rewriteConnectSrc(policy: string, candidateSources: readonly string[]): string {
  const directives = policy.split(';');
  let changed = false;
  let seenConnectSrc = false;

  const rewritten = directives.map((directive) => {
    if (seenConnectSrc) return directive;
    const match = CONNECT_SRC_DIRECTIVE_RE.exec(directive);
    if (!match) return directive;

    seenConnectSrc = true;
    const [, leading, name, rawValue] = match;
    const trimmedEnd = rawValue.replace(/\s+$/, '');
    const trailing = rawValue.slice(trimmedEnd.length);
    const existing = new Set(
      trimmedEnd
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => token.toLowerCase()),
    );

    const missing: string[] = [];
    for (const source of candidateSources) {
      const key = source.toLowerCase();
      if (!existing.has(key)) {
        existing.add(key);
        missing.push(source);
      }
    }

    if (missing.length === 0) return directive;
    changed = true;
    return `${leading}${name}${trimmedEnd} ${missing.join(' ')}${trailing}`;
  });

  return changed ? rewritten.join(';') : policy;
}

export function rewriteDevCspHtml(html: string, apiBase?: string): string {
  const extraOrigin = extractLoopbackHttpOrigin(apiBase);
  const candidateSources = extraOrigin
    ? [...DEV_LOOPBACK_CONNECT_SOURCES, extraOrigin]
    : DEV_LOOPBACK_CONNECT_SOURCES;

  return html.replace(HTML_COMMENT_OR_META_RE, (fullMatch, comment: string | undefined, metaTag: string | undefined) => {
    if (comment !== undefined || metaTag === undefined) return fullMatch;

    const contentSpan = findCspMetaContentSpan(metaTag);
    if (!contentSpan) return metaTag;

    const updated = rewriteConnectSrc(contentSpan.value, candidateSources);
    if (updated === contentSpan.value) return metaTag;

    return `${metaTag.slice(0, contentSpan.start)}${updated}${metaTag.slice(contentSpan.end)}`;
  });
}

export interface DevLocalhostCspPlugin {
  name: 'dev-localhost-csp';
  apply: 'serve';
  configResolved(config: { readonly env: Readonly<Record<string, unknown>> }): void;
  transformIndexHtml(html: string): string;
}

export function createDevLocalhostCspPlugin(): DevLocalhostCspPlugin {
  let apiBase: string | undefined;

  return {
    name: 'dev-localhost-csp',
    apply: 'serve',
    configResolved(config) {
      apiBase = typeof config.env.VITE_API_BASE === 'string' ? config.env.VITE_API_BASE : undefined;
    },
    transformIndexHtml(html) {
      return rewriteDevCspHtml(html, apiBase);
    },
  };
}
