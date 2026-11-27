import type { FeedItem } from '../../shared/types';
import type { DisplayRiskNote } from '../lib/feedDisplay';

export function StatusDot({ tone }: { tone: 'ok' | 'degraded' | 'down' }) {
  return <span className={`status-dot status-dot-${tone}`} aria-hidden="true" />;
}

interface Props {
  level: FeedItem['risk']['level'];
  notes: DisplayRiskNote[];
}

/** Warn/Risk security badge; renders nothing for `ok` items so it never competes with the domain note. */
export function RiskBadge({ level, notes }: Props) {
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
