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
  type ResultPayload,
} from '../src/lib/tracking-review';
import { trackingView } from '../src/lib/tracking-view';
import { scoreContributions } from '../src/lib/tracking-domain';
import { processTrackingLookup } from '../src/lib/tracking-worker';
import { settleNextRound } from '../src/lib/rewards';
import { collect, refresh } from '../src/lib/collection';
import { claimJob, finishJob } from '../src/lib/queue';
import type { XPost } from '../src/lib/domain';
const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
suite('tracking v2 database lifecycle', () => {
  let raidId: string, userId: string, adminId: string, launchId: string;
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
    if (new URL(process.env.DATABASE_URL || 'http://invalid').pathname !== '/useraid_test')
      throw Error('Use dedicated useraid_test database.');
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
    await db.$executeRawUnsafe(
      'TRUNCATE "User", "Token", "Job", "Settings", "ProviderUsage", "XEndpointState" CASCADE',
    );
    const user = await db.user.create({ data: { handle: 'alice', xId: 'alice', approved: true } });
    userId = user.id;
    adminId = (await db.user.create({ data: { handle: 'admin', role: 'ADMIN' } })).id;
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
        creatorId: userId,
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
    expect(draft.scoringVersion).toBe(2);
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
        creatorId: userId,
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
        creatorId: userId,
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
      '@useRAID -is:retweet -is:reply',
      '@useRAID -is:retweet -is:reply',
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
        creatorId: userId,
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
  it('stops new tracking mutations when gate closes', async () => {
    vi.stubEnv('X_TRACKING_V2_ENABLED', 'false');
    await expect(submitTrackingPost(raidId, userId, '130')).rejects.toMatchObject({ status: 503 });
    await expect(ingestTracking(raidId, [xpost('130')])).rejects.toMatchObject({ status: 503 });
    vi.stubEnv('X_TRACKING_V2_ENABLED', 'true');
  });
});
