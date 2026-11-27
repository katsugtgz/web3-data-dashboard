import type { Card, FeedItem } from '../../shared/types';
import type { DisplayLink, DisplayRiskNote, FeedTimelineEntry } from '../lib/feedDisplay';
import { cleanLinkLabel } from '../lib/feedDisplay';
import { formatRelativeTime, hostnameLabel } from '../lib/format';
import { ChainBadge, PlatformBadge } from './EntityVisual';
import { FeedLinkLeadingIcon } from './FeedLinkIcon';
import { AlertTriangleIcon, ExternalLinkIcon, RadarIcon, ShieldAlertIcon } from './Icons';

/** Numbered task steps exactly as the sources reported them. */
export function DropsDetailSteps({ steps }: { steps: readonly string[] }) {
  if (steps.length === 0) return null;

  return (
    <section className="dlg-tasks" aria-label="Task steps">
      <div className="dlg-section-head">
        <h3>Steps</h3>
        <span className="countchip mono">
          {steps.length} {steps.length === 1 ? 'step' : 'steps'}
        </span>
      </div>
      <ol className="drop-step-list">
        {steps.map((step, index) => (
          <li key={step} className="drop-step">
            <span className="drop-step-num mono" aria-hidden="true">
              {index + 1}
            </span>
            <span className="drop-step-text">{step}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

const UNVERIFIED_LINK_HINT = 'Unverified link: confirm it is the official destination before opening it.';

/** Every surfaced link with its verification state and a safe external anchor. */
export function DropsDetailLinks({ links }: { links: readonly DisplayLink[] }) {
  if (links.length === 0) return null;
  const verifiedCount = links.filter(link => link.known).length;

  return (
    <section className="dlg-tasks" aria-label="Link verification">
      <div className="dlg-section-head">
        <h3>Link verification</h3>
        <span className="countchip mono">
          {verifiedCount} of {links.length} verified
        </span>
      </div>
      <ul className="link-matrix">
        {links.map(link => (
          <li key={link.url} className={`link-matrix-row${link.known ? ' is-known' : ''}`}>
            <FeedLinkLeadingIcon url={link.url} known={link.known} />
            <span className="link-matrix-host" title={link.url}>
              {hostnameLabel(link.url)}
              <span className="link-matrix-path">{cleanLinkLabel(link.label)}</span>
            </span>
            <span className={`link-matrix-state${link.known ? ' is-known' : ''}`}>
              {link.known ? 'Verified' : 'Unverified'}
            </span>
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="link-matrix-open"
              title={link.known ? link.url : UNVERIFIED_LINK_HINT}
            >
              <span>Open</span>
              <span className="sr">
                {' '}
                {cleanLinkLabel(link.label)} (opens in a new tab
                {link.known ? '' : ', unverified link'})
              </span>
              <ExternalLinkIcon size={12} />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
};

/** "Nov 27, 2026, 02:30 PM UTC" for a Unix-ms timestamp; empty when it is not a real date. */
function formatPostDate(ts: number): string {
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.toLocaleString('en-US', DATE_FORMAT)} UTC`;
}

/** Every source post, newest first, with an absolute and a relative timestamp. */
export function DropsDetailTimeline({ entries }: { entries: readonly FeedTimelineEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <section className="dlg-tasks" aria-label="Source timeline">
      <div className="dlg-section-head">
        <h3>Source timeline</h3>
        <span className="countchip mono">
          {entries.length} {entries.length === 1 ? 'post' : 'posts'}
        </span>
      </div>
      <ol className="drop-timeline">
        {entries.map(entry => (
          <li key={entry.id} className="drop-timeline-item">
            <PlatformBadge source={entry.platform} size={12} className="drop-timeline-platform" />
            <div className="drop-timeline-body">
              {entry.url ? (
                <a href={entry.url} target="_blank" rel="noopener noreferrer" className="drop-timeline-link">
                  <span>{entry.label}</span>
                  <ExternalLinkIcon size={11} />
                  <span className="sr">
                    {' '}
                    ({entry.platform}) post (opens in a new tab)
                  </span>
                </a>
              ) : (
                <span className="mono">{entry.label}</span>
              )}
              {entry.postedAt > 0 && (
                <time dateTime={new Date(entry.postedAt).toISOString()} className="drop-timeline-time mono">
                  {formatPostDate(entry.postedAt)} · {formatRelativeTime(entry.postedAt)}
                </time>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Safety notes at full length, styled by severity. An `ok` item with no notes renders nothing. */
export function DropsDetailSafety({ level, notes }: { level: FeedItem['risk']['level']; notes: DisplayRiskNote[] }) {
  if (notes.length === 0) return null;
  const isRisk = level === 'risk';

  return (
    <section className={`risk-box ${isRisk ? 'is-risk' : 'is-warn'}`} aria-label="Safety notes">
      <div className="risk-box-head">
        {isRisk ? <ShieldAlertIcon size={14} /> : <AlertTriangleIcon size={14} />}
        <span>{isRisk ? 'High risk signals' : 'Safety notes'}</span>
      </div>
      <ul className="risk-reasons">
        {notes.map(note => (
          <li key={note.id}>{note.text}</li>
        ))}
      </ul>
    </section>
  );
}

/** Jump to the curated card this drop was matched to. */
export function DropsDetailRadarLink({ card, onOpen }: { card: Card; onOpen: () => void }) {
  const meta = [card.r ? `Rank #${card.r}` : '', card.g ? `Tier ${card.g}` : ''].filter(Boolean).join(' · ');
  const chains = card.chains?.length ? card.chains : card.chain ? [card.chain] : [];

  return (
    <section className="dlg-tasks" aria-label="Curated Radar match">
      <div className="dlg-section-head">
        <h3>Curated Radar</h3>
        {chains.length > 0 && (
          <span className="dlg-spec-chains">
            {chains.map(chain => (
              <ChainBadge key={chain} chain={chain} size={13} />
            ))}
          </span>
        )}
      </div>
      <button type="button" className="btn btn-tonal radar-link-btn" onClick={onOpen}>
        <RadarIcon size={15} />
        <span className="radar-link-text">
          <span>View on Curated Radar</span>
          {meta && <span className="note mono radar-link-meta">{meta}</span>}
        </span>
        <ExternalLinkIcon size={13} />
      </button>
    </section>
  );
}
