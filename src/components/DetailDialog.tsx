import { useEffect, useRef, type RefObject } from 'react';
import type { Card, CardTask, Dashboard } from '../../shared/types';
import { orDash } from '../lib/format';
import { BADGE_LABEL } from '../lib/labels';
import { getCardTasks, getTaskStorageKeys } from '../hooks/useWatchlist';
import { Avatar, BadgeChip } from './ProjectCard';

function useBackdropDismiss(ref: RefObject<HTMLDialogElement | null>) {
  // Mandatory fallback for browsers without native <dialog closedby="any"> support (e.g. Safari)
  useEffect(() => {
    const dlg = ref.current;
    if (!dlg || 'closedBy' in HTMLDialogElement.prototype) return;
    let mouseDownOnBackdrop = false;
    const isOnBackdrop = (event: MouseEvent): boolean => {
      if (event.target !== dlg) return false;
      const rect = dlg.getBoundingClientRect();
      return !(
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width
      );
    };
    const onMouseDown = (event: MouseEvent) => {
      mouseDownOnBackdrop = isOnBackdrop(event);
    };
    const onClick = (event: MouseEvent) => {
      const shouldClose = mouseDownOnBackdrop && isOnBackdrop(event);
      mouseDownOnBackdrop = false;
      if (shouldClose) dlg.close();
    };
    dlg.addEventListener('mousedown', onMouseDown);
    dlg.addEventListener('click', onClick);
    return () => {
      dlg.removeEventListener('mousedown', onMouseDown);
      dlg.removeEventListener('click', onClick);
    };
  }, [ref]);
}

function resolveCardIcon(card: Card, icons: Dashboard['IMGS']): string {
  if (card.img !== undefined) return card.img ?? '';
  return icons[String(card.r)] ?? '';
}

function resolveCardChains(card: Card): string[] {
  if (card.chains?.length) return card.chains;
  return card.chain ? [card.chain] : [];
}

function buildDetailRows(card: Card, chains: string[], fit: Dashboard['FIT']): [string, string | number][] {
  const flags = card.b
    .map(k => (k === 'risk' && card.riskLabel ? card.riskLabel : BADGE_LABEL[k]))
    .join(', ');
  return [
    ['Rank', `#${card.r}`],
    ['Ticker', card.t ? `$${card.t}` : 'No ticker yet'],
    ['Chains', chains.length ? chains.join(', ') : 'Not specified'],
    ['Funding', card.f],
    ['Tasks (Open / Total)', card.tk],
    ['Heat (X Score)', card.h.toLocaleString('en-US')],
    ['Updated', card.u === 'today' ? 'Today' : card.u],
    ['Best for', card.fit.map(f => fit[f]).join(', ') || '—'],
    ...(card.x ? [['Code', card.x] as [string, string]] : []),
    ['Status flags', flags || '—'],
  ];
}

function DetailScores({ card }: { card: Card }) {
  const heatWidth =
    card.sub[2] != null
      ? Math.min(100, card.sub[2] * 10)
      : Math.min(100, Math.round(Math.log10(card.h + 1) * 22));
  const heatText = card.sub[2] != null ? `${card.sub[2]}/10` : orDash(card.h.toLocaleString('en-US'));

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
  checked: boolean;
  onToggle: (taskKey: string) => void;
}

function TaskRow({ task: t, storageKey, checked, onToggle }: TaskRowProps) {
  const normStatus = t.status.trim().toUpperCase();
  const isClosed = normStatus === 'CLOSED';
  const showStatus = normStatus === 'OPEN' || isClosed;
  const costLabel = t.cost < 0 ? '—' : t.cost > 0 ? `$${t.cost}` : 'Free';
  const timeLabel = t.timeMinutes ? ` · ${t.timeMinutes} min` : '';

  return (
    <li className={`task-item${checked ? ' is-done' : ''}${isClosed ? ' is-closed' : ''}`}>
      <label className="task-check">
        <input type="checkbox" checked={checked} onChange={() => onToggle(storageKey)} />
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
      {t.url && (
        <a className="task-link" href={t.url} target="_blank" rel="noopener noreferrer">
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
  fit: Dashboard['FIT'];
  icons: Dashboard['IMGS'];
  saved: boolean;
  doneTasks: Set<string>;
  onToggleSaved: (name: string) => void;
  onToggleTask: (taskKey: string) => void;
  onDismiss: () => void;
}

function DetailDialogBody({
  card,
  fit,
  icons,
  saved,
  doneTasks,
  onToggleSaved,
  onToggleTask,
  onDismiss,
}: BodyProps) {
  const icon = resolveCardIcon(card, icons);
  const chains = resolveCardChains(card);
  const taskList = getCardTasks(card);
  const taskKeys = getTaskStorageKeys(card.n, taskList);
  const rows = buildDetailRows(card, chains, fit);

  return (
    <div className="dlg-inner">
      <div className="dlg-head">
        <div className="dlg-title-group">
          <Avatar key={icon} name={card.n} src={icon} size={42} />
          <div>
            <h2 id="detail-title">{card.n}</h2>
            <p className="ticker mono">
              {card.t ? `$${card.t}` : 'Pre-token'} · Rank #{card.r} · Tier {card.g}
            </p>
          </div>
        </div>
        <div className="dlg-head-actions">
          <button
            type="button"
            className="chip"
            aria-pressed={saved}
            onClick={() => onToggleSaved(card.n)}
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

      <DetailScores card={card} />

      <section className="dlg-tasks" aria-label="Project tasks checklist">
        <div className="dlg-section-head">
          <h3>Tasks ({taskList.length})</h3>
          <span className="note">Progress saves locally in your browser</span>
        </div>
        <ul className="task-list">
          {taskList.map((t, i) => (
            <TaskRow
              key={taskKeys[i]}
              task={t}
              storageKey={taskKeys[i]}
              checked={doneTasks.has(taskKeys[i])}
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
  fit: Dashboard['FIT'];
  icons: Dashboard['IMGS'];
  saved: boolean;
  doneTasks: Set<string>;
  onToggleSaved: (name: string) => void;
  onToggleTask: (taskKey: string) => void;
  onClose: () => void;
}

export function DetailDialog({
  card,
  fit,
  icons,
  saved,
  doneTasks,
  onToggleSaved,
  onToggleTask,
  onClose,
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
          card={card}
          fit={fit}
          icons={icons}
          saved={saved}
          doneTasks={doneTasks}
          onToggleSaved={onToggleSaved}
          onToggleTask={onToggleTask}
          onDismiss={() => ref.current?.close()}
        />
      )}
    </dialog>
  );
}
