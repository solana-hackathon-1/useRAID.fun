import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { EngagementSchema, TermsSnapshotSchema } from '../contracts/entities';
import {
  canonicalRequestDigest,
  executeIdempotentCommand,
  type CommandReceiptTransaction as Tx,
} from '../command-receipts';
import { WorkError, type WorkCommand } from './contracts';
import { RaidTermsSchema, publicationProblems } from './terms';
import {
  CommitEngagementInput,
  CommittedEngagementSchema,
  type AcceptanceHost,
  type AcceptanceApproval,
  type CommittedEngagement,
} from './engagement-contracts';
import {
  lockOfferForAcceptance,
  assertOffer,
  assertOfferIssuerAuthorized,
  requireOfferIssuerCheck,
} from './admission-acceptance';
import {
  fail,
  validate,
  session,
  currentHuman,
  source,
  definition,
  clock,
  type Source,
} from './engagement-authority';
const Approval = z.strictObject({
  consentRef: InternalId,
  beneficiaryRef: InternalId,
  eligibilityPolicyVersion: InternalId,
  operatorId: z.null(),
});
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
  const parsed = CommitEngagementInput.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  if (
    typeof host?.allowNewWrites !== 'boolean' ||
    typeof host.assess !== 'function' ||
    typeof host.fundingAvailable !== 'function'
  )
    fail('STORAGE_CONTRACT');
  // An offer is judged against its issuer's current authority: a host that cannot answer fails before any lock or read.
  if (parsed.data.offerId) requireOfferIssuerCheck(host);
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
      const locked = input.offerId ? await lockOfferForAcceptance(tx, input.offerId) : undefined;
      const offer = locked?.offer;
      authorization = await currentHuman(tx, actor, host.identityLocks);
      const terms = await definition(tx, input.termsVersionId);
      const definitionDigest = canonicalRequestDigest(terms);
      if (terms.admission === 'APPLICATION') {
        if (!offer) fail('ADMISSION_REQUIRED');
        assertOffer(offer, input, authorization.participantId, await clock(tx));
      } else if (offer) fail('INVALID_INPUT');
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
      if (locked)
        await assertOfferIssuerAuthorized(
          tx,
          { id: locked.offer.id, issuer: locked.issuer },
          { slotId: input.slotId, guildId: s.guildId },
          host,
        );
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
      if (offer) {
        assertOffer(offer, input, authorization.participantId, await clock(tx));
        await tx.query(
          'UPDATE "RaidOffer" SET "state"=\'ACCEPTED\',"acceptedEngagementId"=$2::uuid WHERE "id"=$1::uuid RETURNING "id"',
          [offer.id, e.id],
        );
      }
      await tx.query(
        'UPDATE "RaidSlot" SET "state"=\'FILLED\' WHERE "id"=$1::uuid RETURNING "id"',
        [input.slotId],
      );
      if (offer) {
        await tx.query(
          'UPDATE "RaidOffer" SET "state"=\'REVOKED\' WHERE "slotId"=$1::uuid AND "state"=\'PENDING\' RETURNING "id"',
          [input.slotId],
        );
        await tx.query(
          'UPDATE "RaidApplication" SET "state"=\'CLOSED\' WHERE "slotId"=$1::uuid AND "state"=\'SUBMITTED\' RETURNING "id"',
          [input.slotId],
        );
      }
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
