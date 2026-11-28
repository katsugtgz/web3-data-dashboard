import { useState } from 'react';
import type { AgentProfile, Card, FeedItem } from '../../shared/types';
import { buildBrief } from '../lib/agentBrief';
import {
  buildFeedTimeline,
  cleanFeedSteps,
  dedupeFeedSources,
  dedupeStrings,
  filterUncoveredSummaryBullets,
  formatFeedSummary,
  formatProjectTitle,
  formatRiskReasons,
  matchRadarCard,
  prepareFeedLinks,
} from '../lib/feedDisplay';
import { resolveEntityVisual, type ProjectLogoIndex } from '../lib/visualAssets';
import { getRefBaseUrl, type CopyStatus as CopyOutcome } from '../hooks/useCopyBriefController';
import { BriefActions } from './BriefActions';
import { CopyStatusBanner, type CopyStatus } from './CopyStatusBanner';
import { DropsDetailHeader } from './DropsDetailHeader';
import { DropsDetailMeta } from './DropsDetailMeta';
import {
  DropsDetailLinks,
  DropsDetailRadarLink,
  DropsDetailSafety,
  DropsDetailSteps,
  DropsDetailTimeline,
} from './DropsDetailSections';
import { ModalDrawer } from './ModalDrawer';

const EMPTY_INDEX: ReadonlyMap<string, Card> = new Map();

interface Props {
  item: FeedItem | null;
  /** Curated cards keyed by id, used to resolve the Radar cross-link. */
  radarIndex?: ReadonlyMap<string, Card>;
  profile: AgentProfile;
  /** Any active copy outcome, whatever region it was addressed to; only the detail one is shown here. */
  copyStatus: CopyOutcome | null;
  logoIndex?: ProjectLogoIndex | null;
  onCopyBrief: (item: FeedItem) => void;
  /** Switches to the Airdrops tab and opens the matched curated card. */
  onOpenRadar: (card: Card) => void;
  onClose: () => void;
}

interface BodyProps {
  item: FeedItem;
  radarIndex: ReadonlyMap<string, Card>;
  profile: AgentProfile;
  logoIndex?: ProjectLogoIndex | null;
  copyStatus: CopyStatus | null;
  onCopyBrief: (item: FeedItem) => void;
  onOpenRadar: (card: Card) => void;
  onDismiss: () => void;
}

function DropsDetailBody({
  item,
  radarIndex,
  profile,
  logoIndex,
  copyStatus,
  onCopyBrief,
  onOpenRadar,
  onDismiss,
}: BodyProps) {
  const [showBrief, setShowBrief] = useState(false);
  const title = formatProjectTitle(item.project);
  const steps = cleanFeedSteps(item.steps);
  const summary = formatFeedSummary(item.summary, title);
  const summaryBullets = filterUncoveredSummaryBullets(summary.bullets, steps);
  const riskNotes = formatRiskReasons(item);
  const links = prepareFeedLinks(item, { max: 12 });
  const chains = dedupeStrings(item.chains);
  const taskTypes = dedupeStrings(item.taskTypes);
  const radarCard = matchRadarCard(item, radarIndex);
  const visual = resolveEntityVisual({
    name: title,
    logo: item.logo,
    ticker: item.ticker,
    domain: item.domain,
    url: links[0]?.url,
    chain: chains[0],
    source: dedupeFeedSources(item.sources)[0]?.platform,
    sectionId: 'drops',
    logoIndex,
  });
  const renderedBrief = showBrief ? buildBrief(item, profile, { refBaseUrl: getRefBaseUrl() }) : null;
  const slug = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'drop'}-drop`;
  const isRisk = item.risk.level === 'risk';

  return (
    <div className="dlg-inner">
      <DropsDetailHeader item={item} title={title} visual={visual} riskNotes={riskNotes} onDismiss={onDismiss} />

      <div className="dlg-scroll-body">
        <CopyStatusBanner status={copyStatus} />

        <BriefActions<FeedItem>
          target={item}
          profile={profile}
          slug={slug}
          blocked={isRisk}
          showBrief={showBrief}
          onToggleBrief={() => setShowBrief(v => !v)}
          onCopyBrief={onCopyBrief}
        />

        {showBrief && renderedBrief && <pre className="brief-preview mono">{renderedBrief}</pre>}

        {(summary.lead || summaryBullets.length > 0) && (
          <div className="dlg-summary">
            {summary.lead && <p className="dlg-description">{summary.lead}</p>}
            {summaryBullets.length > 0 && (
              <ul className="feed-bullets" aria-label="Summary details">
                {summaryBullets.map(bullet => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DropsDetailMeta item={item} title={title} chains={chains} taskTypes={taskTypes} />
        <DropsDetailSteps steps={steps} />
        <DropsDetailLinks links={links} />
        <DropsDetailTimeline entries={buildFeedTimeline(item)} />
        <DropsDetailSafety level={item.risk.level} notes={riskNotes} />
        {radarCard && <DropsDetailRadarLink card={radarCard} onOpen={() => onOpenRadar(radarCard)} />}
      </div>
    </div>
  );
}

/** Right-side drawer with everything known about a single live drop. */
export function DropsDetailDialog({
  item,
  radarIndex = EMPTY_INDEX,
  profile,
  copyStatus,
  logoIndex,
  onCopyBrief,
  onOpenRadar,
  onClose,
}: Props) {
  return (
    <ModalDrawer id="drops-detail" labelledBy="drops-detail-title" open={item !== null} onClose={onClose}>
      {dismiss =>
        item && (
          <DropsDetailBody
            key={item.id}
            item={item}
            radarIndex={radarIndex}
            profile={profile}
            logoIndex={logoIndex}
            copyStatus={copyStatus?.target === 'detail' ? copyStatus : null}
            onCopyBrief={onCopyBrief}
            onOpenRadar={onOpenRadar}
            onDismiss={dismiss}
          />
        )
      }
    </ModalDrawer>
  );
}
