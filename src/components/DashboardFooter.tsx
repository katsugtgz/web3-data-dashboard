import type { SourceHealth } from '../../shared/types';
import { DatabaseIcon } from './Icons';
import { SourcesHealthPopover } from './SourcesHealthPopover';

interface Props {
  preCount: number;
  dropsCount: number;
  sources: SourceHealth[];
  sourcesLoading: boolean;
  sourcesIsLiveApi: boolean;
  sourcesFailed: boolean;
}

/** Data-attribution footer with the sources-health popover. */
export function DashboardFooter({
  preCount,
  dropsCount,
  sources,
  sourcesLoading,
  sourcesIsLiveApi,
  sourcesFailed,
}: Props) {
  return (
    <footer className="app-footer">
      <div className="footer-inner footer-row">
        <p className="footer-copy">
          <DatabaseIcon size={14} className="footer-brand-icon" />{' '}
          Web3 Radar · <span className="mono">{preCount}</span> curated pre-token projects &amp;{' '}
          <span className="mono">{dropsCount}</span> live drops · Keyless data from{' '}
          <a href="https://cryptorank.io" target="_blank" rel="noopener noreferrer">
            CryptoRank
            <span className="sr"> (opens in a new tab)</span>
          </a>
          ,{' '}
          <a href="https://www.coingecko.com" target="_blank" rel="noopener noreferrer">
            CoinGecko
            <span className="sr"> (opens in a new tab)</span>
          </a>
          ,{' '}
          <a href="https://defillama.com" target="_blank" rel="noopener noreferrer">
            DefiLlama
            <span className="sr"> (opens in a new tab)</span>
          </a>
          ,{' '}
          <a href="https://polymarket.com" target="_blank" rel="noopener noreferrer">
            Polymarket
            <span className="sr"> (opens in a new tab)</span>
          </a>
          , and public Telegram channels. Built on Cloudflare Workers &amp; GitHub Pages. Original dashboard by{' '}
          <a href="https://x.com/ASSO7878/" target="_blank" rel="noopener noreferrer">
            @ASSO7878<span className="sr"> (opens in a new tab)</span>
          </a>
          . Not financial advice.
        </p>
        <SourcesHealthPopover
          sources={sources}
          loading={sourcesLoading}
          isLiveApi={sourcesIsLiveApi}
          failed={sourcesFailed}
        />
      </div>
    </footer>
  );
}
