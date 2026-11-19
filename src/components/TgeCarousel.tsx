import { useState } from 'react';
import type { Tge } from '../../shared/types';

export function TgeCarousel({ items }: { items: Tge[] }) {
  const [idx, setIdx] = useState(0);
  const n = items.length;
  if (n === 0) return null;
  const current = items[idx % n];
  return (
    <>
      <div className="carousel" role="region" aria-roledescription="carousel" aria-label="Upcoming TGE and claimable airdrops" style={{ marginTop: 8 }}>
        <div className="cbar">
          <button type="button" className="chip" onClick={() => setIdx(i => (i - 1 + n) % n)} aria-label="Previous TGE">
            ‹
          </button>
          <div className="tgeslide" aria-live="polite">
            <div className="tge">
              <span className="tn">{current.n}</span>
              {current.t && <span className="tt">${current.t}</span>}
              <span className={current.s === 'Claimable' ? 'badge badge-live' : 'badge'}>{current.s}</span>
              <span className="tt">{current.d}</span>
            </div>
          </div>
          <button type="button" className="chip" onClick={() => setIdx(i => (i + 1) % n)} aria-label="Next TGE">
            ›
          </button>
        </div>
        <div className="dots">
          {items.map((it, i) => (
            <button
              type="button"
              key={it.n}
              className="dot"
              onClick={() => setIdx(i)}
              aria-label={`Show ${it.n}`}
              aria-current={i === idx % n ? 'true' : undefined}
            />
          ))}
        </div>
      </div>
    </>
  );
}
