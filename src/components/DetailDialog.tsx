import { useState, type ReactNode } from 'react';
import type { AgentProfile, Card, CardTask, FitKey } from '../../shared/types';
import { buildBrief } from '../lib/agentBrief';
import { orderDetailTasks, type OrderedDetailTask } from '../lib/detailTasks';
import { buildCardMeta, cleanMetaText, describeDeadline } from '../lib/feedDisplay';
import { hostnameLabel, normalizeExternalUrl, orDash } from '../lib/format';
import { BADGE_LABEL } from '../lib/labels';
import { extractTickerFallback, resolveOgPreview, type ProjectLogoIndex } from '../lib/visualAssets';
import {
  cardLegacyStorageKey,
  cardStorageKey,
  getCardTaskKeyPairs,
  getCardTasks,
  isTaskKeyDone,
  type TaskKeyPair,
} from '../hooks/useWatchlist';
import { getRefBaseUrl } from '../hooks/useCopyBriefController';
import { BriefActions } from './BriefActions';
import { CopyStatusBanner, type CopyStatus } from './CopyStatusBanner';
import { DomainPill } from './DomainPill';
import { ChainBadge, CryptoTickerPill, EntityAvatar, PlatformBadge } from './EntityVisual';
import {
  ClockIcon,
  ExternalLinkIcon,
  FlameIcon,
  GlobeIcon,
  LockIcon,
  StarIcon,
  XIcon,
} from './Icons';
import { ModalDrawer } from './ModalDrawer';
import { OgPreview } from './OgPreview';
import { BadgeChip } from './ProjectCard';

function resolveCardChains(card: Card): string[] {
  if (card.chains?.length) return card.chains;
  return card.chain ? [card.chain] : [];
}

interface DetailSpecRow {
  label: string;
  value: ReactNode;
  mono?: boolean;
}

/** TVL, APY, deadline, and reward pool rows; only the facts the card actually carries. */
function buildRichRows(card: Card): DetailSpecRow[] {
  const deadline = describeDeadline(card.deadline);
  return buildCardMeta(card).map(pill => ({
    label: pill.label,
    value: pill.id === 'deadline' && deadline.countdown ? `${pill.value} · ${deadline.countdown}` : pill.value,
    mono: true,
  }));
}

function cardDomainHost(card: Card): string | null {
  const projectUrl = normalizeExternalUrl(card.url);
  return projectUrl ? hostnameLabel(projectUrl) : null;
}

/** Site preview banner and the short project description, above the scores. */
function DetailIntro({ card, description }: { card: Card; description: string | null }) {
  const ogPreview = resolveOgPreview({ ogImage: card.ogImage, fallbackTitle: card.n });
  return (
    <>
      <OgPreview preview={ogPreview} variant="banner" />
      {description && <p className="dlg-description">{description}</p>}
    </>
  );
}

function buildDetailRows(
  card: Card,
  chains: string[],
  resolvedTicker: string | null,
  fit: Record<FitKey, string>,
): DetailSpecRow[] {
  const flags = card.b
    .map(k => (k === 'risk' && card.riskLabel ? card.riskLabel : BADGE_LABEL[k]))
    .join(', ');
  const safeHeat = Number.isFinite(card.h) && card.h >= 0 ? card.h : 0;
  const projectUrl = normalizeExternalUrl(card.url);

  const tickerValue: ReactNode = resolvedTicker ? (
    <CryptoTickerPill ticker={resolvedTicker} size={13} />
  ) : card.b.includes('token') ? (
    'Token live'
  ) : (
    'No ticker yet'
  );

  const chainsValue: ReactNode = chains.length ? (
    <div className="dlg-spec-chains">
      {chains.map(ch => (
        <ChainBadge key={ch} chain={ch} size={13} />
      ))}
    </div>
  ) : (
    'Not specified'
  );

  return [
    { label: 'Rank', value: `#${card.r}`, mono: true },
    { label: 'Ticker', value: tickerValue },
    { label: 'Chains', value: chainsValue },
    { label: 'Funding', value: card.f, mono: true },
    ...buildRichRows(card),
    { label: 'Tasks (Open / Total)', value: card.tk, mono: true },
    { label: 'Heat (X Score)', value: safeHeat.toLocaleString('en-US'), mono: true },
    { label: 'Updated', value: card.u === 'today' ? 'Today' : card.u },
    { label: 'Best for', value: card.fit.map(f => fit[f]).join(', ') || '—' },
    ...(projectUrl
      ? [
          {
            label: 'Website',
            value: (
              <a href={projectUrl} target="_blank" rel="noopener noreferrer" className="dlg-spec-link">
                <GlobeIcon size={12} />
                <span>{hostnameLabel(projectUrl)}</span>
                <ExternalLinkIcon size={12} />
                <span className="sr"> (opens in a new tab)</span>
              </a>
            ),
          },
        ]
      : []),
    ...(card.x ? [{ label: 'Code', value: card.x, mono: true }] : []),
    ...(card.source
      ? [
          {
            label: 'Source',
            value: <PlatformBadge source={card.source} label={card.source} size={13} />,
          },
        ]
      : []),
    { label: 'Status flags', value: flags || '—' },
  ];
}

function DetailScores({ card }: { card: Card }) {
  const safeHeat = Number.isFinite(card.h) && card.h >= 0 ? card.h : 0;
  const hasHeatSubScore = card.sub[2] != null && Number.isFinite(card.sub[2]);
  const heatPercent = hasHeatSubScore
    ? Math.min(100, Math.max(0, (card.sub[2] ?? 0) * 10))
    : Math.min(100, Math.max(0, Math.round((safeHeat / 10000) * 100)));

  return (
    <div className="dlg-scores">
      <div className="dlg-score-main">
        <span className="dlg-score-lbl">Potential score</span>
        <div className="dlg-score-readout">
          <strong className="mono">{card.sc}</strong>
          <span className="dlg-score-sub mono">/ 100</span>
        </div>
      </div>
      <div className="dlg-subbars">
        <div className="subbar-row">
          <span>Launch</span>
          <div className="scorebar">
            <span className="fill-S" style={{ width: `${Math.min(100, Math.max(0, card.sub[0] * 10))}%` }} />
          </div>
          <b className="mono">{card.sub[0]}/10</b>
        </div>
        <div className="subbar-row">
          <span>Value</span>
          <div className="scorebar">
            <span className="fill-A" style={{ width: `${Math.min(100, Math.max(0, card.sub[1] * 10))}%` }} />
          </div>
          <b className="mono">{card.sub[1]}/10</b>
        </div>
        {hasHeatSubScore ? (
          <div className="subbar-row">
            <span className="subbar-heat-label">
              <FlameIcon size={12} className="dlg-heat-icon" />
              <span>Heat</span>
            </span>
            <div className="scorebar">
              <span className="fill-B" style={{ width: `${heatPercent}%` }} />
            </div>
            <b className="mono">{card.sub[2]}/10</b>
          </div>
        ) : (
          <div className="subbar-heat-block">
            <div className="subbar-heat-head">
              <span className="subbar-heat-title">
                <FlameIcon size={12} className="dlg-heat-icon" />
                <span>Heat</span>
              </span>
              <span className="subbar-heat-caption">Community heat · 10k max</span>
              <b className="mono subbar-heat-val">{orDash(safeHeat.toLocaleString('en-US'))}</b>
            </div>
            <div className="scorebar">
              <span className="fill-heat" style={{ width: `${heatPercent}%` }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface TaskRowProps {
  entry: OrderedDetailTask;
  storageKey: string;
  legacyKey: string | null;
  checked: boolean;
  duplicateTitle: boolean;
  onToggle: (taskKey: string, legacyKey?: string) => void;
}

function formatTaskCost(cost: number): string {
  if (!Number.isFinite(cost) || cost < 0) return '—';
  return cost > 0 ? `$${cost}` : 'Free';
}

function TaskMetaDetails({
  task: t,
  isClosed,
  duplicateTitle,
}: {
  task: CardTask;
  isClosed: boolean;
  duplicateTitle: boolean;
}) {
  const normStatus = t.status.trim().toUpperCase();
  const showStatus = normStatus === 'OPEN' || isClosed;
  const costLabel = formatTaskCost(t.cost);
  const hasTime = typeof t.timeMinutes === 'number' && Number.isFinite(t.timeMinutes) && t.timeMinutes > 0;
  const displayTitle = duplicateTitle && t.type ? `${t.title} · ${t.type}` : t.title;

  return (
    <span className="task-meta">
      <span className="task-title">{displayTitle}</span>
      <span className="task-sub">
        {showStatus && (
          <span className={`task-status ${isClosed ? 'closed' : 'open'}`}>
            <span className={`task-status-dot ${isClosed ? 'closed' : 'open'}`} aria-hidden="true" />
            <span>{isClosed ? 'Closed' : 'Open'}</span>
          </span>
        )}
        {t.type && <span className="typetip">{t.type}</span>}
        {t.isExclusive && <span className="badge badge-early">Exclusive</span>}
        <span className="task-cost-pill mono">
          <span>{costLabel}</span>
          {hasTime && (
            <>
              <span aria-hidden="true">·</span>
              <ClockIcon size={11} className="task-time-icon" />
              <span>{t.timeMinutes} min</span>
            </>
          )}
        </span>
      </span>
    </span>
  );
}

function TaskRow({ entry, storageKey, legacyKey, checked, duplicateTitle, onToggle }: TaskRowProps) {
  const { task: t, isClosed } = entry;
  const href = normalizeExternalUrl(t.url);

  return (
    <li className={`task-item${checked && !isClosed ? ' is-done' : ''}${isClosed ? ' is-closed' : ''}`}>
      {isClosed ? (
        <div className="task-static-row">
          <span className="task-closed-indicator" aria-hidden="true" title="Task closed">
            <LockIcon size={13} />
          </span>
          <TaskMetaDetails task={t} isClosed duplicateTitle={duplicateTitle} />
        </div>
      ) : (
        <label className="task-check">
          <input
            type="checkbox"
            checked={checked}
            onChange={() => onToggle(storageKey, legacyKey ?? undefined)}
          />
          <TaskMetaDetails task={t} isClosed={false} duplicateTitle={duplicateTitle} />
        </label>
      )}
      {href && (
        <a className="task-link" href={href} target="_blank" rel="noopener noreferrer">
          <span>View</span>
          <ExternalLinkIcon size={12} />
          <span className="sr"> {t.title} (opens in a new tab)</span>
        </a>
      )}
    </li>
  );
}

interface TaskSectionProps {
  taskList: CardTask[];
  taskPairs: TaskKeyPair[];
  doneTasks: Set<string>;
  onToggleTask: (taskKey: string, legacyKey?: string) => void;
}

function DetailTaskSection({ taskList, taskPairs, doneTasks, onToggleTask }: TaskSectionProps) {
  const ordered = orderDetailTasks(taskList);
  const titleCounts = new Map<string, number>();
  for (const t of taskList) {
    const key = t.title.trim().toLowerCase();
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }
  const openItems = ordered.filter(item => !item.isClosed);
  const closedItems = ordered.filter(item => item.isClosed);

  const actionableCount = openItems.length;
  const openCompletedCount = openItems.filter(item =>
    isTaskKeyDone(doneTasks, taskPairs[item.originalIndex]),
  ).length;
  const completionPct = actionableCount > 0 ? Math.round((openCompletedCount / actionableCount) * 100) : 0;

  return (
    <section className="dlg-tasks" aria-label="Project tasks checklist">
      <div className="dlg-section-head">
        <div className="dlg-section-head-left">
          <h3>Tasks</h3>
          {actionableCount > 0 ? (
            <span
              className={`countchip mono${openCompletedCount === actionableCount ? ' is-complete' : ''}`}
            >
              {openCompletedCount} of {actionableCount} done
            </span>
          ) : (
            <span className="countchip mono">All {closedItems.length} closed</span>
          )}
        </div>
        <span className="note">Saved locally</span>
      </div>

      {actionableCount > 0 && (
        <div
          className="task-progress"
          role="progressbar"
          aria-valuenow={openCompletedCount}
          aria-valuemin={0}
          aria-valuemax={actionableCount}
          aria-label="Completed open tasks"
        >
          <span className="task-progress-fill" style={{ width: `${completionPct}%` }} />
        </div>
      )}

      {openItems.length > 0 && (
        <ul className="task-list">
          {openItems.map(entry => {
            const pair = taskPairs[entry.originalIndex];
            return (
              <TaskRow
                key={pair.primary}
                entry={entry}
                storageKey={pair.primary}
                legacyKey={pair.legacy}
                checked={isTaskKeyDone(doneTasks, pair)}
                duplicateTitle={(titleCounts.get(entry.task.title.trim().toLowerCase()) ?? 0) > 1}
                onToggle={onToggleTask}
              />
            );
          })}
        </ul>
      )}

      {closedItems.length > 0 && (
        <div className="task-closed-group">
          <div className="task-closed-divider">
            <span>Closed tasks ({closedItems.length})</span>
          </div>
          <ul className="task-list task-list-closed">
            {closedItems.map(entry => {
              const pair = taskPairs[entry.originalIndex];
              return (
                <TaskRow
                  key={pair.primary}
                  entry={entry}
                  storageKey={pair.primary}
                  legacyKey={pair.legacy}
                  checked={isTaskKeyDone(doneTasks, pair)}
                  duplicateTitle={(titleCounts.get(entry.task.title.trim().toLowerCase()) ?? 0) > 1}
                  onToggle={onToggleTask}
                />
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

interface BodyProps {
  card: Card;
  fit: Record<FitKey, string>;
  profile: AgentProfile;
  saved: boolean;
  doneTasks: Set<string>;
  logoIndex?: ProjectLogoIndex | null;
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
  logoIndex,
  onToggleSaved,
  onToggleTask,
  onCopyBrief,
  onDismiss,
  copyStatus,
}: BodyProps) {
  const [showBrief, setShowBrief] = useState(false);
  const icon = card.img ?? '';
  const chains = resolveCardChains(card);
  const resolvedTicker = extractTickerFallback(card.n, card.t);
  const taskList = getCardTasks(card);
  const taskPairs = getCardTaskKeyPairs(card, taskList);
  const rows = buildDetailRows(card, chains, resolvedTicker, fit);
  const renderedBrief = showBrief ? buildBrief(card, profile, { refBaseUrl: getRefBaseUrl() }) : null;
  const slug = card.n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'airdrop';

  return (
    <div className="dlg-inner">
      <div className="dlg-sticky-head">
        <div className="dlg-head">
          <div className="dlg-title-group">
            <EntityAvatar
              key={icon || card.n}
              name={card.n}
              img={card.img}
              ticker={resolvedTicker}
              url={card.url}
              chain={chains[0]}
              source={card.source}
              sectionId="airdrops"
              logoIndex={logoIndex}
              size={44}
              shape="rounded"
              className="dlg-entity-avatar"
            />
            <div className="dlg-title-meta">
              <h2 id="detail-title">{card.n}</h2>
              <div className="dlg-subtitle">
                {resolvedTicker ? (
                  <CryptoTickerPill ticker={resolvedTicker} size={13} />
                ) : (
                  <span className="dlg-token-status mono">
                    {card.b.includes('token') ? 'Token live' : 'Pre-token'}
                  </span>
                )}
                <span className="dlg-meta-sep" aria-hidden="true">
                  ·
                </span>
                <span className="dlg-meta-item mono">Rank #{card.r}</span>
                <span className="dlg-meta-sep" aria-hidden="true">
                  ·
                </span>
                <span className={`gradetip dlg-tier-pill ${card.g}`}>Tier {card.g}</span>
                <DomainPill verified={card.verifiedDomain} domain={cardDomainHost(card)} />
              </div>
            </div>
          </div>
          <div className="dlg-head-actions">
            <button
              type="button"
              className="chip dlg-save-btn"
              aria-pressed={saved}
              onClick={() => onToggleSaved(cardStorageKey(card), cardLegacyStorageKey(card))}
            >
              <StarIcon size={14} fill={saved ? 'currentColor' : 'none'} />
              <span>{saved ? 'Saved' : 'Save'}</span>
            </button>
            <button type="button" className="dlg-x" onClick={onDismiss} aria-label="Close details">
              <XIcon size={16} />
            </button>
          </div>
        </div>

        {(card.b.length > 0 || card.x) && (
          <div className="badges dlg-head-badges">
            {card.b.map(k => (
              <BadgeChip key={k} k={k} riskLabel={card.riskLabel} />
            ))}
            {card.x && <span className="codechip">{card.x}</span>}
          </div>
        )}
      </div>

      <div className="dlg-scroll-body">
        <CopyStatusBanner status={copyStatus} />

        <BriefActions<Card>
          target={card}
          profile={profile}
          slug={slug}
          blocked={card.b.includes('risk')}
          showBrief={showBrief}
          onToggleBrief={() => setShowBrief(v => !v)}
          onCopyBrief={onCopyBrief}
        />

        {showBrief && renderedBrief && <pre className="brief-preview mono">{renderedBrief}</pre>}

        <DetailIntro card={card} description={cleanMetaText(card.description, 280)} />

        <DetailScores card={card} />

        <DetailTaskSection
          taskList={taskList}
          taskPairs={taskPairs}
          doneTasks={doneTasks}
          onToggleTask={onToggleTask}
        />

        <section className="dlg-specs" aria-label="Project specifications">
          <div className="dlg-section-head">
            <h3>Specifications</h3>
          </div>
          <dl className="kv">
            {rows.map(row => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd className={row.mono ? 'mono' : undefined}>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}

interface Props {
  card: Card | null;
  fit: Record<FitKey, string>;
  profile: AgentProfile;
  saved: boolean;
  doneTasks: Set<string>;
  logoIndex?: ProjectLogoIndex | null;
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
  logoIndex,
  onToggleSaved,
  onToggleTask,
  onCopyBrief,
  onClose,
  copyStatus,
}: Props) {
  return (
    <ModalDrawer id="detail" labelledBy="detail-title" open={card !== null} onClose={onClose}>
      {dismiss =>
        card && (
          <DetailDialogBody
            key={cardStorageKey(card)}
            card={card}
            fit={fit}
            profile={profile}
            saved={saved}
            doneTasks={doneTasks}
            logoIndex={logoIndex}
            onToggleSaved={onToggleSaved}
            onToggleTask={onToggleTask}
            onCopyBrief={onCopyBrief}
            onDismiss={dismiss}
            copyStatus={copyStatus}
          />
        )
      }
    </ModalDrawer>
  );
}
