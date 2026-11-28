import { useState } from 'react';
import type { Card, FeedItem } from '../../shared/types';
import {
  buildFeedMeta,
  cleanFeedSteps,
  cleanLinkLabel,
  dedupeFeedSources,
  dedupeStrings,
  describeDeadline,
  filterUncoveredSummaryBullets,
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
import { resolveEntityVisual, resolveOgPreview, type ProjectLogoIndex } from '../lib/visualAssets';
import { ChainBadge, CryptoTickerPill, EntityAvatar, PlatformBadge } from './EntityVisual';
import { FeedLinkLeadingIcon } from './FeedLinkIcon';
import { MetaPills, RadarPill } from './MetaPills';
import { FeedStepsPreview } from './FeedStepsPreview';
import { DomainPill } from './DomainPill';
import { OgPreview } from './OgPreview';
import { RiskBadge } from './RiskBadge';
import { BriefBadge } from './BriefActions';
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ClockIcon,
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LockIcon,
  ShieldAlertIcon,
  SparklesIcon,
  TagIcon,
} from './Icons';

const MAX_VISIBLE_RISK_NOTES = 2;
const SUMMARY_COLLAPSE_THRESHOLD = 380;
const SUMMARY_PREVIEW_LIMIT = 340;
const ROUTINE_CAUTION_RE = /(?:not in verified registry|unverified domain|shortener|shortened url)/i;

interface Props {
  item: FeedItem;
  logoIndex?: ProjectLogoIndex;
  /** Curated card matched through `radarId`, or null. */
  radarCard?: Card | null;
  onDetails: (item: FeedItem) => void;
  onCopyBrief: (item: FeedItem) => void;
  onOpenRadar: (card: Card) => void;
}

function buildSummaryPreview(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const window = text.slice(0, limit);
  const lastSpace = window.lastIndexOf(' ');
  const cut = lastSpace >= Math.floor(limit * 0.6) ? window.slice(0, lastSpace) : window;
  return `${cut.replace(/[,:;\-–—(\u00b7]+$/, '').trimEnd()}\u2026`;
}

function feedCardClass(isRisk: boolean, hasOgImage: boolean): string {
  return `cardx feed-card${isRisk ? ' is-risk' : ''}${hasOgImage ? ' has-og' : ''}`;
}

function FeedSummaryBlock({ summary, steps }: { summary: FormattedSummary; steps: readonly string[] }) {
  const [expanded, setExpanded] = useState(false);
  const bullets = filterUncoveredSummaryBullets(summary.bullets, steps);
  if (!summary.lead && bullets.length === 0) return null;

  const isLongLead = summary.lead.length > SUMMARY_COLLAPSE_THRESHOLD;
  const leadText = isLongLead && !expanded ? buildSummaryPreview(summary.lead, SUMMARY_PREVIEW_LIMIT) : summary.lead;

  return (
    <div className="feed-summary-wrap">
      {leadText && (
        <p className="feed-summary">
          {leadText}
          {isLongLead && (
            <>
              {' '}
              <button
                type="button"
                className="link-btn feed-summary-toggle"
                aria-expanded={expanded}
                onClick={() => setExpanded(v => !v)}
              >
                <span>{expanded ? 'Show less' : 'Show more'}</span>
                {expanded ? <ChevronUpIcon size={13} /> : <ChevronDownIcon size={13} />}
              </button>
            </>
          )}
        </p>
      )}
      {bullets.length > 0 && (
        <ul className="feed-bullets" aria-label="Task steps">
          {bullets.map(bullet => (
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
            <FeedLinkLeadingIcon url={link.url} known={link.known} />
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
      {sources.map(src => {
        const safePostUrl = isHttpUrl(src.postUrl) ? src.postUrl.trim() : null;
        const handleLabel = formatSourceHandle(src.platform, src.handle) || src.platform;
        return (
          <li key={src.postUrl}>
            <span className="source-ref-main">
              <PlatformBadge source={src.platform} size={12} className="source-ref-platform" />
              {safePostUrl ? (
                <a href={safePostUrl} target="_blank" rel="noopener noreferrer" className="mono">
                  <span>{handleLabel}</span>
                  <span className="sr"> ({src.platform}) post (opens in a new tab)</span>
                  <ExternalLinkIcon size={11} />
                </a>
              ) : (
                <span className="mono">{handleLabel}</span>
              )}
            </span>
            <span className="mono note source-ref-time">
              <ClockIcon size={11} />
              <span>{formatRelativeTime(src.postedAt)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function FeedCard({
  item,
  logoIndex,
  radarCard = null,
  onDetails,
  onCopyBrief,
  onOpenRadar,
}: Props) {
  const [showSources, setShowSources] = useState(false);
  const isRisk = item.risk.level === 'risk';
  const title = formatProjectTitle(item.project);
  const summary = formatFeedSummary(item.summary, title);
  const riskNotes = formatRiskReasons(item);
  const displayLinks = prepareFeedLinks(item, { max: 3 });
  const steps = cleanFeedSteps(item.steps);
  const chains = dedupeStrings(item.chains);
  const taskTypes = dedupeStrings(item.taskTypes);
  const sources = dedupeFeedSources(item.sources);
  const ogPreview = resolveOgPreview({ ogImage: item.ogImage, fallbackTitle: title });
  const visual = resolveEntityVisual({
    name: title,
    logo: item.logo,
    ticker: item.ticker,
    domain: item.domain,
    url: displayLinks[0]?.url,
    chain: chains[0],
    source: sources[0]?.platform,
    sectionId: 'drops',
    logoIndex,
  });
  const resolvedTicker = visual.resolvedTicker;

  return (
    <article className={feedCardClass(isRisk, Boolean(ogPreview?.image))}>
      <OgPreview preview={ogPreview} variant="strip" />

      <div className="feed-head">
        <div className="feed-head-left">
          <EntityAvatar name={title} resolved={visual} size={38} />
          <div className="feed-title-wrap">
            <h3 className="feed-title">
              <button type="button" className="feed-title-btn" onClick={() => onDetails(item)}>
                {title}
              </button>
            </h3>
            <div className="ticker">
              {resolvedTicker ? (
                <CryptoTickerPill ticker={resolvedTicker} size={13} />
              ) : (
                <span className="ticker-status mono">Pre-token</span>
              )}
              {item.domain && (
                <span className="feed-domain-chip mono" title={`Domain: ${item.domain}`}>
                  <GlobeIcon size={11} className="feed-domain-icon" />
                  <span>{item.domain}</span>
                </span>
              )}
              <DomainPill verified={item.verifiedDomain} domain={item.domain} />
              {item.summarySource === 'ai' && (
                <span className="ai-tag">
                  <SparklesIcon size={11} />
                  <span>AI summary</span>
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="card-actions feed-head-right">
          {item.surf?.tier && (
            <span className={`gradetip tier-pill ${item.surf.tier}`} title={`Curated Tier ${item.surf.tier}`}>
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

      <MetaPills pills={buildFeedMeta(item)} deadline={describeDeadline(item.deadline)}>
        {radarCard && <RadarPill card={radarCard} onOpen={onOpenRadar} />}
      </MetaPills>

      <FeedSummaryBlock summary={summary} steps={steps} />

      <FeedStepsPreview steps={steps} />

      <SafetyNotes level={item.risk.level} notes={riskNotes} />

      {(chains.length > 0 || taskTypes.length > 0) && (
        <div className="chipline feed-tags">
          {chains.map(c => (
            <ChainBadge key={c} chain={c} size={12} />
          ))}
          {taskTypes.map(t => (
            <span key={t} className="badge feed-task-tag">
              <TagIcon size={11} className="feed-task-icon" />
              <span>{t}</span>
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

        <div className="feed-foot-actions">
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
            <>
              <BriefBadge item={item} />
              <button type="button" className="chip feed-copy-btn" onClick={() => onCopyBrief(item)}>
                <CopyIcon size={13} />
                <span>Copy agent brief</span>
                <span className="sr"> for {title}</span>
              </button>
            </>
          )}
          <button
            type="button"
            className="chip feed-details-btn"
            title="Open full details, steps, and links"
            aria-label={`Details for ${title}`}
            onClick={() => onDetails(item)}
          >
            <span>Details</span>
            <ChevronRightIcon size={13} />
          </button>
        </div>
      </div>

      {showSources && sources.length > 0 && <FeedSourceRefs sources={sources} />}
    </article>
  );
}
