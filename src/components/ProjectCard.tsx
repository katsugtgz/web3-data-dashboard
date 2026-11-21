import { useState } from 'react';
import type { Badge, Card, Dashboard } from '../../shared/types';
import { BADGE_LABEL } from '../lib/labels';
import { getCardTasks, getTaskStorageKeys } from '../hooks/useWatchlist';

const BADGE_CLASS: Partial<Record<Badge, string>> = {
  live: 'badge badge-live',
  token: 'badge badge-token',
  early: 'badge badge-early',
  zero: 'badge badge-zero',
  risk: 'badge badge-risk',
};

export function BadgeChip({ k, riskLabel }: { k: Badge; riskLabel?: string }) {
  const text = k === 'risk' && riskLabel ? riskLabel : BADGE_LABEL[k];
  return <span className={BADGE_CLASS[k] ?? 'badge'}>{text}</span>;
}

export function Avatar({ name, src, size = 38 }: { name: string; src: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const initials = name
    .split(/[\s.-]+/)
    .filter(Boolean)
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span className="avatar" style={{ width: size, height: size }} aria-hidden="true">
      <span>{initials || '?'}</span>
      {src && !broken && (
        <img src={src} alt="" loading="lazy" decoding="async" width={size} height={size} onError={() => setBroken(true)} />
      )}
    </span>
  );
}

interface CardHeaderProps {
  card: Card;
  icon: string;
  chains: string[];
  saved: boolean;
  onToggleSaved: (name: string) => void;
  onDetails: (card: Card) => void;
}

function CardHeader({ card: c, icon, chains, saved, onToggleSaved, onDetails }: CardHeaderProps) {
  return (
    <div className="cardrow">
      <Avatar key={icon} name={c.n} src={icon} />
      <div className="cardtitle-wrap">
        <div className="cardname-line">
          <span className="ranknum">
            <span className="sr">Rank </span>
            <span aria-hidden="true">#</span>
            {c.r}
          </span>
          <button type="button" className="cardname-btn" onClick={() => onDetails(c)}>
            {c.n}
          </button>
        </div>
        <p className="ticker">
          <span className="mono">{c.t ? `$${c.t}` : 'Pre-token'}</span>
          {chains.length > 0 && (
            <>
              {' · '}
              <span>
                {chains[0]}
                {chains.length > 1 ? ` +${chains.length - 1}` : ''}
              </span>
            </>
          )}
        </p>
      </div>
      <div className="card-actions">
        <span className={`gradetip ${c.g}`} title={`Tier ${c.g}`}>
          {c.g}
        </span>
        <button
          type="button"
          className="iconbtn starbtn"
          aria-pressed={saved}
          aria-label={`Save ${c.n} to watchlist`}
          title={saved ? 'Remove from watchlist' : 'Save to watchlist'}
          onClick={() => onToggleSaved(c.n)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill={saved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
        </button>
        <button
          type="button"
          className="iconbtn"
          onClick={() => onDetails(c)}
          aria-label={`Details for ${c.n}`}
          title="Inspect project & tasks"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function CardBestTask({ card: c, onDetails }: { card: Card; onDetails: (card: Card) => void }) {
  const mins = c.best.m && c.best.m !== '—' ? ` · ${c.best.m}` : '';
  const cost = c.best.c !== 'Free' ? `${c.best.c}${mins}` : `Free${mins}`;

  return (
    <div className="best">
      <div className="best-info">
        <span className="bl">Best task</span>
        <div className="best-title-row">
          <span className="best-name">{c.best.n}</span>
          {c.best.ty && <span className="typetip">{c.best.ty}</span>}
        </div>
        <span className="subs mono">{cost}</span>
      </div>
      {c.url ? (
        <a className="btn" href={c.url} target="_blank" rel="noopener noreferrer">
          Do it
          <span className="sr"> — {c.n} task (opens in a new tab)</span>
          <span aria-hidden="true">↗</span>
        </a>
      ) : (
        <button type="button" className="btn btn-subtle" onClick={() => onDetails(c)}>
          Details
        </button>
      )}
    </div>
  );
}

function CardScore({ card: c }: { card: Card }) {
  return (
    <div className="score">
      <div className="scorebar" aria-hidden="true">
        <span className={`fill-${c.g}`} style={{ width: `${Math.min(100, Math.max(0, c.sc))}%` }} />
      </div>
      <b className="mono">
        {c.sc}
        <span className="score-max">/100</span>
      </b>
      <span className="subs">
        <span aria-hidden="true">
          L {c.sub[0]} · V {c.sub[1]}
          {c.sub[2] != null ? ` · H ${c.sub[2]}` : ''}
        </span>
        <span className="sr">
          Sub-scores: launch {c.sub[0]} of 10, value {c.sub[1]} of 10
          {c.sub[2] != null ? `, heat ${c.sub[2]} of 10` : ''}
        </span>
      </span>
    </div>
  );
}

interface Props {
  card: Card;
  fit: Dashboard['FIT'];
  icons: Dashboard['IMGS'];
  saved: boolean;
  doneTasks: Set<string>;
  onToggleSaved: (name: string) => void;
  onDetails: (card: Card) => void;
}

export function ProjectCard({ card: c, fit, icons, saved, doneTasks, onToggleSaved, onDetails }: Props) {
  const fitLabels = c.fit.map(f => fit[f]).filter(Boolean);
  const icon = c.img !== undefined ? (c.img ?? '') : (icons[String(c.r)] ?? '');
  const chains = c.chains?.length ? c.chains : c.chain ? [c.chain] : [];

  const tasks = getCardTasks(c);
  const taskKeys = getTaskStorageKeys(c.n, tasks);
  const doneCount = taskKeys.filter(k => doneTasks.has(k)).length;
  const showBadges = c.b.length > 0 || Boolean(c.x) || doneCount > 0;

  return (
    <article className={`cardx${saved ? ' is-saved' : ''}`}>
      <CardHeader
        card={c}
        icon={icon}
        chains={chains}
        saved={saved}
        onToggleSaved={onToggleSaved}
        onDetails={onDetails}
      />

      {showBadges && (
        <div className="badges">
          {c.b.map(k => (
            <BadgeChip key={k} k={k} riskLabel={c.riskLabel} />
          ))}
          {c.x && <span className="codechip">{c.x}</span>}
          {doneCount > 0 && (
            <span className="badge badge-done" title="Completed tasks tracked locally">
              ✓ {doneCount}/{tasks.length} done
            </span>
          )}
        </div>
      )}

      <div className="meta">
        <div>
          Funding
          <b className="mono">{c.f}</b>
        </div>
        <div>
          Tasks
          <b className="mono">{c.tk}</b>
        </div>
        <div>
          Heat
          <b className="mono">{c.h.toLocaleString('en-US')}</b>
        </div>
        <div>
          Updated
          <b>{c.u === 'today' ? 'Today' : c.u}</b>
        </div>
      </div>

      {fitLabels.length > 0 && (
        <div className="fit">
          <span className="lbl">Best for</span>
          {fitLabels.map(f => (
            <span key={f} className="typetip">
              {f}
            </span>
          ))}
        </div>
      )}

      <div className="card-bottom">
        <CardBestTask card={c} onDetails={onDetails} />
        <CardScore card={c} />
      </div>
    </article>
  );
}
