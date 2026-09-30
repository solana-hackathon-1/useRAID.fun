import { enrollRaid } from '@/lib/tracking';
import { launchpadsAvailable } from '@/lib/release';
import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, HttpError } from '@/lib/auth';
import { db } from '@/lib/db';
import { failure } from '@/lib/http';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!launchpadsAvailable) throw new HttpError(503, 'Launchpad rewards are coming soon.');
    checkOrigin(request);
    const user = await requireUser();
    const launch = await db.tokenLaunch.findUnique({
      where: { id: (await params).id },
      include: { raid: true, user: { select: { suspended: true } } },
    });
    if (!launch || launch.status !== 'LIVE')
      throw new HttpError(404, 'Active token launch not found.');
    if (
      !launch.raid ||
      launch.raid.status !== 'ACTIVE' ||
      launch.raid.endsAt <= new Date() ||
      launch.raid.hidden ||
      launch.user.suspended
    )
      throw new HttpError(409, 'No active reward raid.');
    if (launch.raid.trackingVersion === 2) {
      const member = await enrollRaid(launch.raid.id, user.id);
      return NextResponse.json({ enrolled: true, walletAddress: member.walletAddress });
    }
    const [wallet, account] = await Promise.all([
      db.walletIdentity.findUnique({ where: { userId: user.id } }),
      db.xAccount.findUnique({ where: { userId: user.id } }),
    ]);
    if (!wallet || !account)
      throw new HttpError(403, 'Verify both wallet and X account before enrolling.');
    const result = await db.rewardEnrollment.upsert({
      where: { launchId_xId: { launchId: launch.id, xId: account.xUserId } },
      create: {
        launchId: launch.id,
        userId: user.id,
        xId: account.xUserId,
        walletAddress: wallet.address,
      },
      update: {},
    });
    if (result.userId !== user.id || result.walletAddress !== wallet.address)
      throw new HttpError(409, 'Reward identity already enrolled with another wallet.');
    return NextResponse.json({ enrolled: true, walletAddress: result.walletAddress });
  } catch (error) {
    return failure(error);
  }
}
