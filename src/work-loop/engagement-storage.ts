import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { EngagementSchema, TermsSnapshotSchema } from '../contracts/entities';
import {
  canonicalRequestDigest,
  executeIdempotentCommand,
  type CommandReceiptTransaction as Tx,
} from '../command-receipts';
import {
  prepareModuleIdentity,
  requireIdentityLocks,
  type IdentityLockCapability,
} from '../identity-locks';
import { WorkError, type WorkActor, type WorkCommand } from './contracts';
import { RaidTermsSchema, publicationProblems } from './terms';
import {
  CommittedEngagementSchema,
  type AcceptanceHost,
  type AcceptanceApproval,
  type CommittedEngagement,
} from './engagement-contracts';
const Input = z.strictObject({ slotId: z.uuid(), termsVersionId: z.uuid() });
const Approval = z.strictObject({
  consentRef: InternalId,
  beneficiaryRef: InternalId,
  eligibilityPolicyVersion: InternalId,
  operatorId: z.null(),
});
function fail(code: WorkError['code']): never {
  throw new WorkError(code);
}
function validate(tx: Tx, actor: WorkActor) {
  if (
    tx?.dialect !== 'POSTGRESQL' ||
    tx.isolation !== 'READ_COMMITTED' ||
    typeof tx.query !== 'function'
  )
    fail('STORAGE_CONTRACT');
  if (
    !InternalId.safeParse(actor?.accountId).success ||
    !/^[a-f0-9]{64}$/.test(actor?.sessionHash ?? '')
  )
    fail('UNAUTHENTICATED');
}
/** Cheap preliminary check only. Final authority is rechecked after all identity lock waits. */
async function session(tx: Tx, actor: WorkActor) {
  const rows = await tx.query<{ suspended: boolean }>(
    `SELECT u."suspended" FROM "User" u JOIN "Session" s ON s."userId"=u."id" WHERE u."id"=$1 AND s."tokenHash"=$2 AND s."via" IN ('wallet','x') AND s."expiresAt">(clock_timestamp() AT TIME ZONE 'UTC')`,
    [actor.accountId, actor.sessionHash],
  );
  if (rows.length !== 1) fail('UNAUTHENTICATED');
  if (rows[0].suspended) fail('ACCOUNT_RESTRICTED');
}
async function currentHuman(tx: Tx, actor: WorkActor, prelocked?: IdentityLockCapability) {
  const locks = prelocked ?? (await prepareModuleIdentity(tx, actor.accountId, 'SHARE'));
  await requireIdentityLocks(tx, locks, {
    accounts: [{ id: actor.accountId, mode: 'SHARE' }],
    children: ['Session', 'Participant'],
  });
  await session(tx, actor);
  const rows = await tx.query<{ id: string; kind: string }>(
    'SELECT "id"::text,"kind" FROM "Participant" WHERE "accountId"=$1',
    [actor.accountId],
  );
  if (rows.length !== 1 || rows[0].kind !== 'HUMAN' || !z.uuid().safeParse(rows[0].id).success)
    fail('FORBIDDEN');
  return { participantId: rows[0].id, locks };
}
interface Source {
  listingId: string;
  guildId: string;
  revision: number;
  listingState: string;
  currentTermsVersionId: string;
  state: string;
  fundingMode: string;
  fundingRef: string | null;
  termsVersionId: string;
}
async function source(tx: Tx, slotId: string) {
  const refs = await tx.query<{ listingId: string }>(
    'SELECT "listingId"::text FROM "RaidSlot" WHERE "id"=$1::uuid',
    [slotId],
  );
  if (refs.length !== 1) fail('NOT_FOUND');
  // Every source writer uses listing before slot; terms history is immutable.
  await tx.query('SELECT "id" FROM "WorkListing" WHERE "id"=$1::uuid FOR UPDATE', [
    refs[0].listingId,
  ]);
  await tx.query('SELECT "id" FROM "RaidSlot" WHERE "id"=$1::uuid FOR UPDATE', [slotId]);
  const rows = await tx.query<Source>(
    `SELECT l."id"::text AS "listingId",l."guildId",l."revision",l."state" AS "listingState",l."currentTermsVersionId"::text,s."state",s."fundingMode",s."fundingRef",s."termsVersionId"::text FROM "RaidSlot" s JOIN "WorkListing" l ON l."id"=s."listingId" WHERE s."id"=$1::uuid`,
    [slotId],
  );
  if (rows.length !== 1) fail('NOT_FOUND');
  return rows[0];
}
async function definition(tx: Tx, id: string) {
  const rows = await tx.query<{ snapshot: unknown; digest: string }>(
    'SELECT "snapshot","digest" FROM "TermsVersion" WHERE "id"=$1::uuid',
    [id],
  );
  const parsed = RaidTermsSchema.safeParse(rows[0]?.snapshot);
  if (
    rows.length !== 1 ||
    !parsed.success ||
    canonicalRequestDigest(parsed.data) !== rows[0].digest
  )
    fail('STORAGE_CONTRACT');
  return parsed.data;
}
async function clock(tx: Tx) {
  const [row] = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now', []);
  if (!(row?.now instanceof Date)) fail('STORAGE_CONTRACT');
  return row.now;
}
function snapshot(
  s: Source,
  terms: z.infer<typeof RaidTermsSchema>,
  participantId: string,
  approval: AcceptanceApproval,
  now: Date,
) {
  const policy = (key: string) => s.termsVersionId + ':' + key;
  return TermsSnapshotSchema.parse({
    id: s.termsVersionId,
    guildId: s.guildId,
    revision: s.revision,
    scope: JSON.stringify({
      outcome: terms.outcome,
      deliverables: terms.deliverables,
      exclusions: terms.exclusions,
      dependencies: terms.dependencies,
    }),
    acceptanceCriteria: terms.acceptanceCriteria,
    requiredSkills: terms.requiredSkills,
    roster: [
      { participantId, responsibility: 'PRIMARY_EXECUTOR', consentRef: approval.consentRef },
    ],
    rewards: terms.rewards.map((r) => ({
      ...r,
      beneficiaryParticipantId: participantId,
      beneficiaryRef: approval.beneficiaryRef,
    })),
    deadlines: {
      preparation: terms.deadlines.preparation,
      submission: terms.deadlines.submission,
      review: terms.deadlines.review,
      operationalClosure: terms.deadlines.operationalClosure,
    },
    eligibilityPolicyVersion: approval.eligibilityPolicyVersion,
    allowedToolsPolicyVersion: policy('tools'),
    revisionPolicyVersion: policy('revisions'),
    withdrawalPolicyVersion: policy('withdrawal'),
    terminationPolicyVersion: policy('termination'),
    rubricVersion: null,
    rightsPolicyVersion: policy('rights'),
    reviewPolicyVersion: policy('review'),
    disputePolicyVersion: policy('dispute'),
    finalityPolicyVersion: policy('finality'),
    createdAt: now.toISOString(),
  });
}
async function ownEngagement(tx: Tx, id: string, participantId: string) {
  const rows = await tx.query<{
    id: string;
    guildId: string;
    revision: number;
    generation: number;
    state: string;
    slotId: string;
    acceptedTerms: unknown;
    acceptedDigest: string;
  }>(
    `SELECT e."id"::text,e."guildId",e."revision",e."generation",e."state",e."slotId"::text,e."acceptedTerms",e."acceptedDigest" FROM "Engagement" e JOIN "EngagementMember" m ON m."engagementId"=e."id" WHERE e."id"=$1::uuid AND m."participantId"=$2::uuid`,
    [id, participantId],
  );
  if (rows.length !== 1) fail('NOT_FOUND');
  const row = rows[0];
  const parsed = EngagementSchema.safeParse({
    id: row.id,
    guildId: row.guildId,
    revision: row.revision,
    state: row.state,
    source: { kind: 'RAID_SLOT', raidSlotId: row.slotId },
    acceptedTerms: row.acceptedTerms,
  });
  if (!parsed.success || canonicalRequestDigest(parsed.data.acceptedTerms) !== row.acceptedDigest)
    fail('STORAGE_CONTRACT');
  return { engagement: parsed.data, generation: row.generation };
}
/** One canonical receipt and transaction for current HUMAN/SOLO instant acceptance. No external calls. */
export async function commitEngagement(
  tx: Tx,
  command: WorkCommand,
  host: AcceptanceHost,
): Promise<CommittedEngagement> {
  validate(tx, command?.actor);
  const parsed = Input.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  if (
    typeof host?.allowNewWrites !== 'boolean' ||
    typeof host.assess !== 'function' ||
    typeof host.fundingAvailable !== 'function'
  )
    fail('STORAGE_CONTRACT');
  const input = parsed.data,
    actor = command.actor;
  await session(tx, actor);
  let authorization: Awaited<ReturnType<typeof currentHuman>> | undefined;
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'CommitEngagement',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: input,
    },
    async () => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      const s = await source(tx, input.slotId);
      if (s.state === 'FILLED') fail('SLOT_FILLED');
      if (s.state !== 'AVAILABLE' || s.listingState !== 'OPEN') fail('PUBLICATION_BLOCKED');
      if (
        s.termsVersionId !== input.termsVersionId ||
        s.currentTermsVersionId !== input.termsVersionId
      )
        fail('TERMS_VERSION_CHANGED');
      if (s.fundingMode !== 'SIMULATED' || !s.fundingRef) fail('FUNDING_REQUIRED');
      authorization = await currentHuman(tx, actor, host.identityLocks);
      const terms = await definition(tx, input.termsVersionId);
      const definitionDigest = canonicalRequestDigest(terms);
      if (terms.admission !== 'INSTANT') fail('ADMISSION_REQUIRED');
      if (publicationProblems(terms, await clock(tx)).length) fail('DEADLINE_PASSED');
      const assessed = Approval.safeParse(
        await host.assess(tx, {
          actor,
          participantId: authorization.participantId,
          slotId: input.slotId,
          termsVersionId: input.termsVersionId,
          terms,
        }),
      );
      if (!assessed.success) fail('ELIGIBILITY_REJECTED');
      if (
        (await host.fundingAvailable(tx, {
          slotId: input.slotId,
          termsVersionId: input.termsVersionId,
          fundingRef: s.fundingRef,
          terms,
        })) !== true
      )
        fail('FUNDING_REQUIRED');
      if (canonicalRequestDigest(terms) !== definitionDigest) fail('STORAGE_CONTRACT');
      // Host callbacks and lock waits cannot carry an expired session/window across the command boundary.
      await session(tx, actor);
      const now = await clock(tx);
      if (publicationProblems(terms, now).length) fail('DEADLINE_PASSED');
      const accepted = snapshot(s, terms, authorization.participantId, assessed.data, now);
      const [e] = await tx.query<{ id: string }>(
        'INSERT INTO "Engagement" ("slotId","termsVersionId","guildId","acceptedTerms","acceptedDigest") VALUES ($1::uuid,$2::uuid,$3,$4::jsonb,$5) RETURNING "id"::text',
        [
          input.slotId,
          input.termsVersionId,
          s.guildId,
          JSON.stringify(accepted),
          canonicalRequestDigest(accepted),
        ],
      );
      await tx.query(
        'INSERT INTO "EngagementMember" ("engagementId","participantId","termsVersionId") VALUES ($1::uuid,$2::uuid,$3::uuid) RETURNING "participantId"',
        [e.id, authorization.participantId, input.termsVersionId],
      );
      const capacity = await tx.query(
        'INSERT INTO "ActiveCommitment" ("participantId","engagementId","termsVersionId") VALUES ($1::uuid,$2::uuid,$3::uuid) ON CONFLICT ("participantId") DO NOTHING RETURNING "participantId"',
        [authorization.participantId, e.id, input.termsVersionId],
      );
      if (capacity.length !== 1) {
        const existing = await tx.query<{ engagementId: string }>(
          'SELECT "engagementId"::text FROM "ActiveCommitment" WHERE "participantId"=$1::uuid',
          [authorization.participantId],
        );
        if (existing.length !== 1) fail('STORAGE_CONTRACT');
        throw new WorkError('CAPACITY_CONFLICT', existing[0].engagementId);
      }
      await session(tx, actor);
      if (publicationProblems(terms, await clock(tx)).length) fail('DEADLINE_PASSED');
      await tx.query(
        'UPDATE "RaidSlot" SET "state"=\'FILLED\' WHERE "id"=$1::uuid RETURNING "id"',
        [input.slotId],
      );
      return {
        resultRef: e.id,
        events: [
          {
            type: 'work.engagement_committed.v1',
            aggregateId: e.id,
            aggregateVersion: 1,
            guildId: s.guildId,
            payload: {
              engagementId: e.id,
              termsVersionId: input.termsVersionId,
              raidSlotId: input.slotId,
            },
          },
        ],
      };
    },
  );
  authorization = await currentHuman(tx, actor, authorization?.locks ?? host.identityLocks);
  const { engagement, generation } = await ownEngagement(
    tx,
    result.resultRef,
    authorization.participantId,
  );
  if (
    engagement.source.kind !== 'RAID_SLOT' ||
    engagement.source.raidSlotId !== input.slotId ||
    engagement.acceptedTerms.id !== input.termsVersionId
  )
    fail('STORAGE_CONTRACT');
  await session(tx, actor);
  return CommittedEngagementSchema.parse({
    status: result.status,
    fundingMode: 'SIMULATED',
    generation,
    engagement,
  });
}
