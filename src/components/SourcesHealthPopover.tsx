import { useCallback, useRef, useState } from 'react';
import type { SourceHealth } from '../../shared/types';
import { usePopoverDismiss } from '../hooks/usePopoverDismiss';
import { formatSourceHandle, formatSourcesSummary } from '../lib/feedDisplay';
import { formatRelativeTime } from '../lib/format';
import { PlatformBadge } from './EntityVisual';
import { ActivityIcon, ClockIcon, XIcon } from './Icons';

type SourceFilter = 'all' | 'issues';

interface Props {
  sources: SourceHealth[];
  loading: boolean;
  isLiveApi: boolean;
  failed: boolean;
}

function summarizeSources(
  sources: SourceHealth[],
  loading: boolean,
  isLiveApi: boolean,
  failed: boolean,
) {
  let okCount = 0;
  let degradedCount = 0;
  let downCount = 0;

  for (const s of sources) {
    if (s.status === 'ok') okCount += 1;
    else if (s.status === 'degraded') degradedCount += 1;
    else downCount += 1;
  }

  const issueCount = degradedCount + downCount;
  const overallDot =
    downCount > 0 || (failed && sources.length === 0)
      ? 'status-dot-down'
      : degradedCount > 0
        ? 'status-dot-degraded'
        : sources.length > 0
          ? 'status-dot-ok'
          : '';

  let label = isLiveApi
    ? `Sources (${okCount}/${sources.length} ok)`
    : `Sources snapshot (${okCount}/${sources.length} ok)`;
  if (sources.length === 0) {
    label = loading ? 'Checking sources…' : 'Sources unavailable';
  }

  return {
    okCount,
    degradedCount,
    downCount,
    issueCount,
    overallDot,
    label,
    summaryText: formatSourcesSummary(sources),
  };
}

function SourcesPopoverBody({
  sources,
  visibleSources,
  loading,
  isLiveApi,
  failed,
}: {
  sources: SourceHealth[];
  visibleSources: SourceHealth[];
  loading: boolean;
  isLiveApi: boolean;
  failed: boolean;
}) {
  if (loading && sources.length === 0) {
    return <p className="note">Checking sources…</p>;
  }
  if (failed && sources.length === 0) {
    return (
      <p className="note" role="status">
        Sources health unavailable — retry later.
      </p>
    );
  }
  if (sources.length === 0) {
    return (
      <p className="note" role="status">
        No sources configured.
      </p>
    );
  }
  return (
    <ul className="sources-list">
      {!isLiveApi && (
        <li className="note source-item">Snapshot data — may be stale until the live API responds.</li>
      )}
      {visibleSources.length === 0 ? (
        <li className="note source-item-empty">
          All {sources.length} sources operating normally.
        </li>
      ) : (
        visibleSources.map(src => (
          <li key={src.id} className="source-item">
            <span className="source-item-main">
              <span className={`status-dot status-dot-${src.status}`} aria-hidden="true" />
              <PlatformBadge source={src.platform} size={12} className="source-item-platform" />
              <span className="mono source-item-handle">{formatSourceHandle(src.platform, src.handle) || src.id}</span>
            </span>
            <span className="source-item-meta">
              <span className={`badge status-${src.status}`}>{src.status}</span>
              <span className="mono note source-item-time">
                <ClockIcon size={11} />
                <span>{src.lastOkAt ? formatRelativeTime(src.lastOkAt) : 'never'}</span>
              </span>
            </span>
          </li>
        ))
      )}
    </ul>
  );
}

export function SourcesHealthPopover({ sources, loading, isLiveApi, failed }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<SourceFilter>('all');
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const dismiss = useCallback(() => setOpen(false), []);
  usePopoverDismiss(containerRef, open, dismiss, triggerRef);

  const summary = summarizeSources(sources, loading, isLiveApi, failed);
  const visibleSources = filter === 'issues' ? sources.filter(s => s.status !== 'ok') : sources;

  return (
    <div className="sources-health" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="chip sources-trigger"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <ActivityIcon size={14} />
        <span className={`status-dot ${summary.overallDot}`} aria-hidden="true" />
        <span>{summary.label}</span>
      </button>

      {open && (
        <div className="sources-popover" role="region" aria-label="Configured feed sources health">
          <div className="sources-popover-head">
            <strong>{summary.summaryText}</strong>
            <button
              type="button"
              className="iconbtn"
              onClick={() => {
                dismiss();
                triggerRef.current?.focus();
              }}
              aria-label="Close sources health"
            >
              <XIcon size={14} />
            </button>
          </div>

          {sources.length > 0 && (
            <div className="sources-popover-filter">
              <div className="seg-group seg-group-compact" role="group" aria-label="Filter sources by status">
                <button
                  type="button"
                  className="seg-btn"
                  aria-pressed={filter === 'all'}
                  onClick={() => setFilter('all')}
                >
                  All <span className="chip-count mono">{sources.length}</span>
                </button>
                <button
                  type="button"
                  className="seg-btn"
                  aria-pressed={filter === 'issues'}
                  onClick={() => setFilter('issues')}
                >
                  Degraded &amp; Down <span className="chip-count mono">{summary.issueCount}</span>
                </button>
              </div>
            </div>
          )}

          <SourcesPopoverBody
            sources={sources}
            visibleSources={visibleSources}
            loading={loading}
            isLiveApi={isLiveApi}
            failed={failed}
          />
        </div>
      )}
    </div>
  );
}
