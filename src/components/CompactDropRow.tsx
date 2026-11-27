import type { Card, FeedItem } from '../../shared/types';
import {
  buildFeedMeta,
  cleanFeedSteps,
  dedupeFeedSources,
  dedupeStrings,
  formatProjectTitle,
  formatRiskReasons,
  matchRadarCard,
  prepareFeedLinks,
  type FeedMetaId,
} from '../lib/feedDisplay';
import { resolveEntityVisual, type ProjectLogoIndex } from '../lib/visualAssets';
import { ChainBadge, EntityAvatar } from './EntityVisual';
import { DomainPill } from './DomainPill';
import { RiskBadge } from './RiskBadge';
import {
  ChevronRightIcon,
  CopyIcon,
  LockIcon,
  RadarIcon,
  TagIcon,
} from './Icons';

const META_COLUMN: readonly FeedMetaId[] = ['reward', 'cost'];

interface RowProps {
  item: FeedItem;
  logoIndex?: ProjectLogoIndex;
  radarIndex: ReadonlyMap<string, Card>;
  onDetails: (item: FeedItem) => void;
  onCopyBrief: (item: FeedItem) => void;
  onOpenRadar: (card: Card) => void;
}

const EMPTY_INDEX: ReadonlyMap<string, Card> = new Map();

function CompactDropRow({ item, logoIndex, radarIndex, onDetails, onCopyBrief, onOpenRadar }: RowProps) {
  const title = formatProjectTitle(item.project);
  const chains = dedupeStrings(item.chains);
  const sources = dedupeFeedSources(item.sources);
  const links = prepareFeedLinks(item, { max: 3 });
  const meta = new Map(buildFeedMeta(item).map(pill => [pill.id, pill.value]));
  const deadlinePill = meta.get('deadline');
  const stepCount = cleanFeedSteps(item.steps).length;
  const isRisk = item.risk.level === 'risk';
  const radarCard = matchRadarCard(item, radarIndex);
  const visual = resolveEntityVisual({
    name: title,
    logo: item.logo,
    ticker: item.ticker,
    domain: item.domain,
    url: links[0]?.url,
    chain: chains[0],
    source: sources[0]?.platform,
    sectionId: 'drops',
    logoIndex,
  });

  return (
    <tr className={isRisk ? 'is-risk' : undefined}>
      <th scope="row">
        <div className="compact-entity">
          <EntityAvatar name={title} resolved={visual} size={26} />
          <div className="compact-entity-text">
            <button type="button" className="compact-name-btn" onClick={() => onDetails(item)}>
              {title}
            </button>
            <span className="compact-sub mono">
              {visual.resolvedTicker ?? 'Pre-token'}
              {item.domain ? ` · ${item.domain}` : ''}
            </span>
          </div>
        </div>
      </th>

      {META_COLUMN.map(id => (
        <td key={id} className="td-num compact-meta mono">
          {meta.get(id) ?? '—'}
        </td>
      ))}

      <td className="compact-deadline">
        {deadlinePill ? (
          <span className="typetip compact-chip" title={`Deadline: ${deadlinePill}`}>
            {deadlinePill}
          </span>
        ) : (
          <span className="compact-empty">—</span>
        )}
      </td>

      <td className="td-chain">
        {chains.length > 0 ? (
          <div className="market-chain-list">
            {chains.slice(0, 2).map(chain => (
              <ChainBadge key={chain} chain={chain} size={13} />
            ))}
            {chains.length > 2 && <span className="market-chain-overflow mono">+{chains.length - 2}</span>}
          </div>
        ) : (
          <span className="compact-empty">—</span>
        )}
      </td>

      <td className="compact-trust">
        <DomainPill verified={item.verifiedDomain} domain={item.domain} />
        <RiskBadge level={item.risk.level} notes={formatRiskReasons(item)} />
      </td>

      <td className="compact-steps">
        {stepCount > 0 ? (
          <span className="compact-chip-inline">
            <TagIcon size={11} />
            <span className="mono">{stepCount} steps</span>
          </span>
        ) : (
          <span className="compact-empty">—</span>
        )}
      </td>

      <td className="td-num mono compact-score">{item.score.toFixed(2)}</td>

      <td className="compact-actions">
        {radarCard && (
          <button
            type="button"
            className="iconbtn"
            title="Open the matched Curated Radar project"
            aria-label={`Open ${title} on Curated Radar`}
            onClick={() => onOpenRadar(radarCard)}
          >
            <RadarIcon size={14} />
          </button>
        )}
        {isRisk ? (
          <span className="iconbtn is-blocked" title="Brief blocked: high risk" role="img" aria-label="Brief blocked: high risk">
            <LockIcon size={14} />
          </span>
        ) : (
          <button
            type="button"
            className="iconbtn"
            title="Copy agent brief"
            aria-label={`Copy agent brief for ${title}`}
            onClick={() => onCopyBrief(item)}
          >
            <CopyIcon size={14} />
          </button>
        )}
        <button
          type="button"
          className="iconbtn"
          title="Open details"
          aria-label={`Details for ${title}`}
          onClick={() => onDetails(item)}
        >
          <ChevronRightIcon size={14} />
        </button>
      </td>
    </tr>
  );
}

interface TableProps {
  items: readonly FeedItem[];
  logoIndex?: ProjectLogoIndex;
  /** Curated cards keyed by id, to resolve each row's Radar cross-link. */
  radarIndex?: ReadonlyMap<string, Card>;
  onDetails: (item: FeedItem) => void;
  onCopyBrief: (item: FeedItem) => void;
  onOpenRadar: (card: Card) => void;
}

/** Dense one-line-per-drop table used by the Compact view. */
export function CompactDropsTable({
  items,
  logoIndex,
  radarIndex,
  onDetails,
  onCopyBrief,
  onOpenRadar,
}: TableProps) {
  return (
    <div tabIndex={0} role="region" aria-label="Live drops table" className="table-wrap compact-table-wrap">
      <table className="demo compact-table">
        <caption className="sr">
          Live drops, one row per project. Open a row's Details action for its steps, links, and sources.
        </caption>
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col" className="th-num">Reward pool</th>
            <th scope="col" className="th-num">Cost</th>
            <th scope="col">Deadline</th>
            <th scope="col">Chains</th>
            <th scope="col">Trust</th>
            <th scope="col">Steps</th>
            <th scope="col" className="th-num">Score</th>
            <th scope="col">
              <span className="sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <CompactDropRow
              key={item.id}
              item={item}
              logoIndex={logoIndex}
              radarIndex={radarIndex ?? EMPTY_INDEX}
              onDetails={onDetails}
              onCopyBrief={onCopyBrief}
              onOpenRadar={onOpenRadar}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
