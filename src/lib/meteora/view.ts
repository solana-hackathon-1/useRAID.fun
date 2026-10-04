import { db } from '../db';
import { meteoraNetwork, meteoraConnection } from './config';
import { campaignBalances } from './campaigns';
import { publicMeteoraLaunch } from './launch';
import { refreshLaunchState, type LaunchChainSnapshot } from './state';
import { observedImpressions } from '../raid-progress';
export const imageUrl = (uri: string) =>
  uri.startsWith('ipfs://') ? `https://gateway.pinata.cloud/ipfs/${uri.slice(7)}` : uri;
export async function meteoraTokenView(mint: string, userId?: string, refresh = false) {
  let launch = await db.tokenLaunch.findUnique({ where: { mint }, include: { user: true } });
  if (
    !launch ||
    launch.provider !== 'METEORA' ||
    launch.network !== meteoraNetwork() ||
    !['LIVE', 'PAUSED'].includes(launch.status) ||
    launch.user.suspended
  )
    return null;
  let snapshot = launch.chainSnapshot as unknown as LaunchChainSnapshot | null;
  let error = launch.error;
  if (
    refresh &&
    launch.status === 'LIVE' &&
    (!launch.chainObservedAt || Date.now() - +launch.chainObservedAt > 15000)
  ) {
    try {
      snapshot = await refreshLaunchState(launch, meteoraConnection());
      launch = await db.tokenLaunch.findUniqueOrThrow({ where: { mint }, include: { user: true } });
    } catch {
      error = 'Current pool data unavailable. Last verified data shown.';
    }
  }
  const raids = await db.raid.findMany({
    where: {
      tokenLaunchId: launch.id,
      hidden: false,
      status: { in: ['ACTIVE', 'ENDED', 'DRAFT'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, title: true, status: true },
  });
  const member = userId ? await db.walletIdentity.findUnique({ where: { userId } }) : null;
  const publicRaidIds = raids.filter((r) => r.status !== 'DRAFT').map((r) => r.id);
  const posts = await db.post.findMany({
    where: {
      raidId: { in: publicRaidIds },
      qualification: 'QUALIFIED',
      availability: 'AVAILABLE',
      reviewStatus: { not: 'FLAGGED' },
      hidden: false,
      deleted: false,
    },
    select: {
      authorId: true,
      views: true,
      qualification: true,
      availability: true,
      reviewStatus: true,
      hidden: true,
      deleted: true,
    },
  });
  const attention = {
    qualifiedPosts: posts.length,
    raiders: new Set(posts.map((p) => p.authorId)).size,
    impressions: observedImpressions(posts),
  };
  const ownPayments = userId
    ? await db.launchCampaignPayout.findMany({
        where: {
          launchId: launch.id,
          xId: {
            in: (
              await db.raidEnrollment.findMany({
                where: { userId, raidId: { in: raids.map((r) => r.id) } },
                select: { xId: true },
              })
            ).map((m) => m.xId),
          },
        },
      })
    : [];
  return {
    ...publicMeteoraLaunch(launch),
    image: imageUrl(launch.imageUri),
    description: launch.description,
    snapshot,
    attention,
    observedAt: launch.chainObservedAt?.toISOString() || null,
    error,
    balances: await campaignBalances(launch.id, launch.mint),
    isCreator: launch.userId === userId,
    walletAddress: member?.address || null,
    raids: raids.filter((r) => r.status !== 'DRAFT' || launch.userId === userId),
    ownPayments: ownPayments.map((p) => ({
      id: p.id,
      asset: p.asset,
      units: p.units.toString(),
      status: p.status,
      signature: p.signature,
      network: p.network,
    })),
  };
}
export type MeteoraTokenView = NonNullable<Awaited<ReturnType<typeof meteoraTokenView>>>;
export async function launchDiscovery() {
  const launches = await db.tokenLaunch.findMany({
    where: {
      provider: 'METEORA',
      network: meteoraNetwork(),
      status: 'LIVE',
      user: { suspended: false },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return launches.map((l) => ({
    mint: l.mint,
    name: l.name,
    symbol: l.symbol,
    image: imageUrl(l.imageUri),
    network: l.network,
    phase: l.migrationStatus,
    snapshot: l.chainSnapshot as unknown as LaunchChainSnapshot | null,
    createdAt: l.createdAt.toISOString(),
  }));
}
