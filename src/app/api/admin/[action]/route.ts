import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, HttpError } from '@/lib/auth';
import { db } from '@/lib/db';
import { settingsInput } from '@/lib/validation';
import { failure } from '@/lib/http';
import { fundingPricing, fundingQuote } from '@/lib/raid-funding';
export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  try {
    checkOrigin(request);
    const user = await requireUser(true);
    const { action } = await params;
    const b = await request.json();
    const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : '';
    if (!reason) throw new HttpError(400, 'A reason is required for the audit log.');
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(729103)`;
      if (action === 'settings')
        await tx.settings.upsert({
          where: { id: 'global' },
          create: settingsInput.parse(b),
          update: settingsInput.parse(b),
        });
      else if (action === 'finance') {
        if (typeof b.launchPaused !== 'boolean' || typeof b.payoutPaused !== 'boolean')
          throw new HttpError(400, 'Invalid finance switches.');
        await tx.settings.upsert({
          where: { id: 'global' },
          create: { launchPaused: b.launchPaused, payoutPaused: b.payoutPaused },
          update: { launchPaused: b.launchPaused, payoutPaused: b.payoutPaused },
        });
      } else if (action === 'launch-resume') {
        const launch = await tx.tokenLaunch.findUnique({ where: { id: b.id } });
        if (!launch || launch.status !== 'PAUSED')
          throw new HttpError(409, 'Launch is not paused.');
        await tx.tokenLaunch.update({ where: { id: b.id }, data: { status: 'LIVE', error: null } });
      } else if (action === 'funding-quote') {
        const raid = await tx.raid.findUnique({ where: { id: b.id } });
        const pricing = fundingPricing();
        if (
          !raid ||
          raid.studioVersion === 1 ||
          raid.mint ||
          raid.status !== 'DRAFT' ||
          raid.fundingSignature ||
          !raid.impressionTarget ||
          !pricing
        )
          throw new HttpError(409, 'Funding quote unavailable for this draft.');
        await tx.raid.update({
          where: { id: raid.id },
          data: {
            fundingLamports: fundingQuote(raid.impressionTarget, pricing.lamportsPerThousand),
            fundingRecipient: pricing.recipient,
          },
        });
      } else if (action === 'creator') {
        if (typeof b.approved !== 'boolean' || typeof b.suspended !== 'boolean')
          throw new HttpError(400, 'Invalid creator status.');
        const target = await tx.user.findUniqueOrThrow({ where: { id: b.id } });
        if (target.role === 'ADMIN' && b.suspended)
          throw new HttpError(400, 'Administrators cannot be suspended here.');
        const settings = await tx.settings.upsert({
          where: { id: 'global' },
          create: {},
          update: {},
        });
        if (
          b.approved &&
          !target.approved &&
          (await tx.user.count({ where: { approved: true, role: 'CREATOR' } })) >=
            settings.maxCreators
        )
          throw new HttpError(409, 'Pilot creator quota reached.');
        await tx.user.update({
          where: { id: b.id },
          data: { approved: b.approved, suspended: b.suspended },
        });
        if (b.suspended) await tx.session.deleteMany({ where: { userId: b.id } });
      } else if (action === 'raid' || action === 'post') {
        if (typeof b.hidden !== 'boolean') throw new HttpError(400, 'Invalid visibility.');
        if (action === 'raid')
          await tx.raid.update({ where: { id: b.id }, data: { hidden: b.hidden } });
        else {
          const current = await tx.post.findUniqueOrThrow({
            where: { id: b.id },
            include: { raid: true },
          });
          if (current.raid.trackingVersion === 2)
            throw new HttpError(409, 'Use the contribution review controls for this post.');
          const post = await tx.post.update({ where: { id: b.id }, data: { hidden: b.hidden } });
          // Historical comparisons are invalid after a moderation decision.
          await tx.snapshot.updateMany({
            where: { raidId: post.raidId },
            data: { complete: false },
          });
        }
      } else if (action === 'retry')
        await tx.job.update({
          where: { id: b.id },
          data: {
            attempts: 0,
            error: null,
            lockedAt: null,
            lease: null,
            doneAt: null,
            runAt: new Date(),
          },
        });
      else throw new HttpError(400, 'Unsupported admin action.');
      await tx.moderationEvent.create({
        data: { actorId: user.id, action, targetId: b.id || 'global', reason },
      });
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
