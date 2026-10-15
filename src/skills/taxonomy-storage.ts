import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import {
  executeIdempotentCommand,
  CommandReceiptError,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';
import { prepareSkillTaxonomyUpdate } from './index';
import { PublishedSkillTaxonomySchema, type PublishedSkillTaxonomy } from './contracts';
import {
  PublishSkillTaxonomyInputSchema,
  SkillTaxonomyActorSchema,
  SkillTaxonomyStorageError,
  type SkillTaxonomyActor,
  type PublishSkillTaxonomyCommand,
  type SkillTaxonomyStorageOptions,
} from './taxonomy-storage-contracts';
export * from './taxonomy-storage-contracts';
function fail(code: SkillTaxonomyStorageError['code']): never {
  throw new SkillTaxonomyStorageError(code);
}
function actorValid(value: unknown): SkillTaxonomyActor {
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
    const result = await tx.query<Row>(sql, bindings);
    if (!Array.isArray(result)) fail('STORAGE_CONTRACT');
    return result;
  } catch (error) {
    if (error instanceof CommandReceiptError || error instanceof SkillTaxonomyStorageError)
      throw error;
    return fail('STORAGE_UNAVAILABLE');
  }
}
/** User and Session authority remain locked until the host commits; DB clock is checked after waits. */
async function authorize(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  policy?: SkillTaxonomyStorageOptions['canPublish'],
) {
  const users = await query<{ id: string; suspended: boolean; role: string; xId: string | null }>(
    tx,
    'SELECT "id","suspended","role","xId" FROM "User" WHERE "id"=$1 FOR NO KEY UPDATE',
    [actor.accountId],
  );
  if (users.length !== 1) fail('AUTHENTICATION_REQUIRED');
  const user = users[0];
  if (user.suspended !== false) fail('ACCOUNT_RESTRICTED');
  const sessions = await query<{ userId: string; via: string }>(
    tx,
    'SELECT "userId","via" FROM "Session" WHERE "tokenHash"=$1 FOR SHARE',
    [actor.sessionHash],
  );
  if (
    sessions.length !== 1 ||
    sessions[0].userId !== actor.accountId ||
    !['wallet', 'x'].includes(sessions[0].via)
  )
    fail('AUTHENTICATION_REQUIRED');
  const clock = await query<{ valid: boolean }>(
    tx,
    `SELECT "expiresAt">(clock_timestamp() AT TIME ZONE 'UTC') AS valid FROM "Session" WHERE "tokenHash"=$1`,
    [actor.sessionHash],
  );
  if (clock.length !== 1 || clock[0].valid !== true) fail('AUTHENTICATION_REQUIRED');
  if (policy) {
    // Preserve the root administrative contract: a relayed wallet proof is not X admin authority.
    if (sessions[0].via !== 'x') fail('FORBIDDEN');
    if (
      user.id !== actor.accountId ||
      user.role !== 'ADMIN' ||
      typeof user.xId !== 'string' ||
      !user.xId
    )
      fail('FORBIDDEN');
    let result: unknown;
    try {
      result = policy(Object.freeze({ accountId: user.id, xId: user.xId }));
    } catch {
      fail('STORAGE_UNAVAILABLE');
    }
    if (result !== true) fail('FORBIDDEN');
  }
}
/** Shared locked skill-store actor boundary; the returned identity is not an authorization token. */
export async function lockSkillStorageActor(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  policy?: SkillTaxonomyStorageOptions['canPublish'],
): Promise<SkillTaxonomyActor> {
  const actor = actorValid(actorValue);
  if (policy !== undefined && typeof policy !== 'function') fail('STORAGE_CONTRACT');
  await authorize(tx, actor, policy);
  return actor;
}
async function loadVersion(
  tx: CommandReceiptTransaction,
  versionId: string,
): Promise<PublishedSkillTaxonomy> {
  const rows = await query<{
    taxonomyId: string;
    revision: number;
    publishedByAccountId: string;
    publishedAt: Date;
    skills: unknown;
  }>(
    tx,
    'SELECT "taxonomyId","revision","publishedByAccountId","publishedAt","skills" FROM "SkillTaxonomyVersion" WHERE "id"=$1::uuid',
    [versionId],
  );
  if (rows.length !== 1 || !(rows[0].publishedAt instanceof Date)) fail('STORAGE_CONTRACT');
  const r = rows[0];
  const parsed = PublishedSkillTaxonomySchema.safeParse({
    version: 'v1',
    id: r.taxonomyId,
    revision: r.revision,
    state: 'PUBLISHED',
    publishedByAccountId: r.publishedByAccountId,
    publishedAt: r.publishedAt.toISOString(),
    skills: r.skills,
  });
  if (!parsed.success) fail('STORAGE_CONTRACT');
  return parsed.data;
}
/** Receipt → User → Session → catalog advisory lock → projection. No rank, public or external effects. */
export async function publishSkillTaxonomy(
  tx: CommandReceiptTransaction,
  command: PublishSkillTaxonomyCommand,
  options: SkillTaxonomyStorageOptions,
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; taxonomy: PublishedSkillTaxonomy }> {
  const actor = actorValid(command?.actor);
  if (typeof options?.allowNewWrites !== 'boolean' || typeof options?.canPublish !== 'function')
    fail('STORAGE_CONTRACT');
  const parsed = PublishSkillTaxonomyInputSchema.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const input = parsed.data;
  let result;
  try {
    result = await executeIdempotentCommand(
      tx,
      {
        actorId: actor.accountId,
        commandKind: 'PublishSkillTaxonomy',
        idempotencyKey: command.idempotencyKey,
        requestId: command.requestId,
        request: input,
      },
      async ({ receiptId }) => {
        await authorize(tx, actor, options.canPublish);
        if (!options.allowNewWrites) fail('WRITES_DISABLED');
        // A lock exists even before the first row. Hash collisions only serialize unrelated catalogs.
        await query(
          tx,
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 12012))::text AS locked',
          [input.taxonomyId],
        );
        const rows = await query<{ currentVersionId: string }>(
          tx,
          'SELECT "currentVersionId"::text FROM "SkillTaxonomy" WHERE "id"=$1 FOR UPDATE',
          [input.taxonomyId],
        );
        await authorize(tx, actor, options.canPublish);
        if (rows.length > 1) fail('STORAGE_CONTRACT');
        const previous = rows.length ? await loadVersion(tx, rows[0].currentVersionId) : null;
        const proposal = prepareSkillTaxonomyUpdate(previous, input);
        const versions = await query<{ id: string }>(
          tx,
          `INSERT INTO "SkillTaxonomyVersion"("taxonomyId","revision","skills","receiptId","publishedByAccountId","requestId") VALUES($1,$2::int,$3::jsonb,$4::uuid,$5,$6) RETURNING "id"::text`,
          [
            input.taxonomyId,
            String(proposal.taxonomy.revision),
            JSON.stringify(proposal.taxonomy.skills),
            receiptId,
            actor.accountId,
            command.requestId,
          ],
        );
        if (versions.length !== 1 || !z.uuid().safeParse(versions[0].id).success)
          fail('STORAGE_CONTRACT');
        const versionId = versions[0].id;
        const projections = await query<{ id: string }>(
          tx,
          previous === null
            ? 'INSERT INTO "SkillTaxonomy"("id","revision","currentVersionId") VALUES($1,$2::int,$3::uuid) RETURNING "id"'
            : 'UPDATE "SkillTaxonomy" SET "revision"=$2::int,"currentVersionId"=$3::uuid WHERE "id"=$1 RETURNING "id"',
          [input.taxonomyId, String(proposal.taxonomy.revision), versionId],
        );
        if (projections.length !== 1) fail('STORAGE_CONTRACT');
        await authorize(tx, actor, options.canPublish);
        return {
          resultRef: versionId,
          events: [
            {
              type: 'skill.taxonomy_published.v1',
              aggregateId: input.taxonomyId,
              aggregateVersion: proposal.taxonomy.revision,
              payload: { skillTaxonomyVersionId: versionId },
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
  // Replays skip the handler, but neither policy revocation nor session expiry is bypassed.
  await authorize(tx, actor, options.canPublish);
  const taxonomy = await loadVersion(tx, result.resultRef);
  await authorize(tx, actor, options.canPublish);
  return { status: result.status, taxonomy };
}
export async function readPublishedSkillTaxonomy(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  id: string,
): Promise<PublishedSkillTaxonomy | null> {
  const actor = actorValid(actorValue);
  if (!InternalId.safeParse(id).success) fail('INVALID_INPUT');
  await authorize(tx, actor);
  const rows = await query<{ currentVersionId: string }>(
    tx,
    'SELECT "currentVersionId"::text FROM "SkillTaxonomy" WHERE "id"=$1',
    [id],
  );
  if (rows.length > 1) fail('STORAGE_CONTRACT');
  const result = rows.length ? await loadVersion(tx, rows[0].currentVersionId) : null;
  await authorize(tx, actor);
  return result;
}
export async function readSkillTaxonomyForPublisher(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  id: string,
  policy: Pick<SkillTaxonomyStorageOptions, 'canPublish'>,
): Promise<PublishedSkillTaxonomy | null> {
  const actor = actorValid(actorValue);
  if (!InternalId.safeParse(id).success) fail('INVALID_INPUT');
  if (typeof policy?.canPublish !== 'function') fail('STORAGE_CONTRACT');
  await authorize(tx, actor, policy.canPublish);
  const result = await readPublishedSkillTaxonomy(tx, actor, id);
  await authorize(tx, actor, policy.canPublish);
  return result;
}
