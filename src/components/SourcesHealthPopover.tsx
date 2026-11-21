import { useState } from 'react';
import type { SourceHealth } from '../../shared/types';
import { formatRelativeTime } from '../lib/format';

interface Props {
  sources: SourceHealth[];
  loading: boolean;
}

export function SourcesHealthPopover({ sources, loading }: Props) {
  const [open, setOpen] = useState(false);

  const okCount = sources.filter(s => s.status === 'ok').length;
  const degradedCount = sources.filter(s => s.status === 'degraded').length;
  const downCount = sources.filter(s => s.status === 'down').length;

  return (
    <div className="sources-health">
      <button
        type="button"
        className="chip"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        Sources health ({okCount}/{sources.length} ok)
      </button>

      {open && (
        <div className="sources-popover" role="region" aria-label="Configured feed sources health">
          <div className="sources-popover-head">
            <strong>
              {okCount} ok · {degradedCount} degraded · {downCount} down
            </strong>
            <button type="button" className="link-btn" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          {loading && sources.length === 0 ? (
            <p className="note">Checking sources…</p>
          ) : (
            <ul className="sources-list">
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
