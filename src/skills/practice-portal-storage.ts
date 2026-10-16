import { z } from 'zod';
import type { CommandReceiptTransaction, SqlBinding } from '../command-receipts';
import { SkillTaxonomyActorSchema, type SkillTaxonomyActor } from './taxonomy-storage-contracts';
import { readPublishedSkillTaxonomy } from './taxonomy-storage';
import { readPracticeTrialDefinition } from './practice-trial-storage';
import {
  lockPracticeTrialParticipant,
  readPracticeTrialStart,
} from './practice-trial-attempt-storage';
import { readPracticeTrialSubmission } from './practice-trial-submission-storage';
import {
  PracticePortalCatalogSchema,
  PracticePortalListInputSchema,
  PracticePortalTrialSchema,
  PracticePortalError,
} from './practice-portal-contracts';
function fail(code: PracticePortalError['code']): never {
  throw new PracticePortalError(code);
}
async function query<T>(
  tx: CommandReceiptTransaction,
  sql: string,
  bindings: readonly SqlBinding[],
): Promise<T[]> {
  if (
    tx?.dialect !== 'POSTGRESQL' ||
    tx.isolation !== 'READ_COMMITTED' ||
    typeof tx.query !== 'function'
  )
    fail('STORAGE_CONTRACT');
  try {
    const rows = await tx.query<T>(sql, bindings);
    if (!Array.isArray(rows)) fail('STORAGE_CONTRACT');
    return rows;
  } catch (e) {
    if (e instanceof PracticePortalError) throw e;
    return fail('STORAGE_UNAVAILABLE');
  }
}
function scope(canRead: () => boolean) {
  try {
    if (typeof canRead === 'function' && canRead() === true) return;
  } catch {
    /* Fail closed, never leak host detail. */
  }
  fail('RESOURCE_UNAVAILABLE');
}
async function owner(tx: CommandReceiptTransaction, a: SkillTaxonomyActor, canRead: () => boolean) {
  scope(canRead);
  const p = await lockPracticeTrialParticipant(tx, a);
  scope(canRead);
  return p;
}
/** Current catalog and C1 publication share lock12012; this is bounded transport pagination. */
export async function listOwnPracticeTrials(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  inputValue: unknown,
  canRead: () => boolean,
) {
  const a = SkillTaxonomyActorSchema.safeParse(actorValue),
    input = PracticePortalListInputSchema.safeParse(inputValue);
  if (!a.success || !input.success) fail('INVALID_INPUT');
  await owner(tx, a.data, canRead);
  await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,12012))::text', [
    input.data.taxonomyId,
  ]);
  const rows = await query(tx, 'SELECT "id" FROM "SkillTaxonomy" WHERE "id"=$1 FOR SHARE', [
    input.data.taxonomyId,
  ]);
  await owner(tx, a.data, canRead);
  if (rows.length !== 1) fail('RESOURCE_UNAVAILABLE');
  const taxonomy = await readPublishedSkillTaxonomy(tx, a.data, input.data.taxonomyId);
  if (!taxonomy) fail('RESOURCE_UNAVAILABLE');
  const active = taxonomy.skills
    .filter((s) => s.status === 'ACTIVE')
    .map((s) => ({ id: s.id, domain: s.domain }));
  const ids = await query<{ id: string }>(
    tx,
    'SELECT t."id" FROM "PracticeTrial" t JOIN "PracticeTrialVersion" v ON v."id"=t."currentVersionId" WHERE t."taxonomyId"=$1 AND ($2::text IS NULL OR t."id" COLLATE "C">$2::text COLLATE "C") AND v."availability"=\'AVAILABLE\' AND EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS s(id text,domain text) WHERE s.id=t."skillId" AND s.domain=t."skillDomain") ORDER BY t."id" COLLATE "C" LIMIT 51',
    [input.data.taxonomyId, input.data.after, JSON.stringify(active)],
  );
  const trials = [];
  for (const row of ids.slice(0, 50)) {
    const saved = await readPracticeTrialDefinition(tx, a.data, row.id);
    if (
      !saved ||
      saved.availability !== 'AVAILABLE' ||
      saved.taxonomyReference.recordId !== taxonomy.id ||
      !active.some(
        (s) => s.id === saved.definition.skillId && s.domain === saved.definition.skillDomain,
      )
    )
      fail('STORAGE_CONTRACT');
    const safe = { ...saved };
    Reflect.deleteProperty(safe, 'publishedByAccountId');
    trials.push(PracticePortalTrialSchema.parse(safe));
  }
  await owner(tx, a.data, canRead);
  return PracticePortalCatalogSchema.parse({
    version: 'v1',
    taxonomyId: taxonomy.id,
    trials,
    nextCursor: ids.length > 50 ? ids[49].id : null,
  });
}
/** Actual own start before ID-only submission lookup;12016 serializes current progress with C3. */
export async function readOwnPracticeTrialProgress(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  id: string,
  canRead: () => boolean,
) {
  const a = SkillTaxonomyActorSchema.safeParse(actorValue);
  if (!a.success || !z.uuid().safeParse(id).success) fail('INVALID_INPUT');
  const participant = await owner(tx, a.data, canRead);
  const start = await readPracticeTrialStart(tx, a.data, id);
  if (!start) {
    await owner(tx, a.data, canRead);
    return null;
  }
  if (start.participantId !== participant.id) fail('STORAGE_CONTRACT');
  await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,12016))::text', [id]);
  await owner(tx, a.data, canRead);
  const rows = await query<{ id: string }>(
    tx,
    'SELECT "id"::text FROM "PracticeTrialSubmission" WHERE "startId"=$1::uuid AND "accountId"=$2 AND "participantId"=$3::uuid',
    [id, a.data.accountId, participant.id],
  );
  if (rows.length > 1) fail('STORAGE_CONTRACT');
  const submission = rows.length ? await readPracticeTrialSubmission(tx, a.data, rows[0].id) : null;
  if (
    rows.length &&
    (!submission || submission.startId !== id || submission.participantId !== start.participantId)
  )
    fail('STORAGE_CONTRACT');
  await owner(tx, a.data, canRead);
  return {
    version: 'v1' as const,
    progress: submission ? ('SUBMITTED' as const) : ('STARTED' as const),
    start,
    submission,
  };
}
