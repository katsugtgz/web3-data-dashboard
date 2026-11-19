import { useEffect, useRef } from 'react';
import type { Card, Dashboard } from '../../shared/types';
import { orDash } from '../lib/format';
import { BADGE_LABEL } from '../lib/labels';

interface Props {
  card: Card | null;
  fit: Dashboard['FIT'];
  onClose: () => void;
}

export function DetailDialog({ card, fit, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (card && !dlg.open) dlg.showModal();
    if (!card && dlg.open) dlg.close();
  }, [card]);

  const rows: [string, string | number][] = card
    ? [
        ['Rank', card.r],
        ['Ticker', card.t ? `$${card.t}` : 'No ticker yet'],
        ['Grade', card.g],
        ['Code', card.x || '—'],
        ['Status', card.b.map(k => BADGE_LABEL[k]).join(', ')],
        ['Funding', card.f],
        ['Tasks', card.tk],
        ['Heat', card.h.toLocaleString('en-US')],
        ['Updated', card.u === 'today' ? 'Today' : card.u],
        ['Best for', card.fit.map(f => fit[f]).join(', ') || '—'],
        ['Best task', card.best.n],
        ['Task type', card.best.ty],
        ['Cost', card.best.c],
        ['Time', card.best.m],
        ['Score', `${card.sc}/100`],
        ['Sub-scores', `Launch ${card.sub[0]} · Value ${card.sub[1]} · Heat ${orDash(card.sub[2])} (of 10 each)`],
      ]
    : [];

  return (
    <dialog id="detail" ref={ref} aria-labelledby="detail-title" onClose={onClose}>
      <div className="dlg-head">
        <h2 id="detail-title">{card?.n ?? ''}</h2>
        <button type="button" className="dlg-x" onClick={() => ref.current?.close()} aria-label="Close details">
          ×
        </button>
      </div>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        <div>
          <dt>Link</dt>
          <dd>
            {card?.url ? (
              <a href={card.url} target="_blank" rel="noopener noreferrer">
                Open task
              </a>
            ) : (
              'Not in snapshot'
            )}
          </dd>
        </div>
      </dl>
    </dialog>
  );
}
