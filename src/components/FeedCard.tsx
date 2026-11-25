import { useState } from 'react';
import type { FeedItem } from '../../shared/types';
import {
  dedupeFeedSources,
  formatFeedSummary,
  formatProjectTitle,
  formatRiskReasons,
  prepareFeedLinks,
  type DisplayLink,
  type DisplayRiskNote,
  type FormattedSummary,
} from '../lib/feedDisplay';
import { formatRelativeTime } from '../lib/format';
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  LockIcon,
  ShieldAlertIcon,
  SparklesIcon,
} from './Icons';

const MAX_VISIBLE_RISK_NOTES = 2;
const ROUTINE_CAUTION_RE = /(?:not in verified registry|unverified domain|shortener|shortened url)/i;

interface Props {
  item: FeedItem;
  onCopyBrief: (item: FeedItem) => void;
}

function StatusDot({ tone }: { tone: 'ok' | 'degraded' | 'down' }) {
  return <span className={`status-dot status-dot-${tone}`} aria-hidden="true" />;
}

function RiskBadge({ level, notes }: { level: FeedItem['risk']['level']; notes: DisplayRiskNote[] }) {
  if (level === 'ok') return null;
  const title =
    notes.map(n => n.text).join(' · ') ||
    (level === 'risk' ? 'High risk signals detected' : 'Caution advised');
  return (
    <span className={`badge ${level === 'risk' ? 'badge-risk' : 'badge-warn'}`} title={title}>
      <StatusDot tone={level === 'risk' ? 'down' : 'degraded'} />
      <span>{level === 'risk' ? 'RISK' : 'Warn'}</span>
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

  const isRisk = level === 'risk';
  const isRoutineCaution = level === 'warn' && notes.length === 1 && ROUTINE_CAUTION_RE.test(notes[0].text);

  if (isRoutineCaution) {
    return (
      <div className="risk-box is-caution-quiet" aria-label="Safety note">
        <AlertTriangleIcon size={13} className="risk-quiet-icon" />
        <span className="risk-quiet-text">{notes[0].text}</span>
      </div>
    );
  }

  const hiddenCount = Math.max(0, notes.length - MAX_VISIBLE_RISK_NOTES);
  const visible = expanded ? notes : notes.slice(0, MAX_VISIBLE_RISK_NOTES);
  const toneClass = isRisk ? 'is-risk' : 'is-warn';

  return (
    <div className={`risk-box ${toneClass}`}>
      <div className="risk-box-head">
        {isRisk ? <ShieldAlertIcon size={14} /> : <AlertTriangleIcon size={14} />}
        <span>{isRisk ? 'High risk signals' : 'Safety notice'}</span>
      </div>
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

function cleanLinkLabel(label: string): string {
  return label.replace(/[-/_]+(?=\u2026$)/, '').replace(/[-_]+$/, '\u2026');
}

function FeedLinkPills({ links, projectTitle }: { links: DisplayLink[]; projectTitle: string }) {
  if (links.length === 0) return null;
  return (
    <div className="feed-links">
      {links.map(link => {
        const displayLabel = cleanLinkLabel(link.label);
        return (
          <a
            key={link.url}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            title={link.url}
            className={`feed-link${link.known ? ' is-known' : ''}`}
          >
            {link.known && <CheckCircle2Icon size={13} className="feed-link-verified" />}
            <span className="feed-link-label">{displayLabel}</span>
            <span className="sr"> — {projectTitle} (opens in a new tab)</span>
            <ExternalLinkIcon size={12} className="feed-link-ext" />
          </a>
        );
      })}
    </div>
  );
}

function FeedSourceRefs({ sources }: { sources: FeedItem['sources'] }) {
  return (
    <ul className="source-refs" aria-label="Source posts">
      {sources.map(src => (
        <li key={src.postUrl}>
          <a href={src.postUrl} target="_blank" rel="noopener noreferrer">
            <span>
              @{src.handle} ({src.platform})
            </span>
            <span className="sr"> post (opens in a new tab)</span>
            <ExternalLinkIcon size={11} />
          </a>
          <span className="mono note">{formatRelativeTime(src.postedAt)}</span>
        </li>
      ))}
    </ul>
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
                <span className="mono feed-domain">{item.domain}</span>
              </>
            )}
            {item.summarySource === 'ai' && (
              <>
                {' · '}
                <span className="ai-tag">
                  <SparklesIcon size={11} />
                  <span>AI summary</span>
                </span>
              </>
            )}
          </p>
        </div>

        <div className="card-actions feed-head-right">
          {item.surf?.tier && (
            <span className={`gradetip tier-pill ${item.surf.tier}`} title={`Surf Tier ${item.surf.tier}`}>
              Tier {item.surf.tier}
            </span>
          )}
          <RiskBadge level={item.risk.level} notes={riskNotes} />
          <span className="feed-score-pill mono" title={`Signal confidence score ${item.score.toFixed(2)}`}>
            <span className="feed-score-lbl">Score</span>
            <span className="feed-score-val">{item.score.toFixed(2)}</span>
          </span>
        </div>
      </div>

      <FeedSummaryBlock summary={summary} />

      <SafetyNotes level={item.risk.level} notes={riskNotes} />

      {(chains.length > 0 || taskTypes.length > 0) && (
        <div className="chipline feed-tags">
          {chains.map(c => (
            <span key={c} className="typetip">
              {c}
            </span>
          ))}
          {taskTypes.map(t => (
            <span key={t} className="badge feed-task-tag">
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
            className="link-btn feed-sources-btn"
            aria-expanded={showSources}
            onClick={() => setShowSources(v => !v)}
          >
            <ChevronDownIcon size={14} className={showSources ? 'chev-open' : undefined} />
            <span>
              Seen in {item.sourceCount} {item.sourceCount === 1 ? 'source' : 'sources'}
            </span>
          </button>
          <span className="feed-foot-sep" aria-hidden="true">
            ·
          </span>
          <span className="note mono feed-time">{formatRelativeTime(item.lastSeen)}</span>
        </div>

        {isRisk ? (
          <span
            className="status-pill risk-blocked-status"
            aria-disabled="true"
            title="Blocked: high risk / agent guardrail"
            aria-label={`Copy agent brief blocked for ${title}: high risk`}
          >
            <LockIcon size={13} />
            <span>Risk blocked</span>
          </span>
        ) : (
          <button type="button" className="chip feed-copy-btn" onClick={() => onCopyBrief(item)}>
            <CopyIcon size={13} />
            <span>Copy agent brief</span>
            <span className="sr"> for {title}</span>
          </button>
        )}
      </div>

      {showSources && sources.length > 0 && <FeedSourceRefs sources={sources} />}
    </article>
  );
}
