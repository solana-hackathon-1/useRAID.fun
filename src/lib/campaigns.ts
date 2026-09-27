import { randomBytes } from 'node:crypto';
import type { User } from '@prisma/client';
import { db } from './db';
import { HttpError } from './auth';
import { raidInput } from './validation';
export async function createRaid(user: User, input: unknown) {
  if (!user.approved || user.suspended) throw new HttpError(403, 'Creator approval is required.');
  const data = raidInput.parse(input);
  const startsAt = data.startsAt ? new Date(data.startsAt) : new Date();
  if (+startsAt < Date.now() - 60000 || +startsAt > Date.now() + 30 * 86400000)
    throw new HttpError(400, 'Schedule within the next 30 days.');
  return db.$transaction(async (tx) => {
    const token = await tx.token.upsert({
      where: { mint: data.mint },
      create: { mint: data.mint, symbol: data.symbol, name: data.name },
      update: {},
    });
    return tx.raid.create({
      data: {
        tag: `raid_${randomBytes(5).toString('hex')}`,
        title: data.title,
        description: data.description,
        mint: token.mint,
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
    const raid = await tx.raid.findUnique({ where: { id } });
    if (!raid) throw new HttpError(404, 'Raid not found.');
    if (raid.creatorId !== user.id)
      throw new HttpError(403, 'This campaign belongs to another creator.');
    if (!user.approved || user.suspended || raid.hidden)
      throw new HttpError(403, 'Campaign access is restricted.');
    if (action === 'launch') {
      if (raid.status !== 'DRAFT') throw new HttpError(409, 'Only drafts can be launched.');
      const settings = await tx.settings.upsert({
        where: { id: 'global' },
        create: {},
        update: {},
      });
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
        data: { status: 'ENDED', endsAt: new Date(), finalRefreshed: raid.status === 'SCHEDULED' },
      });
    throw new HttpError(400, 'Unsupported campaign action.');
  });
}
