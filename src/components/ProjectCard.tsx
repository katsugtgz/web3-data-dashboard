import { useState } from 'react';
import type { Badge, Card, Dashboard } from '../../shared/types';
import { orDash } from '../lib/format';
import { BADGE_LABEL } from '../lib/labels';

const BADGE_CLASS: Partial<Record<Badge, string>> = { live: 'badge badge-live', risk: 'badge badge-risk' };

export function BadgeChip({ k }: { k: Badge }) {
  return <span className={BADGE_CLASS[k] ?? 'badge'}>{BADGE_LABEL[k]}</span>;
}

function Avatar({ name, src }: { name: string; src: string }) {
  const [broken, setBroken] = useState(false);
  const initials = name
    .split(/\s+/)
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span className="avatar" aria-hidden="true">
      <span>{initials}</span>
      {src && !broken && (
        <img src={src} alt="" loading="lazy" width={36} height={36} onError={() => setBroken(true)} />
      )}
    </span>
  );
}

interface Props {
  card: Card;
  fit: Dashboard['FIT'];
  icons: Dashboard['IMGS'];
  onDetails: (card: Card) => void;
}

export function ProjectCard({ card: c, fit, icons, onDetails }: Props) {
  const fitLabels = c.fit.map(f => fit[f]).filter(Boolean);
  const icon = c.img !== undefined ? (c.img ?? '') : (icons[String(c.r)] ?? '');
  const mins = c.best.m && c.best.m !== '—' ? ` · ${c.best.m}` : '';
  const cost = c.best.c !== 'Free' ? `${c.best.c}${mins}` : `Free${mins}`;

  return (
    <article className="cardx">
      <div className="cardrow">
        <Avatar key={icon} name={c.n} src={icon} />
        <div>
          <p className="cardname">
            <span className="sr">Rank {c.r}. </span>
            {c.n}
          </p>
          <p className="ticker">
            {c.t ? `$${c.t}` : 'No ticker yet'} · {c.f}
          </p>
        </div>
        <span className={`gradetip ${c.g}`} title={`Grade ${c.g}`}>
          {c.g}
        </span>
        {c.x && <span className="codechip">{c.x}</span>}
        <button type="button" className="more" onClick={() => onDetails(c)} aria-label={`Details for ${c.n}`}>
          ›
        </button>
      </div>
      <div className="badges">
        {c.b.map(k => (
          <BadgeChip key={k} k={k} />
        ))}
      </div>
      <div className="meta">
        <div>
          Funding<b>{c.f}</b>
        </div>
        <div>
          Tasks<b>{c.tk}</b>
        </div>
        <div>
          Heat<b>{c.h.toLocaleString('en-US')}</b>
        </div>
        <div>
          Updated<b>{c.u === 'today' ? 'Today' : c.u}</b>
        </div>
      </div>
      {fitLabels.length > 0 && (
        <p className="fit">
          <span className="lbl">Best for: </span>
          {fitLabels.map(f => (
            <span key={f} className="typetip">
              {f}
            </span>
          ))}
        </p>
      )}
      <div className="best">
        <span className="bl">Best task</span>
        <span>{c.best.n}</span>
        <span className="typetip">{c.best.ty}</span>
        <span className="subs">{cost}</span>
        {c.url ? (
          <a
            className="btn"
            href={c.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Do task for ${c.n} (opens in a new tab)`}
          >
            Do it
          </a>
        ) : (
          <span className="nolink" title="Outbound link not captured in this snapshot">
            Link not in snapshot
          </span>
        )}
      </div>
      <div className="score">
        <div className="scorebar" aria-hidden="true">
          <span style={{ width: `${c.sc}%` }} />
        </div>
        <b>
          {c.sc}/100 · {c.g}
        </b>
        <span
          className="subs"
          aria-label={`Sub-scores: launch ${c.sub[0]} of 10, value ${c.sub[1]} of 10, heat ${orDash(c.sub[2])} of 10`}
        >
          Launch {c.sub[0]} · Value {c.sub[1]} · Heat {orDash(c.sub[2])}
        </span>
      </div>
    </article>
  );
}
