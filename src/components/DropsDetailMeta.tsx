import type { FeedItem } from '../../shared/types';
import { buildFeedMeta, describeDeadline } from '../lib/feedDisplay';
import { formatRelativeTime } from '../lib/format';
import { resolveOgPreview } from '../lib/visualAssets';
import { ChainBadge } from './EntityVisual';
import { OgPreview } from './OgPreview';

interface Props {
  item: FeedItem;
  title: string;
  chains: readonly string[];
  taskTypes: readonly string[];
}

interface MetaCell {
  id: string;
  label: string;
  value: string;
  /** Extra tone for the deadline cell: soon, past, or upcoming. */
  state?: string;
}

const META_LABEL = { reward: 'Reward', tvl: 'TVL', funding: 'Funding', cost: 'Cost', deadline: 'Deadline' } as const;

/** The seven offer facts in a fixed order; a missing fact shows an em dash so the grid never jumps. */
function buildMetaCells(item: FeedItem, chains: readonly string[], taskTypes: readonly string[]): MetaCell[] {
  const byId = new Map(buildFeedMeta(item).map(pill => [pill.id, pill.value]));
  const deadline = describeDeadline(item.deadline);
  const text = (id: keyof typeof META_LABEL): string => byId.get(id) ?? '—';

  return [
    { id: 'reward', label: META_LABEL.reward, value: text('reward') },
    {
      id: 'deadline',
      label: META_LABEL.deadline,
      value: deadline.countdown ? `${text('deadline')} · ${deadline.countdown}` : text('deadline'),
      state: deadline.countdown ? deadline.state : undefined,
    },
    { id: 'cost', label: META_LABEL.cost, value: text('cost') },
    { id: 'tvl', label: META_LABEL.tvl, value: text('tvl') },
    { id: 'funding', label: META_LABEL.funding, value: text('funding') },
    { id: 'chains', label: 'Chains', value: chains.join(', ') || 'Not specified' },
    { id: 'taskTypes', label: 'Task types', value: taskTypes.join(', ') || '—' },
  ];
}

function MetaCellView({ cell, chains }: { cell: MetaCell; chains: readonly string[] }) {
  const isChains = cell.id === 'chains' && chains.length > 0;
  return (
    <div className={`drop-meta-cell${cell.state ? ` is-${cell.state}` : ''}`}>
      <dt>{cell.label}</dt>
      <dd className="mono">
        {isChains ? (
          <span className="dlg-spec-chains">
            {chains.map(chain => (
              <ChainBadge key={chain} chain={chain} size={13} />
            ))}
          </span>
        ) : (
          cell.value
        )}
      </dd>
    </div>
  );
}

/** Open Graph preview card plus the structured metadata grid. */
export function DropsDetailMeta({ item, title, chains, taskTypes }: Props) {
  const ogPreview = resolveOgPreview({
    ogImage: item.ogImage,
    ogTitle: item.ogTitle,
    ogDescription: item.ogDescription,
    fallbackTitle: title,
  });

  return (
    <>
      <OgPreview preview={ogPreview} variant="card" />

      <section className="dlg-tasks drop-meta" aria-label="Offer details">
        <div className="dlg-section-head">
          <h3>Offer details</h3>
          <span className="note">
            Reported by {item.sourceCount} {item.sourceCount === 1 ? 'source' : 'sources'} · first seen{' '}
            {formatRelativeTime(item.firstSeen)}
          </span>
        </div>
        <dl className="drop-meta-grid">
          {buildMetaCells(item, chains, taskTypes).map(cell => (
            <MetaCellView key={cell.id} cell={cell} chains={chains} />
          ))}
        </dl>
      </section>
    </>
  );
}
