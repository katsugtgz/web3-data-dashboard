import type { Grade } from '../../shared/types';
import type { StatusFilter } from '../hooks/useAirdropFilters';

interface Props {
  counts: { total: number; pre: number; sTier: number; savedMatch: number };
  tgeCount: number;
  isLive: boolean;
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
  tgeCount,
  isLive,
  status,
  grade,
  onSelectAll,
  onTogglePre,
  onToggleSTier,
  onJumpTge,
  onToggleSaved,
}: Props) {
  return (
    <div className="kpi-strip" aria-label="Dashboard metrics overview">
      <button
        type="button"
        className={`kpi-card${status === 'all' && grade === 'All' ? ' is-active' : ''}`}
        onClick={onSelectAll}
      >
        <span className="kpi-label">Active Tracked</span>
        <strong className="kpi-val mono">{counts.total}</strong>
        <span className="kpi-sub">{isLive ? 'Live API feed' : 'Snapshot'}</span>
      </button>
      <button
        type="button"
        className={`kpi-card${status === 'pre' ? ' is-active' : ''}`}
        onClick={onTogglePre}
      >
        <span className="kpi-label">Pre-Token</span>
        <strong className="kpi-val mono">{counts.pre}</strong>
        <span className="kpi-sub">{Math.round((counts.pre / Math.max(1, counts.total)) * 100)}% unlaunched</span>
      </button>
      <button
        type="button"
        className={`kpi-card${grade === 'S' ? ' is-active' : ''}`}
        onClick={onToggleSTier}
      >
        <span className="kpi-label">S-Tier Projects</span>
        <strong className="kpi-val mono">{counts.sTier}</strong>
        <span className="kpi-sub">Highest conviction</span>
      </button>
      <button type="button" className="kpi-card" onClick={onJumpTge}>
        <span className="kpi-label">Upcoming TGE</span>
        <strong className="kpi-val mono">{tgeCount}</strong>
        <span className="kpi-sub">Claim &amp; verify ↓</span>
      </button>
      <button
        type="button"
        className={`kpi-card${status === 'saved' ? ' is-active' : ''}`}
        onClick={onToggleSaved}
      >
        <span className="kpi-label">Watchlist</span>
        <strong className="kpi-val mono">{counts.savedMatch}</strong>
        <span className="kpi-sub">Saved locally</span>
      </button>
    </div>
  );
}
