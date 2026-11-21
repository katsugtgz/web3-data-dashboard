import { useMemo, useRef, useState } from 'react';
import type { Tge } from '../../shared/types';
import { formatTgeStatus } from '../lib/labels';
import { Avatar } from './ProjectCard';

type TgeFilter = 'all' | 'claimable' | 'verify';

export function TgeCarousel({ items }: { items: Tge[] }) {
  const [filter, setFilter] = useState<TgeFilter>('all');
  const railRef = useRef<HTMLDivElement>(null);

  const normalized = useMemo(
    () =>
      items.map(it => {
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
        return { ...it, name, ticker, statusLabel: st.label, statusKind: st.kind, claimable: st.claimable };
      }),
    [items],
  );

  const claimableCount = useMemo(() => normalized.filter(i => i.statusKind === 'claimable').length, [normalized]);
  const verifyCount = useMemo(() => normalized.filter(i => i.statusKind === 'verify').length, [normalized]);

  const visible = useMemo(() => {
    if (filter === 'claimable') return normalized.filter(i => i.statusKind === 'claimable');
    if (filter === 'verify') return normalized.filter(i => i.statusKind === 'verify');
    return normalized;
  }, [normalized, filter]);

  if (items.length === 0) return null;

  const scrollBy = (dir: -1 | 1) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({ left: dir * Math.max(280, rail.clientWidth * 0.75), behavior: 'smooth' });
  };

  return (
    <div
      className="tge-section"
      role="region"
      aria-label="Upcoming TGE and claimable airdrops"
    >
      <div className="tge-toolbar">
        <div className="chipline" role="group" aria-label="Filter TGE status">
          <button type="button" className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            All <span className="chip-count mono">{normalized.length}</span>
          </button>
          <button
            type="button"
            className="chip"
            aria-pressed={filter === 'claimable'}
            onClick={() => setFilter('claimable')}
          >
            Claimable <span className="chip-count mono">{claimableCount}</span>
          </button>
          <button
            type="button"
            className="chip"
            aria-pressed={filter === 'verify'}
            onClick={() => setFilter('verify')}
          >
            Eligibility check <span className="chip-count mono">{verifyCount}</span>
          </button>
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

      <div className="tge-rail" ref={railRef} tabIndex={0}>
        {visible.map(it => (
          <article key={`${it.name}-${it.d}`} className="tge-card">
            <div className="tge-card-top">
              <Avatar name={it.name} src={it.logo ?? ''} size={30} />
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
            </div>
            {it.url && (
              <a
                className="tge-link"
                href={it.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${it.name} link (opens in a new tab)`}
              >
                Open link ↗
              </a>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
