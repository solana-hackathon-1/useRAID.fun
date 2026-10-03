import { newTrackingRules } from './config';
import { randomBytes } from 'node:crypto';
import type { User } from '@prisma/client';
import { db } from './db';
import { HttpError } from './auth-primitives';
import { raidInput } from './validation';
import { lockTracking } from './tracking';
import { fundingPricing, fundingQuote } from './raid-funding';
import { config } from './config';
export async function createRaid(user: User, input: unknown) {
  if (!user.approved || user.suspended) throw new HttpError(403, 'Creator approval is required.');
  if (!(await db.xAccount.findUnique({ where: { userId: user.id } })))
    throw new HttpError(403, 'Connect your verified X account before creating a Raid.');
  const data = raidInput.parse(input);
  const pricing = fundingPricing();
  const startsAt = data.startsAt ? new Date(data.startsAt) : new Date();
  if (+startsAt < Date.now() - 60000 || +startsAt > Date.now() + 30 * 86400000)
    throw new HttpError(400, 'Schedule within the next 30 days.');
  return db.$transaction(async (tx) => {
    const token =
      data.projectType === 'TOKEN'
        ? await tx.token.upsert({
            where: { mint: data.mint! },
            create: { mint: data.mint!, symbol: data.symbol, name: data.name },
            update: {},
          })
        : null;
    return tx.raid.create({
      data: {
        ...newTrackingRules(),
        tag: `raid_${randomBytes(5).toString('hex')}`,
        title: data.title,
        description: data.description,
        mint: token?.mint || null,
        projectName: data.name,
        projectSymbol: data.symbol,
        fundingStatus: token ? 'NOT_REQUIRED' : 'PENDING',
        fundingRequest: token ? '' : data.fundingRequest,
        impressionTarget: token ? null : data.impressionTarget,
        fundingLamports:
          !token && pricing
            ? fundingQuote(data.impressionTarget!, pricing.lamportsPerThousand)
            : null,
        fundingRecipient: !token && pricing ? pricing.recipient : null,
        creatorId: user.id,
        startsAt,
        endsAt: new Date(+startsAt + data.duration * 3600000),
      },
    });
  });
}
export async function changeRaid(user: User, id: string, action: string) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(729103)`;
    await lockTracking(tx, id);
    const raid = await tx.raid.findUnique({ where: { id } });
    if (!raid) throw new HttpError(404, 'Raid not found.');
    if (raid.creatorId !== user.id)
      throw new HttpError(403, 'This campaign belongs to another creator.');
    if ((raid.studioVersion !== 1 && !user.approved) || user.suspended || raid.hidden)
      throw new HttpError(403, 'Campaign access is restricted.');
    if (action === 'launch') {
      if (raid.studioVersion === 1) throw new HttpError(409, 'Use Fund & Launch for this Raid.');
      if (!raid.mint && raid.fundingStatus !== 'VERIFIED')
        throw new HttpError(
          409,
          'Fund this non-token Raid before launch. Funding terms are pending confirmation.',
        );
      if (raid.status !== 'DRAFT') throw new HttpError(409, 'Only drafts can be launched.');
      const settings = await tx.settings.upsert({
        where: { id: 'global' },
        create: {},
        update: {},
      });
      if (
        raid.trackingVersion === 2 &&
        (!settings.collectionEnabled || !config.liveApproved || !process.env.X_BEARER_TOKEN)
      )
        throw new HttpError(
          503,
          'Live X collection must be verified and enabled before this Raid can launch.',
        );
      const now = new Date();
      const duration = +raid.endsAt - +raid.startsAt;
      const start = raid.startsAt > now ? raid.startsAt : now,
        end = new Date(+start + duration);
      // Reserve a pilot slot for all scheduled and active campaigns, conservatively.
      const count = await tx.raid.count({
        where: { status: { in: ['ACTIVE', 'SCHEDULED'] }, hidden: false, endsAt: { gt: now } },
      });
      if (count >= settings.maxActiveRaids)
        throw new HttpError(
          409,
          'All pilot campaign slots are reserved. Try after another campaign ends.',
        );
      return tx.raid.update({
        where: { id },
        data: { startsAt: start, endsAt: end, status: start > now ? 'SCHEDULED' : 'ACTIVE' },
      });
    }
    if (action === 'end' && ['ACTIVE', 'SCHEDULED'].includes(raid.status))
      return tx.raid.update({
        where: { id },
        data: {
          status: 'ENDED',
          endsAt: new Date(),
          finalRefreshed: raid.status === 'SCHEDULED',
          ...(raid.trackingVersion === 2
            ? {
                trackingPhase: 'FINALIZING',
                sinceId: null,
                nextToken: null,
                searchEndAt: null,
                pendingNewestId: null,
                finalRefreshed: false,
              }
            : {}),
        },
      });
    throw new HttpError(400, 'Unsupported campaign action.');
  });
}
