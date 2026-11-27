import type { FeedItem } from '../../shared/types';
import type { DisplayRiskNote } from '../lib/feedDisplay';
import type { ResolvedEntityVisual } from '../lib/visualAssets';
import { CryptoTickerPill, EntityAvatar } from './EntityVisual';
import { XIcon } from './Icons';
import { DomainPill } from './DomainPill';
import { RiskBadge } from './RiskBadge';

interface Props {
  item: FeedItem;
  title: string;
  visual: ResolvedEntityVisual;
  riskNotes: DisplayRiskNote[];
  onDismiss: () => void;
}

function MetaSep() {
  return (
    <span className="dlg-meta-sep" aria-hidden="true">
      ·
    </span>
  );
}

/** Sticky header of the drop drawer: identity, tier, domain trust, risk level, score, close. */
export function DropsDetailHeader({ item, title, visual, riskNotes, onDismiss }: Props) {
  const tier = item.surf?.tier;

  return (
    <div className="dlg-sticky-head">
      <div className="dlg-head">
        <div className="dlg-title-group">
          <EntityAvatar
            key={item.logo || title}
            name={title}
            resolved={visual}
            size={44}
            shape="rounded"
            className="dlg-entity-avatar"
          />
          <div className="dlg-title-meta">
            <h2 id="drops-detail-title">{title}</h2>
            <div className="dlg-subtitle">
              {visual.resolvedTicker ? (
                <CryptoTickerPill ticker={visual.resolvedTicker} size={13} />
              ) : (
                <span className="dlg-token-status mono">Pre-token</span>
              )}
              {tier && (
                <>
                  <MetaSep />
                  <span className={`gradetip dlg-tier-pill ${tier}`}>Tier {tier}</span>
                </>
              )}
              {item.domain && (
                <>
                  <MetaSep />
                  <span className="dlg-meta-item mono">{item.domain}</span>
                </>
              )}
              <DomainPill verified={item.verifiedDomain} domain={item.domain} />
              <RiskBadge level={item.risk.level} notes={riskNotes} />
            </div>
          </div>
        </div>
        <div className="dlg-head-actions">
          <span className="feed-score-pill mono" title={`Signal confidence score ${item.score.toFixed(2)}`}>
            <span className="feed-score-lbl">Score</span>
            <span className="feed-score-val">{item.score.toFixed(2)}</span>
          </span>
          <button type="button" className="dlg-x" onClick={onDismiss} aria-label="Close drop details">
            <XIcon size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
