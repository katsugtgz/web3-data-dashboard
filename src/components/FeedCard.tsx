import { useState } from 'react';
import type { FeedItem } from '../../shared/types';
import { formatRelativeTime, hostnameLabel, isHttpUrl } from '../lib/format';

interface Props {
  item: FeedItem;
  onCopyBrief: (item: FeedItem) => void;
}

function RiskBadge({ level, reasons }: { level: FeedItem['risk']['level']; reasons: string[] }) {
  if (level === 'ok') return null;
  const title = reasons.join(' · ') || (level === 'risk' ? 'High risk signals detected' : 'Caution advised');
  return (
    <span className={`badge ${level === 'risk' ? 'badge-risk' : 'badge-warn'}`} title={title}>
      {level === 'risk' ? '⚠ RISK' : '! Warn'}
    </span>
  );
}

export function FeedCard({ item, onCopyBrief }: Props) {
  const [showSources, setShowSources] = useState(false);
  const isRisk = item.risk.level === 'risk';

  return (
    <article className={`cardx feed-card${item.risk.level === 'risk' ? ' is-risk' : ''}`}>
      <div className="feed-head">
        <div className="feed-title-wrap">
          <h3 className="feed-title">{item.project}</h3>
          <p className="ticker">
            <span className="mono">{item.ticker ? `$${item.ticker}` : 'Pre-token'}</span>
            {item.domain && (
              <>
                {' · '}
                <span className="mono">{item.domain}</span>
              </>
            )}
            {item.summarySource === 'ai' && (
              <>
                {' · '}
                <span className="ai-tag">AI summary</span>
              </>
            )}
          </p>
        </div>
        <div className="card-actions">
          {item.surf?.tier && (
            <span className={`gradetip ${item.surf.tier}`} title={`Surf Tier ${item.surf.tier}`}>
              {item.surf.tier}
            </span>
          )}
          <RiskBadge level={item.risk.level} reasons={item.risk.reasons} />
        </div>
      </div>

      <p className="feed-summary">{item.summary}</p>

      {item.risk.reasons.length > 0 && (
        <ul className="risk-reasons" aria-label="Safety notes">
          {item.risk.reasons.map(reason => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      <div className="chipline">
        {item.chains.map(c => (
          <span key={c} className="typetip">
            {c}
          </span>
        ))}
        {item.taskTypes.map(t => (
          <span key={t} className="badge">
            {t}
          </span>
        ))}
      </div>

      {item.links.length > 0 && (
        <div className="feed-links">
          {item.links.slice(0, 3).map(link =>
            isHttpUrl(link.url) ? (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`feed-link${link.known ? ' is-known' : ''}`}
              >
                {link.known ? '✓ ' : ''}
                {hostnameLabel(link.url)}
                <span className="sr"> — {item.project} (opens in a new tab)</span>
                <span aria-hidden="true"> ↗</span>
              </a>
            ) : null,
          )}
        </div>
      )}

      <div className="feed-foot">
        <div className="feed-foot-left">
          <button
            type="button"
            className="link-btn"
            aria-expanded={showSources}
            onClick={() => setShowSources(v => !v)}
          >
            Seen in {item.sourceCount} {item.sourceCount === 1 ? 'source' : 'sources'}
          </button>
          <span className="note mono">
            {formatRelativeTime(item.lastSeen)} · score {item.score.toFixed(2)}
          </span>
        </div>
        {isRisk ? (
          <span className="note risk-blocked">⚠ Not available for RISK items</span>
        ) : (
          <button type="button" className="chip" onClick={() => onCopyBrief(item)}>
            Copy agent brief
            <span className="sr"> for {item.project}</span>
          </button>
        )}
      </div>

      {showSources && item.sources.length > 0 && (
        <ul className="source-refs" aria-label="Source posts">
          {item.sources.map(src => (
            <li key={src.postUrl}>
              <a href={src.postUrl} target="_blank" rel="noopener noreferrer">
                @{src.handle} ({src.platform})
                <span className="sr"> post (opens in a new tab)</span>
                <span aria-hidden="true"> ↗</span>
              </a>
              <span className="mono note">{formatRelativeTime(src.postedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
