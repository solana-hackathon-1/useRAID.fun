import { z } from 'zod';
import {
  canonicalRequestDigest,
  executeIdempotentCommand,
  type CommandReceiptTransaction as Tx,
} from '../command-receipts';
import type { WorkCommand } from './contracts';
import { closeEngagement } from './closure-storage';
import {
  DecideReviewInput,
  ReviewResultSchema,
  ReviewSchema,
  SubmissionResultSchema,
  SubmissionSchema,
  SubmitWorkInput,
  type SubmissionHost,
} from './submission-contracts';
import {
  fail,
  validate,
  session,
  currentActor,
  currentHuman,
  definition,
  clock,
} from './engagement-authority';

function check(tx: Tx, command: WorkCommand, host: SubmissionHost) {
  validate(tx, command?.actor);
  if (typeof host?.allowNewWrites !== 'boolean') fail('STORAGE_CONTRACT');
}
function parse<T>(schema: z.ZodType<T>, command: WorkCommand): T {
  const parsed = schema.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  return parsed.data;
}
interface EngagementRow {
  id: string;
  guildId: string;
  termsVersionId: string;
  state: string;
  acceptedTerms: {
    acceptanceCriteria: string[];
    deadlines: { submission: string; operationalClosure: string };
  };
}
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
async function readSubmission(tx: Tx, id: string) {
  const rows = await tx.query<Record<string, unknown>>(
    `SELECT "id"::text,"engagementId"::text,"termsVersionId"::text,"submissionNumber","submitterParticipantId"::text,"explanation","artifacts","dependencies","aiUsage","createdAt" FROM "WorkSubmission" WHERE "id"=$1::uuid`,
    [id],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const parsed = SubmissionSchema.safeParse({ ...rows[0], createdAt: iso(rows[0].createdAt) });
  if (!parsed.success) fail('STORAGE_CONTRACT');
  return parsed.data;
}
async function engagementState(tx: Tx, id: string) {
  const rows = await tx.query<{ state: string }>(
    'SELECT "state" FROM "Engagement" WHERE "id"=$1::uuid',
    [id],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  return rows[0].state;
}
/** Records one immutable, bounded submission version for the actor's own active engagement. */
export async function submitWork(tx: Tx, command: WorkCommand, host: SubmissionHost) {
  check(tx, command, host);
  const value = parse(SubmitWorkInput, command),
    actor = command.actor;
  await session(tx, actor);
  let auth: Awaited<ReturnType<typeof currentHuman>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'SubmitEngagementWork',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async () => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      auth = await currentHuman(tx, actor);
      // Only the actual member sees this engagement; absent and foreign engagements are indistinguishable.
      const rows = await tx.query<EngagementRow>(
        `SELECT e."id"::text,e."guildId",e."termsVersionId"::text,e."state",raid_effective_terms(e."id") AS "acceptedTerms" FROM "Engagement" e JOIN "EngagementMember" m ON m."engagementId"=e."id" WHERE e."id"=$1::uuid AND m."participantId"=$2::uuid FOR UPDATE OF e`,
        [value.engagementId, auth.participantId],
      );
      if (rows.length !== 1) fail('NOT_FOUND');
      const e = rows[0];
      if (e.state !== 'IN_PROGRESS' && e.state !== 'REVISION_REQUESTED') fail('ENGAGEMENT_STATE');
      const [latest] = await tx.query<{ n: number }>(
        'SELECT COALESCE(max("submissionNumber"),0)::int AS n FROM "WorkSubmission" WHERE "engagementId"=$1::uuid',
        [e.id],
      );
      if (value.expectedSubmissionNumber !== latest.n + 1) fail('REVISION_CONFLICT');
      const terms = await definition(tx, e.termsVersionId);
      if (latest.n + 1 > 1 + terms.review.maxRevisionRounds) fail('REVISION_LIMIT');
      let due = Date.parse(e.acceptedTerms.deadlines.submission);
      if (e.state === 'REVISION_REQUESTED') {
        const [r] = await tx.query<{ due: Date }>(
          'SELECT r."revisionDeadline" AS due FROM "WorkReview" r JOIN "WorkSubmission" s ON s."id"=r."submissionId" WHERE s."engagementId"=$1::uuid AND s."submissionNumber"=$2::int',
          [e.id, String(latest.n)],
        );
        if (!(r?.due instanceof Date)) fail('STORAGE_CONTRACT');
        due = r.due.getTime();
      }
      if (!(due > (await clock(tx)).getTime())) fail('DEADLINE_PASSED');
      // The row lock outlives lock waits; re-prove session and exact capacity before persisting.
      await currentHuman(tx, actor, auth.locks);
      const held = await tx.query(
        'SELECT 1 FROM "ActiveCommitment" WHERE "engagementId"=$1::uuid AND "participantId"=$2::uuid',
        [e.id, auth.participantId],
      );
      if (held.length !== 1) fail('ENGAGEMENT_STATE');
      const content = {
        engagementId: e.id,
        submissionNumber: latest.n + 1,
        explanation: value.explanation,
        artifacts: value.artifacts,
        dependencies: value.dependencies,
        aiUsage: value.aiUsage,
      };
      const [saved] = await tx.query<{ id: string }>(
        'INSERT INTO "WorkSubmission" ("engagementId","termsVersionId","submissionNumber","submitterParticipantId","explanation","artifacts","dependencies","aiUsage","digest") VALUES ($1::uuid,$2::uuid,$3::int,$4::uuid,$5,$6::jsonb,$7::jsonb,$8,$9) RETURNING "id"::text',
        [
          e.id,
          e.termsVersionId,
          String(latest.n + 1),
          auth.participantId,
          value.explanation,
          JSON.stringify(value.artifacts),
          JSON.stringify(value.dependencies),
          value.aiUsage,
          canonicalRequestDigest(content),
        ],
      );
      await tx.query(
        'UPDATE "Engagement" SET "state"=\'SUBMITTED\',"revision"="revision"+1 WHERE "id"=$1::uuid RETURNING "id"',
        [e.id],
      );
      return {
        resultRef: saved.id,
        events: [
          {
            type: 'work.submission_recorded.v1',
            aggregateId: saved.id,
            aggregateVersion: 1,
            guildId: e.guildId,
            payload: { engagementId: e.id, submissionId: saved.id },
          },
        ],
      };
    },
  );
  auth = await currentHuman(tx, actor, auth?.locks);
  const submission = await readSubmission(tx, receipt.resultRef);
  if (submission.submitterParticipantId !== auth.participantId) fail('FORBIDDEN');
  const result = SubmissionResultSchema.parse({
    status: receipt.status,
    engagementState: await engagementState(tx, submission.engagementId),
    submission,
  });
  await session(tx, actor);
  return result;
}
/** Records the terms reviewer's criterion-level decision for the latest submission and applies its effect. */
export async function decideReview(tx: Tx, command: WorkCommand, host: SubmissionHost) {
  check(tx, command, host);
  const value = parse(DecideReviewInput, command),
    actor = command.actor;
  await session(tx, actor);
  let locks: Awaited<ReturnType<typeof currentActor>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'DecideEngagementReview',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async () => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      locks = await currentActor(tx, actor);
      // Missing, foreign and non-reviewer submissions are one indistinguishable denial.
      const ref = await tx.query<{ engagementId: string; number: number }>(
        `SELECT s."engagementId"::text,s."submissionNumber" AS number FROM "WorkSubmission" s JOIN "TermsVersion" t ON t."id"=s."termsVersionId" WHERE s."id"=$1::uuid AND t."snapshot"->'review'->>'reviewerAccountId'=$2`,
        [value.submissionId, actor.accountId],
      );
      if (ref.length !== 1) fail('FORBIDDEN');
      const rows = await tx.query<EngagementRow>(
        `SELECT e."id"::text,e."guildId",e."termsVersionId"::text,e."state",raid_effective_terms(e."id") AS "acceptedTerms" FROM "Engagement" e WHERE e."id"=$1::uuid FOR UPDATE`,
        [ref[0].engagementId],
      );
      if (rows.length !== 1) fail('STORAGE_CONTRACT');
      const e = rows[0];
      const members = await tx.query<{ participantId: string; accountId: string }>(
        'SELECT m."participantId"::text,p."accountId" FROM "EngagementMember" m JOIN "Participant" p ON p."id"=m."participantId" WHERE m."engagementId"=$1::uuid',
        [e.id],
      );
      if (members.some((m) => m.accountId === actor.accountId)) fail('FORBIDDEN');
      if (e.state !== 'SUBMITTED') fail('ENGAGEMENT_STATE');
      const [latest] = await tx.query<{ n: number }>(
        'SELECT max("submissionNumber")::int AS n FROM "WorkSubmission" WHERE "engagementId"=$1::uuid',
        [e.id],
      );
      if (latest.n !== ref[0].number) fail('REVISION_CONFLICT');
      const prior = await tx.query('SELECT 1 FROM "WorkReview" WHERE "submissionId"=$1::uuid', [
        value.submissionId,
      ]);
      if (prior.length) fail('REVIEW_EXISTS');
      // Original accepted criteria only: every one is judged exactly once, none invented.
      const total = e.acceptedTerms.acceptanceCriteria.length;
      if (value.criteria.length !== total || value.criteria.some((c) => c.index >= total))
        fail('INVALID_INPUT');
      const terms = await definition(tx, e.termsVersionId);
      const now = await clock(tx);
      if (value.decision === 'REQUEST_REVISION') {
        if (ref[0].number > terms.review.maxRevisionRounds) fail('REVISION_LIMIT');
        const due = Date.parse(value.revisionDeadline as string);
        if (due <= now.getTime()) fail('DEADLINE_PASSED');
        if (due > Date.parse(e.acceptedTerms.deadlines.operationalClosure)) fail('INVALID_INPUT');
      }
      await currentActor(tx, actor, locks);
      const sortedCriteria = [...value.criteria].sort((a, b) => a.index - b.index);
      const [saved] = await tx.query<{ id: string }>(
        'INSERT INTO "WorkReview" ("submissionId","engagementId","termsVersionId","reviewerAccountId","decision","reason","criteria","revisionDeadline","digest") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb,$8::timestamptz,$9) RETURNING "id"::text',
        [
          value.submissionId,
          e.id,
          e.termsVersionId,
          actor.accountId,
          value.decision,
          value.reason,
          JSON.stringify(sortedCriteria),
          value.revisionDeadline,
          canonicalRequestDigest({ ...value, criteria: sortedCriteria }),
        ],
      );
      if (value.decision === 'ACCEPT') {
        // Closing ends the work duty, records the closure and releases exactly this engagement's reservations.
        await closeEngagement(
          tx,
          e.id,
          members.map((m) => m.participantId),
          'ACCEPTED',
          actor.accountId,
        );
      } else if (value.decision === 'REQUEST_REVISION') {
        await tx.query(
          'UPDATE "Engagement" SET "state"=\'REVISION_REQUESTED\',"revision"="revision"+1 WHERE "id"=$1::uuid RETURNING "id"',
          [e.id],
        );
      }
      const events: {
        type: string;
        aggregateId: string;
        aggregateVersion: number;
        guildId: string;
        payload: Record<string, string>;
      }[] = [
        {
          type: 'work.review_decided.v1',
          aggregateId: value.submissionId,
          aggregateVersion: 2,
          guildId: e.guildId,
          payload: { engagementId: e.id, submissionId: value.submissionId },
        },
      ];
      if (value.decision === 'ACCEPT') {
        // Acceptance closes the work duty in this transaction; announce it like every other closure.
        const [closed] = await tx.query<{ revision: number }>(
          'SELECT "revision" FROM "Engagement" WHERE "id"=$1::uuid',
          [e.id],
        );
        events.push({
          type: 'work.engagement_closed.v1',
          aggregateId: e.id,
          aggregateVersion: closed.revision,
          guildId: e.guildId,
          payload: { engagementId: e.id },
        });
      }
      return { resultRef: saved.id, events };
    },
  );
  locks = await currentActor(tx, actor, locks);
  const rows = await tx.query<Record<string, unknown>>(
    `SELECT "id"::text,"submissionId"::text,"engagementId"::text,"termsVersionId"::text,"reviewerAccountId","decision","reason","criteria","revisionDeadline","createdAt" FROM "WorkReview" WHERE "id"=$1::uuid`,
    [receipt.resultRef],
  );
  if (rows.length !== 1 || rows[0].reviewerAccountId !== actor.accountId) fail('STORAGE_CONTRACT');
  const stored: Record<string, unknown> = { ...rows[0] };
  delete stored.reviewerAccountId;
  const review = ReviewSchema.safeParse({
    ...stored,
    revisionDeadline: iso(stored.revisionDeadline ?? null),
    createdAt: iso(stored.createdAt),
  });
  if (!review.success) fail('STORAGE_CONTRACT');
  const result = ReviewResultSchema.parse({
    status: receipt.status,
    engagementState: await engagementState(tx, review.data.engagementId),
    review: review.data,
  });
  await session(tx, actor);
  return result;
}
