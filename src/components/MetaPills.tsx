import type { ComponentType, ReactNode } from 'react';
import type { Card } from '../../shared/types';
import type { DeadlineInfo } from '../lib/feedDisplay';
import {
  ClockIcon,
  CoinsIcon,
  DollarSignIcon,
  LayersIcon,
  PercentIcon,
  RadarIcon,
  TrendingUpIcon,
  type IconProps,
} from './Icons';

export interface MetaPillItem {
  id: string;
  label: string;
  value: string;
}

const PILL_ICON: Record<string, ComponentType<IconProps>> = {
  reward: CoinsIcon,
  deadline: ClockIcon,
  cost: DollarSignIcon,
  tvl: LayersIcon,
  funding: TrendingUpIcon,
  apy: PercentIcon,
};

interface Props {
  pills: readonly MetaPillItem[];
  /** Parsed deadline of the same item; turns the deadline pill into a countdown when the date is ISO. */
  deadline?: DeadlineInfo | null;
  /** Extra trailing pills, such as a Radar cross-link or a domain-trust badge. */
  children?: ReactNode;
}

/** One row of labelled fact pills. Renders nothing when there is nothing to show. */
export function MetaPills({ pills, deadline, children }: Props) {
  if (pills.length === 0 && !children) return null;

  return (
    <div className="feed-meta" role="group" aria-label="Offer details">
      {pills.map(pill => {
        const Icon = PILL_ICON[pill.id];
        // A parsable deadline reads as a countdown ("in 3d"); the full date stays in the tooltip.
        const countdown = pill.id === 'deadline' ? (deadline?.countdown ?? null) : null;
        return (
          <span
            key={pill.id}
            className={`feed-meta-pill${countdown && deadline ? ` is-${deadline.state}` : ''}`}
            title={`${pill.label}: ${pill.value}`}
          >
            <Icon size={12} className="feed-meta-icon" />
            <span className="feed-meta-label">{pill.label}</span>
            <b className="mono feed-meta-val">{countdown ?? pill.value}</b>
          </span>
        );
      })}
      {children}
    </div>
  );
}

interface RadarPillProps {
  card: Card;
  onOpen: (card: Card) => void;
}

/** Cross-link to the curated card a drop was matched with through `radarId`. */
export function RadarPill({ card, onOpen }: RadarPillProps) {
  return (
    <button
      type="button"
      className="feed-meta-pill feed-radar-pill"
      title="Open the matched Curated Radar project"
      onClick={() => onOpen(card)}
    >
      <RadarIcon size={12} className="feed-meta-icon" />
      <span className="feed-meta-label">Radar</span>
      {card.g && <b className="mono feed-meta-val">Tier {card.g}</b>}
    </button>
  );
}
