import { randomBytes } from 'node:crypto';
import { Prisma, type User } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { authorCapBps, config, trackingEnabled, trackingSettlementEnabled } from './config';
import { HttpError } from './auth-primitives';
import { validMint } from './domain';
import { balance, lockBalance, quoteUsdc, usdcSettings, studioSandbox } from './usdc';
import { chargeStudioLookups, targetIds, targetPreviews } from './studio-targets';
import { lockTracking } from './tracking';
import { assertApprovedCreator } from './campaigns';
import { verifiedToken } from './token-identity';

export const studioInput = z
  .object({
    studioVersion: z.literal(1),
    projectType: z.enum(['PROJECT', 'TOKEN']),
    title: z.string().trim().min(3).max(120),
    description: z.string().trim().max(2000).default(''),
    mint: z.string().default(''),
    name: z.string().trim().max(80).default(''),
    symbol: z.string().trim().max(15).default(''),
    imageUri: z
      .string()
      .max(400000)
      .default('')
      .refine(
        (v) =>
          !v ||
          /^https:\/\//.test(v) ||
          /^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/.test(v),
        'Choose a PNG, JPEG, or GIF image.',
      ),
    targetPosts: z.array(z.string().max(300)).max(100).default([]),
    impressionTarget: z.coerce.number().int().min(1000).max(1_000_000_000),
    duration: z.coerce
      .number()
      .refine((v) => [6, 12, 24, 72, 168].includes(v), 'Choose an available duration.'),
  })
  .superRefine((v, ctx) => {
    if (v.projectType === 'TOKEN' && (!validMint(v.mint) || !v.name || !v.symbol))
      ctx.addIssue({
        code: 'custom',
        message: 'Identify token with contract address, name, and ticker.',
      });
  });
export async function saveStudioRaid(user: User, input: unknown, id?: string) {
  if (user.suspended || !(await db.xAccount.findUnique({ where: { userId: user.id } })))
    throw new HttpError(403, 'Connect X to create a Raid.');
  assertApprovedCreator(user);
  const data = studioInput.parse(input),
    ids = targetIds(data.targetPosts);
  if (id) {
    const existing = await db.raid.findUnique({ where: { id } });
    if (
      !existing ||
      existing.creatorId !== user.id ||
      existing.studioVersion !== 1 ||
      existing.status !== 'DRAFT' ||
      existing.hidden
    )
      throw new HttpError(404, 'Draft not found.');
  }
  // Previews validated within a day are reused so re-saving a draft never re-reads X.
  const known = new Set(
    id
      ? (
          await db.raidBriefPost.findMany({
            where: {
              raidId: id,
              postId: { in: ids },
              validatedAt: { gte: new Date(Date.now() - 86400000) },
              preview: { not: Prisma.DbNull },
            },
            select: { postId: true },
          })
        ).map((p) => p.postId)
      : [],
  );
  const missing = ids.filter((postId) => !known.has(postId));
  let previews: Awaited<ReturnType<typeof targetPreviews>> = [];
  if (missing.length)
    try {
      await chargeStudioLookups(user.id, missing.length);
      previews = await targetPreviews(missing, id);
    } catch {
      /* Drafts retain links while the provider or the daily lookup quota is unavailable. */
    }
  return db.$transaction(
    async (tx) => {
      if (id) {
        await lockTracking(tx, id);
        const existing = await tx.raid.findUnique({ where: { id } });
        if (!existing || existing.creatorId !== user.id)
          throw new HttpError(404, 'Draft not found.');
        if (existing.studioVersion !== 1 || existing.status !== 'DRAFT' || existing.hidden)
          throw new HttpError(409, 'Only your new Studio drafts can be edited.');
      }
      const settings = usdcSettings(),
        now = new Date();
      const token =
        data.projectType === 'TOKEN'
          ? await tx.token.upsert({
              where: { mint: data.mint },
              create: {
                mint: data.mint,
                name: data.name,
                symbol: data.symbol,
              },
              update: {},
            })
          : null;
      const verified = verifiedToken(token);
      const fields = {
        studioVersion: 1,
        fundingAsset: 'USDC',
        fundingNetwork: settings.network,
        trackingVersion: 2,
        ruleVersion: 4,
        scoringVersion: 2,
        officialHandle: config.handle,
        title: data.title,
        description: data.description,
        mint: token?.mint || null,
        projectName: token ? verified?.name || data.name : data.title,
        projectSymbol: token ? verified?.symbol || data.symbol : '',
        imageUri: data.imageUri || verified?.imageUri || null,
        impressionTarget: data.impressionTarget,
        quoteRate: settings.rateUnits,
        poolUnits: settings.rateUnits ? quoteUsdc(data.impressionTarget, settings.rateUnits) : null,
        fundingStatus: 'PENDING',
        startsAt: now,
        endsAt: new Date(+now + data.duration * 3600000),
      };
      const raid = id
        ? await tx.raid.update({ where: { id }, data: fields })
        : await tx.raid.create({
            data: { ...fields, creatorId: user.id, tag: `raid_${randomBytes(5).toString('hex')}` },
          });
      await tx.raidBriefPost.deleteMany({ where: { raidId: raid.id, postId: { notIn: ids } } });
      const kept = new Set(
        (
          await tx.raidBriefPost.findMany({ where: { raidId: raid.id }, select: { postId: true } })
        ).map((p) => p.postId),
      );
      const previewOf = (postId: string) => previews.find((p) => p.id === postId);
      await tx.raidBriefPost.createMany({
        data: ids
          .filter((postId) => !kept.has(postId))
          .map((postId) => {
            const preview = previewOf(postId);
            return { raidId: raid.id, postId, ...(preview ? { preview, validatedAt: now } : {}) };
          }),
        skipDuplicates: true,
      });
      for (const postId of ids.filter((postId) => kept.has(postId) && previewOf(postId)))
        await tx.raidBriefPost.update({
          where: { raidId_postId: { raidId: raid.id, postId } },
          data: { preview: previewOf(postId)!, validatedAt: now },
        });
      const unvalidated = ids.filter(
        (postId) => kept.has(postId) && !known.has(postId) && !previewOf(postId),
      );
      if (unvalidated.length)
        await tx.raidBriefPost.updateMany({
          where: { raidId: raid.id, postId: { in: unvalidated } },
          data: { validatedAt: null, preview: Prisma.JsonNull },
        });
      return { id: raid.id };
    },
    { timeout: 15000 },
  );
}
export async function launchStudioRaid(
  user: User,
  id: string,
  expectedUnits: string,
  terms: boolean,
) {
  if (!terms) throw new HttpError(400, 'Accept reward and refund terms before launching.');
  const owned = await db.raid.findUnique({ where: { id }, include: { creator: true } });
  if (
    !owned ||
    owned.creatorId !== user.id ||
    owned.studioVersion !== 1 ||
    owned.hidden ||
    owned.creator.suspended
  )
    throw new HttpError(404, 'Campaign not found.');
  assertApprovedCreator(owned.creator);
  if (owned.status === 'ACTIVE' || owned.status === 'ENDED') return { id };
  if (owned.status !== 'DRAFT') throw new HttpError(409, 'Only drafts can launch.');
  // Spend no X reads while the platform or the creator is not ready to launch.
  const readiness = usdcSettings();
  if (
    !trackingEnabled() ||
    (!studioSandbox() && !trackingSettlementEnabled()) ||
    !readiness.ready ||
    !readiness.rateUnits ||
    (!studioSandbox() &&
      (!config.liveApproved ||
        !process.env.X_BEARER_TOKEN ||
        !(await db.settings.findUnique({ where: { id: 'global' } }))?.collectionEnabled))
  )
    throw new HttpError(503, 'Live campaign funding is not ready. Your draft is saved.');
  if (!(await db.xAccount.findUnique({ where: { userId: user.id } })))
    throw new HttpError(403, 'Connect X before launching.');
  if (!(await db.walletIdentity.findUnique({ where: { userId: user.id } })))
    throw new HttpError(403, 'Connect your wallet from Account before funding.');
  if (
    owned.impressionTarget &&
    (await balance(user.id)).available < quoteUsdc(owned.impressionTarget, readiness.rateUnits)
  )
    throw new HttpError(409, 'Insufficient USDC. Deposit funds to continue.');
  const targets = await db.raidBriefPost.findMany({ where: { raidId: id } });
  const previews = await targetPreviews(
    targets.map((p) => p.postId),
    id,
  );
  if (!targets.length || previews.length !== targets.length)
    throw new HttpError(409, 'Validate all target posts before launch.');
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(729103)`;
      await lockTracking(tx, id);
      await lockBalance(tx, user.id);
      const raid = await tx.raid.findUniqueOrThrow({
        where: { id },
        include: { creator: true, briefPosts: true },
      });
      if (
        raid.creatorId !== user.id ||
        raid.studioVersion !== 1 ||
        raid.hidden ||
        raid.creator.suspended
      )
        throw new HttpError(403, 'Campaign access is restricted.');
      assertApprovedCreator(raid.creator);
      if (raid.status === 'ACTIVE' || raid.status === 'ENDED') return { id };
      if (raid.status !== 'DRAFT') throw new HttpError(409, 'Only drafts can launch.');
      if (!(await tx.xAccount.findUnique({ where: { userId: user.id } })))
        throw new HttpError(403, 'Connect X before launching.');
      if (!(await tx.walletIdentity.findUnique({ where: { userId: user.id } })))
        throw new HttpError(403, 'Connect your wallet from Account before funding.');
      const settings = await tx.settings.upsert({
          where: { id: 'global' },
          create: {},
          update: {},
        }),
        funding = usdcSettings();
      if (
        !trackingEnabled() ||
        (!studioSandbox() && !trackingSettlementEnabled()) ||
        !funding.ready ||
        !funding.rateUnits ||
        (!studioSandbox() &&
          (!settings.collectionEnabled || !config.liveApproved || !process.env.X_BEARER_TOKEN))
      )
        throw new HttpError(503, 'Live campaign funding is not ready. Your draft is saved.');
      if (
        raid.briefPosts.length !== previews.length ||
        raid.briefPosts.some((p) => !previews.some((v) => v.id === p.postId))
      )
        throw new HttpError(409, 'Target posts changed; review and retry.');
      const pool = quoteUsdc(raid.impressionTarget!, funding.rateUnits);
      if (pool.toString() !== expectedUnits || raid.quoteRate !== funding.rateUnits)
        throw new HttpError(409, 'Funding rate changed. Save draft again to review updated quote.');
      if ((await balance(user.id, tx)).available < pool)
        throw new HttpError(409, 'Insufficient USDC. Deposit funds to continue.');
      const now = new Date();
      if (
        (await tx.raid.count({
          where: { status: { in: ['ACTIVE', 'SCHEDULED'] }, hidden: false, endsAt: { gt: now } },
        })) >= settings.maxActiveRaids
      )
        throw new HttpError(409, 'Campaign capacity reached. Try after another Raid ends.');
      await tx.balanceEntry.create({
        data: {
          key: `raid-reserve:${id}`,
          userId: user.id,
          raidId: id,
          network: funding.network,
          kind: 'RAID_RESERVED',
          availableDelta: -pool,
          reservedDelta: pool,
        },
      });
      for (const preview of previews)
        await tx.raidBriefPost.update({
          where: { raidId_postId: { raidId: id, postId: preview.id } },
          data: { preview, validatedAt: now },
        });
      await tx.raid.update({
        where: { id },
        data: {
          status: 'ACTIVE',
          fundingStatus: 'VERIFIED',
          poolUnits: pool,
          authorCapBps: authorCapBps(),
          fundingNetwork: funding.network,
          fundingRecipient: funding.recipient,
          fundedAt: now,
          startsAt: now,
          endsAt: new Date(+now + (+raid.endsAt - +raid.startsAt)),
        },
      });
      return { id };
    },
    { timeout: 30000 },
  );
}
