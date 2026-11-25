import { useState } from 'react';
import type { FeedItem } from '../../shared/types';
import {
  dedupeFeedSources,
  formatFeedSummary,
  formatProjectTitle,
  formatRiskReasons,
  formatSourceHandle,
  prepareFeedLinks,
  type DisplayLink,
  type DisplayRiskNote,
  type FormattedSummary,
} from '../lib/feedDisplay';
import { formatRelativeTime, isHttpUrl } from '../lib/format';

const MAX_VISIBLE_RISK_NOTES = 2;

interface Props {
  item: FeedItem;
  onCopyBrief: (item: FeedItem) => void;
}

function RiskBadge({ level, notes }: { level: FeedItem['risk']['level']; notes: DisplayRiskNote[] }) {
  if (level === 'ok') return null;
  const title =
    notes.map(n => n.text).join(' · ') ||
    (level === 'risk' ? 'High risk signals detected' : 'Caution advised');
  return (
    <span className={`badge ${level === 'risk' ? 'badge-risk' : 'badge-warn'}`} title={title}>
      {level === 'risk' ? '⚠ RISK' : '! Warn'}
    </span>
  );
}

function FeedSummaryBlock({ summary }: { summary: FormattedSummary }) {
  if (!summary.lead && summary.bullets.length === 0) return null;
  return (
    <div className="feed-summary-wrap">
      {summary.lead && <p className="feed-summary">{summary.lead}</p>}
      {summary.bullets.length > 0 && (
        <ul className="feed-bullets" aria-label="Task steps">
          {summary.bullets.map(bullet => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SafetyNotes({ level, notes }: { level: FeedItem['risk']['level']; notes: DisplayRiskNote[] }) {
  const [expanded, setExpanded] = useState(false);
  if (notes.length === 0) return null;

  const hiddenCount = Math.max(0, notes.length - MAX_VISIBLE_RISK_NOTES);
  const visible = expanded ? notes : notes.slice(0, MAX_VISIBLE_RISK_NOTES);
  const toneClass = level === 'risk' ? 'is-risk' : 'is-warn';

  return (
    <div className={`risk-box ${toneClass}`}>
      <ul className="risk-reasons" aria-label="Safety notes">
        {visible.map(note => (
          <li key={note.id}>{note.text}</li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          className="risk-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(v => !v)}
        >
          {expanded ? 'Show fewer notes' : `+${hiddenCount} more safety ${hiddenCount === 1 ? 'note' : 'notes'}`}
        </button>
      )}
    </div>
  );
}

function FeedLinkPills({ links, projectTitle }: { links: DisplayLink[]; projectTitle: string }) {
  if (links.length === 0) return null;
  return (
    <div className="feed-links">
      {links.map(link => (
        <a
          key={link.url}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          title={link.url}
          className={`feed-link${link.known ? ' is-known' : ''}`}
        >
          {link.known && <span aria-hidden="true">✓</span>}
          <span className="feed-link-label">{link.label}</span>
          <span className="sr"> — {projectTitle} (opens in a new tab)</span>
          <span aria-hidden="true">↗</span>
        </a>
      ))}
    </div>
  );
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function FeedCard({ item, onCopyBrief }: Props) {
  const [showSources, setShowSources] = useState(false);
  const isRisk = item.risk.level === 'risk';
  const title = formatProjectTitle(item.project);
  const summary = formatFeedSummary(item.summary, title);
  const riskNotes = formatRiskReasons(item);
  const displayLinks = prepareFeedLinks(item, { max: 3 });
  const chains = dedupeStrings(item.chains);
  const taskTypes = dedupeStrings(item.taskTypes);
  const sources = dedupeFeedSources(item.sources);

  return (
    <article className={`cardx feed-card${isRisk ? ' is-risk' : ''}`}>
      <div className="feed-head">
        <div className="feed-title-wrap">
          <h3 className="feed-title">{title}</h3>
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
            <span className={`gradetip ${item.surf.tier}`} title={`Curated Tier ${item.surf.tier}`}>
              {item.surf.tier}
            </span>
          )}
          <RiskBadge level={item.risk.level} notes={riskNotes} />
        </div>
      </div>

      <FeedSummaryBlock summary={summary} />

      <SafetyNotes level={item.risk.level} notes={riskNotes} />

      {(chains.length > 0 || taskTypes.length > 0) && (
        <div className="chipline">
          {chains.map(c => (
            <span key={c} className="typetip">
              {c}
            </span>
          ))}
          {taskTypes.map(t => (
            <span key={t} className="badge">
              {t}
            </span>
          ))}
        </div>
      )}

      <FeedLinkPills links={displayLinks} projectTitle={title} />

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
            <span className="sr"> for {title}</span>
          </button>
        )}
      </div>

      {showSources && sources.length > 0 && (
        <ul className="source-refs" aria-label="Source posts">
          {sources.map(src => {
            const safePostUrl = isHttpUrl(src.postUrl) ? src.postUrl.trim() : null;
            const label = `${formatSourceHandle(src.platform, src.handle) || src.platform} (${src.platform})`;
            return (
              <li key={src.postUrl}>
                {safePostUrl ? (
                  <a href={safePostUrl} target="_blank" rel="noopener noreferrer">
                    {label}
                    <span className="sr"> post (opens in a new tab)</span>
                    <span aria-hidden="true"> ↗</span>
                  </a>
                ) : (
                  <span>{label}</span>
                )}
                <span className="mono note">{formatRelativeTime(src.postedAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}
