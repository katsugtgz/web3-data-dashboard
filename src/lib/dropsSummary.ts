import type { FeedItem } from '../../shared/types';

export interface DropsSummary {
  totalClusters: number;
  multiSourceCount: number;
  verifiedLinkCount: number;
  riskFlaggedCount: number;
}

export function summarizeDrops(items: readonly FeedItem[]): DropsSummary {
  let multiSourceCount = 0;
  let verifiedLinkCount = 0;
  let riskFlaggedCount = 0;

  for (const item of items) {
    if (item.sourceCount >= 2) multiSourceCount += 1;
    if (item.links.some(link => link.known)) verifiedLinkCount += 1;
    if (item.risk.level === 'risk') riskFlaggedCount += 1;
  }

  return {
    totalClusters: items.length,
    multiSourceCount,
    verifiedLinkCount,
    riskFlaggedCount,
  };
}
