import { useMemo, useRef, useState } from 'react';
import type { Tge } from '../../shared/types';
import { normalizeExternalUrl } from '../lib/format';
import { formatTgeStatus } from '../lib/labels';
import { Avatar } from './ProjectCard';

type TgeFilter = 'all' | 'claimable' | 'verify' | 'other';

export function TgeCarousel({ items }: { items: Tge[] }) {
  const [filter, setFilter] = useState<TgeFilter>('all');
  const railRef = useRef<HTMLDivElement>(null);

  const normalized = useMemo(() => {
    const seen = new Map<string, number>();
    return items.map(it => {
      const st = formatTgeStatus(it.s);
      // Split inline "$TICKER" from snapshot names like "predict.fun $PREDICT"
      let name = it.n;
      let ticker = it.t;
      if (!ticker) {
        const m = name.match(/^(.*?)\s+\$([A-Za-z0-9_]+)$/);
        if (m) {
          name = m[1];
          ticker = m[2];
        }
      }
      const baseKey = `${name}-${it.t}-${it.d}-${it.source ?? ''}`;
      const occ = seen.get(baseKey) ?? 0;
      seen.set(baseKey, occ + 1);
      return {
        ...it,
        name,
        ticker,
        safeUrl: normalizeExternalUrl(it.url),
        itemKey: `${baseKey}-${occ}`,
        statusLabel: st.label,
        statusKind: st.kind,
        claimable: st.claimable,
      };
    });
  }, [items]);

  const claimableCount = useMemo(() => normalized.filter(i => i.statusKind === 'claimable').length, [normalized]);
  const verifyCount = useMemo(() => normalized.filter(i => i.statusKind === 'verify').length, [normalized]);
  const otherCount = normalized.length - claimableCount - verifyCount;
  const activeFilter: TgeFilter = filter === 'other' && otherCount === 0 ? 'all' : filter;

  const visible = useMemo(() => {
    if (activeFilter === 'claimable') return normalized.filter(i => i.statusKind === 'claimable');
    if (activeFilter === 'verify') return normalized.filter(i => i.statusKind === 'verify');
    if (activeFilter === 'other') return normalized.filter(i => i.statusKind === 'other');
    return normalized;
  }, [normalized, activeFilter]);

  if (items.length === 0) return null;

  const scrollBy = (dir: -1 | 1) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({ left: dir * Math.max(280, rail.clientWidth * 0.75), behavior: 'smooth' });
  };

  return (
    <div className="tge-section">
      <div className="tge-toolbar">
        <div className="chipline" role="group" aria-label="Filter TGE status">
          <button type="button" className="chip" aria-pressed={activeFilter === 'all'} onClick={() => setFilter('all')}>
            All <span className="chip-count mono">{normalized.length}</span>
          </button>
          <button
            type="button"
            className="chip"
            aria-pressed={activeFilter === 'claimable'}
            onClick={() => setFilter('claimable')}
          >
            Claimable <span className="chip-count mono">{claimableCount}</span>
          </button>
          <button
            type="button"
            className="chip"
            aria-pressed={activeFilter === 'verify'}
            onClick={() => setFilter('verify')}
          >
            Eligibility check <span className="chip-count mono">{verifyCount}</span>
          </button>
          {otherCount > 0 && (
            <button
              type="button"
              className="chip"
              aria-pressed={activeFilter === 'other'}
              onClick={() => setFilter('other')}
            >
              Other <span className="chip-count mono">{otherCount}</span>
            </button>
          )}
        </div>
        <div className="tge-nav">
          <button type="button" className="iconbtn" onClick={() => scrollBy(-1)} aria-label="Scroll TGE list left">
            ‹
          </button>
          <button type="button" className="iconbtn" onClick={() => scrollBy(1)} aria-label="Scroll TGE list right">
            ›
          </button>
        </div>
      </div>

      {visible.length > 0 ? (
        <div
          className="tge-rail"
          ref={railRef}
          role="region"
          aria-label="Upcoming TGE and claimable airdrops"
          tabIndex={0}
        >
          {visible.map(it => (
            <article key={it.itemKey} className="tge-card">
              <div className="tge-card-top">
                <Avatar key={it.logo ?? ''} name={it.name} src={it.logo ?? ''} size={30} />
                <div className="tge-card-title">
                  <span className="tn">{it.name}</span>
                  {it.ticker && <span className="tt mono">${it.ticker}</span>}
                </div>
                {it.tier && <span className={`gradetip ${it.tier}`}>{it.tier}</span>}
              </div>
              <div className="tge-card-meta">
                <span className={it.claimable ? 'badge badge-live' : 'badge'}>{it.statusLabel}</span>
                <span className="tt mono">{it.d}</span>
                {it.raise && <span className="tt mono">{it.raise}</span>}
                {it.source && (
                  <span className="typetip mono" title={`Source: ${it.source}`}>
                    {it.source}
                  </span>
                )}
              </div>
              {it.safeUrl && (
                <a className="tge-link" href={it.safeUrl} target="_blank" rel="noopener noreferrer">
                  Open link
                  <span className="sr"> for {it.name} (opens in a new tab)</span>
                  <span aria-hidden="true"> ↗</span>
                </a>
              )}
            </article>
          ))}
        </div>
      ) : (
        <p className="note" role="status">
          No TGE events match this filter.
        </p>
      )}
    </div>
  );
}
