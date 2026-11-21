import { useEffect, useRef } from 'react';
import type { Card, Dashboard } from '../../shared/types';
import { orDash } from '../lib/format';
import { BADGE_LABEL } from '../lib/labels';
import { getCardTasks, getTaskStorageKeys } from '../hooks/useWatchlist';
import { Avatar, BadgeChip } from './ProjectCard';

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
  }, []);

  const icon = card ? (card.img !== undefined ? (card.img ?? '') : (icons[String(card.r)] ?? '')) : '';
  const chains = card ? (card.chains?.length ? card.chains : card.chain ? [card.chain] : []) : [];

  const taskList = card ? getCardTasks(card) : [];
  const taskKeys = card ? getTaskStorageKeys(card.n, taskList) : [];

  const rows: [string, string | number][] = card
    ? [
        ['Rank', `#${card.r}`],
        ['Ticker', card.t ? `$${card.t}` : 'No ticker yet'],
        ['Chains', chains.length ? chains.join(', ') : 'Not specified'],
        ['Funding', card.f],
        ['Tasks (Open / Total)', card.tk],
        ['Heat (X Score)', card.h.toLocaleString('en-US')],
        ['Updated', card.u === 'today' ? 'Today' : card.u],
        ['Best for', card.fit.map(f => fit[f]).join(', ') || '—'],
        ...(card.x ? [['Code', card.x] as [string, string]] : []),
        ['Status flags', card.b.map(k => (k === 'risk' && card.riskLabel ? card.riskLabel : BADGE_LABEL[k])).join(', ') || '—'],
      ]
    : [];

  return (
    <dialog
      id="detail"
      ref={ref}
      aria-labelledby="detail-title"
      onClose={onClose}
      {...({ closedby: 'any' } as Record<string, string>)}
    >
      {card && (
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
              <button
                type="button"
                className="dlg-x"
                onClick={() => ref.current?.close()}
                aria-label="Close details"
              >
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
                  <span
                    style={{
                      width: `${card.sub[2] != null ? Math.min(100, card.sub[2] * 10) : Math.min(100, Math.round(Math.log10(card.h + 1) * 22))}%`,
                    }}
                  />
                </div>
                <b className="mono">{card.sub[2] != null ? `${card.sub[2]}/10` : orDash(card.h.toLocaleString('en-US'))}</b>
              </div>
            </div>
          </div>

          <section className="dlg-tasks" aria-label="Project tasks checklist">
            <div className="dlg-section-head">
              <h3>Tasks ({taskList.length})</h3>
              <span className="note">Progress saves locally in your browser</span>
            </div>
            <ul className="task-list">
              {taskList.map((t, i) => {
                const key = taskKeys[i];
                const checked = doneTasks.has(key);
                const normStatus = t.status.trim().toUpperCase();
                const isClosed = normStatus === 'CLOSED';
                const isOpen = normStatus === 'OPEN';
                const showStatus = isOpen || isClosed;
                const costLabel = t.cost < 0 ? '—' : t.cost > 0 ? `$${t.cost}` : 'Free';
                const timeLabel = t.timeMinutes ? ` · ${t.timeMinutes} min` : '';
                return (
                  <li key={key} className={`task-item${checked ? ' is-done' : ''}${isClosed ? ' is-closed' : ''}`}>
                    <label className="task-check">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onToggleTask(key)}
                      />
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
                      <a
                        className="task-link"
                        href={t.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${t.title} (opens in a new tab)`}
                      >
                        Open ↗
                      </a>
                    )}
                  </li>
                );
              })}
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
      )}
    </dialog>
  );
}
