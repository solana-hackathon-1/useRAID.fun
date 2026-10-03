import { newTrackingRules } from '@/lib/config';
import { assertLaunchpadsAvailable } from '@/lib/release';
import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, HttpError } from '@/lib/auth';
import { db } from '@/lib/db';
import { failure } from '@/lib/http';
import { config } from '@/lib/config';
import { LOCKED_PHASES } from '@/lib/tracking-domain';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertLaunchpadsAvailable();
    checkOrigin(request);
    const user = await requireUser();
    const id = (await params).id;
    const raid = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(729103)`;
      const launch = await tx.tokenLaunch.findUnique({ where: { id } });
      if (!launch || launch.userId !== user.id || launch.status !== 'LIVE' || user.suspended)
        throw new HttpError(403, 'Token owner access required.');
      const existing = await tx.raid.findFirst({
        where: {
          tokenLaunchId: id,
          status: { in: ['ACTIVE', 'SCHEDULED'] },
          endsAt: { gt: new Date() },
        },
      });
      if (existing) throw new HttpError(409, 'Reward raid already active.');
      const unfinished = await tx.raid.findFirst({
        where: {
          tokenLaunchId: id,
          trackingVersion: 2,
          OR: [{ trackingPhase: { notIn: [...LOCKED_PHASES] } }, { finalFeeSweepAt: null }],
        },
      });
      if (unfinished)
        throw new HttpError(
          409,
          'Previous Raid must finish review and fee collection before renewal.',
        );
      const settings = await tx.settings.findUnique({ where: { id: 'global' } });
      if (
        !config.liveApproved ||
        Reflect.get(process.env, 'PAYOUT_ENABLED') !== 'true' ||
        !settings?.collectionEnabled ||
        settings.launchPaused ||
        settings.payoutPaused ||
        !settings.payoutWorkerAt ||
        +settings.payoutWorkerAt < Date.now() - 120000 ||
        settings.operatorAddress !== process.env.OPERATOR_PUBLIC_KEY
      )
        throw new HttpError(503, 'Reward raids unavailable.');
      const count = await tx.raid.count({
        where: {
          status: { in: ['ACTIVE', 'SCHEDULED'] },
          endsAt: { gt: new Date() },
          hidden: false,
        },
      });
      if (count >= settings.maxActiveRaids) throw new HttpError(409, 'Campaign capacity full.');
      const now = new Date();
      const raid = await tx.raid.create({
        data: {
          ...newTrackingRules(),
          tag: `raid_${randomBytes(5).toString('hex')}`,
          title: `${launch.name} reward raid`,
          description:
            launch.description.length >= 20
              ? launch.description
              : `${launch.name} community reward campaign`,
          mint: launch.mint,
          creatorId: user.id,
          tokenLaunchId: id,
          status: 'ACTIVE',
          startsAt: now,
          endsAt: new Date(+now + 24 * 3600000),
        },
      });
      await tx.tokenLaunch.update({ where: { id }, data: { raidId: raid.id } });
      return raid;
    });
    return NextResponse.json({ raidId: raid.id });
  } catch (error) {
    return failure(error);
  }
}
