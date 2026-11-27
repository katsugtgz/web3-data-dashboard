import { useMemo, type RefObject } from 'react';
import type { Card, FeedItem } from '../../shared/types';
import { DROPS_PAGE_STEP, type DropsFiltersState } from '../hooks/useDropsFilters';
import { summarizeDrops, type DropsSummary } from '../lib/dropsSummary';
import { matchRadarCard } from '../lib/feedDisplay';
import { formatRelativeTime } from '../lib/format';
import type { ProjectLogoIndex } from '../lib/visualAssets';
import { summarizeDropMix, type DropMix } from '../lib/viz';
import { CompactDropsTable } from './CompactDropRow';
import { DropsFilterDock } from './DropsFilterDock';
import { FeedCard } from './FeedCard';
import { CheckCircle2Icon, LayersIcon, ShieldAlertIcon, ShieldCheckIcon, ZapIcon } from './Icons';
import { KpiActivity, MiniBars } from './KpiSparkline';
import { useViewMode, ViewToggle } from './ViewToggle';

const SKELETON_IDS = ['sk-1', 'sk-2', 'sk-3', 'sk-4', 'sk-5', 'sk-6'] as const;
const DROPS_VIEW_KEY = 'radar.drops.view';

interface Props {
  filters: DropsFiltersState;
  totalCount: number;
  pendingCount: number;
  generatedAt: number | null;
  xUnavailable: boolean;
  loading: boolean;
  failed: boolean;
  logoIndex?: ProjectLogoIndex;
  /** Curated cards keyed by id, for the Radar cross-link pills. */
  radarIndex?: ReadonlyMap<string, Card>;
  searchRef: RefObject<HTMLInputElement | null>;
  onApplyPending: () => void;
  onSelectDetail: (item: FeedItem) => void;
  onCopyBrief: (item: FeedItem) => void;
  onOpenRadar: (card: Card) => void;
}

function DropsKpiStrip({
  summary,
  mix,
  totalCount,
  loading,
  filters,
}: {
  summary: DropsSummary;
  mix: DropMix;
  totalCount: number;
  loading: boolean;
  filters: DropsFiltersState;
}) {
  const isMultiSource = filters.minSources >= 2;
  const showingRisk = !filters.hideRisk;
  const matching = filters.visible.length;

  return (
    <div className="kpi-strip kpi-strip-4" role="group" aria-label="Live drops signal overview">
      <button
        type="button"
        className="kpi-card"
        title={filters.hasAnyFilter ? 'Reset active drops filters' : 'All tracked signal clusters'}
        aria-label={`Tracked clusters: ${totalCount} tracked, ${matching} matching. Resets drops filters.`}
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
        <span className="kpi-viz">
          <KpiActivity timestamps={mix.lastSeen} label="Drops seen per day" />
          <MiniBars segments={mix.platforms} label="Source posts by platform" />
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
        <span className="kpi-viz">
          <MiniBars segments={mix.corroboration} label="Corroborated versus single-source drops" />
        </span>
      </button>

      <div className="kpi-card kpi-card-static">
        <span className="kpi-label-row">
          <CheckCircle2Icon size={13} className="kpi-icon kpi-icon-ok" />
          <span className="kpi-label">Verified Domains</span>
        </span>
        <strong className="kpi-val mono">{summary.verifiedLinkCount}</strong>
        <span className="kpi-sub">Known protocol links</span>
        <span className="kpi-viz">
          <MiniBars segments={mix.verification} label="Drops with a known link versus without" />
        </span>
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

interface BodyProps {
  filters: DropsFiltersState;
  view: 'card' | 'compact';
  totalCount: number;
  loading: boolean;
  failed: boolean;
  logoIndex?: ProjectLogoIndex;
  radarIndex: ReadonlyMap<string, Card>;
  onSelectDetail: (item: FeedItem) => void;
  onCopyBrief: (item: FeedItem) => void;
  onOpenRadar: (card: Card) => void;
}

const EMPTY_INDEX: ReadonlyMap<string, Card> = new Map();

function DropsBody({
  filters,
  view,
  totalCount,
  loading,
  failed,
  logoIndex,
  radarIndex,
  onSelectDetail,
  onCopyBrief,
  onOpenRadar,
}: BodyProps) {
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
      {view === 'compact' ? (
        <CompactDropsTable
          items={filters.rendered}
          logoIndex={logoIndex}
          radarIndex={radarIndex}
          onDetails={onSelectDetail}
          onCopyBrief={onCopyBrief}
          onOpenRadar={onOpenRadar}
        />
      ) : (
        <div className="grid">
          {filters.rendered.map(item => (
            <FeedCard
              key={item.id}
              item={item}
              logoIndex={logoIndex}
              radarCard={matchRadarCard(item, radarIndex)}
              onDetails={onSelectDetail}
              onCopyBrief={onCopyBrief}
              onOpenRadar={onOpenRadar}
            />
          ))}
        </div>
      )}
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
  logoIndex,
  radarIndex = EMPTY_INDEX,
  searchRef,
  onApplyPending,
  onSelectDetail,
  onCopyBrief,
  onOpenRadar,
}: Props) {
  const [view, selectView] = useViewMode(DROPS_VIEW_KEY);
  const summary = useMemo(() => summarizeDrops(filters.visible), [filters.visible]);
  const mix = useMemo(() => summarizeDropMix(filters.visible), [filters.visible]);

  return (
    <section role="tabpanel" id="panel-drops" aria-labelledby="tab-drops">
      <DropsKpiStrip summary={summary} mix={mix} totalCount={totalCount} loading={loading} filters={filters} />

      <div className="section-head">
        <div>
          <h2 className="section">Live Drops Feed</h2>
          <p className="note">
            Real-time deduplicated signals from public Telegram channels, RSS/API trackers &amp; best-effort X, safety-screened in English
            {generatedAt ? ` · latest activity ${formatRelativeTime(generatedAt)}` : ''}.
            {xUnavailable && <span className="x-unavail"> · X unavailable (Telegram &amp; feeds unaffected)</span>}
          </p>
        </div>
        <span className="sr-only" aria-live="polite">
          {pendingCount > 0 ? `${pendingCount} new ${pendingCount === 1 ? 'drop' : 'drops'} available` : ''}
        </span>
        {pendingCount > 0 && (
          <button type="button" className="new-drops-pill" onClick={onApplyPending}>
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
        <div className="results-bar-actions">
          {filters.hasAnyFilter && (
            <button type="button" className="link-btn" onClick={filters.resetFilters}>
              Reset filters
            </button>
          )}
          <ViewToggle view={view} onChange={selectView} label="drops" />
        </div>
      </div>

      <DropsBody
        filters={filters}
        view={view}
        totalCount={totalCount}
        loading={loading}
        failed={failed}
        logoIndex={logoIndex}
        radarIndex={radarIndex}
        onSelectDetail={onSelectDetail}
        onCopyBrief={onCopyBrief}
        onOpenRadar={onOpenRadar}
      />
    </section>
  );
}
