import type { RaidView } from './types';

export const LIVE_WINDOW_MS = 3600000;
// "Live" means a qualifying post landed recently; activity arrives newest first.
const lastPost = (r: RaidView) => Date.parse(r.activity[0]?.createdAt ?? '') || 0;

export function discoveryRows(
  raids: RaidView[],
  tab: string,
  search: string,
  onlyFresh: boolean,
  now: number,
) {
  return raids
    .filter((r) => r.status === 'ACTIVE')
    .filter((r) =>
      `${r.symbol} ${r.name} ${r.title} ${r.mint}`.toLowerCase().includes(search.toLowerCase()),
    )
    .filter((r) => !onlyFresh || r.freshness === 'fresh' || r.freshness === 'demo')
    .filter((r) => tab !== 'Rising' || (r.raiders >= 5 && r.delta !== null && r.delta > 0))
    .filter((r) => tab !== 'Live' || (lastPost(r) > 0 && now - lastPost(r) < LIVE_WINDOW_MS))
    .sort(
      (a, b) =>
        Number(!!b.mint) - Number(!!a.mint) ||
        (tab === 'New raids'
          ? +new Date(b.createdAt) - +new Date(a.createdAt)
          : tab === 'Rising'
            ? (b.delta || 0) - (a.delta || 0)
            : tab === 'Live'
              ? lastPost(b) - lastPost(a) || b.score - a.score
              : b.score - a.score),
    );
}
