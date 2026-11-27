import { useMemo, type RefObject } from 'react';
import { CATEGORIES, FIT, TYPES } from '../../shared/constants';
import type { Card, Tge } from '../../shared/types';
import { PAGE_STEP, type AirdropFiltersState } from '../hooks/useAirdropFilters';
import { cardStorageKey, isCardSaved } from '../hooks/useWatchlist';
import { formatRelativeTime, isStaleTimestamp } from '../lib/format';
import type { ProjectLogoIndex } from '../lib/visualAssets';
import { summarizeCardMix } from '../lib/viz';
import { CompactProjectsTable } from './CompactProjectRow';
import { FilterDock } from './FilterDock';
import { KpiStrip } from './KpiStrip';
import { ProjectCard } from './ProjectCard';
import { TgeCarousel } from './TgeCarousel';
import { useViewMode, ViewToggle } from './ViewToggle';

const STALE_AIRDROPS_MS = 6 * 3_600_000;
const AIRDROPS_VIEW_KEY = 'radar.airdrops.view';
const EMPTY_CARDS: readonly Card[] = [];

interface Props {
  filters: AirdropFiltersState;
  cardCount: number;
  /** Every curated card, for the KPI tier/source distribution (filters do not apply). */
  cards?: readonly Card[];
  tgeItems: Tge[];
  fetchedAt: number | null;
  isLive: boolean;
  failed: boolean;
  saved: Set<string>;
  doneTasks: Set<string>;
  logoIndex?: ProjectLogoIndex;
  searchRef: RefObject<HTMLInputElement | null>;
  onToggleSaved: (key: string, legacyKey?: string) => void;
  onSelectDetail: (card: Card) => void;
  onCopyBrief: (card: Card) => void;
}

export function AirdropPanel({
  filters,
  cardCount,
  cards = EMPTY_CARDS,
  tgeItems,
  fetchedAt,
  isLive,
  failed,
  saved,
  doneTasks,
  logoIndex,
  searchRef,
  onToggleSaved,
  onSelectDetail,
  onCopyBrief,
}: Props) {
  const isStale = isStaleTimestamp(fetchedAt, STALE_AIRDROPS_MS);
  const [view, selectView] = useViewMode(AIRDROPS_VIEW_KEY);
  const mix = useMemo(() => summarizeCardMix(cards), [cards]);
  const emptyMsg =
    filters.status === 'saved' && filters.counts.savedMatch === 0
      ? 'No saved projects yet. Click the star icon on any project card to build your watchlist.'
      : 'No projects match your current filters.';

  return (
    <section role="tabpanel" id="panel-airdrops" aria-labelledby="tab-airdrops">
      {isStale && fetchedAt !== null && (
        <p className="stale-banner" role="status">
          Airdrop feed may be stale — last updated {formatRelativeTime(fetchedAt)} (upstream source delayed).
        </p>
      )}
      <KpiStrip
        mix={mix}
        counts={filters.counts}
        tgeCount={tgeItems.length}
        isLive={isLive}
        failed={failed}
        status={filters.status}
        grade={filters.grade}
        onSelectAll={() => {
          filters.setStatus('all');
          filters.setGrade('All');
        }}
        onTogglePre={() => filters.setStatus(s => (s === 'pre' ? 'all' : 'pre'))}
        onToggleSTier={() => filters.setGrade(g => (g === 'S' ? 'All' : 'S'))}
        onJumpTge={() => document.getElementById('tge-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        onToggleSaved={() => filters.setStatus(s => (s === 'saved' ? 'all' : 'saved'))}
      />

      <div className="section-head">
        <div>
          <h2 className="section">Airdrop Radar · Potential Ranking</h2>
          <p className="note">
            Ranked by funding, X score, and recency. Click any project to inspect all tasks and track progress locally.
          </p>
        </div>
      </div>

      <FilterDock filters={filters} types={TYPES} fit={FIT} searchRef={searchRef} />

      <div className="results-bar">
        <p className="note" role="status">
          Showing <strong className="mono">{filters.renderedCards.length}</strong>
          {filters.renderedCards.length < filters.visible.length ? ` of ${filters.visible.length} matching` : ''} (
          {cardCount} {failed ? 'previously loaded' : isLive ? 'live' : 'snapshot'} total)
        </p>
        {filters.hasAnyFilter && (
          <button type="button" className="link-btn" onClick={filters.resetFilters}>
            Reset filters
          </button>
        )}
        <ViewToggle view={view} onChange={selectView} label="airdrops" />
      </div>

      {filters.visible.length > 0 ? (
        <>
          <ProjectList
            view={view}
            cards={filters.renderedCards}
            saved={saved}
            doneTasks={doneTasks}
            logoIndex={logoIndex}
            onToggleSaved={onToggleSaved}
            onSelectDetail={onSelectDetail}
            onCopyBrief={onCopyBrief}
          />
          {filters.remaining > 0 && (
            <div className="loadmore-bar">
              <button type="button" className="btn btn-subtle" onClick={filters.showMore}>
                Show {Math.min(PAGE_STEP, filters.remaining)} more ({filters.remaining} left)
              </button>
              <button type="button" className="chip" onClick={filters.showAll}>
                Show all {filters.visible.length}
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="empty" role="status">
          <p>{emptyMsg}</p>
          {filters.hasAnyFilter && (
            <button type="button" className="btn empty-action" onClick={filters.resetFilters}>
              Reset filters
            </button>
          )}
        </div>
      )}

      <div className="tge-block">
        <div className="section-head">
          <div>
            <h2 id="tge-heading" className="section">
              Upcoming TGE / Claimable
            </h2>
            <p className="note">
              {tgeItems.length} TGE and verification events tracked ({failed ? 'last available data' : isLive ? 'live feed' : 'snapshot'}).
            </p>
          </div>
        </div>
        <TgeCarousel items={tgeItems} logoIndex={logoIndex} />
      </div>

      <div className="categories-bar" role="group" aria-label="Airdrop categories">
        <span className="note">Ecosystem programs:</span>
        <div className="chipline">
          {CATEGORIES.map(c => (
            <span key={c} className="countchip">
              {c}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

type ProjectView = 'card' | 'compact';

interface ProjectListProps {
  view: ProjectView;
  cards: readonly Card[];
  saved: Set<string>;
  doneTasks: Set<string>;
  logoIndex?: ProjectLogoIndex;
  onToggleSaved: (key: string, legacyKey?: string) => void;
  onSelectDetail: (card: Card) => void;
  onCopyBrief: (card: Card) => void;
}

/** Curated projects as cards or as a compact table, per the view toggle. */
function ProjectList({ view, cards, saved, doneTasks, logoIndex, onToggleSaved, onSelectDetail, onCopyBrief }: ProjectListProps) {
  if (view === 'compact') {
    return (
      <CompactProjectsTable
        cards={cards}
        saved={saved}
        doneTasks={doneTasks}
        logoIndex={logoIndex}
        onToggleSaved={onToggleSaved}
        onDetails={onSelectDetail}
        onCopyBrief={onCopyBrief}
      />
    );
  }

  return (
    <div className="grid">
      {cards.map(c => (
        <ProjectCard
          key={cardStorageKey(c)}
          card={c}
          fit={FIT}
          saved={isCardSaved(saved, c)}
          doneTasks={doneTasks}
          logoIndex={logoIndex}
          onToggleSaved={onToggleSaved}
          onDetails={onSelectDetail}
          onCopyBrief={onCopyBrief}
        />
      ))}
    </div>
  );
}
