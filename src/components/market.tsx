import type { Market } from '@/lib/providers/market';
import { money } from './ui';
import { formatUtcDateTime } from '@/lib/format';
export function MarketPanel({
  market,
  at,
  error,
  demo,
}: {
  market: Market | null;
  at: string | null;
  error: string | null;
  demo: boolean;
}) {
  return (
    <div className="panel">
      <h2>Market snapshot</h2>
      <div className="market-list">
        <div>
          <span>Price</span>
          <strong>
            {market?.price != null
              ? new Intl.NumberFormat('en', {
                  style: 'currency',
                  currency: 'USD',
                  maximumSignificantDigits: 4,
                }).format(market.price)
              : 'Unavailable'}
          </strong>
        </div>
        <div>
          <span>Market cap</span>
          <strong>{money(market?.marketCap)}</strong>
        </div>
        <div>
          <span>FDV</span>
          <strong>{money(market?.fdv)}</strong>
        </div>
        <div>
          <span>24h volume</span>
          <strong>{money(market?.volume)}</strong>
        </div>
        <div>
          <span>Liquidity</span>
          <strong>{money(market?.liquidity)}</strong>
        </div>
      </div>
      <div className="market-source">
        {demo ? (
          <p>Illustrative market data. No real token pair is connected.</p>
        ) : (
          <>
            {error && <p>{error}</p>}
            {at && (
              <p>
                {Date.now() - +new Date(at) > 180000 ? 'Stale · ' : ''}Observed{' '}
                {formatUtcDateTime(at)}
              </p>
            )}
            {market && (
              <>
                <a href={market.url} target="_blank" rel="noopener noreferrer">
                  DEX Screener · {market.dex}
                </a>
                <p>Pair: {market.pairAddress}</p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
