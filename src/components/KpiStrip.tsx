import { useId } from 'react';
import type { Grade } from '../../shared/types';
import type { StatusFilter } from '../hooks/useAirdropFilters';
import { formatMiniBarsLabel, type CardMix } from '../lib/viz';
import { CalendarIcon, LayersIcon, SparklesIcon, StarIcon, ZapIcon } from './Icons';
import { KpiActivity, MiniBars } from './KpiSparkline';

interface Props {
  counts: { total: number; pre: number; sTier: number; savedMatch: number };
  mix: CardMix;
  tgeCount: number;
  isLive: boolean;
  failed: boolean;
  status: StatusFilter;
  grade: 'All' | Grade;
  onSelectAll: () => void;
  onTogglePre: () => void;
  onToggleSTier: () => void;
  onJumpTge: () => void;
  onToggleSaved: () => void;
}

export function KpiStrip({
  counts,
  mix,
  tgeCount,
  isLive,
  failed,
  status,
  grade,
  onSelectAll,
  onTogglePre,
  onToggleSTier,
  onJumpTge,
  onToggleSaved,
}: Props) {
  const idPrefix = useId();
  const hasActiveFilter = status !== 'all' || grade !== 'All';
  const isPreActive = status === 'pre';
  const isSTierActive = grade === 'S';
  const isSavedActive = status === 'saved';

  const hasTiers = mix.tiers.some(s => s.value > 0);
  const hasSources = mix.sources.some(s => s.value > 0);
  const tierLabel = formatMiniBarsLabel('Projects by tier', mix.tiers);
  const sourceLabel = formatMiniBarsLabel('Projects by source', mix.sources);

  const activeStatusId = `${idPrefix}-active-status`;
  const activeActivityId = `${idPrefix}-active-activity`;
  const activeTiersId = `${idPrefix}-active-tiers`;
  const activeDescribedBy = [activeStatusId, activeActivityId, hasTiers ? activeTiersId : null].filter(Boolean).join(' ');

  const sTierSubId = `${idPrefix}-stier-sub`;
  const sTierSourcesId = `${idPrefix}-stier-sources`;
  const sTierDescribedBy = [sTierSubId, hasSources ? sTierSourcesId : null].filter(Boolean).join(' ');

  return (
    <div className="kpi-strip" role="group" aria-label="Dashboard metrics overview">
      <button
        type="button"
        className="kpi-card"
        aria-pressed={!hasActiveFilter}
        title={hasActiveFilter ? 'Reset status and tier filters' : 'All actively tracked projects'}
        aria-label={`Active tracked projects: ${counts.total}. Resets status and tier filters.`}
        aria-describedby={activeDescribedBy}
        onClick={onSelectAll}
      >
        <span className="kpi-label-row">
          <LayersIcon size={13} className="kpi-icon" />
          <span className="kpi-label">Active Tracked</span>
        </span>
        <strong className="kpi-val mono">{counts.total}</strong>
        <span id={activeStatusId} className="kpi-sub">
          {failed ? 'Last available data' : isLive ? 'Live API feed' : 'Snapshot'}
        </span>
        <span className="kpi-viz">
          <KpiActivity id={activeActivityId} timestamps={mix.updated} label="Projects updated per day" />
          <MiniBars id={activeTiersId} segments={mix.tiers} label={tierLabel} />
        </span>
      </button>

      <button
        type="button"
        className={`kpi-card${isPreActive ? ' is-active' : ''}`}
        aria-pressed={isPreActive}
        onClick={onTogglePre}
      >
        <span className="kpi-label-row">
          <SparklesIcon size={13} className="kpi-icon" />
          <span className="kpi-label">Pre-Token</span>
        </span>
        <strong className="kpi-val mono">{counts.pre}</strong>
        <span className="kpi-sub">{Math.round((counts.pre / Math.max(1, counts.total)) * 100)}% unlaunched</span>
      </button>

      <button
        type="button"
        className={`kpi-card${isSTierActive ? ' is-active' : ''}`}
        aria-pressed={isSTierActive}
        aria-label={`S-Tier projects: ${counts.sTier}. Filters to S-Tier.`}
        aria-describedby={sTierDescribedBy}
        onClick={onToggleSTier}
      >
        <span className="kpi-label-row">
          <ZapIcon size={13} className="kpi-icon" />
          <span className="kpi-label">S-Tier Projects</span>
        </span>
        <strong className="kpi-val mono">{counts.sTier}</strong>
        <span id={sTierSubId} className="kpi-sub">
          Highest conviction
        </span>
        <span className="kpi-viz">
          <MiniBars id={sTierSourcesId} segments={mix.sources} label={sourceLabel} />
        </span>
      </button>

      <button type="button" className="kpi-card kpi-card-jump" onClick={onJumpTge}>
        <span className="kpi-label-row">
          <CalendarIcon size={13} className="kpi-icon" />
          <span className="kpi-label">Upcoming TGE</span>
        </span>
        <strong className="kpi-val mono">{tgeCount}</strong>
        <span className="kpi-sub kpi-sub-cue">Claim &amp; verify ↓</span>
      </button>

      <button
        type="button"
        className={`kpi-card${isSavedActive ? ' is-active' : ''}`}
        aria-pressed={isSavedActive}
        onClick={onToggleSaved}
      >
        <span className="kpi-label-row">
          <StarIcon size={13} className="kpi-icon" fill={isSavedActive ? 'currentColor' : 'none'} />
          <span className="kpi-label">Watchlist</span>
        </span>
        <strong className="kpi-val mono">{counts.savedMatch}</strong>
        <span className="kpi-sub">Saved locally</span>
      </button>
    </div>
  );
}
