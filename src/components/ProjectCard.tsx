import { useState } from 'react';
import type { Badge, Card, FitKey } from '../../shared/types';
import {
  cardLegacyStorageKey,
  cardStorageKey,
  getCardTaskKeyPairs,
  getCardTasks,
  isTaskKeyDone,
} from '../hooks/useWatchlist';
import { normalizeExternalUrl } from '../lib/format';
import { BADGE_LABEL } from '../lib/labels';
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  LockIcon,
  StarIcon,
} from './Icons';

const MAX_CARD_CHIPS = 3;

const BADGE_CLASS: Partial<Record<Badge, string>> = {
  live: 'badge badge-live',
  token: 'badge badge-token',
  early: 'badge badge-early',
  zero: 'badge badge-zero',
  risk: 'badge badge-risk',
};

type ProjectTag =
  | { id: string; kind: 'badge'; badge: Badge; label: string }
  | { id: string; kind: 'code'; label: string }
  | { id: string; kind: 'done'; label: string }
  | { id: string; kind: 'fit'; label: string };

function normalizeTagKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/\s+path$/i, '')
    .replace(/\s+/g, ' ');
}

function buildProjectTags(card: Card, fit: Record<FitKey, string>, doneCount: number, taskTotal: number): ProjectTag[] {
  const seen = new Set<string>();
  const tags: ProjectTag[] = [];

  const pushUnique = (tag: ProjectTag) => {
    const key = normalizeTagKey(tag.label);
    if (!key || seen.has(key)) return;
    seen.add(key);
    tags.push(tag);
  };

  // Prioritize risk & progress badges so critical cues are never hidden behind +N.
  if (card.b.includes('risk')) {
    pushUnique({
      id: 'badge-risk',
      kind: 'badge',
      badge: 'risk',
      label: card.riskLabel || BADGE_LABEL.risk,
    });
  }

  if (doneCount > 0) {
    pushUnique({
      id: 'badge-done',
      kind: 'done',
      label: `${doneCount}/${taskTotal} done`,
    });
  }

  for (const b of card.b) {
    if (b === 'risk') continue;
    pushUnique({
      id: `badge-${b}`,
      kind: 'badge',
      badge: b,
      label: BADGE_LABEL[b],
    });
  }

  if (card.x) {
    pushUnique({ id: `code-${card.x}`, kind: 'code', label: card.x });
  }

  for (const f of card.fit) {
    const label = fit[f];
    if (!label) continue;
    pushUnique({ id: `fit-${f}`, kind: 'fit', label });
  }

  return tags;
}

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
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          width={size}
          height={size}
          onError={() => setBroken(true)}
        />
      )}
    </span>
  );
}

interface CardHeaderProps {
  card: Card;
  icon: string;
  chains: string[];
  saved: boolean;
  onToggleSaved: (key: string, legacyKey?: string) => void;
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
          <span className="mono">{c.t ? `$${c.t}` : c.b.includes('token') ? 'Token live' : 'Pre-token'}</span>
          {chains.length > 0 && (
            <>
              {' · '}
              <span>
                {chains[0]}
                {chains.length > 1 ? ` +${chains.length - 1}` : ''}
              </span>
            </>
          )}
          {c.source && (
            <>
              {' · '}
              <span className="mono" title={`Source: ${c.source}`}>
                {c.source}
              </span>
            </>
          )}
        </p>
      </div>
      <div className="card-actions">
        <span className={`gradetip tier-pill ${c.g}`} title={`Tier ${c.g}`}>
          Tier {c.g}
        </span>
        <button
          type="button"
          className="iconbtn starbtn"
          aria-pressed={saved}
          aria-label={`Save ${c.n} to watchlist`}
          title={saved ? 'Remove from watchlist' : 'Save to watchlist'}
          onClick={() => onToggleSaved(cardStorageKey(c), cardLegacyStorageKey(c))}
        >
          <StarIcon size={14} fill={saved ? 'currentColor' : 'none'} />
        </button>
        <button
          type="button"
          className="iconbtn"
          onClick={() => onDetails(c)}
          aria-label={`Details for ${c.n}`}
          title="Inspect project & tasks"
        >
          <ChevronRightIcon size={14} />
        </button>
      </div>
    </div>
  );
}

function ProjectChipRow({ tags, riskLabel }: { tags: ProjectTag[]; riskLabel?: string }) {
  if (tags.length === 0) return null;
  const firstThreeLen = tags.slice(0, MAX_CARD_CHIPS).reduce((sum, tag) => sum + tag.label.length, 0);
  const visibleCount = tags.length > 2 && firstThreeLen > 34 ? 2 : MAX_CARD_CHIPS;
  const visible = tags.slice(0, visibleCount);
  const overflow = tags.slice(visibleCount);

  return (
    <div className="badges chip-row">
      {visible.map(tag => {
        if (tag.kind === 'badge') {
          return <BadgeChip key={tag.id} k={tag.badge} riskLabel={riskLabel} />;
        }
        if (tag.kind === 'code') {
          return (
            <span key={tag.id} className="codechip">
              {tag.label}
            </span>
          );
        }
        if (tag.kind === 'done') {
          return (
            <span key={tag.id} className="badge badge-done" title="Completed tasks tracked locally">
              <CheckCircle2Icon size={12} />
              <span>{tag.label}</span>
            </span>
          );
        }
        return (
          <span key={tag.id} className="typetip">
            {tag.label}
          </span>
        );
      })}
      {overflow.length > 0 && (
        <span className="typetip chip-overflow mono" title={overflow.map(t => t.label).join(' · ')}>
          +{overflow.length}
        </span>
      )}
    </div>
  );
}

function CardBestTask({ card: c, onDetails }: { card: Card; onDetails: (card: Card) => void }) {
  const mins = c.best.m && c.best.m !== '—' ? ` · ${c.best.m}` : '';
  const cost = c.best.c !== 'Free' ? `${c.best.c}${mins}` : `Free${mins}`;
  const href = normalizeExternalUrl(c.url);

  return (
    <div className="best task-preview">
      <div className="best-info">
        <span className="bl">Best task</span>
        <div className="best-title-row">
          <span className="best-name">{c.best.n}</span>
          {c.best.ty && <span className="typetip">{c.best.ty}</span>}
        </div>
        <span className="subs mono">{cost}</span>
      </div>
      {href ? (
        <a className="btn btn-sm btn-tonal" href={href} target="_blank" rel="noopener noreferrer">
          <span>Open task</span>
          <span className="sr"> — {c.n} task (opens in a new tab)</span>
          <ExternalLinkIcon size={13} />
        </a>
      ) : (
        <button type="button" className="btn btn-sm btn-subtle" onClick={() => onDetails(c)}>
          Details
        </button>
      )}
    </div>
  );
}

function CardScore({ card: c }: { card: Card }) {
  return (
    <div className="score scorebar-wrap">
      <div className="scorebar" aria-hidden="true">
        <span className={`fill-${c.g}`} style={{ width: `${Math.min(100, Math.max(0, c.sc))}%` }} />
      </div>
      <b className="mono">
        {c.sc}
        <span className="score-max">/100</span>
      </b>
    </div>
  );
}

interface Props {
  card: Card;
  fit: Record<FitKey, string>;
  saved: boolean;
  doneTasks: Set<string>;
  onToggleSaved: (key: string, legacyKey?: string) => void;
  onDetails: (card: Card) => void;
  onCopyBrief: (card: Card) => void;
}

export function ProjectCard({ card: c, fit, saved, doneTasks, onToggleSaved, onDetails, onCopyBrief }: Props) {
  const icon = c.img ?? '';
  const chains = c.chains?.length ? c.chains : c.chain ? [c.chain] : [];

  const tasks = getCardTasks(c);
  const taskPairs = getCardTaskKeyPairs(c, tasks);
  const doneCount = taskPairs.filter(pair => isTaskKeyDone(doneTasks, pair)).length;
  const tags = buildProjectTags(c, fit, doneCount, tasks.length);
  const isRisk = c.b.includes('risk');
  const safeHeat = Number.isFinite(c.h) && c.h >= 0 ? c.h : 0;
  const subTitle = `Launch potential ${c.sub[0]}/10, Airdrop value ${c.sub[1]}/10${c.sub[2] != null ? `, Heat ${c.sub[2]}/10` : ''}`;

  return (
    <article className={`cardx project-card${saved ? ' is-saved' : ''}`}>
      <CardHeader
        card={c}
        icon={icon}
        chains={chains}
        saved={saved}
        onToggleSaved={onToggleSaved}
        onDetails={onDetails}
      />

      <ProjectChipRow tags={tags} riskLabel={c.riskLabel} />

      <div className="card-bottom project-bottom">
        <div className="meta project-stats">
          <div>
            Funding
            <b className="mono">{c.f}</b>
          </div>
          <div title={`${c.tk} open tasks`}>
            Open tasks
            <b className="mono">{c.tk}</b>
          </div>
          <div>
            Heat
            <b className="mono">{safeHeat.toLocaleString('en-US')}</b>
          </div>
          <div>
            Updated
            <b className="mono">{c.u === 'today' ? 'Today' : c.u}</b>
          </div>
        </div>

        <CardBestTask card={c} onDetails={onDetails} />

        <CardScore card={c} />

        <div className="card-bottom-row project-foot">
          <span className="subs project-subscores" title={subTitle}>
            <span aria-hidden="true">
              Launch {c.sub[0]} · Value {c.sub[1]}
              {c.sub[2] != null ? ` · Heat ${c.sub[2]}` : ''}
            </span>
            <span className="sr">
              Sub-scores: launch {c.sub[0]} of 10, value {c.sub[1]} of 10
              {c.sub[2] != null ? `, heat ${c.sub[2]} of 10` : ''}
            </span>
          </span>

          {isRisk ? (
            <span
              className="status-pill risk-blocked-status"
              aria-disabled="true"
              title="Blocked: high risk / agent guardrail"
              aria-label={`Copy agent brief blocked for ${c.n}: high risk`}
            >
              <LockIcon size={13} />
              <span>Risk blocked</span>
            </span>
          ) : (
            <button type="button" className="chip project-copy-btn" onClick={() => onCopyBrief(c)}>
              <CopyIcon size={13} />
              <span>Copy agent brief</span>
              <span className="sr"> for {c.n}</span>
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
