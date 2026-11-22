import { useState } from 'react';
import type { SourceHealth } from '../../shared/types';
import { formatRelativeTime } from '../lib/format';

interface Props {
  sources: SourceHealth[];
  loading: boolean;
  isLiveApi: boolean;
  failed: boolean;
}

export function SourcesHealthPopover({ sources, loading, isLiveApi, failed }: Props) {
  const [open, setOpen] = useState(false);

  const okCount = sources.filter(s => s.status === 'ok').length;
  const degradedCount = sources.filter(s => s.status === 'degraded').length;
  const downCount = sources.filter(s => s.status === 'down').length;
  const tgCount = sources.filter(s => s.platform === 'telegram').length;
  const xCount = sources.filter(s => s.platform === 'x').length;

  const label =
    sources.length === 0
      ? loading
        ? 'Checking sources…'
        : 'Sources unavailable'
      : isLiveApi
        ? `Sources health (${okCount}/${sources.length} ok)`
        : `Sources snapshot (${okCount}/${sources.length} ok)`;

  return (
    <div className="sources-health">
      <button
        type="button"
        className="chip"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        {label}
      </button>

      {open && (
        <div className="sources-popover" role="region" aria-label="Configured feed sources health">
          <div className="sources-popover-head">
            <strong>
              TG {tgCount} · X {xCount} — {okCount} ok · {degradedCount} degraded · {downCount} down
            </strong>
            <button type="button" className="link-btn" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          {loading && sources.length === 0 ? (
            <p className="note">Checking sources…</p>
          ) : failed && sources.length === 0 ? (
            <p className="note" role="status">Sources health unavailable — retry later.</p>
          ) : (
            <ul className="sources-list">
              {!isLiveApi && (
                <li className="note source-item">Snapshot data — may be stale until the live API responds.</li>
              )}
              {sources.map(src => (
                <li key={src.id} className="source-item">
                  <span>
                    <span className="mono">@{src.handle}</span>{' '}
                    <span className="note">({src.platform})</span>
                  </span>
                  <span className="source-item-meta">
                    <span className={`badge status-${src.status}`}>{src.status}</span>
                    <span className="mono note">
                      {src.lastOkAt ? formatRelativeTime(src.lastOkAt) : 'never'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
