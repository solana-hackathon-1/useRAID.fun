export interface Market {
  price: number | null;
  marketCap: number | null;
  fdv: number | null;
  volume: number | null;
  liquidity: number | null;
  pairAddress: string;
  url: string;
  dex: string;
  change: number | null;
  symbol: string;
  name: string;
}
type Pair = {
  chainId: string;
  baseToken: { address: string; symbol: string; name: string };
  pairAddress: string;
  url: string;
  dexId: string;
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  priceChange?: { h24?: number };
};
export function selectMarket(pairs: Pair[], mint: string): Market | null {
  const pair = pairs
    .filter((p) => p.chainId === 'solana' && p.baseToken.address === mint)
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  if (!pair) return null;
  return {
    price: pair.priceUsd ? Number(pair.priceUsd) : null,
    marketCap: pair.marketCap ?? null,
    fdv: pair.fdv ?? null,
    volume: pair.volume?.h24 ?? null,
    liquidity: pair.liquidity?.usd ?? null,
    pairAddress: pair.pairAddress,
    url: `https://dexscreener.com/solana/${encodeURIComponent(pair.pairAddress)}`,
    dex: pair.dexId,
    change: pair.priceChange?.h24 ?? null,
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
  };
}
export async function fetchMarket(mint: string) {
  const res = await fetch(
    `https://api.dexscreener.com/token-pairs/v1/solana/${encodeURIComponent(mint)}`,
    { signal: AbortSignal.timeout(15000), cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`Market provider returned ${res.status}.`);
  return selectMarket(await res.json(), mint);
}
