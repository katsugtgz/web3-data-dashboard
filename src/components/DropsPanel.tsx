import type { RefObject } from 'react';
import type { FeedItem } from '../../shared/types';
import { DROPS_PAGE_STEP, type DropsFiltersState } from '../hooks/useDropsFilters';
import { formatRelativeTime } from '../lib/format';
import { DropsFilterDock } from './DropsFilterDock';
import { FeedCard } from './FeedCard';

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
    return (
      <div className="loading-shell" role="status" aria-live="polite">
        <div className="loading-bar" />
        <p className="note">Loading live drops…</p>
      </div>
    );
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
        <p>No drops match your current filters.</p>
        {filters.hasAnyFilter && (
          <button type="button" className="btn" style={{ marginTop: 10 }} onClick={filters.resetFilters}>
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
  return (
    <section role="tabpanel" id="panel-drops" aria-labelledby="tab-drops">
      <div className="section-head">
        <div>
          <h2 className="section">Live Drops Feed</h2>
          <p className="note">
            Real-time deduplicated signals from public Telegram channels &amp; best-effort X, safety-screened in English
            {generatedAt ? ` · updated ${formatRelativeTime(generatedAt)}` : ''}.
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
