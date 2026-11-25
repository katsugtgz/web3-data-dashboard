import { useMemo, type RefObject } from 'react';
import type { FeedItem } from '../../shared/types';
import { DROPS_PAGE_STEP, type DropsFiltersState } from '../hooks/useDropsFilters';
import { summarizeDrops, type DropsSummary } from '../lib/dropsSummary';
import { formatRelativeTime } from '../lib/format';
import { DropsFilterDock } from './DropsFilterDock';
import { FeedCard } from './FeedCard';
import { CheckCircle2Icon, LayersIcon, ShieldAlertIcon, ShieldCheckIcon, ZapIcon } from './Icons';

const SKELETON_IDS = ['sk-1', 'sk-2', 'sk-3', 'sk-4', 'sk-5', 'sk-6'] as const;

interface Props {
  filters: DropsFiltersState;
  totalCount: number;
  pendingCount: number;
  generatedAt: number | null;
  xUnavailable: boolean;
  loading: boolean;
  failed: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
  onApplyPending: () => void;
  onCopyBrief: (item: FeedItem) => void;
}

function DropsKpiStrip({
  summary,
  totalCount,
  loading,
  filters,
}: {
  summary: DropsSummary;
  totalCount: number;
  loading: boolean;
  filters: DropsFiltersState;
}) {
  const isMultiSource = filters.minSources >= 2;
  const showingRisk = !filters.hideRisk;

  return (
    <div className="kpi-strip kpi-strip-4" role="group" aria-label="Live drops signal overview">
      <button
        type="button"
        className="kpi-card"
        title={filters.hasAnyFilter ? 'Reset active drops filters' : 'All tracked signal clusters'}
        onClick={filters.resetFilters}
      >
        <span className="kpi-label-row">
          <ZapIcon size={13} className="kpi-icon" />
          <span className="kpi-label">Tracked Clusters</span>
        </span>
        <strong className="kpi-val mono">{totalCount}</strong>
        <span className="kpi-sub">
          {loading && totalCount === 0 ? 'Syncing live signals…' : `${filters.visible.length} matching`}
        </span>
      </button>

      <button
        type="button"
        className={`kpi-card${isMultiSource ? ' is-active' : ''}`}
        aria-pressed={isMultiSource}
        onClick={() => filters.setMinSources(isMultiSource ? 1 : 2)}
      >
        <span className="kpi-label-row">
          <LayersIcon size={13} className="kpi-icon" />
          <span className="kpi-label">Multi-Source (2+)</span>
        </span>
        <strong className="kpi-val mono">{summary.multiSourceCount}</strong>
        <span className="kpi-sub">Corroborated signals</span>
      </button>

      <div className="kpi-card kpi-card-static">
        <span className="kpi-label-row">
          <CheckCircle2Icon size={13} className="kpi-icon kpi-icon-ok" />
          <span className="kpi-label">Verified Domains</span>
        </span>
        <strong className="kpi-val mono">{summary.verifiedLinkCount}</strong>
        <span className="kpi-sub">Known protocol links</span>
      </div>

      <button
        type="button"
        className={`kpi-card${showingRisk ? ' is-active is-risk-active' : ''}`}
        aria-pressed={showingRisk}
        onClick={filters.toggleHideRisk}
      >
        <span className="kpi-label-row">
          {showingRisk ? (
            <ShieldAlertIcon size={13} className="kpi-icon kpi-icon-risk" />
          ) : (
            <ShieldCheckIcon size={13} className="kpi-icon kpi-icon-ok" />
          )}
          <span className="kpi-label">Risk Filter</span>
        </span>
        <strong className="kpi-val mono">
          {filters.hideRisk ? 'Hidden' : `${summary.riskFlaggedCount} shown`}
        </strong>
        <span className="kpi-sub">{filters.hideRisk ? 'Click to inspect RISK' : 'Flagged in feed'}</span>
      </button>
    </div>
  );
}

function DropsSkeleton() {
  return (
    <div className="skeleton-grid" role="status" aria-live="polite" aria-label="Loading live drops">
      <span className="sr">Loading live drops…</span>
      {SKELETON_IDS.map(id => (
        <div key={id} className="skeleton-card" aria-hidden="true">
          <div className="skeleton-head">
            <span className="skeleton-line is-title" />
            <span className="skeleton-pill" />
          </div>
          <div className="skeleton-body">
            <span className="skeleton-line" />
            <span className="skeleton-line" />
            <span className="skeleton-line is-short" />
          </div>
          <div className="skeleton-tags">
            <span className="skeleton-pill" />
            <span className="skeleton-pill" />
          </div>
          <div className="skeleton-foot">
            <span className="skeleton-line is-short" />
            <span className="skeleton-pill" />
          </div>
        </div>
      ))}
    </div>
  );
}

function DropsBody({
  filters,
  totalCount,
  loading,
  failed,
  onCopyBrief,
}: {
  filters: DropsFiltersState;
  totalCount: number;
  loading: boolean;
  failed: boolean;
  onCopyBrief: (item: FeedItem) => void;
}) {
  if (loading && totalCount === 0) {
    return <DropsSkeleton />;
  }
  if (failed && totalCount === 0) {
    return (
      <p className="empty" role="alert">
        Unable to load live drops feed. Please refresh to retry.
      </p>
    );
  }
  if (filters.visible.length === 0) {
    return (
      <div className="empty" role="status">
        <p>{totalCount === 0 ? 'No drops yet. Check back soon.' : 'No drops match your current filters.'}</p>
        {filters.hasAnyFilter && (
          <button type="button" className="btn empty-action" onClick={filters.resetFilters}>
            Reset filters
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="grid">
        {filters.rendered.map(item => (
          <FeedCard key={item.id} item={item} onCopyBrief={onCopyBrief} />
        ))}
      </div>
      {filters.remaining > 0 && (
        <div className="loadmore-bar">
          <button type="button" className="btn btn-subtle" onClick={filters.showMore}>
            Show {Math.min(DROPS_PAGE_STEP, filters.remaining)} more ({filters.remaining} left)
          </button>
          <button type="button" className="chip" onClick={filters.showAll}>
            Show all {filters.visible.length}
          </button>
        </div>
      )}
    </>
  );
}

export function DropsPanel({
  filters,
  totalCount,
  pendingCount,
  generatedAt,
  xUnavailable,
  loading,
  failed,
  searchRef,
  onApplyPending,
  onCopyBrief,
}: Props) {
  const summary = useMemo(() => summarizeDrops(filters.visible), [filters.visible]);

  return (
    <section role="tabpanel" id="panel-drops" aria-labelledby="tab-drops">
      <DropsKpiStrip summary={summary} totalCount={totalCount} loading={loading} filters={filters} />

      <div className="section-head">
        <div>
          <h2 className="section">Live Drops Feed</h2>
          <p className="note">
            Real-time deduplicated signals from public Telegram channels &amp; best-effort X, safety-screened in English
            {generatedAt ? ` · latest activity ${formatRelativeTime(generatedAt)}` : ''}.
            {xUnavailable && <span className="x-unavail"> · X unavailable (Telegram unaffected)</span>}
          </p>
        </div>
        {pendingCount > 0 && (
          <button type="button" className="new-drops-pill" aria-live="polite" onClick={onApplyPending}>
            {pendingCount} new {pendingCount === 1 ? 'drop' : 'drops'} ↑
          </button>
        )}
      </div>

      <DropsFilterDock filters={filters} searchRef={searchRef} />

      <div className="results-bar">
        <p className="note" role="status">
          Showing <strong className="mono">{filters.rendered.length}</strong>
          {filters.rendered.length < filters.visible.length ? ` of ${filters.visible.length} matching` : ''} (
          {totalCount} clusters tracked)
        </p>
        {filters.hasAnyFilter && (
          <button type="button" className="link-btn" onClick={filters.resetFilters}>
            Reset filters
          </button>
        )}
      </div>

      <DropsBody
        filters={filters}
        totalCount={totalCount}
        loading={loading}
        failed={failed}
        onCopyBrief={onCopyBrief}
      />
    </section>
  );
}
