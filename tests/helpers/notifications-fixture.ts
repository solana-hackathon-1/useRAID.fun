import { randomUUID } from 'node:crypto';

/** Server environment for the owned preview: only the notification reads flag, nothing live. */
export function notificationsBrowserEnvironment(): Record<string, string> {
  return {
    DEMO_MODE: 'false',
    ADMIN_X_IDS: '',
    X_ADMIN_USER_ID: '',
    USDC_NETWORK: 'devnet',
    NOTIFICATIONS_READS_ENABLED: 'true',
    NOTIFICATIONS_DISPATCH_ENABLED: 'false',
    WORK_WORKSPACE_READS_ENABLED: 'false',
    PRACTICE_PORTAL_READS_ENABLED: 'false',
    SKILL_ASSESSMENT_READS_ENABLED: 'false',
    SKILL_CLAIMS_ENABLED: 'false',
    RAIDER_ONBOARDING_ENABLED: 'false',
    ACCOUNT_FOLDS_ENABLED: 'false',
    WALLET_LINKS_ENABLED: 'false',
    LIVE_COLLECTION_APPROVED: 'false',
    LAUNCH_ENABLED: 'false',
    PAYOUT_ENABLED: 'false',
    X_TRACKING_V2_SETTLEMENT_ENABLED: 'false',
  };
}
/** Synthetic accepted engagement with a founder, worker and reviewer, each holding a browser session. */
export async function seedNotificationsFixture() {
  const [
    { db },
    { hash },
    { runCommandTransaction },
    { dispatchWorkNotifications },
    lifecycle,
    guard,
  ] = await Promise.all([
    import('../../src/lib/db'),
    import('../../src/lib/auth-primitives'),
    import('../../src/lib/command-receipts-adapter'),
    import('../../src/notifications/storage'),
    import('./work-lifecycle'),
    import('./db-guard'),
  ]);
  guard.assertTestDatabase();
  await guard.truncateAll(db);
  async function human(id: string) {
    const user = await db.user.create({ data: { id, handle: id, role: 'CREATOR' } });
    const participant = await db.participant.create({
      data: {
        accountId: user.id,
        provisionActorAccountId: user.id,
        provisionRequestId: 'synthetic-' + id,
      },
    });
    const cookie = randomUUID();
    await db.session.create({
      data: {
        tokenHash: hash(cookie),
        userId: user.id,
        via: 'wallet',
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    return {
      id,
      cookie,
      participantId: participant.id,
      actor: { accountId: id, sessionHash: hash(cookie) },
    };
  }
  const founder = await human('founder-synthetic');
  const reviewer = await human('reviewer-synthetic');
  const stranger = await human('stranger-synthetic');
  const engagement = await lifecycle.seedEngagement(
    db,
    {
      title: 'SECRET-TITLE-IN-NOTIFICATION',
      outcome: 'SECRET-OUTCOME',
      publicSummary: 'SECRET-SUMMARY',
    },
    { founderId: founder.id, reviewer },
  );
  const workerId = engagement.worker.actor.accountId;
  const cookie = randomUUID();
  await db.session.create({
    data: {
      tokenHash: hash(cookie),
      userId: workerId,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const worker = { id: workerId, cookie };
  const dispatch = () =>
    runCommandTransaction(db, (tx) => dispatchWorkNotifications(tx, { limit: 100 }));
  return { db, founder, reviewer, stranger, worker, engagement, dispatch };
}
