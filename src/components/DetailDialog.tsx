import { useEffect, useRef, useState } from 'react';
import type { AgentProfile, Card, CardTask, FitKey } from '../../shared/types';
import { buildBrief } from '../lib/agentBrief';
import { downloadMarkdown } from '../lib/clipboard';
import { normalizeExternalUrl, orDash } from '../lib/format';
import { BADGE_LABEL } from '../lib/labels';
import {
  cardLegacyStorageKey,
  cardStorageKey,
  getCardTaskKeyPairs,
  getCardTasks,
  isTaskKeyDone,
} from '../hooks/useWatchlist';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import { CopyStatusBanner, type CopyStatus } from './CopyStatusBanner';
import { Avatar, BadgeChip } from './ProjectCard';

function resolveCardChains(card: Card): string[] {
  if (card.chains?.length) return card.chains;
  return card.chain ? [card.chain] : [];
}

function buildDetailRows(card: Card, chains: string[], fit: Record<FitKey, string>): [string, string | number][] {
  const flags = card.b
    .map(k => (k === 'risk' && card.riskLabel ? card.riskLabel : BADGE_LABEL[k]))
    .join(', ');
  const tickerLabel = card.t ? `$${card.t}` : card.b.includes('token') ? 'Token live' : 'No ticker yet';
  const safeHeat = Number.isFinite(card.h) && card.h >= 0 ? card.h : 0;
  return [
    ['Rank', `#${card.r}`],
    ['Ticker', tickerLabel],
    ['Chains', chains.length ? chains.join(', ') : 'Not specified'],
    ['Funding', card.f],
    ['Tasks (Open / Total)', card.tk],
    ['Heat (X Score)', safeHeat.toLocaleString('en-US')],
    ['Updated', card.u === 'today' ? 'Today' : card.u],
    ['Best for', card.fit.map(f => fit[f]).join(', ') || '—'],
    ...(card.x ? [['Code', card.x] as [string, string]] : []),
    ['Status flags', flags || '—'],
  ];
}

function DetailScores({ card }: { card: Card }) {
  const safeHeat = Number.isFinite(card.h) && card.h >= 0 ? card.h : 0;
  const heatWidth =
    card.sub[2] != null && Number.isFinite(card.sub[2])
      ? Math.min(100, Math.max(0, card.sub[2] * 10))
      : Math.min(100, Math.round(Math.log10(safeHeat + 1) * 22));
  const heatText =
    card.sub[2] != null && Number.isFinite(card.sub[2]) ? `${card.sub[2]}/10` : orDash(safeHeat.toLocaleString('en-US'));

  return (
    <div className="dlg-scores">
      <div className="dlg-score-main">
        <span className="dlg-score-lbl">Potential score</span>
        <strong className="mono">{card.sc}</strong>
        <span className="dlg-score-sub">/ 100</span>
      </div>
      <div className="dlg-subbars">
        <div className="subbar-row">
          <span>Launch</span>
          <div className="scorebar">
            <span style={{ width: `${Math.min(100, card.sub[0] * 10)}%` }} />
          </div>
          <b className="mono">{card.sub[0]}/10</b>
        </div>
        <div className="subbar-row">
          <span>Value</span>
          <div className="scorebar">
            <span style={{ width: `${Math.min(100, card.sub[1] * 10)}%` }} />
          </div>
          <b className="mono">{card.sub[1]}/10</b>
        </div>
        <div className="subbar-row">
          <span>Heat</span>
          <div className="scorebar">
            <span style={{ width: `${heatWidth}%` }} />
          </div>
          <b className="mono">{heatText}</b>
        </div>
      </div>
    </div>
  );
}

interface TaskRowProps {
  task: CardTask;
  storageKey: string;
  legacyKey: string | null;
  checked: boolean;
  onToggle: (taskKey: string, legacyKey?: string) => void;
}

function TaskRow({ task: t, storageKey, legacyKey, checked, onToggle }: TaskRowProps) {
  const normStatus = t.status.trim().toUpperCase();
  const isClosed = normStatus === 'CLOSED';
  const showStatus = normStatus === 'OPEN' || isClosed;
  const costLabel = !Number.isFinite(t.cost) || t.cost < 0 ? '—' : t.cost > 0 ? `$${t.cost}` : 'Free';
  const timeLabel =
    typeof t.timeMinutes === 'number' && Number.isFinite(t.timeMinutes) && t.timeMinutes > 0
      ? ` · ${t.timeMinutes} min`
      : '';
  const href = normalizeExternalUrl(t.url);

  return (
    <li className={`task-item${checked ? ' is-done' : ''}${isClosed ? ' is-closed' : ''}`}>
      <label className="task-check">
        <input type="checkbox" checked={checked} onChange={() => onToggle(storageKey, legacyKey ?? undefined)} />
        <span className="task-meta">
          <span className="task-title">{t.title}</span>
          <span className="task-sub">
            {showStatus && (
              <span className={`task-status ${isClosed ? 'closed' : 'open'}`}>
                {isClosed ? 'Closed' : 'Open'}
              </span>
            )}
            {t.type && <span className="typetip">{t.type}</span>}
            <span className="mono">
              {costLabel}
              {timeLabel}
            </span>
          </span>
        </span>
      </label>
      {href && (
        <a className="task-link" href={href} target="_blank" rel="noopener noreferrer">
          Open
          <span className="sr"> {t.title} (opens in a new tab)</span>
          <span aria-hidden="true"> ↗</span>
        </a>
      )}
    </li>
  );
}

interface BodyProps {
  card: Card;
  fit: Record<FitKey, string>;
  profile: AgentProfile;
  saved: boolean;
  doneTasks: Set<string>;
  onToggleSaved: (name: string, legacyKey?: string) => void;
  onToggleTask: (taskKey: string, legacyKey?: string) => void;
  onCopyBrief: (card: Card) => void;
  onDismiss: () => void;
  copyStatus: CopyStatus | null;
}

function DetailDialogBody({
  card,
  fit,
  profile,
  saved,
  doneTasks,
  onToggleSaved,
  onToggleTask,
  onCopyBrief,
  onDismiss,
  copyStatus,
}: BodyProps) {
  const [showBrief, setShowBrief] = useState(false);
  const icon = card.img ?? '';
  const chains = resolveCardChains(card);
  const taskList = getCardTasks(card);
  const taskPairs = getCardTaskKeyPairs(card, taskList);
  const rows = buildDetailRows(card, chains, fit);
  const renderedBrief = showBrief ? buildBrief(card, profile) : null;
  const slug = card.n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'airdrop';

  return (
    <div className="dlg-inner">
      <div className="dlg-head">
        <div className="dlg-title-group">
          <Avatar key={icon} name={card.n} src={icon} size={42} />
          <div>
            <h2 id="detail-title">{card.n}</h2>
            <p className="ticker mono">
              {card.t ? `$${card.t}` : card.b.includes('token') ? 'Token live' : 'Pre-token'} · Rank #{card.r} · Tier {card.g}
            </p>
          </div>
        </div>
        <div className="dlg-head-actions">
          <button
            type="button"
            className="chip"
            aria-pressed={saved}
            onClick={() => onToggleSaved(cardStorageKey(card), cardLegacyStorageKey(card))}
          >
            <span aria-hidden="true">{saved ? '★' : '☆'}</span> Save
          </button>
          <button type="button" className="dlg-x" onClick={onDismiss} aria-label="Close details">
            ×
          </button>
        </div>
      </div>

      {card.b.length > 0 && (
        <div className="badges" style={{ marginBottom: 14 }}>
          {card.b.map(k => (
            <BadgeChip key={k} k={k} riskLabel={card.riskLabel} />
          ))}
        </div>
      )}

      <CopyStatusBanner status={copyStatus} />

      {card.b.includes('risk') ? (
        <p className="note risk-blocked">Brief unavailable for RISK items.</p>
      ) : (
        <div className="dlg-brief-bar">
          <button type="button" className="btn" onClick={() => onCopyBrief(card)}>
            Copy agent brief
          </button>
          <button
            type="button"
            className="chip"
            aria-expanded={showBrief}
            onClick={() => setShowBrief(v => !v)}
          >
            {showBrief ? 'Hide preview' : 'Preview brief'}
          </button>
          <button
            type="button"
            className="chip"
            onClick={() => {
              const md = buildBrief(card, profile);
              if (md) downloadMarkdown(`${slug}-agent-brief.md`, md);
            }}
          >
            Download .md
          </button>
        </div>
      )}

      {showBrief && renderedBrief && (
        <pre className="brief-preview mono">{renderedBrief}</pre>
      )}

      <DetailScores card={card} />

      <section className="dlg-tasks" aria-label="Project tasks checklist">
        <div className="dlg-section-head">
          <h3>Tasks ({taskList.length})</h3>
          <span className="note">Progress saves locally in your browser</span>
        </div>
        <ul className="task-list">
          {taskList.map((t, i) => (
            <TaskRow
              key={taskPairs[i].primary}
              task={t}
              storageKey={taskPairs[i].primary}
              legacyKey={taskPairs[i].legacy}
              checked={isTaskKeyDone(doneTasks, taskPairs[i])}
              onToggle={onToggleTask}
            />
          ))}
        </ul>
      </section>

      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

interface Props {
  card: Card | null;
  fit: Record<FitKey, string>;
  profile: AgentProfile;
  saved: boolean;
  doneTasks: Set<string>;
  onToggleSaved: (name: string, legacyKey?: string) => void;
  onToggleTask: (taskKey: string, legacyKey?: string) => void;
  onCopyBrief: (card: Card) => void;
  onClose: () => void;
  copyStatus: CopyStatus | null;
}

export function DetailDialog({
  card,
  fit,
  profile,
  saved,
  doneTasks,
  onToggleSaved,
  onToggleTask,
  onCopyBrief,
  onClose,
  copyStatus,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (card && !dlg.open) dlg.showModal();
    if (!card && dlg.open) dlg.close();
  }, [card]);

  useBackdropDismiss(ref);

  return (
    <dialog
      id="detail"
      ref={ref}
      aria-labelledby="detail-title"
      onClose={onClose}
      {...({ closedby: 'any' } as Record<string, string>)}
    >
      {card && (
        <DetailDialogBody
          key={cardStorageKey(card)}
          card={card}
          fit={fit}
          profile={profile}
          saved={saved}
          doneTasks={doneTasks}
          onToggleSaved={onToggleSaved}
          onToggleTask={onToggleTask}
          onCopyBrief={onCopyBrief}
          onDismiss={() => ref.current?.close()}
          copyStatus={copyStatus}
        />
      )}
    </dialog>
  );
}
