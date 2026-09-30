import 'dotenv/config';
import { db } from '../src/lib/db';
import { ingestTracking } from '../src/lib/tracking';

if (new URL(process.env.DATABASE_URL || 'http://invalid').pathname !== '/useraid_dev')
  throw new Error('Local tracking preview requires isolated useraid_dev database.');
if (process.env.X_TRACKING_V2_ENABLED !== 'true')
  throw new Error('Enable X_TRACKING_V2_ENABLED for local preview.');

const raidId = 'local-tracking-fixture';
const mint = 'So11111111111111111111111111111111111111112';
const now = new Date();
try {
  const creator = await db.user.upsert({
    where: { xId: 'fixture-creator' },
    create: { xId: 'fixture-creator', handle: 'local-fixture-creator', approved: true },
    update: {},
  });
  await db.token.upsert({
    where: { mint },
    create: { mint, name: 'Local Test Fixture', symbol: 'LOCAL' },
    update: {},
  });
  await db.raid.upsert({
    where: { id: raidId },
    create: {
      id: raidId,
      tag: 'raid_local_fixture',
      title: 'Local tracking fixture — no X or SOL',
      description:
        'Sample posts and engagement generated locally to inspect tracking UI. No X request or payout occurred.',
      mint,
      creatorId: creator.id,
      startsAt: new Date(+now - 3600000),
      endsAt: new Date(+now + 24 * 3600000),
      status: 'ACTIVE',
      trackingVersion: 2,
      ruleVersion: 2,
      scoringVersion: 2,
      coverage: 'unavailable',
    },
    update: {},
  });
  const participants = [
    { xId: 'fixture-alice', handle: 'fixture_alice', wallet: '11111111111111111111111111111111' },
    {
      xId: 'fixture-bob',
      handle: 'fixture_bob',
      wallet: 'SysvarRent111111111111111111111111111111111',
    },
  ];
  for (const participant of participants) {
    const user = await db.user.upsert({
      where: { xId: participant.xId },
      create: { xId: participant.xId, handle: participant.handle },
      update: {},
    });
    await db.raidEnrollment.upsert({
      where: { raidId_xId: { raidId, xId: participant.xId } },
      create: {
        raidId,
        userId: user.id,
        xId: participant.xId,
        walletAddress: participant.wallet,
        joinedAt: new Date(+now - 30 * 60000),
      },
      update: {},
    });
  }
  const posts = [
    {
      id: '990000000000000001',
      author_id: 'fixture-alice',
      text: 'Sample community update @useRAID #raid_local_fixture',
      created_at: new Date(+now - 20 * 60000).toISOString(),
      likes: 20,
    },
    {
      id: '990000000000000002',
      author_id: 'fixture-bob',
      text: 'Another sample community post @useRAID #raid_local_fixture',
      created_at: new Date(+now - 10 * 60000).toISOString(),
      likes: 9,
    },
    {
      id: '990000000000000003',
      author_id: 'fixture-alice',
      text: 'Sample community update @useRAID #raid_local_fixture',
      created_at: new Date(+now - 5 * 60000).toISOString(),
      likes: 100,
    },
  ];
  for (const post of posts) {
    if (await db.post.findUnique({ where: { id: post.id } })) continue;
    await ingestTracking(
      raidId,
      [
        {
          id: post.id,
          author_id: post.author_id,
          text: post.text,
          created_at: post.created_at,
          entities: {
            mentions: [{ username: 'useRAID' }],
            hashtags: [{ tag: 'raid_local_fixture' }],
          },
          public_metrics: {
            like_count: post.likes,
            reply_count: 1,
            retweet_count: 2,
            quote_count: 0,
          },
        },
      ],
      { source: 'LOCAL_FIXTURE', sampleKey: `fixture:${post.id}` },
    );
  }
  console.log('Local tracking fixture ready: http://localhost:3000/raids/local-tracking-fixture');
} finally {
  await db.$disconnect();
}
