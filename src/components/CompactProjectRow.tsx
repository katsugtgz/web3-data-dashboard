import type { Card } from '../../shared/types';
import {
  cardLegacyStorageKey,
  cardStorageKey,
  getCardTaskKeyPairs,
  getCardTasks,
  isCardSaved,
  isTaskKeyDone,
} from '../hooks/useWatchlist';
import { buildCardMeta } from '../lib/feedDisplay';
import { hostnameLabel, normalizeExternalUrl } from '../lib/format';
import { extractTickerFallback, type ProjectLogoIndex } from '../lib/visualAssets';
import { DomainPill } from './DomainPill';
import { ChevronRightIcon, CopyIcon, LockIcon, StarIcon } from './Icons';
import { Avatar, BadgeChip } from './ProjectCard';

interface RowProps {
  card: Card;
  saved: boolean;
  doneTasks: Set<string>;
  logoIndex?: ProjectLogoIndex;
  onToggleSaved: (key: string, legacyKey?: string) => void;
  onDetails: (card: Card) => void;
  onCopyBrief: (card: Card) => void;
}

function CompactProjectRow({ card: c, saved, doneTasks, logoIndex, onToggleSaved, onDetails, onCopyBrief }: RowProps) {
  const chains = c.chains?.length ? c.chains : c.chain ? [c.chain] : [];
  const resolvedTicker = extractTickerFallback(c.n, c.t);
  const isRisk = c.b.includes('risk');
  const tasks = getCardTasks(c);
  const doneCount = getCardTaskKeyPairs(c, tasks).filter(pair => isTaskKeyDone(doneTasks, pair)).length;
  const meta = new Map(buildCardMeta(c).map(pill => [pill.id, pill.value]));
  const projectHost = normalizeExternalUrl(c.url);
  const cell = (id: 'tvl' | 'apy' | 'deadline' | 'reward') => meta.get(id) ?? '—';

  return (
    <tr className={isRisk ? 'is-risk' : undefined}>
      <th scope="row">
        <div className="compact-entity">
          <Avatar name={c.n} src={c.img} ticker={resolvedTicker} url={c.url} chain={chains[0]} source={c.source} logoIndex={logoIndex} size={26} />
          <div className="compact-entity-text">
            <button type="button" className="compact-name-btn" onClick={() => onDetails(c)}>
              <span className="sr">Rank {c.r}: </span>
              {c.n}
            </button>
            <span className="compact-sub mono">
              {resolvedTicker ?? (c.b.includes('token') ? 'Token live' : 'Pre-token')}
              {doneCount > 0 ? ` · ${doneCount}/${tasks.length} done` : ''}
            </span>
          </div>
        </div>
      </th>
      <td>
        <span className={`gradetip tier-pill ${c.g}`} title={`Tier ${c.g}`}>
          {c.g}
        </span>
      </td>
      <td className="td-num mono">{cell('tvl')}</td>
      <td className="td-num mono">{cell('apy')}</td>
      <td className="mono">{cell('deadline')}</td>
      <td className="td-num mono">{cell('reward')}</td>
      <td className="td-num mono">{c.f}</td>
      <td className="td-num mono">{c.tk}</td>
      <td className="compact-trust">
        <DomainPill verified={c.verifiedDomain} domain={projectHost ? hostnameLabel(projectHost) : null} />
        {isRisk && <BadgeChip k="risk" riskLabel={c.riskLabel} />}
      </td>
      <td className="td-num mono">{c.sc}</td>
      <td className="compact-actions">
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
        {isRisk ? (
          <span className="iconbtn is-blocked" title="Brief blocked: high risk" role="img" aria-label="Brief blocked: high risk">
            <LockIcon size={14} />
          </span>
        ) : (
          <button
            type="button"
            className="iconbtn"
            title="Copy agent brief"
            aria-label={`Copy agent brief for ${c.n}`}
            onClick={() => onCopyBrief(c)}
          >
            <CopyIcon size={14} />
          </button>
        )}
        <button type="button" className="iconbtn" title="Open details" aria-label={`Details for ${c.n}`} onClick={() => onDetails(c)}>
          <ChevronRightIcon size={14} />
        </button>
      </td>
    </tr>
  );
}

interface TableProps {
  cards: readonly Card[];
  saved: Set<string>;
  doneTasks: Set<string>;
  logoIndex?: ProjectLogoIndex;
  onToggleSaved: (key: string, legacyKey?: string) => void;
  onDetails: (card: Card) => void;
  onCopyBrief: (card: Card) => void;
}

const NUMERIC_COLS = new Set(['TVL', 'APY', 'Reward pool', 'Funding', 'Tasks', 'Score']);
/** Must stay in the same order as the cells of CompactProjectRow. */
const COLUMNS = ['Project', 'Tier', 'TVL', 'APY', 'Deadline', 'Reward pool', 'Funding', 'Tasks', 'Trust', 'Score', 'Actions'] as const;
const ICON_ONLY_COLS = new Set(['Tier', 'Actions']);

/** Dense one-line-per-project table used by the Compact view on the Airdrops tab. */
export function CompactProjectsTable({ cards, saved, doneTasks, logoIndex, onToggleSaved, onDetails, onCopyBrief }: TableProps) {
  return (
    <div tabIndex={0} role="region" aria-label="Airdrop projects table" className="table-wrap compact-table-wrap">
      <table className="demo compact-table">
        <caption className="sr">Curated projects, one row each. Open a row's Details action for all tasks.</caption>
        <thead>
          <tr>
            {COLUMNS.map(label => (
              <th key={label} scope="col" className={NUMERIC_COLS.has(label) ? 'th-num' : undefined}>
                {ICON_ONLY_COLS.has(label) ? <span className="sr">{label}</span> : label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cards.map(card => (
            <CompactProjectRow
              key={cardStorageKey(card)}
              card={card}
              saved={isCardSaved(saved, card)}
              doneTasks={doneTasks}
              logoIndex={logoIndex}
              onToggleSaved={onToggleSaved}
              onDetails={onDetails}
              onCopyBrief={onCopyBrief}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
