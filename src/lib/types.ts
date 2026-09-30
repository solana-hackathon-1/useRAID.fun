import type { Market } from './providers/market';
export interface RaidView {
  id: string;
  trackingVersion?: number;
  fundingAsset?: string;
  poolUnits?: string | null;
  imageUri?: string | null;
  tag: string;
  title: string;
  description: string;
  mint: string | null;
  symbol: string;
  name: string;
  status: string;
  startsAt: string;
  endsAt: string;
  createdAt: string;
  score: number;
  raiders: number;
  posts: number;
  interactions: number;
  momentum: number | null;
  delta: number | null;
  observedAt: string | null;
  freshness: 'fresh' | 'stale' | 'partial' | 'unavailable' | 'demo';
  coverage: string;
  market: Market | null;
  marketAt: string | null;
  marketError: string | null;
  activity: {
    id: string;
    authorId: string;
    text: string;
    createdAt: string;
    interactions: number;
  }[];
  history: { at: string; score: number }[];
}
