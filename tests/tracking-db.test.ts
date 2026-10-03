import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Keypair, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { db } from '../src/lib/db';
import { createRaid, changeRaid } from '../src/lib/campaigns';
import { config } from '../src/lib/config';
import {
  enrollRaid,
  submitTrackingPost,
  ingestTracking,
  markTrackingUnavailable,
} from '../src/lib/tracking';
import {
  finalizeTracking,
  openDispute,
  resolveTracking,
  carryHeldFunds,
  trackingBlockers,
  type ResultPayload,
} from '../src/lib/tracking-review';
import { trackingView } from '../src/lib/tracking-view';
import { scoreContributions } from '../src/lib/tracking-domain';
import { processTrackingLookup } from '../src/lib/tracking-worker';
import { settleNextRound } from '../src/lib/rewards';
import { collect, refresh } from '../src/lib/collection';
import { claimJob, finishJob, JOB_MAX_ATTEMPTS } from '../src/lib/queue';
import { runJob, schedule } from '../src/lib/worker-jobs';
import { searchPosts } from '../src/lib/providers/x';
import type { XPost } from '../src/lib/domain';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
suite('tracking v2 database lifecycle', () => {
  let raidId: string, userId: string, adminId: string, launchId: string, creatorId: string;
  const started = new Date(Date.now() - 3600000),
    posted = new Date(Date.now() - 600000);
  const xpost = (id: string, patch: Partial<XPost> = {}): XPost => ({
    id,
    author_id: 'alice',
    text: `Unique message ${id} @useRAID #raid_tracking`,
    created_at: posted.toISOString(),
    entities: { mentions: [{ username: 'useRAID' }], hashtags: [{ tag: 'raid_tracking' }] },
    public_metrics: { like_count: 3, reply_count: 0, retweet_count: 0, quote_count: 0 },
    ...patch,
  });
  beforeAll(() => {
    assertTestDatabase();
    vi.stubEnv('X_ADMIN_USER_ID', 'admin-x');
    vi.stubEnv('X_TRACKING_V2_ENABLED', 'true');
    vi.stubEnv('X_TRACKING_V2_SETTLEMENT_ENABLED', 'true');
    vi.stubEnv('X_BEARER_TOKEN', 'test-only');
    config.demo = false;
    config.liveApproved = true;
    const key = Keypair.generate();
    vi.stubEnv('OPERATOR_SECRET_KEY', bs58.encode(key.secretKey));
    vi.stubEnv('OPERATOR_PUBLIC_KEY', key.publicKey.toBase58());
    vi.stubEnv('PLATFORM_TREASURY_ADDRESS', Keypair.generate().publicKey.toBase58());
  });
  beforeEach(async () => {
    await truncateAll(db);
    const user = await db.user.create({ data: { handle: 'alice', xId: 'alice', approved: true } });
    userId = user.id;
    adminId = (await db.user.create({ data: { handle: 'admin', xId: 'admin-x', role: 'ADMIN' } }))
      .id;
    creatorId = (
      await db.user.create({ data: { handle: 'creator', xId: 'creator', approved: true } })
    ).id;
    await db.xAccount.create({
      data: { userId, xUserId: 'alice', username: 'alice', displayName: 'Alice' },
    });
    await db.walletIdentity.create({
      data: { userId, address: Keypair.generate().publicKey.toBase58() },
    });
    const mint = Keypair.generate().publicKey.toBase58();
    await db.token.create({ data: { mint, name: 'Test', symbol: 'TEST' } });
    launchId = (
      await db.tokenLaunch.create({
        data: {
          userId,
          mint,
          name: 'Test',
          symbol: 'TEST',
          description: 'Test tracking token',
          metadataUri: 'ipfs://test',
          imageUri: '',
          feeAddress: Keypair.generate().publicKey.toBase58(),
          feeSecret: 'fixture',
          mintSecret: 'fixture',
          status: 'LIVE',
        },
      })
    ).id;
    const raid = await db.raid.create({
      data: {
        mint,
        creatorId,
        tag: 'raid_tracking',
        title: 'Tracking test',
        description: 'Tracking lifecycle fixture',
        tokenLaunchId: launchId,
        status: 'ACTIVE',
        startsAt: started,
        endsAt: new Date(Date.now() + 3600000),
        trackingVersion: 2,
        ruleVersion: 2,
        scoringVersion: 2,
      },
    });
    raidId = raid.id;
    await db.tokenLaunch.update({ where: { id: launchId }, data: { raidId } });
    await db.settings.create({ data: { collectionEnabled: true } });
    await enrollRaid(raidId, userId);
    await db.raidEnrollment.updateMany({
      where: { raidId },
      data: { joinedAt: new Date(+started + 1000) },
    });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await db.$disconnect();
  });
  async function close() {
    await db.raid.update({
      where: { id: raidId },
      data: {
        status: 'ENDED',
        endsAt: new Date(Date.now() - 60000),
        trackingPhase: 'FINALIZING',
        finalRefreshed: true,
        coverage: 'complete',
        coveredUntil: new Date(),
        observedAt: new Date(),
        finalFeeSweepAt: new Date(),
      },
    });
  }
  it('creates and launches new Raids with frozen mention-only rules', async () => {
    const creator = await db.user.findUniqueOrThrow({ where: { id: userId } });
    const existing = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
    const draft = await createRaid(creator, {
      title: 'Local creator flow check',
      description: 'Verify a new creator Raid inherits tracking rules.',
      mint: existing.mint,
      symbol: 'TEST',
      name: 'Test',
      duration: 24,
    });
    expect(draft.trackingVersion).toBe(2);
    expect(draft.ruleVersion).toBe(3);
    expect(draft.scoringVersion).toBe(3);
    const launched = await changeRaid(creator, draft.id, 'launch');
    expect(launched.status).toBe('ACTIVE');
    expect(launched.trackingVersion).toBe(2);
  });
  it('serializes joining and preserves wallet lock', async () => {
    const joins = await Promise.all([enrollRaid(raidId, userId), enrollRaid(raidId, userId)]);
    expect(joins[0].id).toBe(joins[1].id);
    await db.walletIdentity.update({
      where: { userId },
      data: { address: Keypair.generate().publicKey.toBase58() },
    });
    await expect(enrollRaid(raidId, userId)).rejects.toMatchObject({ status: 409 });
  });
  it('deduplicates concurrent submissions and rejects mismatched author without importing it', async () => {
    const results = await Promise.all([
      submitTrackingPost(raidId, userId, '100'),
      submitTrackingPost(raidId, userId, '100'),
    ]);
    expect(results[0].id).toBe(results[1].id);
    expect(await db.job.count()).toBe(1);
    await ingestTracking(raidId, [xpost('100', { author_id: 'imposter' })], {
      submissionId: results[0].id,
    });
    expect(
      (await db.postSubmission.findUniqueOrThrow({ where: { id: results[0].id } })).reasonCode,
    ).toBe('AUTHOR_MISMATCH');
    expect(await db.post.count()).toBe(0);
    await expect(submitTrackingPost(raidId, adminId, '101')).rejects.toMatchObject({ status: 403 });
  });
  it('automatically assigns a mention only with one eligible Raid', async () => {
    await db.raid.update({ where: { id: raidId }, data: { ruleVersion: 3 } });
    const post = xpost('mention-one', {
      text: 'Original @useRAID',
      entities: { mentions: [{ username: 'useRAID' }] },
    });
    await ingestTracking(raidId, [post]);
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).qualification).toBe(
      'QUALIFIED',
    );
    await ingestTracking(raidId, [xpost('mention-stranger', { author_id: 'stranger' })]);
    expect(await db.post.findUnique({ where: { id: 'mention-stranger' } })).toBeNull();
  });
  it('leaves overlapping mentions unassigned until a raider claims one Raid', async () => {
    const original = await db.raid.update({ where: { id: raidId }, data: { ruleVersion: 3 } });
    const other = await db.raid.create({
      data: {
        mint: original.mint,
        creatorId,
        tag: 'raid_overlap',
        title: 'Overlapping Raid',
        description: 'Mention attribution fixture',
        status: 'ACTIVE',
        startsAt: original.startsAt,
        endsAt: original.endsAt,
        trackingVersion: 2,
        ruleVersion: 3,
        scoringVersion: 2,
      },
    });
    await enrollRaid(other.id, userId);
    await db.raidEnrollment.updateMany({
      where: { raidId: other.id },
      data: { joinedAt: new Date(+started + 1000) },
    });
    const post = xpost('mention-overlap', {
      text: 'Original @useRAID',
      entities: { mentions: [{ username: 'useRAID' }] },
    });
    await Promise.all([ingestTracking(raidId, [post]), ingestTracking(other.id, [post])]);
    expect(await db.post.findUnique({ where: { id: post.id } })).toBeNull();
    const [first, second] = await Promise.all([
      submitTrackingPost(raidId, userId, post.id),
      submitTrackingPost(other.id, userId, post.id),
    ]);
    await Promise.all([
      ingestTracking(raidId, [post], { submissionId: first.id }),
      ingestTracking(other.id, [post], { submissionId: second.id }),
    ]);
    const claimed = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect([raidId, other.id]).toContain(claimed.raidId);
    expect(await db.post.count({ where: { id: post.id } })).toBe(1);
    expect(await db.postSubmission.count({ where: { postId: post.id, status: 'QUALIFIED' } })).toBe(
      1,
    );
  });
  it('keeps observations append-only, preserves cross-Raid ownership, and excludes later same-author duplicate', async () => {
    await ingestTracking(raidId, [xpost('101')], { sampleKey: 'sample1' });
    await ingestTracking(raidId, [xpost('101')], { sampleKey: 'sample1' });
    await ingestTracking(
      raidId,
      [
        xpost('101', {
          public_metrics: { like_count: 7, reply_count: 0, retweet_count: 0, quote_count: 0 },
        }),
      ],
      { sampleKey: 'sample2' },
    );
    expect(await db.metricObservation.count()).toBe(2);
    await ingestTracking(raidId, [
      xpost('102', { text: xpost('101').text, created_at: new Date(+posted + 1).toISOString() }),
    ]);
    expect((await db.post.findUniqueOrThrow({ where: { id: '102' } })).reasonCode).toBe(
      'DUPLICATE_CONTENT',
    );
    const original = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
    const other = await db.raid.create({
      data: {
        mint: original.mint,
        creatorId,
        tag: 'raid_other',
        title: 'Other',
        description: 'Other Raid',
        startsAt: started,
        endsAt: original.endsAt,
        trackingVersion: 2,
      },
    });
    await ingestTracking(other.id, [xpost('101')]);
    expect((await db.post.findUniqueOrThrow({ where: { id: '101' } })).raidId).toBe(raidId);
    await expect(db.metricObservation.updateMany({ data: { likes: 999 } })).rejects.toThrow(
      /append-only/,
    );
  });
  it('keeps incomplete lookups separate from unavailable posts and preserves content expiry', async () => {
    await ingestTracking(raidId, [xpost('103')]);
    await markTrackingUnavailable(raidId, ['103'], false);
    expect((await db.post.findUniqueOrThrow({ where: { id: '103' } })).deleted).toBe(false);
    await ingestTracking(raidId, [xpost('103')]);
    await db.post.update({
      where: { id: '103' },
      data: { text: '', normalized: '', contentExpiredAt: new Date() },
    });
    await ingestTracking(raidId, [
      xpost('1031', { text: xpost('103').text, created_at: new Date(+posted + 1).toISOString() }),
    ]);
    expect((await db.post.findUniqueOrThrow({ where: { id: '1031' } })).reasonCode).toBe(
      'DUPLICATE_CONTENT',
    );
    expect(scoreContributions(await db.post.findMany()).score).toBe(300);
    await markTrackingUnavailable(raidId, ['103'], true);
    expect((await db.post.findUniqueOrThrow({ where: { id: '103' } })).availability).toBe(
      'UNAVAILABLE',
    );
    expect(await db.metricObservation.count()).toBe(3);
  });
  it('blocks incomplete collection, versions corrections, freezes ordinary refresh and rejects snapshot mutation', async () => {
    await ingestTracking(raidId, [xpost('104')]);
    await close();
    await db.job.create({
      data: { key: 'incomplete', kind: 'collect', payload: { raidId }, attempts: 8 },
    });
    await finalizeTracking(raidId);
    expect(await db.campaignResult.count()).toBe(0);
    await db.job.updateMany({ data: { doneAt: new Date() } });
    await finalizeTracking(raidId);
    const first = await db.campaignResult.findFirstOrThrow();
    expect((first.payload as unknown as ResultPayload).participants[0].score).toBe(300);
    await ingestTracking(raidId, [
      xpost('104', {
        public_metrics: { like_count: 1000, reply_count: 0, retweet_count: 0, quote_count: 0 },
      }),
    ]);
    expect((await db.post.findUniqueOrThrow({ where: { id: '104' } })).likes).toBe(3);
    const dispute = await openDispute(raidId, userId, {
      category: 'EXCLUSION',
      reason: 'Please investigate',
      postId: '104',
    });
    await db.raid.update({
      where: { id: raidId },
      data: { reviewEndsAt: new Date(Date.now() - 1) },
    });
    await finalizeTracking(raidId);
    expect((await db.raid.findUniqueOrThrow({ where: { id: raidId } })).trackingPhase).toBe(
      'REVIEW',
    );
    await resolveTracking(raidId, adminId, {
      action: 'exclude',
      postId: '104',
      reason: 'Confirmed spam',
    });
    await resolveTracking(raidId, adminId, {
      action: 'resolve-dispute',
      disputeId: dispute.id,
      reason: 'Evidence corrected',
    });
    await finalizeTracking(raidId);
    const current = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
    expect(current.reviewEndsAt!.getTime()).toBeGreaterThan(Date.now() + 7100000);
    expect(await db.campaignResult.count()).toBe(2);
    expect(
      (await db.campaignResult.findUniqueOrThrow({ where: { id: first.id } })).payload,
    ).toEqual(first.payload);
    await expect(
      db.campaignResult.update({ where: { id: first.id }, data: { fingerprint: 'changed' } }),
    ).rejects.toThrow(/append-only/);
  });
  it('accepts missing eligible posts during review, then restarts review', async () => {
    await ingestTracking(raidId, [xpost('105')]);
    await close();
    await finalizeTracking(raidId);
    const submitted = await submitTrackingPost(raidId, userId, '106');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: [xpost('106')] }), { status: 200 })),
    );
    await db.job.update({
      where: { key: `submission:${submitted.id}` },
      data: { runAt: new Date(Date.now() - 1000) },
    });
    const job = await claimJob();
    expect(job).not.toBeNull();
    await processTrackingLookup(raidId, '106', job!.id, submitted.id);
    await finishJob(job!);
    await finalizeTracking(raidId);
    expect(await db.campaignResult.count()).toBe(2);
    expect((await trackingView(raidId, userId))!.ownContributions).toHaveLength(2);
  });
  it('holds empty results without allocating funds', async () => {
    await close();
    await finalizeTracking(raidId);
    await db.raid.update({
      where: { id: raidId },
      data: { reviewEndsAt: new Date(Date.now() - 1) },
    });
    await finalizeTracking(raidId);
    expect((await db.raid.findUniqueOrThrow({ where: { id: raidId } })).trackingPhase).toBe('HELD');
    expect(await db.rewardRound.count()).toBe(0);
  });
  it('settles once from approved snapshot despite mutable post changes; preserves exact fee allocation', async () => {
    await ingestTracking(raidId, [xpost('107')]);
    await close();
    await finalizeTracking(raidId);
    const launch = await db.tokenLaunch.findUniqueOrThrow({ where: { id: launchId } });
    const rpc = {
      getLatestBlockhash: vi.fn(async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
      })),
      getFeeForMessage: vi.fn(async () => ({ value: 5000 })),
    } as unknown as Connection;
    await db.feeClaim.create({
      data: {
        launchId,
        raidId,
        signature: randomUUID(),
        source: 'test',
        grossLamports: 10_000_000n,
        costLamports: 5000n,
      },
    });
    expect(await settleNextRound(rpc, launch)).toBe(false);
    await db.raid.update({
      where: { id: raidId },
      data: { reviewEndsAt: new Date(Date.now() - 1) },
    });
    await finalizeTracking(raidId);
    await db.post.update({ where: { id: '107' }, data: { likes: 100000 } });
    expect(await settleNextRound(rpc, launch)).toBe(true);
    expect(await settleNextRound(rpc, launch)).toBe(false);
    const round = await db.rewardRound.findFirstOrThrow();
    const payout = await db.rewardPayout.findFirstOrThrow();
    expect(payout.score).toBe(300);
    expect(round.resultSnapshotId).toBeTruthy();
    expect(round.costLamports + round.raiderLamports + round.platformLamports).toBe(10_000_000n);
    expect(round.platformLamports).toBe(998500n);
    expect(payout.lamports).toBe(8986500n);
    expect((await db.feeClaim.findFirstOrThrow()).roundId).toBe(round.id);
  });
  describe('scoring v3 duplicate handling', () => {
    const raider = async (xId: string) => {
      const user = await db.user.create({ data: { handle: xId, xId } });
      await db.raidEnrollment.create({
        data: {
          raidId,
          userId: user.id,
          xId,
          walletAddress: Keypair.generate().publicKey.toBase58(),
          joinedAt: started,
        },
      });
    };
    const text = 'Gm raiders loving this campaign @useRAID #raid_tracking';
    const copy = (id: string, author: string, offset: number) =>
      xpost(id, { author_id: author, text, created_at: new Date(+posted + offset).toISOString() });
    const states = async () =>
      Object.fromEntries(
        (await db.post.findMany()).map((p) => [p.id, [p.qualification, p.reviewStatus]]),
      );
    it('flags only later copies and keeps an audited clearance when another copy arrives', async () => {
      await db.raid.update({ where: { id: raidId }, data: { scoringVersion: 3 } });
      await raider('bob');
      await raider('cara');
      await ingestTracking(raidId, [copy('301', 'alice', 0), copy('302', 'bob', 1)]);
      expect(await states()).toEqual({
        '301': ['QUALIFIED', 'CLEAR'],
        '302': ['QUALIFIED', 'FLAGGED'],
      });
      await db.post.update({ where: { id: '302' }, data: { reviewStatus: 'CLEARED' } });
      await ingestTracking(raidId, [copy('303', 'cara', 2)]);
      expect(await states()).toEqual({
        '301': ['QUALIFIED', 'CLEAR'],
        '302': ['QUALIFIED', 'CLEARED'],
        '303': ['QUALIFIED', 'FLAGGED'],
      });
    });
    it('keeps the legacy symmetric flagging on a scoring v2 Raid', async () => {
      await raider('bob');
      await ingestTracking(raidId, [copy('311', 'alice', 0), copy('312', 'bob', 1)]);
      expect(await states()).toEqual({
        '311': ['QUALIFIED', 'FLAGGED'],
        '312': ['QUALIFIED', 'FLAGGED'],
      });
    });
    it('catches a short near-duplicate under v3 and ignores it under v2', async () => {
      const short = (id: string, author: string, last: string, offset: number) =>
        xpost(id, {
          author_id: author,
          text: `gm raiders loving the new campaign launch happening today with all our friends ${last} @useRAID #raid_tracking`,
          created_at: new Date(+posted + offset).toISOString(),
        });
      await raider('bob');
      await ingestTracking(raidId, [
        short('321', 'alice', 'friends', 0),
        short('322', 'bob', 'frens', 1),
      ]);
      expect((await states())['322']).toEqual(['QUALIFIED', 'CLEAR']);
      await db.raid.update({ where: { id: raidId }, data: { scoringVersion: 3 } });
      await ingestTracking(raidId, [short('322', 'bob', 'frens', 1)], { correction: true });
      expect(await states()).toEqual({
        '321': ['QUALIFIED', 'CLEAR'],
        '322': ['QUALIFIED', 'FLAGGED'],
      });
    });
  });
  describe('re-homing an excluded post', () => {
    const other = async (extra: Record<string, unknown> = {}) => {
      const original = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
      const raid = await db.raid.create({
        data: {
          mint: original.mint,
          creatorId,
          tag: 'raid_rehome',
          title: 'Rehome target',
          description: 'Rehome target Raid',
          status: 'ACTIVE',
          startsAt: started,
          endsAt: original.endsAt,
          trackingVersion: 2,
          ruleVersion: 2,
          scoringVersion: 2,
          ...extra,
        },
      });
      await enrollRaid(raid.id, userId);
      await db.raidEnrollment.updateMany({
        where: { raidId: raid.id },
        data: { joinedAt: new Date(+started + 1000) },
      });
      return raid;
    };
    const wrongRaid = (id: string) =>
      xpost(id, {
        text: `Rehome ${id} @useRAID #raid_rehome`,
        entities: { mentions: [{ username: 'useRAID' }], hashtags: [{ tag: 'raid_rehome' }] },
      });
    const submit = async (target: string, id: string) => {
      const submitted = await submitTrackingPost(target, userId, id);
      await ingestTracking(target, [wrongRaid(id)], { submissionId: submitted.id });
      return submitted;
    };
    it('moves an excluded post to the Raid where it qualifies and records the move', async () => {
      const target = await other();
      await ingestTracking(raidId, [wrongRaid('401')]);
      expect(await db.post.findUniqueOrThrow({ where: { id: '401' } })).toMatchObject({
        raidId,
        qualification: 'EXCLUDED',
        reasonCode: 'ATTRIBUTION',
      });
      await submit(target.id, '401');
      expect(await db.post.findUniqueOrThrow({ where: { id: '401' } })).toMatchObject({
        raidId: target.id,
        qualification: 'QUALIFIED',
        reasonCode: null,
      });
      const decision = await db.contributionDecision.findFirstOrThrow({
        where: { postId: '401' },
        orderBy: { at: 'desc' },
      });
      expect(decision.evidence).toMatchObject({ movedFromRaidId: raidId });
      expect(await db.metricObservation.count({ where: { postId: '401' } })).toBe(2);
    });
    it('keeps qualified, admin-excluded and frozen-source posts where they are', async () => {
      const target = await other();
      await ingestTracking(raidId, [xpost('402')]);
      await expect(submitTrackingPost(target.id, userId, '402')).rejects.toMatchObject({
        status: 409,
      });
      await ingestTracking(raidId, [wrongRaid('403')]);
      await db.post.update({ where: { id: '403' }, data: { adminExcluded: true } });
      await expect(submitTrackingPost(target.id, userId, '403')).rejects.toMatchObject({
        status: 409,
      });
      await ingestTracking(raidId, [wrongRaid('404')]);
      await db.raid.update({ where: { id: raidId }, data: { trackingPhase: 'ALLOCATED' } });
      const submitted = await submit(target.id, '404');
      expect((await db.post.findUniqueOrThrow({ where: { id: '404' } })).raidId).toBe(raidId);
      expect(
        await db.postSubmission.findUniqueOrThrow({ where: { id: submitted.id } }),
      ).toMatchObject({ status: 'EXCLUDED', reasonCode: 'OTHER_RAID' });
    });
  });
  it('flags cross-author copies until audited review; same-author duplicates stay excluded', async () => {
    const bob = await db.user.create({ data: { handle: 'bob', xId: 'bob' } });
    await db.raidEnrollment.create({
      data: {
        raidId,
        userId: bob.id,
        xId: 'bob',
        walletAddress: Keypair.generate().publicKey.toBase58(),
        joinedAt: started,
      },
    });
    await ingestTracking(raidId, [
      xpost('120'),
      xpost('121', { author_id: 'bob', text: xpost('120').text }),
    ]);
    expect(await db.post.count({ where: { reviewStatus: 'FLAGGED' } })).toBe(2);
    await close();
    await finalizeTracking(raidId);
    expect(await db.campaignResult.count()).toBe(0);
    await resolveTracking(raidId, adminId, {
      action: 'clear',
      postId: '120',
      reason: 'Independent legitimate attribution verified',
    });
    await resolveTracking(raidId, adminId, {
      action: 'exclude',
      postId: '121',
      reason: 'Confirmed copy',
    });
    await finalizeTracking(raidId);
    expect(await db.campaignResult.count()).toBe(1);
  });
  it('completes paginated discovery and final observations before publishing a snapshot', async () => {
    await db.raid.update({
      where: { id: raidId },
      data: {
        status: 'ENDED',
        endsAt: new Date(Date.now() - 60000),
        trackingPhase: 'FINALIZING',
        ruleVersion: 3,
      },
    });
    let page = 0;
    const queries: URL[] = [];
    const mentionPost = (id: string) =>
      xpost(id, {
        text: `Unique message ${id} @useRAID`,
        entities: { mentions: [{ username: 'useRAID' }] },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes('search/recent')) {
          queries.push(new URL(String(url)));
          page++;
          return new Response(
            JSON.stringify({
              data: [mentionPost(page === 1 ? '122' : '123')],
              meta: page === 1 ? { next_token: 'page-two', newest_id: '123' } : {},
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ data: [mentionPost('122'), mentionPost('123')] }), {
          status: 200,
        });
      }),
    );
    await collect(raidId, 'scan-first');
    expect((await db.raid.findUniqueOrThrow({ where: { id: raidId } })).nextToken).toBe('page-two');
    const next = await claimJob();
    expect(next!.kind).toBe('collect');
    await collect(raidId, next!.id);
    expect(queries.map((url) => url.searchParams.get('query'))).toEqual([
      '@useRAID -is:retweet -is:reply (from:alice)',
      '@useRAID -is:retweet -is:reply (from:alice)',
    ]);
    expect(queries[1].searchParams.get('next_token')).toBe('page-two');
    await finishJob(next!);
    const refreshJob = await claimJob();
    expect(refreshJob!.kind).toBe('refresh');
    const payload = refreshJob!.payload as { coveredUntil: string; final: boolean };
    await refresh(raidId, '', payload.final, payload.coveredUntil, refreshJob!.id);
    await finishJob(refreshJob!);
    await finalizeTracking(raidId);
    expect((await db.raid.findUniqueOrThrow({ where: { id: raidId } })).trackingPhase).toBe(
      'REVIEW',
    );
    expect(await db.metricObservation.count()).toBe(4);
    expect((await trackingView(raidId, userId))!.leaderboard[0].score).toBe(600);
  });
  it('keeps held claims untouched until explicit audited assignment to a later same-token Raid', async () => {
    await close();
    await finalizeTracking(raidId);
    await db.raid.update({
      where: { id: raidId },
      data: { reviewEndsAt: new Date(Date.now() - 1) },
    });
    await finalizeTracking(raidId);
    const source = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
    await db.feeClaim.create({
      data: { launchId, raidId, signature: randomUUID(), source: 'test', grossLamports: 1000000n },
    });
    const target = await db.raid.create({
      data: {
        mint: source.mint,
        creatorId,
        tokenLaunchId: launchId,
        tag: 'raid_next',
        title: 'Next',
        description: 'Next eligible Raid',
        status: 'ACTIVE',
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 3600000),
        trackingVersion: 2,
      },
    });
    await expect(
      carryHeldFunds(raidId, target.id, userId, 'Move held claims'),
    ).rejects.toMatchObject({ status: 403 });
    await carryHeldFunds(
      raidId,
      target.id,
      adminId,
      'Assign unallocated fees to the next community Raid',
    );
    expect((await db.feeClaim.findFirstOrThrow()).raidId).toBe(target.id);
    expect(await db.rewardPayout.count()).toBe(0);
    expect((await db.raid.findUniqueOrThrow({ where: { id: raidId } })).trackingPhase).toBe(
      'HELD_RESOLVED',
    );
    expect(
      await db.moderationEvent.count({
        where: { action: 'tracking:carry-held', targetId: raidId },
      }),
    ).toBe(1);
  });
  describe('conflict of interest', () => {
    const clear = (postId = '401') =>
      resolveTracking(raidId, adminId, { action: 'clear', postId, reason: 'Checked' });
    it('lets an unrelated administrator review', async () => {
      await ingestTracking(raidId, [xpost('401')]);
      await clear();
      expect(
        await db.moderationEvent.count({ where: { action: 'tracking:clear', actorId: adminId } }),
      ).toBe(1);
    });
    it('rejects the administrator who created the Raid', async () => {
      await ingestTracking(raidId, [xpost('401')]);
      await db.raid.update({ where: { id: raidId }, data: { creatorId: adminId } });
      await expect(clear()).rejects.toMatchObject({ status: 403 });
      expect(await db.moderationEvent.count({ where: { action: 'tracking:clear' } })).toBe(0);
    });
    it('rejects an administrator who joined the Raid, by account or by X id', async () => {
      await ingestTracking(raidId, [xpost('401')]);
      const byAccount = await db.raidEnrollment.create({
        data: { raidId, userId: adminId, xId: 'other-x', walletAddress: 'w' },
      });
      await expect(clear()).rejects.toMatchObject({ status: 403 });
      await db.raidEnrollment.delete({ where: { id: byAccount.id } });
      await db.raidEnrollment.create({
        data: { raidId, userId: creatorId, xId: 'admin-x', walletAddress: 'w2' },
      });
      await expect(clear()).rejects.toMatchObject({ status: 403 });
    });
    it('rejects reviewing a contribution the administrator authored', async () => {
      await ingestTracking(raidId, [xpost('401')]);
      await db.post.updateMany({ where: { id: '401' }, data: { authorId: 'admin-x' } });
      await expect(clear()).rejects.toMatchObject({ status: 403 });
    });
    it("rejects carrying held funds from or into the administrator's own Raid", async () => {
      const source = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
      const target = await db.raid.create({
        data: {
          mint: source.mint,
          creatorId: adminId,
          tag: 'raid_admin',
          title: 'Admin Raid',
          description: 'Created by the administrator',
          status: 'ACTIVE',
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 3600000),
          trackingVersion: 2,
        },
      });
      await expect(carryHeldFunds(raidId, target.id, adminId, 'Move')).rejects.toMatchObject({
        status: 403,
      });
      await expect(carryHeldFunds(target.id, raidId, adminId, 'Move')).rejects.toMatchObject({
        status: 403,
      });
    });
  });
  it('stops new tracking mutations when gate closes', async () => {
    vi.stubEnv('X_TRACKING_V2_ENABLED', 'false');
    await expect(submitTrackingPost(raidId, userId, '130')).rejects.toMatchObject({ status: 503 });
    await expect(ingestTracking(raidId, [xpost('130')])).rejects.toMatchObject({ status: 503 });
    vi.stubEnv('X_TRACKING_V2_ENABLED', 'true');
  });
  describe('queue robustness', () => {
    const drain = async (times: number) => {
      for (let i = 0; i < times; i++) {
        await db.job.updateMany({ data: { runAt: new Date(Date.now() - 1000) } });
        const job = await claimJob();
        if (!job) return;
        await runJob(job);
      }
    };
    async function submission(id: string) {
      const submitted = await submitTrackingPost(raidId, userId, id);
      return db.job.findUniqueOrThrow({ where: { key: `submission:${submitted.id}` } });
    }
    it('dead-letters an unresolvable submission as LOOKUP_FAILED and stops blocking finalization', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
      );
      const job = await submission('201');
      await drain(JOB_MAX_ATTEMPTS);
      const dead = await db.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(dead.failedAt).not.toBeNull();
      const row = await db.postSubmission.findFirstOrThrow({ where: { postId: '201' } });
      expect(row).toMatchObject({ status: 'EXCLUDED', reasonCode: 'LOOKUP_FAILED' });
      await close();
      expect(await db.$transaction((tx) => trackingBlockers(tx, raidId))).toBe(0);
      expect(
        (await db.raid.findUniqueOrThrow({ where: { id: raidId } })).collectionError,
      ).toBeNull();
      await finalizeTracking(raidId);
      expect(await db.campaignResult.count()).toBe(1);
    }, 60000);
    it('does not dead-letter submissions while X is failing with 5xx or unreachable', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('{}', { status: 503 })),
      );
      const job = await submission('202');
      await drain(JOB_MAX_ATTEMPTS + 2);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('fetch failed');
        }),
      );
      await drain(JOB_MAX_ATTEMPTS + 2);
      const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(row.failedAt).toBeNull();
      expect(row.attempts).toBe(0);
      expect((await db.postSubmission.findFirstOrThrow({ where: { postId: '202' } })).status).toBe(
        'QUEUED',
      );
    }, 60000);
    it('excludes a submission when X rejects the lookup as an invalid request', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('{}', { status: 400 })),
      );
      const job = await submission('203');
      await drain(1);
      expect(await db.postSubmission.findFirstOrThrow({ where: { postId: '203' } })).toMatchObject({
        status: 'EXCLUDED',
        reasonCode: 'INVALID_POST',
      });
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).doneAt).not.toBeNull();
      expect(await db.$transaction((tx) => trackingBlockers(tx, raidId))).toBe(0);
    });
    it('excludes a malformed stored post id without calling X', async () => {
      const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetcher);
      const enrollment = await db.raidEnrollment.findFirstOrThrow({ where: { raidId } });
      const created = await db.postSubmission.create({
        data: { raidId, enrollmentId: enrollment.id, postId: '99999999999999999999' },
      });
      await processTrackingLookup(raidId, created.postId, 'k', created.id);
      expect(fetcher).not.toHaveBeenCalled();
      expect(
        await db.postSubmission.findUniqueOrThrow({ where: { id: created.id } }),
      ).toMatchObject({ status: 'EXCLUDED', reasonCode: 'INVALID_POST' });
    });
  });
  describe('lookup and finalization correctness', () => {
    const problem = (type: string, id: string) => ({
      resource_id: id,
      type: `https://api.x.com/2/problems/${type}`,
    });
    const respond = (body: unknown) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
      );
    const endsAtOf = async () =>
      (await db.raid.findUniqueOrThrow({ where: { id: raidId } })).endsAt.toISOString();
    it('excludes a restricted post as POST_RESTRICTED without blocking finalization', async () => {
      await ingestTracking(raidId, [xpost('301')]);
      await close();
      respond({ errors: [problem('not-authorized-for-resource', '301')] });
      await refresh(raidId, '', true, await endsAtOf());
      expect(await db.post.findUniqueOrThrow({ where: { id: '301' } })).toMatchObject({
        availability: 'UNAVAILABLE',
        reasonCode: 'POST_RESTRICTED',
        qualification: 'EXCLUDED',
      });
      expect(await db.$transaction((tx) => trackingBlockers(tx, raidId))).toBe(0);
      await finalizeTracking(raidId);
      expect(await db.campaignResult.count()).toBe(1);
    });
    it('escalates an unresolved final lookup to LOOKUP_FAILED at attempt five', async () => {
      await ingestTracking(raidId, [xpost('302')]);
      await close();
      await db.raid.update({ where: { id: raidId }, data: { finalRefreshed: false } });
      respond({ data: [] });
      const ends = await endsAtOf();
      await expect(refresh(raidId, '', true, ends, 'k4', 4)).rejects.toThrow('incomplete lookup');
      expect((await db.post.findUniqueOrThrow({ where: { id: '302' } })).availability).toBe(
        'DATA_INCOMPLETE',
      );
      await refresh(raidId, '', true, ends, 'k5', 5);
      expect(await db.post.findUniqueOrThrow({ where: { id: '302' } })).toMatchObject({
        availability: 'UNAVAILABLE',
        reasonCode: 'LOOKUP_FAILED',
      });
      expect((await db.raid.findUniqueOrThrow({ where: { id: raidId } })).finalRefreshed).toBe(
        true,
      );
      expect(await db.$transaction((tx) => trackingBlockers(tx, raidId))).toBe(0);
    });
    it('does not escalate a non-final pass', async () => {
      await ingestTracking(raidId, [xpost('304')]);
      await db.post.updateMany({
        where: { raidId },
        data: { observedAt: new Date(Date.now() - 3 * 3600000) },
      });
      respond({ data: [] });
      await expect(refresh(raidId, '', false, undefined, 'k', 6)).rejects.toThrow(
        'incomplete lookup',
      );
      expect((await db.post.findUniqueOrThrow({ where: { id: '304' } })).availability).toBe(
        'DATA_INCOMPLETE',
      );
    });
    it('lets an admin exclusion unblock a post stuck as DATA_INCOMPLETE', async () => {
      await ingestTracking(raidId, [xpost('303')]);
      await close();
      await markTrackingUnavailable(raidId, ['303'], false);
      expect(await db.$transaction((tx) => trackingBlockers(tx, raidId))).toBe(1);
      await resolveTracking(raidId, adminId, {
        action: 'exclude',
        postId: '303',
        reason: 'Cannot be verified',
      });
      expect(await db.$transaction((tx) => trackingBlockers(tx, raidId))).toBe(0);
      await finalizeTracking(raidId);
      expect(await db.campaignResult.count()).toBe(1);
    });
    it('keeps refreshing a post already owned by this Raid when the author overlaps another Raid', async () => {
      const original = await db.raid.update({ where: { id: raidId }, data: { ruleVersion: 3 } });
      const other = await db.raid.create({
        data: {
          mint: original.mint,
          creatorId,
          tag: 'raid_overlap',
          title: 'Overlapping Raid',
          description: 'Mention attribution fixture',
          status: 'ACTIVE',
          startsAt: original.startsAt,
          endsAt: original.endsAt,
          trackingVersion: 2,
          ruleVersion: 3,
          scoringVersion: 2,
        },
      });
      await enrollRaid(other.id, userId);
      await db.raidEnrollment.updateMany({
        where: { raidId: other.id },
        data: { joinedAt: new Date(+started + 1000) },
      });
      const mention = (likes: number) =>
        xpost('310', {
          text: 'Original @useRAID',
          entities: { mentions: [{ username: 'useRAID' }] },
          public_metrics: { like_count: likes, reply_count: 0, retweet_count: 0, quote_count: 0 },
        });
      const claim = await submitTrackingPost(raidId, userId, '310');
      await ingestTracking(raidId, [mention(3)], { submissionId: claim.id });
      await close();
      respond({ data: [mention(9)] });
      await refresh(raidId, '', true, await endsAtOf());
      const post = await db.post.findUniqueOrThrow({ where: { id: '310' } });
      expect(post.likes).toBe(9);
      expect(+post.observedAt).toBeGreaterThanOrEqual(
        +(await db.raid.findUniqueOrThrow({ where: { id: raidId } })).endsAt,
      );
      await db.job.updateMany({ data: { doneAt: new Date() } });
      await finalizeTracking(raidId);
      expect(await db.campaignResult.count({ where: { raidId } })).toBe(1);
    });
    it('does not reopen results for an unrelated review-time submission', async () => {
      await ingestTracking(raidId, [xpost('401')]);
      await close();
      await finalizeTracking(raidId);
      const before = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
      expect(before.trackingPhase).toBe('REVIEW');
      const submitted = await submitTrackingPost(raidId, userId, '402');
      respond({
        data: [xpost('402', { created_at: new Date(+started - 3600000).toISOString() })],
      });
      await db.job.update({
        where: { key: `submission:${submitted.id}` },
        data: { runAt: new Date(Date.now() - 1000) },
      });
      const job = await claimJob();
      await processTrackingLookup(raidId, '402', job!.id, submitted.id);
      await finishJob(job!);
      await finalizeTracking(raidId);
      const after = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
      expect(after.trackingPhase).toBe('REVIEW');
      expect(+after.reviewEndsAt!).toBe(+before.reviewEndsAt!);
      expect(await db.campaignResult.count()).toBe(1);
      expect(await db.post.findUnique({ where: { id: '402' } })).toBeNull();
      expect(
        await db.postSubmission.findUniqueOrThrow({ where: { id: submitted.id } }),
      ).toMatchObject({ status: 'EXCLUDED', reasonCode: 'OUTSIDE_RAID' });
    });
    it('caps repeated review extensions at 24 hours from the first result', async () => {
      await ingestTracking(raidId, [xpost('501')]);
      await close();
      const t0 = new Date();
      await finalizeTracking(raidId, t0);
      const first = await db.campaignResult.findFirstOrThrow({ orderBy: { version: 'asc' } });
      for (const [id, hours] of [
        ['502', 23],
        ['503', 24.5],
      ] as const) {
        await ingestTracking(raidId, [xpost(id)], { correction: true });
        await finalizeTracking(raidId, new Date(+t0 + hours * 3600000));
        expect(
          +(await db.raid.findUniqueOrThrow({ where: { id: raidId } })).reviewEndsAt!,
        ).toBeLessThanOrEqual(+first.createdAt + 24 * 3600000);
      }
      expect(await db.campaignResult.count()).toBe(3);
      expect(+(await db.raid.findUniqueOrThrow({ where: { id: raidId } })).reviewEndsAt!).toBe(
        +first.createdAt + 24 * 3600000,
      );
    });
    it('holds a Raid whose search window expired until an admin accepts coverage', async () => {
      const ended = new Date(Date.now() - 8 * 86400000);
      await db.raid.update({
        where: { id: raidId },
        data: {
          status: 'ENDED',
          startsAt: new Date(+ended - 3600000),
          endsAt: ended,
          trackingPhase: 'FINALIZING',
          finalRefreshed: false,
        },
      });
      await expect(
        resolveTracking(raidId, adminId, { action: 'accept-coverage', reason: 'early' }),
      ).rejects.toMatchObject({ status: 409 });
      await schedule();
      const held = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
      expect(held.holdReason).toBe('COVERAGE_EXPIRED');
      await finalizeTracking(raidId);
      expect(await db.campaignResult.count()).toBe(0);
      await expect(
        resolveTracking(raidId, userId, { action: 'accept-coverage', reason: 'no' }),
      ).rejects.toMatchObject({ status: 403 });
      await resolveTracking(raidId, adminId, {
        action: 'accept-coverage',
        reason: 'Accept partial search coverage',
      });
      respond({ data: [] });
      await db.job.updateMany({ data: { runAt: new Date(Date.now() - 1000) } });
      const job = await claimJob();
      expect(job!.key).toMatch(/^accept-coverage:/);
      await runJob(job!);
      const raid = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
      expect(raid).toMatchObject({ finalRefreshed: true, holdReason: null });
      expect(+raid.coveredUntil!).toBe(+ended);
      await finalizeTracking(raidId);
      expect(await db.campaignResult.count()).toBe(1);
    });
    it('finalizes an expired v1 Raid as partial coverage', async () => {
      const { mint } = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
      const legacy = await db.raid.create({
        data: {
          mint,
          creatorId,
          tag: 'raid_legacy',
          title: 'Legacy',
          description: 'Legacy expired window',
          status: 'ENDED',
          startsAt: new Date(Date.now() - 10 * 86400000),
          endsAt: new Date(Date.now() - 8 * 86400000),
        },
      });
      await schedule();
      expect(await db.raid.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({
        finalRefreshed: true,
        coverage: 'partial',
      });
    });
    it('searches the full window on the final pass and clamps to the 7-day limit', async () => {
      const urls: URL[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL | Request) => {
          urls.push(new URL(String(url)));
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }),
      );
      const startsAt = new Date(Date.now() - 6 * 3600000);
      const endsAt = new Date(Date.now() - 3 * 3600000);
      const covered = new Date(Date.now() - 4 * 3600000);
      const raid = {
        id: raidId,
        tag: 'raid_tracking',
        startsAt,
        endsAt,
        sinceId: null,
        nextToken: null,
        trackingVersion: 2,
        officialHandle: 'useRAID',
        coveredUntil: covered,
      };
      const startOf = () => urls.at(-1)!.searchParams.get('start_time');
      await searchPosts({ ...raid, ruleVersion: 4, searchEndAt: new Date(+endsAt - 3600000) });
      expect(startOf()).toBe(new Date(+covered - 1000).toISOString());
      await searchPosts({ ...raid, ruleVersion: 4, searchEndAt: endsAt });
      expect(startOf()).toBe(startsAt.toISOString());
      await searchPosts({ ...raid, ruleVersion: 3, searchEndAt: new Date(+endsAt - 3600000) });
      expect(startOf()).toBe(startsAt.toISOString());
      await searchPosts({
        ...raid,
        ruleVersion: 3,
        startsAt: new Date(Date.now() - 9 * 86400000),
        searchEndAt: endsAt,
      });
      const clamped = Date.parse(startOf()!);
      expect(clamped).toBeGreaterThan(Date.now() - 7 * 86400000);
      expect(clamped).toBeLessThan(Date.now() - 7 * 86400000 + 120000);
    });
  });
  describe('raid-specific search', () => {
    const queryOf = (fetcher: ReturnType<typeof vi.fn>, call: number) =>
      new URL(String(fetcher.mock.calls[call][0])).searchParams.get('query');
    beforeEach(async () => {
      await db.raid.update({ where: { id: raidId }, data: { ruleVersion: 3 } });
    });
    it('skips X entirely and still advances coverage when nobody is enrolled', async () => {
      await db.raidEnrollment.deleteMany({ where: { raidId } });
      const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetcher);
      await collect(raidId, 'empty');
      expect(fetcher).not.toHaveBeenCalled();
      expect(await db.providerUsage.count()).toBe(0);
      const raid = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
      expect(raid.searchEndAt).toBeNull();
      expect(raid.searchQuery).toBeNull();
      const job = await db.job.findFirstOrThrow({ where: { kind: 'refresh' } });
      expect(job.payload).toMatchObject({ raidId, final: false });
      expect((job.payload as { coveredUntil?: string }).coveredUntil).toBeTruthy();
    });
    it('persists the author filter for the whole window and clears it afterwards', async () => {
      const bob = await db.user.create({ data: { handle: 'bob', xId: 'bob' } });
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ data: [], meta: { next_token: 'page-2', newest_id: '9' } }),
          ),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], meta: {} })));
      vi.stubGlobal('fetch', fetcher);
      await collect(raidId, 'first');
      expect(queryOf(fetcher, 0)).toBe('@useRAID -is:retweet -is:reply (from:alice)');
      expect((await db.raid.findUniqueOrThrow({ where: { id: raidId } })).searchQuery).toBe(
        '@useRAID -is:retweet -is:reply (from:alice)',
      );
      await db.raidEnrollment.create({
        data: {
          raidId,
          userId: bob.id,
          xId: 'bob',
          walletAddress: Keypair.generate().publicKey.toBase58(),
        },
      });
      await collect(raidId, 'second');
      expect(queryOf(fetcher, 1)).toBe('@useRAID -is:retweet -is:reply (from:alice)');
      const raid = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
      expect(raid.searchQuery).toBeNull();
      expect(raid.searchEndAt).toBeNull();
    });
  });

  describe('money policies', () => {
    const measured = (id: string, views: number) =>
      xpost(id, {
        public_metrics: {
          like_count: 3,
          reply_count: 0,
          retweet_count: 0,
          quote_count: 0,
          impression_count: views,
        },
      });
    const fundedRaid = (impressionTarget = 1_000_000) =>
      db.raid.update({
        where: { id: raidId },
        data: { fundingStatus: 'VERIFIED', impressionTarget },
      });
    const endEarly = async () =>
      changeRaid(await db.user.findUniqueOrThrow({ where: { id: creatorId } }), raidId, 'end');
    const settled = async () => {
      await db.raid.update({
        where: { id: raidId },
        data: {
          finalRefreshed: true,
          coverage: 'complete',
          coveredUntil: new Date(),
          observedAt: new Date(),
          collectionError: null,
        },
      });
    };

    it('rejects the raid creator from joining their own raid', async () => {
      await expect(enrollRaid(raidId, creatorId)).rejects.toMatchObject({ status: 403 });
      expect(await db.raidEnrollment.count({ where: { userId: creatorId } })).toBe(0);
    });
    it('hides the join action from the creator', async () => {
      const view = await trackingView(raidId, creatorId);
      expect(view).toMatchObject({ isCreator: true, canJoin: false });
      expect(await trackingView(raidId, userId)).toMatchObject({ isCreator: false });
    });
    it('keeps measuring qualified posts after an early end, then settles on the original end', async () => {
      await fundedRaid();
      await ingestTracking(raidId, [measured('301', 100)]);
      const original = (await db.raid.findUniqueOrThrow({ where: { id: raidId } })).endsAt;
      const ended = await endEarly();
      expect(ended.measureUntil).toEqual(original);
      expect(+ended.endsAt).toBeLessThanOrEqual(Date.now());
      await expect(submitTrackingPost(raidId, userId, '302')).rejects.toMatchObject({
        status: 409,
      });
      await settled();
      await finalizeTracking(raidId);
      expect(await db.campaignResult.count({ where: { raidId } })).toBe(0);
      await schedule();
      expect(
        await db.job.count({ where: { key: { startsWith: `measure:${raidId}:` }, doneAt: null } }),
      ).toBe(1);
      const after = new Date(+original + 1000);
      await db.job.updateMany({ data: { doneAt: new Date() } });
      await finalizeTracking(raidId, after);
      expect(await db.campaignResult.count({ where: { raidId } })).toBe(0);
      await schedule(after);
      expect(
        await db.job.count({
          where: { key: { startsWith: `measure-final:${raidId}:` }, doneAt: null },
        }),
      ).toBe(1);
      await db.job.updateMany({ data: { doneAt: new Date() } });
      await db.post.updateMany({ where: { raidId }, data: { observedAt: after } });
      const result = await finalizeTracking(raidId, after);
      expect(result).toBeTruthy();
      expect(await db.campaignResult.count({ where: { raidId } })).toBe(1);
    });
    it('does not measure when nobody has posted', async () => {
      await fundedRaid();
      expect((await endEarly()).measureUntil).toBeNull();
    });
    it('finalizes without waiting once the impression target is already met', async () => {
      await fundedRaid(100);
      await ingestTracking(raidId, [measured('303', 100)]);
      expect((await endEarly()).measureUntil).not.toBeNull();
      await settled();
      await db.post.updateMany({ where: { raidId }, data: { observedAt: new Date() } });
      expect(await finalizeTracking(raidId)).toBeTruthy();
    });
  });
});
