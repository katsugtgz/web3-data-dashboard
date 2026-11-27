import type { Card } from '../../shared/types';
import { buildCardMeta, describeDeadline } from '../lib/feedDisplay';
import { hostnameLabel, normalizeExternalUrl } from '../lib/format';
import { DomainPill } from './DomainPill';
import { MetaPills } from './MetaPills';

/** TVL, APY, deadline, reward pool, and domain trust. Renders nothing for a card without these facts. */
export function ProjectRichMeta({ card }: { card: Card }) {
  const pills = buildCardMeta(card);
  if (pills.length === 0 && card.verifiedDomain == null) return null;
  const projectHost = normalizeExternalUrl(card.url);

  return (
    <MetaPills pills={pills} deadline={describeDeadline(card.deadline)}>
      <DomainPill verified={card.verifiedDomain} domain={projectHost ? hostnameLabel(projectHost) : null} />
    </MetaPills>
  );
}
