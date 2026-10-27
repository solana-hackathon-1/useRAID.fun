import {
  executeIdempotentCommand,
  type CommandReceiptTransaction as Tx,
} from '../command-receipts';
import { TermsSnapshotSchema } from '../contracts/entities';
import type { WorkCommand } from './contracts';
import {
  StartEngagementInput,
  StartResultSchema,
  type StartHost,
  type StartResult,
} from './start-contracts';
import { RaidTermsSchema } from './terms';
import { fail, validate, session, currentHuman, clock } from './engagement-authority';

/**
 * The member starts their own accepted engagement. The command rechecks identity, ownership, state, time and the
 * host's binding and resource answers under the engagement lock, then moves ACCESS_PENDING to IN_PROGRESS. Capacity
 * stays held and the accepted terms are untouched.
 */
export async function startEngagement(
  tx: Tx,
  command: WorkCommand,
  host: StartHost,
): Promise<StartResult> {
  validate(tx, command?.actor);
  if (
    typeof host?.allowNewWrites !== 'boolean' ||
    typeof host.verifyBinding !== 'function' ||
    typeof host.resourcesReady !== 'function'
  )
    fail('STORAGE_CONTRACT');
  const parsed = StartEngagementInput.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const value = parsed.data,
    actor = command.actor;
  await session(tx, actor);
  let auth: Awaited<ReturnType<typeof currentHuman>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'StartEngagement',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async () => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      auth = await currentHuman(tx, actor);
      // A person sees only their own engagement: missing, foreign and Founder-only are one answer.
      const own = await tx.query(
        'SELECT 1 FROM "EngagementMember" WHERE "engagementId"=$1::uuid AND "participantId"=$2::uuid',
        [value.engagementId, auth.participantId],
      );
      if (own.length !== 1) fail('NOT_FOUND');
      const rows = await tx.query<{
        state: string;
        revision: number;
        guildId: string;
        slotId: string;
        termsVersionId: string;
        fundingRef: string | null;
        terms: unknown;
        definition: unknown;
      }>(
        `SELECT e."state",e."revision",e."guildId",e."slotId"::text,e."termsVersionId"::text,s."fundingRef",
          raid_effective_terms(e."id") AS terms,t."snapshot" AS definition
         FROM "Engagement" e JOIN "RaidSlot" s ON s."id"=e."slotId" JOIN "TermsVersion" t ON t."id"=e."termsVersionId"
         WHERE e."id"=$1::uuid FOR UPDATE OF e`,
        [value.engagementId],
      );
      if (rows.length !== 1) fail('STORAGE_CONTRACT');
      const e = rows[0];
      if (e.state !== 'ACCESS_PENDING') fail('ENGAGEMENT_STATE');
      const effective = TermsSnapshotSchema.safeParse(e.terms);
      const definition = RaidTermsSchema.safeParse(e.definition);
      if (!effective.success || !definition.success || !e.fundingRef) fail('STORAGE_CONTRACT');
      // With no time left to submit, starting would only create work that must time out.
      const now = await clock(tx);
      if (Date.parse(effective.data!.deadlines.submission) <= now.getTime())
        fail('DEADLINE_PASSED');
      const binding = {
        engagementId: value.engagementId,
        slotId: e.slotId,
        termsVersionId: e.termsVersionId,
        fundingRef: e.fundingRef!,
        terms: definition.data!,
      };
      if ((await host.verifyBinding(tx, binding)) !== true) fail('FUNDING_REQUIRED');
      if (
        (await host.resourcesReady(tx, {
          engagementId: value.engagementId,
          terms: definition.data!,
        })) !== true
      )
        fail('RESOURCES_NOT_READY');
      // Host callbacks and lock waits cannot carry an expired session or deadline across the boundary.
      await currentHuman(tx, actor, auth.locks);
      if (Date.parse(effective.data!.deadlines.submission) <= (await clock(tx)).getTime())
        fail('DEADLINE_PASSED');
      await tx.query(
        'UPDATE "Engagement" SET "state"=\'IN_PROGRESS\',"revision"="revision"+1 WHERE "id"=$1::uuid RETURNING "id"',
        [value.engagementId],
      );
      return {
        resultRef: value.engagementId,
        events: [
          {
            type: 'work.engagement_started.v1',
            aggregateId: value.engagementId,
            aggregateVersion: e.revision + 1,
            guildId: e.guildId,
            payload: { engagementId: value.engagementId },
          },
        ],
      };
    },
  );
  auth = await currentHuman(tx, actor, auth?.locks);
  const rows = await tx.query<{ id: string; state: string; revision: number }>(
    'SELECT e."id"::text,e."state",e."revision" FROM "Engagement" e JOIN "EngagementMember" m ON m."engagementId"=e."id" WHERE e."id"=$1::uuid AND m."participantId"=$2::uuid',
    [receipt.resultRef, auth.participantId],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const result = StartResultSchema.safeParse({ status: receipt.status, engagement: rows[0] });
  if (!result.success) fail('STORAGE_CONTRACT');
  await session(tx, actor);
  return result.data;
}
