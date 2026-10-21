import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  executeIdempotentCommand,
  CommandReceiptError,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';
import { lockSkillStorageActor } from './taxonomy-storage';
import {
  SkillTaxonomyActorSchema,
  SkillTaxonomyStorageError,
  type SkillTaxonomyActor,
} from './taxonomy-storage-contracts';
import {
  PracticeReviewInboxInputSchema,
  PracticeReviewInboxHostResultSchema,
} from './practice-review-inbox-contracts';
function fail(code: SkillTaxonomyStorageError['code']): never {
  throw new SkillTaxonomyStorageError(code);
}
async function query<Row>(
  tx: CommandReceiptTransaction,
  sql: string,
  bindings: readonly SqlBinding[],
): Promise<Row[]> {
  if (
    tx?.dialect !== 'POSTGRESQL' ||
    tx.isolation !== 'READ_COMMITTED' ||
    typeof tx.query !== 'function'
  )
    fail('STORAGE_CONTRACT');
  try {
    const rows = await tx.query<Row>(sql, bindings);
    if (!Array.isArray(rows)) fail('STORAGE_CONTRACT');
    return rows;
  } catch (error) {
    if (error instanceof CommandReceiptError || error instanceof SkillTaxonomyStorageError)
      throw error;
    return fail('STORAGE_UNAVAILABLE');
  }
}
/** Metadata authorization is separate from exact-case evidence/decision authorization. */
export async function listPracticeReviewInbox(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  inputValue: unknown,
  canDiscover: (scope: Readonly<{ accountId: string }>) => boolean,
) {
  const actor = SkillTaxonomyActorSchema.safeParse(actorValue),
    input = PracticeReviewInboxInputSchema.safeParse(inputValue);
  if (!actor.success || !input.success) fail('INVALID_INPUT');
  if (typeof canDiscover !== 'function') fail('STORAGE_CONTRACT');
  const policy = () => {
    let allowed: unknown;
    try {
      allowed = canDiscover(Object.freeze({ accountId: actor.data.accountId }));
    } catch {
      fail('STORAGE_UNAVAILABLE');
    }
    if (allowed !== true) fail('FORBIDDEN');
  };
  const authority = async () => {
    await lockSkillStorageActor(tx, actor.data);
    policy();
  };
  await authority();
  const accessId = randomUUID();
  try {
    await executeIdempotentCommand(
      tx,
      {
        actorId: actor.data.accountId,
        commandKind: 'ListPracticeReviewInbox',
        idempotencyKey: accessId,
        requestId: accessId,
        request: input.data,
      },
      async () => ({
        resultRef: actor.data.accountId,
        events: [
          {
            type: 'skill.practice_review_inbox_access_authorized.v1',
            aggregateId: actor.data.accountId,
            aggregateVersion: 1,
            payload: {},
            publish: false,
          },
        ],
      }),
    );
  } catch (error) {
    if (error instanceof CommandReceiptError || error instanceof SkillTaxonomyStorageError)
      throw error;
    fail('STORAGE_UNAVAILABLE');
  }
  // Audit and lock waits can outlive the session; no metadata selection until rechecked.
  await authority();
  const Row = z.strictObject({
    assignmentId: z.uuid(),
    submissionId: z.uuid(),
    purpose: z.enum(['OWNERSHIP_REVIEW', 'ASSESSMENT_REVIEW']),
    issuedAt: z.date(),
    expiresAt: z.date(),
    observedAt: z.date(),
  });
  // Appointment metadata only; revocation management shares the held evaluator User lock.
  const rows = await query<z.infer<typeof Row>>(
    tx,
    `SELECT g."id"::text AS "assignmentId",g."submissionId"::text AS "submissionId",g."purpose",g."issuedAt",g."expiresAt",clock_timestamp() AS "observedAt" FROM "PracticeTrialReviewAssignment" g WHERE g."evaluatorAccountId"=$1 AND ($2::uuid IS NULL OR g."id">$2::uuid) AND g."expiresAt">clock_timestamp() AND NOT EXISTS(SELECT 1 FROM "PracticeTrialReviewRevocation" r WHERE r."assignmentId"=g."id") ORDER BY g."id" LIMIT 21`,
    [actor.data.accountId, input.data.after],
  );
  if (
    rows.length > 21 ||
    !rows.every(
      (row, i) =>
        Row.safeParse(row).success &&
        row.issuedAt <= row.observedAt &&
        row.expiresAt > row.observedAt &&
        (i === 0 || rows[i - 1].assignmentId < row.assignmentId) &&
        (input.data.after === null || row.assignmentId > input.data.after),
    )
  )
    fail('STORAGE_CONTRACT');
  await authority();
  // Time keeps moving under locks. Last DB observation checks actual session plus expiry.
  const clock = await query<{ observedAt: Date; valid: boolean }>(
    tx,
    `SELECT clock_timestamp() AS "observedAt", "expiresAt">(clock_timestamp() AT TIME ZONE 'UTC') AS valid FROM "Session" WHERE "tokenHash"=$1 AND "userId"=$2`,
    [actor.data.sessionHash, actor.data.accountId],
  );
  if (clock.length !== 1 || clock[0].valid !== true) fail('AUTHENTICATION_REQUIRED');
  if (!z.date().safeParse(clock[0].observedAt).success) fail('STORAGE_CONTRACT');
  policy();
  const observedAt = clock[0].observedAt;
  const current = rows.filter((row) => row.expiresAt > observedAt);
  const entries = current.slice(0, 20).map((row) => ({
    assignmentId: row.assignmentId,
    submissionId: row.submissionId,
    purpose: row.purpose,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }));
  const parsed = PracticeReviewInboxHostResultSchema.safeParse({
    accountId: actor.data.accountId,
    page: {
      version: 'v1',
      private: true,
      isAuthorizationToken: false,
      accessId,
      observedAt: observedAt.toISOString(),
      entries,
      nextCursor: current.length > 20 ? entries.at(-1)!.assignmentId : null,
    },
  });
  if (
    !parsed.success ||
    entries.some((entry) => input.data.after !== null && entry.assignmentId <= input.data.after)
  )
    fail('STORAGE_CONTRACT');
  return parsed.data;
}
