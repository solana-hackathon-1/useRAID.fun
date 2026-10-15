import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import {
  executeIdempotentCommand,
  canonicalRequestDigest,
  CommandReceiptError,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';
import { PracticeTrialDefinitionSchema } from './practice-trial-contracts';
import {
  lockSkillStorageActor,
  readPublishedSkillTaxonomy,
  SkillTaxonomyStorageError,
  SkillTaxonomyActorSchema,
  type SkillTaxonomyActor,
} from './taxonomy-storage';
import {
  PublishPracticeTrialInputSchema,
  StoredPracticeTrialDefinitionSchema,
  PracticeTrialStorageError,
  type StoredPracticeTrialDefinition,
  type PublishPracticeTrialCommand,
  type PracticeTrialStorageOptions,
} from './practice-trial-storage-contracts';
export * from './practice-trial-storage-contracts';
function fail(code: PracticeTrialStorageError['code']): never {
  throw new PracticeTrialStorageError(code);
}
function actorValid(value: unknown) {
  const result = SkillTaxonomyActorSchema.safeParse(value);
  if (!result.success) fail('INVALID_INPUT');
  return result.data;
}
async function query<Row>(
  tx: CommandReceiptTransaction,
  sql: string,
  bindings: readonly SqlBinding[],
): Promise<Row[]> {
  if (
    tx?.dialect !== 'POSTGRESQL' ||
    tx?.isolation !== 'READ_COMMITTED' ||
    typeof tx.query !== 'function'
  )
    fail('STORAGE_CONTRACT');
  try {
    const rows = await tx.query<Row>(sql, bindings);
    if (!Array.isArray(rows)) fail('STORAGE_CONTRACT');
    return rows;
  } catch (error) {
    if (error instanceof CommandReceiptError || error instanceof PracticeTrialStorageError)
      throw error;
    return fail('STORAGE_UNAVAILABLE');
  }
}
async function authorize(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  policy?: PracticeTrialStorageOptions['canPublish'],
) {
  try {
    await lockSkillStorageActor(tx, actor, policy);
  } catch (error) {
    if (error instanceof SkillTaxonomyStorageError) fail(error.code);
    throw error;
  }
}
async function load(
  tx: CommandReceiptTransaction,
  versionId: string,
): Promise<StoredPracticeTrialDefinition> {
  const rows = await query<{
    definition: unknown;
    availability: string;
    taxonomyId: string;
    taxonomyRevision: number;
    publishedByAccountId: string;
  }>(
    tx,
    'SELECT "definition","availability","taxonomyId","taxonomyRevision","publishedByAccountId" FROM "PracticeTrialVersion" WHERE "id"=$1::uuid',
    [versionId],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const r = rows[0];
  const parsed = StoredPracticeTrialDefinitionSchema.safeParse({
    version: 'v1',
    definition: r.definition,
    availability: r.availability,
    taxonomyReference: { recordId: r.taxonomyId, revision: r.taxonomyRevision },
    publishedByAccountId: r.publishedByAccountId,
    persisted: true,
    verifiesSkill: false,
    createsPermissionGrant: false,
    consumesCapacity: false,
    createsFinancialObligation: false,
  });
  if (!parsed.success) fail('STORAGE_CONTRACT');
  try {
    if (canonicalRequestDigest(parsed.data.definition) !== canonicalRequestDigest(r.definition))
      fail('STORAGE_CONTRACT');
  } catch {
    fail('STORAGE_CONTRACT');
  }
  return parsed.data;
}
/** Receipt→User→Session→catalog12012/SHARE→trial12013/UPDATE→rubric12014; no external waits. */
export async function publishPracticeTrialDefinition(
  tx: CommandReceiptTransaction,
  command: PublishPracticeTrialCommand,
  options: PracticeTrialStorageOptions,
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; trial: StoredPracticeTrialDefinition }> {
  const actor = actorValid(command?.actor);
  if (typeof options?.allowNewWrites !== 'boolean' || typeof options?.canPublish !== 'function')
    fail('STORAGE_CONTRACT');
  const parsed = PublishPracticeTrialInputSchema.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const input = parsed.data;
  let result;
  try {
    result = await executeIdempotentCommand(
      tx,
      {
        actorId: actor.accountId,
        commandKind: 'PublishPracticeTrial',
        idempotencyKey: command.idempotencyKey,
        requestId: command.requestId,
        request: input,
      },
      async ({ receiptId }) => {
        await authorize(tx, actor, options.canPublish);
        if (!options.allowNewWrites) fail('WRITES_DISABLED');
        await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,12012))::text', [
          input.taxonomyReference.recordId,
        ]);
        const catalogs = await query<{ currentVersionId: string; revision: number }>(
          tx,
          'SELECT "currentVersionId"::text,"revision" FROM "SkillTaxonomy" WHERE "id"=$1 FOR SHARE',
          [input.taxonomyReference.recordId],
        );
        await authorize(tx, actor, options.canPublish);
        if (!catalogs.length) fail('RESOURCE_UNAVAILABLE');
        if (catalogs.length !== 1) fail('STORAGE_CONTRACT');
        if (catalogs[0].revision !== input.taxonomyReference.revision) fail('REVISION_CHANGED');
        const taxonomy = await readPublishedSkillTaxonomy(
          tx,
          actor,
          input.taxonomyReference.recordId,
        );
        if (!taxonomy || taxonomy.revision !== catalogs[0].revision) fail('STORAGE_CONTRACT');
        const skill = taxonomy.skills.find((item) => item.id === input.draft.skillId);
        if (
          !skill ||
          skill.domain !== input.draft.skillDomain ||
          (input.availability === 'AVAILABLE' && skill.status !== 'ACTIVE')
        )
          fail('SKILL_UNAVAILABLE');
        await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,12013))::text', [
          input.trialId,
        ]);
        const prior = await query<{
          revision: number;
          skillId: string;
          skillDomain: string;
          taxonomyId: string;
        }>(
          tx,
          'SELECT "revision","skillId","skillDomain","taxonomyId" FROM "PracticeTrial" WHERE "id"=$1 FOR UPDATE',
          [input.trialId],
        );
        await authorize(tx, actor, options.canPublish);
        if (prior.length > 1) fail('STORAGE_CONTRACT');
        if ((prior[0]?.revision ?? 0) !== input.expectedRevision) fail('REVISION_CHANGED');
        if (
          (prior.length &&
            (prior[0].skillId !== skill.id ||
              prior[0].skillDomain !== skill.domain ||
              prior[0].taxonomyId !== taxonomy.id)) ||
          (!prior.length && input.availability === 'RETIRED')
        )
          fail('HISTORY_CONFLICT');
        const rubric = input.draft.rubric;
        await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,12014))::text', [
          rubric.reference.recordId,
        ]);
        await authorize(tx, actor, options.canPublish);
        const existing = await query<{ id: string; criteria: unknown }>(
          tx,
          'SELECT "id"::text,"criteria" FROM "SkillRubricVersion" WHERE "rubricId"=$1 AND "revision"=$2::int',
          [rubric.reference.recordId, String(rubric.reference.revision)],
        );
        if (existing.length > 1) fail('STORAGE_CONTRACT');
        if (
          existing.length &&
          canonicalRequestDigest(existing[0].criteria) !== canonicalRequestDigest(rubric.criteria)
        )
          fail('RUBRIC_CONFLICT');
        const [clock] = await query<{ now: Date; id: string }>(
          tx,
          "SELECT date_trunc('milliseconds',clock_timestamp()) AS now,gen_random_uuid()::text AS id",
          [],
        );
        if (
          !clock ||
          !(clock.now instanceof Date) ||
          Number.isNaN(clock.now.getTime()) ||
          !z.uuid().safeParse(clock.id).success
        )
          fail('STORAGE_CONTRACT');
        if (Date.parse(taxonomy.publishedAt) > clock.now.getTime()) fail('STORAGE_CONTRACT');
        const definition = PracticeTrialDefinitionSchema.parse({
          ...input.draft,
          reference: { recordId: input.trialId, revision: input.expectedRevision + 1 },
          state: 'PUBLISHED',
          publishedAt: clock.now.toISOString(),
        });
        let rubricId = existing[0]?.id;
        if (!rubricId) {
          const [latest] = await query<{ revision: number }>(
            tx,
            'SELECT COALESCE(max("revision"),0)::int AS revision FROM "SkillRubricVersion" WHERE "rubricId"=$1',
            [rubric.reference.recordId],
          );
          if (!latest || latest.revision + 1 !== rubric.reference.revision)
            fail('RUBRIC_REVISION_CHANGED');
          const rows = await query<{ id: string }>(
            tx,
            'INSERT INTO "SkillRubricVersion"("rubricId","revision","criteria","introducedByTrialVersionId") VALUES($1,$2::int,$3::jsonb,$4::uuid) RETURNING "id"::text',
            [
              rubric.reference.recordId,
              String(rubric.reference.revision),
              JSON.stringify(rubric.criteria),
              clock.id,
            ],
          );
          if (rows.length !== 1 || !z.uuid().safeParse(rows[0].id).success)
            fail('STORAGE_CONTRACT');
          rubricId = rows[0].id;
        }
        const version = await query<{ id: string }>(
          tx,
          'INSERT INTO "PracticeTrialVersion"("id","trialId","revision","skillId","skillDomain","taxonomyId","taxonomyRevision","taxonomyVersionId","rubricId","rubricRevision","rubricVersionId","definition","availability","receiptId","publishedByAccountId","requestId","publishedAt") VALUES($1::uuid,$2,$3::int,$4,$5,$6,$7::int,$8::uuid,$9,$10::int,$11::uuid,$12::jsonb,$13,$14::uuid,$15,$16,$17::timestamptz) RETURNING "id"::text',
          [
            clock.id,
            input.trialId,
            String(definition.reference.revision),
            skill.id,
            skill.domain,
            taxonomy.id,
            String(taxonomy.revision),
            catalogs[0].currentVersionId,
            rubric.reference.recordId,
            String(rubric.reference.revision),
            rubricId,
            JSON.stringify(definition),
            input.availability,
            receiptId,
            actor.accountId,
            command.requestId,
            definition.publishedAt,
          ],
        );
        if (version.length !== 1 || version[0].id !== clock.id) fail('STORAGE_CONTRACT');
        const projection = await query<{ id: string }>(
          tx,
          prior.length
            ? 'UPDATE "PracticeTrial" SET "revision"=$2::int,"currentVersionId"=$3::uuid WHERE "id"=$1 RETURNING "id"'
            : 'INSERT INTO "PracticeTrial"("id","revision","currentVersionId","skillId","skillDomain","taxonomyId") VALUES($1,$2::int,$3::uuid,$4,$5,$6) RETURNING "id"',
          prior.length
            ? [input.trialId, String(definition.reference.revision), clock.id]
            : [
                input.trialId,
                String(definition.reference.revision),
                clock.id,
                skill.id,
                skill.domain,
                taxonomy.id,
              ],
        );
        if (projection.length !== 1) fail('STORAGE_CONTRACT');
        await authorize(tx, actor, options.canPublish);
        return {
          resultRef: clock.id,
          events: [
            {
              type: 'skill.practice_trial_published.v1',
              aggregateId: input.trialId,
              aggregateVersion: definition.reference.revision,
              payload: { practiceTrialVersionId: clock.id },
              publish: false,
            },
          ],
        };
      },
    );
  } catch (error) {
    if (error instanceof CommandReceiptError && error.code === 'IDEMPOTENCY_KEY_REUSED')
      await authorize(tx, actor, options.canPublish);
    throw error;
  }
  await authorize(tx, actor, options.canPublish);
  const trial = await load(tx, result.resultRef);
  await authorize(tx, actor, options.canPublish);
  return { status: result.status, trial };
}
/** Current/historical approved records; current own session required, no publisher privilege needed. */
export async function readPracticeTrialDefinition(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  id: string,
  revision?: number,
): Promise<StoredPracticeTrialDefinition | null> {
  const actor = actorValid(actorValue);
  if (
    !InternalId.safeParse(id).success ||
    (revision !== undefined && !z.number().int().min(1).max(2147483647).safeParse(revision).success)
  )
    fail('INVALID_INPUT');
  await authorize(tx, actor);
  const rows = await query<{ id: string }>(
    tx,
    revision === undefined
      ? 'SELECT "currentVersionId"::text AS id FROM "PracticeTrial" WHERE "id"=$1'
      : 'SELECT "id"::text FROM "PracticeTrialVersion" WHERE "trialId"=$1 AND "revision"=$2::int',
    revision === undefined ? [id] : [id, String(revision)],
  );
  if (rows.length > 1) fail('STORAGE_CONTRACT');
  const trial = rows.length ? await load(tx, rows[0].id) : null;
  await authorize(tx, actor);
  return trial;
}
