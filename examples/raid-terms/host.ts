import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
interface PgConnection {
  query(
    sql: string,
    bindings?: readonly (string | null)[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}
interface PgClient extends PgConnection {
  release(): void;
}
interface PgPool extends PgConnection {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}
const { Pool } = createRequire(import.meta.url)('pg') as {
  Pool: new (options: { connectionString: string }) => PgPool;
};
import {
  retryWholeTransaction,
  CommandReceiptError,
  type CommandReceiptTransaction,
} from './command-receipts';
import { saveRaidTerms, publishRaid, readRaidTerms } from './work-loop/storage';
import type { WorkHost } from './work-loop/contracts';
import type { LockTransaction } from './identity-locks';
import { commitEngagement } from './work-loop/engagement-storage';
import type { AcceptanceHost } from './work-loop/engagement-contracts';
import { submitApplication, issueOffer } from './work-loop/admission-storage';
import type { AdmissionHost } from './work-loop/admission-contracts';
import { submitWork, decideReview } from './work-loop/submission-storage';
import type { SubmissionHost } from './work-loop/submission-contracts';
import { closeOverdueEngagement, readOwnEngagementClosure } from './work-loop/closure-storage';
import type { ClosureHost } from './work-loop/closure-contracts';
import {
  proposeAmendment,
  respondToAmendment,
  readEffectiveTerms,
} from './work-loop/amendment-storage';
import type { AmendmentHost } from './work-loop/amendment-contracts';
import { reissueRaid } from './work-loop/replacement-storage';
import { raidTerms } from './fixture';
import { AssetPolicySnapshotSchema, assetKey } from './contracts/assets';
import { recommend, reviewChoices } from './work-loop/recommendation';
import { readCreationDrafts } from './work-loop/creation-storage';
import {
  dispatchWorkNotifications,
  listOwnNotifications,
  markNotificationRead,
} from './notifications/storage';
import {
  saveWizardIntent,
  writeWizardRecovery,
  readWizardRecovery,
  clearWizardRecovery,
} from './work-loop/creation-recovery';
import { toDraftView } from './work-loop/creation-contracts';
import { buildTerms, defaultWizardForm } from './work-loop/creation-form';
import { createSimulatedReservations } from './work-loop/simulated-reservation';
import { exampleInput, exampleRubric } from './recommendation-fixture';
const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(url.pathname, '/raid_terms_example');
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
  'Use the dedicated loopback example database.',
);
const pool = new Pool({ connectionString: url.toString() });
async function transaction<T>(work: (tx: CommandReceiptTransaction) => Promise<T>): Promise<T> {
  return retryWholeTransaction(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const port: CommandReceiptTransaction & LockTransaction = {
        identityLayout: { xKeyColumn: null, children: ['Session', 'Participant'] },
        dialect: 'POSTGRESQL',
        isolation: 'READ_COMMITTED',
        async query<Row>(sql: string, bindings: readonly (string | null)[]) {
          try {
            return (await client.query(sql, [...bindings])).rows as Row[];
          } catch (error) {
            const code = (error as { code?: string }).code;
            throw new CommandReceiptError(
              code === '40P01' || code === '40001' ? 'RETRY_TRANSACTION' : 'STORAGE_UNAVAILABLE',
            );
          }
        },
      };
      const result = await work(port);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}
const actor = { accountId: 'synthetic-owner', sessionHash: 'a'.repeat(64) },
  guild = 'synthetic-guild';
const command = (input: unknown, key: string = randomUUID()) => ({
  actor,
  input,
  idempotencyKey: key,
  requestId: 'example:' + key,
});
try {
  // This host owns its own authority/session and reservation records. No RAID auth/Prisma/Next import.
  await pool.query(
    'CREATE TABLE "User" ("id" text PRIMARY KEY, "suspended" boolean NOT NULL DEFAULT false); CREATE TABLE "HostSession" ("hash" text PRIMARY KEY,"accountId" text NOT NULL REFERENCES "User", "expiresAt" timestamptz NOT NULL); CREATE TABLE "HostGuildAuthority" ("guildId" text PRIMARY KEY,"accountId" text NOT NULL REFERENCES "User"); CREATE TABLE "HostReservation" ("slotId" uuid PRIMARY KEY,"termsVersionId" uuid NOT NULL,"digest" text NOT NULL); CREATE TABLE "HostAmendmentReservation" ("amendmentId" uuid PRIMARY KEY,"digest" text NOT NULL); CREATE TABLE "HostAmendmentConsent" ("amendmentId" uuid NOT NULL,"participantId" uuid NOT NULL,"digest" text NOT NULL,PRIMARY KEY ("amendmentId","participantId"))',
  );
  await pool.query(`
    CREATE TABLE "Session" ("tokenHash" text PRIMARY KEY,"userId" text NOT NULL REFERENCES "User","via" text NOT NULL,"expiresAt" timestamp(3) NOT NULL);
    CREATE TABLE "Participant" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),"accountId" text NOT NULL UNIQUE REFERENCES "User" ON DELETE RESTRICT ON UPDATE RESTRICT,"kind" text NOT NULL DEFAULT 'HUMAN' CHECK ("kind"='HUMAN'));
    CREATE TABLE "WalletIdentity" ("address" text PRIMARY KEY,"userId" text NOT NULL REFERENCES "User");
    CREATE TABLE "WalletLink" ("id" uuid PRIMARY KEY,"address" text NOT NULL,"accountId" text NOT NULL REFERENCES "User");
    CREATE TABLE "HostAcceptance" ("slotId" uuid NOT NULL,"termsVersionId" uuid NOT NULL,"participantId" uuid NOT NULL REFERENCES "Participant","consentRef" text NOT NULL,"beneficiaryRef" text NOT NULL,"eligibilityPolicyVersion" text NOT NULL,PRIMARY KEY ("slotId","participantId"));
    CREATE FUNCTION host_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic canonical identity is immutable'; END $$;
    CREATE TRIGGER participant_immutable BEFORE UPDATE OR DELETE ON "Participant" FOR EACH ROW EXECUTE FUNCTION host_identity_immutable();
  `);
  for (const file of [
    'migrations/receipts.sql',
    'migrations/terms.sql',
    'migrations/capacity.sql',
    'migrations/admission.sql',
    'migrations/submissions.sql',
    'migrations/closure.sql',
    'migrations/simulated-reservations.sql',
    'migrations/notifications.sql',
    'migrations/amendments.sql',
    'migrations/reservation-binding.sql',
  ])
    await pool.query(await readFile(new URL(file, import.meta.url), 'utf8'));
  await pool.query('INSERT INTO "User" ("id") VALUES ($1)', [actor.accountId]);
  await pool.query(
    'INSERT INTO "HostSession" VALUES ($1,$2,clock_timestamp()+interval \'1 hour\')',
    [actor.sessionHash, actor.accountId],
  );
  await pool.query('INSERT INTO "HostGuildAuthority" VALUES ($1,$2)', [guild, actor.accountId]);
  const host: WorkHost = {
    allowNewWrites: true,
    async authorize(tx, a, g) {
      const rows = await tx.query(
        'SELECT u."id" FROM "User" u JOIN "HostSession" s ON s."accountId"=u."id" JOIN "HostGuildAuthority" g ON g."accountId"=u."id" WHERE u."id"=$1 AND s."hash"=$2 AND g."guildId"=$3 AND NOT u."suspended" AND s."expiresAt">clock_timestamp() FOR SHARE OF u,s,g',
        [a.accountId, a.sessionHash, g],
      );
      return rows.length === 1;
    },
    async reserveSimulatedFunding(tx, b) {
      // Explicit synthetic reservation, not a real balance or claimed on-chain funding.
      await tx.query(
        'INSERT INTO "HostReservation" VALUES ($1::uuid,$2::uuid,$3) RETURNING "slotId"',
        [b.slotId, b.termsVersionId, JSON.stringify(b.terms.rewards)],
      );
      return 'synthetic:' + b.slotId;
    },
  };
  // Advice is optional, versioned and never authoritative: the Founder's typed terms alone decide publication.
  const advice = recommend(exampleInput(), exampleRubric());
  assert.equal(advice.authoritative, false);
  assert.equal(advice.rubricEvaluation, 'UNEVALUATED_EXAMPLE');
  const advised = reviewChoices(advice, {
    difficulty: raidTerms().difficulty,
    requiredSkills: raidTerms().requiredSkills.map((s) => ({
      skillId: s.skillId,
      minimumRank: s.minimumRank,
    })),
    participantKinds: ['HUMAN'],
    rewards: raidTerms().rewards.map((r) => ({ policy: r.policy, amount: r.amount })),
  });
  assert.equal(advised.suggestion.policyVersion, 'example-rubric-v1');
  assert.ok(advised.gaps.every((gap) => gap.explanation.length > 0));
  const input = { listingId: null, expectedRevision: 0, guildId: guild, terms: raidTerms() },
    c = command(input);
  const saved = await transaction((tx) => saveRaidTerms(tx, c, host));
  assert.equal(saved.terms.outcome, input.terms.outcome);
  const published = await transaction((tx) =>
    publishRaid(
      tx,
      command({ listingId: saved.listingId, termsVersionId: saved.termsVersionId }),
      host,
    ),
  );
  assert.equal(published.fundingMode, 'SIMULATED');
  assert.equal((await pool.query('SELECT * FROM "HostReservation"')).rowCount, 1);
  assert.equal(
    (await transaction((tx) => saveRaidTerms(tx, c, { ...host, allowNewWrites: false }))).status,
    'REPLAYED',
  );
  // Alternate current authorization policy is still bounded to the same actual saved authority.
  const alternate: WorkHost = {
    ...host,
    authorize: async (tx, a, g) =>
      g === guild && (await host.authorize(tx, a, g, 'MANAGE_LISTING')),
  };
  assert.equal(
    (await transaction((tx) => readRaidTerms(tx, actor, saved.termsVersionId, alternate)))
      .termsVersionId,
    saved.termsVersionId,
  );
  await pool.query(
    "INSERT INTO \"Session\" VALUES ($1,$2,'wallet',(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 hour')",
    [actor.sessionHash, actor.accountId],
  );
  // Actual minimal canonical HUMAN identity/session and exact-source consent owned by this host.
  const member = { accountId: 'synthetic-member', sessionHash: 'b'.repeat(64) };
  await pool.query('INSERT INTO "User" ("id") VALUES ($1)', [member.accountId]);
  await pool.query(
    "INSERT INTO \"Session\" VALUES ($1,$2,'wallet',(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 hour')",
    [member.sessionHash, member.accountId],
  );
  const participant = (
    await pool.query('INSERT INTO "Participant" ("accountId") VALUES ($1) RETURNING "id"::text', [
      member.accountId,
    ])
  ).rows[0] as { id: string };
  await pool.query('INSERT INTO "HostAcceptance" VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6)', [
    published.slotId,
    saved.termsVersionId,
    participant.id,
    'synthetic-explicit-consent',
    'synthetic-fixed-beneficiary',
    'synthetic-eligibility-v1',
  ]);
  const acceptance: AcceptanceHost = {
    allowNewWrites: true,
    async assess(tx, c) {
      const found = await tx.query<{
        consentRef: string;
        beneficiaryRef: string;
        eligibilityPolicyVersion: string;
      }>(
        'SELECT "consentRef","beneficiaryRef","eligibilityPolicyVersion" FROM "HostAcceptance" WHERE "slotId"=$1::uuid AND "termsVersionId"=$2::uuid AND "participantId"=$3::uuid FOR SHARE',
        [c.slotId, c.termsVersionId, c.participantId],
      );
      return found.length === 1 ? { ...found[0], operatorId: null } : null;
    },
    async fundingAvailable(tx, b) {
      const found = await tx.query(
        'SELECT "slotId" FROM "HostReservation" WHERE "slotId"=$1::uuid AND "termsVersionId"=$2::uuid AND "digest"=$3 FOR SHARE',
        [b.slotId, b.termsVersionId, JSON.stringify(b.terms.rewards)],
      );
      return b.fundingRef === 'synthetic:' + b.slotId && found.length === 1;
    },
  };
  const commit = {
    actor: member,
    input: { slotId: published.slotId, termsVersionId: saved.termsVersionId },
    idempotencyKey: 'synthetic-commit',
    requestId: 'synthetic-commit',
  };
  const engagement = await transaction((tx) => commitEngagement(tx, commit, acceptance));
  assert.equal(engagement.engagement.state, 'ACCESS_PENDING');
  assert.equal(engagement.engagement.acceptedTerms.roster[0].participantId, participant.id);
  assert.equal((await pool.query('SELECT * FROM "ActiveCommitment"')).rowCount, 1);
  assert.equal(
    (
      await transaction((tx) =>
        commitEngagement(tx, commit, {
          ...acceptance,
          allowNewWrites: false,
          assess: async () => null,
          fundingAvailable: async () => false,
        }),
      )
    ).status,
    'REPLAYED',
  );
  const otherTerms = await transaction((tx) => saveRaidTerms(tx, command(input), host));
  const otherSlot = await transaction((tx) =>
    publishRaid(
      tx,
      command({ listingId: otherTerms.listingId, termsVersionId: otherTerms.termsVersionId }),
      host,
    ),
  );
  await pool.query('INSERT INTO "HostAcceptance" VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6)', [
    otherSlot.slotId,
    otherTerms.termsVersionId,
    participant.id,
    'synthetic-second-consent',
    'synthetic-fixed-beneficiary',
    'synthetic-eligibility-v1',
  ]);
  await assert.rejects(
    transaction((tx) =>
      commitEngagement(
        tx,
        {
          ...commit,
          input: { slotId: otherSlot.slotId, termsVersionId: otherTerms.termsVersionId },
          idempotencyKey: 'second-intent',
        },
        acceptance,
      ),
    ),
    (error: unknown) => (error as { code: string }).code === 'CAPACITY_CONFLICT',
  );
  assert.equal((await pool.query('SELECT * FROM "Engagement"')).rowCount, 1);
  const admissions: AdmissionHost = {
    allowNewWrites: true,
    applicationLimit: 5,
    authorize: host.authorize,
  };
  const appTerms = await transaction((tx) =>
    saveRaidTerms(
      tx,
      command({ ...input, terms: { ...input.terms, admission: 'APPLICATION' } }),
      host,
    ),
  );
  const appSlot = await transaction((tx) =>
    publishRaid(
      tx,
      command({ listingId: appTerms.listingId, termsVersionId: appTerms.termsVersionId }),
      host,
    ),
  );
  const applicantCommand = (input: unknown) => ({ ...command(input), actor: member });
  const application = await transaction((tx) =>
    submitApplication(
      tx,
      applicantCommand({
        slotId: appSlot.slotId,
        termsVersionId: appTerms.termsVersionId,
        evidenceRefs: ['synthetic:portfolio'],
      }),
      admissions,
    ),
  );
  const offer = await transaction((tx) =>
    issueOffer(
      tx,
      command({
        applicationId: application.application.id,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      admissions,
    ),
  );
  await pool.query('INSERT INTO "HostAcceptance" VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6)', [
    appSlot.slotId,
    appTerms.termsVersionId,
    participant.id,
    'synthetic-offer-consent',
    'synthetic-beneficiary',
    'synthetic-eligibility-v1',
  ]);
  await assert.rejects(
    transaction((tx) =>
      commitEngagement(
        tx,
        applicantCommand({
          slotId: appSlot.slotId,
          termsVersionId: appTerms.termsVersionId,
          offerId: offer.offer.id,
        }),
        acceptance,
      ),
    ),
    (e: unknown) => (e as { code: string }).code === 'CAPACITY_CONFLICT',
  );
  // A separate current candidate accepts the same exact slot after the first candidate is busy.
  const candidate = { accountId: 'synthetic-candidate', sessionHash: 'c'.repeat(64) };
  await pool.query('INSERT INTO "User" ("id") VALUES ($1)', [candidate.accountId]);
  await pool.query(
    "INSERT INTO \"Session\" VALUES ($1,$2,'wallet',(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 hour')",
    [candidate.sessionHash, candidate.accountId],
  );
  const p2 = (
    await pool.query('INSERT INTO "Participant" ("accountId") VALUES ($1) RETURNING "id"::text', [
      candidate.accountId,
    ])
  ).rows[0] as { id: string };
  const candidateCommand = (input: unknown) => ({ ...command(input), actor: candidate });
  const a2 = await transaction((tx) =>
    submitApplication(
      tx,
      candidateCommand({
        slotId: appSlot.slotId,
        termsVersionId: appTerms.termsVersionId,
        evidenceRefs: [],
      }),
      admissions,
    ),
  );
  const o2 = await transaction((tx) =>
    issueOffer(
      tx,
      command({
        applicationId: a2.application.id,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      admissions,
    ),
  );
  await pool.query('INSERT INTO "HostAcceptance" VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6)', [
    appSlot.slotId,
    appTerms.termsVersionId,
    p2.id,
    'synthetic-second-offer-consent',
    'synthetic-beneficiary-2',
    'synthetic-eligibility-v1',
  ]);
  const selected = await transaction((tx) =>
    commitEngagement(
      tx,
      candidateCommand({
        slotId: appSlot.slotId,
        termsVersionId: appTerms.termsVersionId,
        offerId: o2.offer.id,
      }),
      acceptance,
    ),
  );
  assert.equal(selected.engagement.state, 'ACCESS_PENDING');
  const previousOffer = (
    await pool.query('SELECT "state" FROM "RaidOffer" WHERE "id"=$1::uuid', [offer.offer.id])
  ).rows[0] as { state: string };
  assert.equal(previousOffer.state, 'REVOKED');
  await pool.query('DELETE FROM "Session" WHERE "tokenHash"=$1', [member.sessionHash]);
  await assert.rejects(
    transaction((tx) => commitEngagement(tx, commit, acceptance)),
    (error: unknown) => (error as { code: string }).code === 'UNAUTHENTICATED',
  );
  assert.equal(
    (await pool.query('SELECT * FROM "ActiveCommitment"')).rowCount,
    2,
    'Session loss does not close work.',
  );
  // Binding/access start is another module's job; the host moves the engagement through the guarded transition.
  const reviewer = { accountId: 'reviewer', sessionHash: 'd'.repeat(64) };
  await pool.query('INSERT INTO "User" ("id") VALUES ($1)', [reviewer.accountId]);
  await pool.query(
    "INSERT INTO \"Session\" VALUES ($1,$2,'wallet',(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 hour')",
    [reviewer.sessionHash, reviewer.accountId],
  );
  await pool.query(
    'UPDATE "Engagement" SET "state"=\'IN_PROGRESS\',"revision"="revision"+1 WHERE "id"=$1::uuid',
    [selected.engagement.id],
  );
  // A consented amendment: the Founder's proposal changes nothing until the affected member agrees to its exact digest.
  const amendments: AmendmentHost = {
    allowNewWrites: true,
    authorize: (tx, a, target) => host.authorize(tx, a, target.guildId, 'MANAGE_LISTING'),
    async reserveAdditionalFunding(tx, b) {
      await tx.query(
        'INSERT INTO "HostAmendmentReservation" VALUES ($1::uuid,$2) RETURNING "amendmentId"',
        [b.amendmentId, JSON.stringify(b.increase)],
      );
      return 'synthetic-increase:' + b.amendmentId;
    },
    async fundingAvailable(tx, b) {
      const held = await tx.query(
        'SELECT 1 FROM "HostAmendmentReservation" WHERE "amendmentId"=$1::uuid',
        [b.amendmentId],
      );
      return held.length === 1;
    },
    async assessConsent(tx, c) {
      const agreed = await tx.query(
        'SELECT 1 FROM "HostAmendmentConsent" WHERE "amendmentId"=$1::uuid AND "participantId"=$2::uuid AND "digest"=$3',
        [c.amendmentId, c.participantId, c.digest],
      );
      return agreed.length === 1
        ? { consentRef: 'synthetic-amendment-consent:' + c.amendmentId }
        : null;
    },
  };
  const originalReward = selected.engagement.acceptedTerms.rewards[0].amount;
  const raisedReward = String(BigInt(originalReward) + 500000000n);
  const proposal = await transaction((tx) =>
    proposeAmendment(
      tx,
      command({
        engagementId: selected.engagement.id,
        changes: { rewards: [{ amount: raisedReward }] },
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      amendments,
    ),
  );
  assert.equal(proposal.amendment.state, 'PROPOSED');
  assert.equal(proposal.amendment.requiresFunding, true);
  const before = await transaction((tx) =>
    readEffectiveTerms(tx, candidate, selected.engagement.id),
  );
  assert.equal(before.rewards[0].amount, originalReward, 'A proposal changes no effective term.');
  await assert.rejects(
    transaction((tx) =>
      respondToAmendment(
        tx,
        candidateCommand({ amendmentId: proposal.amendment.id, decision: 'ACCEPT' }),
        amendments,
      ),
    ),
    (e: unknown) => (e as { code: string }).code === 'CONSENT_REQUIRED',
  );
  await assert.rejects(
    transaction((tx) =>
      respondToAmendment(
        tx,
        { ...command({ amendmentId: proposal.amendment.id, decision: 'ACCEPT' }), actor },
        amendments,
      ),
    ),
    (e: unknown) => (e as { code: string }).code === 'FORBIDDEN',
    'The Founder has no member authority to consent.',
  );
  await pool.query('INSERT INTO "HostAmendmentConsent" VALUES ($1::uuid,$2::uuid,$3)', [
    proposal.amendment.id,
    p2.id,
    proposal.amendment.digest,
  ]);
  const agreed = await transaction((tx) =>
    respondToAmendment(
      tx,
      candidateCommand({ amendmentId: proposal.amendment.id, decision: 'ACCEPT' }),
      amendments,
    ),
  );
  assert.equal(agreed.amendment.state, 'ACCEPTED');
  const after = await transaction((tx) =>
    readEffectiveTerms(tx, candidate, selected.engagement.id),
  );
  assert.equal(after.rewards[0].amount, raisedReward);
  const original = (
    await pool.query('SELECT "acceptedTerms" FROM "Engagement" WHERE "id"=$1::uuid', [
      selected.engagement.id,
    ])
  ).rows[0] as { acceptedTerms: { rewards: { amount: string }[] } };
  assert.equal(
    original.acceptedTerms.rewards[0].amount,
    originalReward,
    'Original terms are kept.',
  );
  const submissions: SubmissionHost = { allowNewWrites: true };
  const submission = (n: number) =>
    candidateCommand({
      engagementId: selected.engagement.id,
      expectedSubmissionNumber: n,
      explanation: 'Synthetic guide written and verified.',
      artifacts: [
        { kind: 'COMMIT', ref: 'synthetic://repo/setup.md', immutableVersion: 'b'.repeat(40) },
      ],
      dependencies: [],
      aiUsage: null,
    });
  const decision = (
    submissionId: string,
    decisionKind: string,
    result: string,
    deadline: string | null,
  ) => ({
    ...command({
      submissionId,
      decision: decisionKind,
      reason: 'Reviewed against the accepted criterion.',
      criteria: [{ index: 0, result, evidence: null }],
      revisionDeadline: deadline,
    }),
    actor: reviewer,
  });
  const first = await transaction((tx) => submitWork(tx, submission(1), submissions));
  assert.equal(first.engagementState, 'SUBMITTED');
  await assert.rejects(
    transaction((tx) =>
      decideReview(
        tx,
        { ...decision(first.submission.id, 'ACCEPT', 'MET', null), actor: candidate },
        submissions,
      ),
    ),
    (e: unknown) => (e as { code: string }).code === 'FORBIDDEN',
  );
  const revision = await transaction((tx) =>
    decideReview(
      tx,
      decision(
        first.submission.id,
        'REQUEST_REVISION',
        'UNMET',
        new Date(Date.now() + 3600000).toISOString(),
      ),
      submissions,
    ),
  );
  assert.equal(revision.engagementState, 'REVISION_REQUESTED');
  const second = await transaction((tx) => submitWork(tx, submission(2), submissions));
  const closed = await transaction((tx) =>
    decideReview(tx, decision(second.submission.id, 'ACCEPT', 'MET', null), submissions),
  );
  assert.equal(closed.engagementState, 'ACCEPTED');
  const own = await transaction((tx) =>
    readOwnEngagementClosure(tx, candidate, selected.engagement.id),
  );
  assert.equal(own.closure.reason, 'ACCEPTED');
  assert.equal(own.claims[0].status, 'UNSETTLED', 'Closing work leaves the claim unsettled.');
  assert.equal(own.claims[0].amount, raisedReward, 'The claim follows the agreed amendment.');
  // Operations closure is deadline-gated: the first member's pending engagement is not yet overdue.
  const closures: ClosureHost = {
    allowNewWrites: true,
    authorize: async (_tx, a) => a.accountId === reviewer.accountId,
  };
  const pendingEngagement = (
    await pool.query(
      'SELECT "id"::text,"revision" FROM "Engagement" WHERE "state"=\'ACCESS_PENDING\' ORDER BY "createdAt" LIMIT 1',
    )
  ).rows[0] as { id: string; revision: number };
  await assert.rejects(
    transaction((tx) =>
      closeOverdueEngagement(
        tx,
        {
          ...command({
            engagementId: pendingEngagement.id,
            expectedRevision: pendingEngagement.revision,
          }),
          actor: reviewer,
        },
        closures,
      ),
    ),
    (e: unknown) => (e as { code: string }).code === 'DEADLINE_NOT_REACHED',
  );
  // Safe in-app notifications: derived from outbox events, deduplicated, identifier-only and own-record only.
  const dispatched = await transaction((tx) => dispatchWorkNotifications(tx, { limit: 100 }));
  assert.ok(dispatched.created > 0, 'Work events become notifications.');
  const again = await transaction((tx) => dispatchWorkNotifications(tx, { limit: 100 }));
  assert.equal(again.created, 0, 'A repeated job creates no duplicate notification.');
  const mine = await transaction((tx) => listOwnNotifications(tx, candidate));
  assert.ok(mine.items.some((n) => n.kind === 'ENGAGEMENT_ACCEPTED'));
  assert.ok(
    mine.items.every((n) => /^\/(raider|creator)\/work$/.test(n.link) && n.message.length < 120),
    'Notifications carry fixed text and an in-product path only.',
  );
  await transaction((tx) => markNotificationRead(tx, candidate, mine.items[0].id));
  await assert.rejects(
    transaction((tx) => markNotificationRead(tx, reviewer, mine.items[0].id)),
    (e: unknown) => (e as { code: string }).code === 'NOT_FOUND',
    'Another person cannot read or mark it.',
  );
  // Wizard path: form -> exact typed terms -> draft saved, and a partly covered reward is never published.
  const solPolicy = AssetPolicySnapshotSchema.parse(raidTerms().rewards[0].policy);
  const catalog = [
    { label: 'Synthetic SOL', policy: solPolicy, funded: true },
    {
      label: 'Synthetic token',
      policy: AssetPolicySnapshotSchema.parse({
        ...solPolicy,
        assetId: {
          chain: 'SOLANA',
          networkIdentity: 'synthetic-work',
          kind: 'TOKEN',
          mint: '11111111111111111111111111111111',
          tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        },
        verifiedDecimals: 6,
      }),
      funded: false,
    },
  ];
  const sample = raidTerms();
  const built = buildTerms(
    {
      ...defaultWizardForm(),
      title: 'Wizard guide',
      publicSummary: 'A guide.',
      category: 'documentation',
      outcome: sample.outcome,
      deliverables: sample.deliverables.join('\n'),
      acceptanceCriteria: sample.acceptanceCriteria.join('\n'),
      skills: [{ skillId: 'writing', minimumRank: 'E', assessmentPolicyVersion: 'starter-v1' }],
      rewards: [
        { assetKey: assetKey(catalog[0].policy.assetId), amount: '1.5' },
        { assetKey: assetKey(catalog[1].policy.assetId), amount: '2.5' },
      ],
      reviewerAccountId: 'reviewer',
    },
    catalog,
    new Date(),
  );
  assert.ok(built.ok, 'The form builds exact typed terms.');
  const wizardHost: WorkHost = {
    ...host,
    reserveSimulatedFunding: createSimulatedReservations(catalog),
  };
  const initialSaveKey = randomUUID();
  const draftSaved = await transaction((tx) =>
    saveRaidTerms(
      tx,
      command(
        { listingId: null, expectedRevision: 0, guildId: guild, terms: built.terms },
        initialSaveKey,
      ),
      wizardHost,
    ),
  );
  await assert.rejects(
    transaction((tx) =>
      publishRaid(
        tx,
        command({ listingId: draftSaved.listingId, termsVersionId: draftSaved.termsVersionId }),
        wizardHost,
      ),
    ),
    (e: unknown) => (e as { code: string }).code === 'FUNDING_REQUIRED',
    'One uncovered asset blocks the whole reward.',
  );
  const drafts = await transaction((tx) => readCreationDrafts(tx, actor, wizardHost));
  assert.ok(
    drafts.some((d) => d.listingId === draftSaved.listingId && d.state === 'DRAFT' && !d.reserved),
  );
  // Independent recovery consumer: an unconfirmed committed save is replayed before edited intent.
  const storeValues = new Map<string, string>();
  const store = {
    get length() {
      return storeValues.size;
    },
    key: (i: number) => [...storeValues.keys()][i] ?? null,
    getItem: (key: string) => storeValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storeValues.set(key, value);
    },
    removeItem: (key: string) => {
      storeValues.delete(key);
    },
  };
  const edited = { ...built.terms, title: 'Edited after unconfirmed first save' };
  writeWizardRecovery(store, {
    version: 'v1',
    accountId: actor.accountId,
    form: defaultWizardForm(),
    binding: null,
    pending: {
      input: { listingId: null, expectedRevision: 0, terms: built.terms },
      key: initialSaveKey,
      fingerprint: 'original',
    },
  });
  const restored = readWizardRecovery(store, actor.accountId);
  assert.ok(restored);
  assert.equal(readWizardRecovery(store, 'other-account'), null);
  const observedKeys: string[] = [];
  const recovered = await saveWizardIntent({
    recovery: restored,
    input: { listingId: null, expectedRevision: 0, terms: edited },
    fingerprint: 'edited',
    key: randomUUID(),
    persist: (value) => writeWizardRecovery(store, value),
    save: async (input, key) => {
      observedKeys.push(key);
      return transaction(async (tx) => {
        const saved = await saveRaidTerms(
          tx,
          command({ ...input, guildId: guild }, key),
          wizardHost,
        );
        const [exact] = await readCreationDrafts(tx, actor, wizardHost, {
          listingId: saved.listingId,
          termsVersionId: saved.termsVersionId,
        });
        return { status: saved.status, draft: toDraftView(exact, catalog) };
      });
    },
  });
  assert.equal(recovered.draft.listingId, draftSaved.listingId);
  assert.equal(recovered.draft.revision, 2);
  assert.equal(recovered.draft.terms.title, edited.title);
  assert.equal(observedKeys[0], initialSaveKey);
  assert.equal(observedKeys.length, 2);
  clearWizardRecovery(store, actor.accountId);
  assert.equal(readWizardRecovery(store, actor.accountId), null);
  // Only a terminated attempt can be replaced; a still-pending one is not.
  await assert.rejects(
    transaction((tx) =>
      reissueRaid(tx, command({ engagementId: pendingEngagement.id, terms: raidTerms() }), host),
    ),
    (e: unknown) => (e as { code: string }).code === 'ENGAGEMENT_STATE',
  );
  assert.equal(
    (await pool.query('SELECT * FROM "ActiveCommitment"')).rowCount,
    1,
    'Accepted work releases only its own participant commitment.',
  );
  await pool.query('DELETE FROM "HostGuildAuthority" WHERE "guildId"=$1', [guild]);
  await assert.rejects(
    transaction((tx) => readRaidTerms(tx, actor, saved.termsVersionId, host)),
    (e: unknown) => (e as { code: string }).code === 'FORBIDDEN',
  );
  console.log(
    'PASS: independent PG host terms/publication/applications/offers/consent/capacity/amendment/wizard-draft/notification/submission/review/closure/replacement guard/receipt recovery/revocation; SIMULATED ONLY.',
  );
} finally {
  await pool.end();
}
