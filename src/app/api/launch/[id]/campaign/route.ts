import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, rateLimit } from '@/lib/auth';
import { ownedLaunch } from '@/lib/meteora/launch';
import { campaignBalances, saveLaunchCampaign } from '@/lib/meteora/campaigns';
import { db } from '@/lib/db';
import { failure, readJson } from '@/lib/http';
import { z } from 'zod';
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(),
      launch = await ownedLaunch((await params).id, user.id);
    const raids = await db.raid.findMany({
      where: { tokenLaunchId: launch.id, fundingAsset: 'LAUNCH' },
      include: { briefPosts: true, launchBudgets: true },
      orderBy: { createdAt: 'desc' },
    });
    const wallet = await db.walletIdentity.findUnique({ where: { userId: user.id } });
    return NextResponse.json(
      {
        launchId: launch.id,
        name: launch.name,
        symbol: launch.symbol,
        mint: launch.mint,
        network: launch.network,
        balances: await campaignBalances(launch.id, launch.mint),
        xConnected: !!(await db.xAccount.findUnique({ where: { userId: user.id } })),
        walletAddress: wallet?.address,
        raids: raids.map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          status: r.status,
          impressionTarget: r.impressionTarget,
          duration: (+r.endsAt - +r.startsAt) / 3600000,
          targetPosts: r.briefPosts.map((p) => `https://x.com/i/web/status/${p.postId}`),
          budgets: r.launchBudgets.map((b) => ({
            asset: b.asset,
            reserved: b.reservedUnits.toString(),
            earned: b.earnedUnits.toString(),
            paid: b.paidUnits.toString(),
          })),
        })),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    await rateLimit(`launch-campaign:${user.id}`, 20, 60);
    const body = await readJson(request, z.object({ action: z.string().optional() }).loose());
    return NextResponse.json(
      await saveLaunchCampaign((await params).id, user.id, body, body.action === 'start'),
    );
  } catch (e) {
    return failure(e);
  }
}
