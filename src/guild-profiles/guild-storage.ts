import { z } from 'zod';
import {
  CommandReceiptError,
  executeIdempotentCommand,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';
import { InternalId } from '../contracts/ids';
import { PublicGuildSchema } from '../contracts/entities';
import { evaluateGuildProfilePermission, projectPublicGuildProfile } from './index';
import {
  ActivateGuildInputSchema,
  EditGuildProfileInputSchema,
  GUILD_AUTHORITY_KINDS,
  GuildStorageError,
  ManagedGuildSchema,
  type GuildActivationHost,
  type GuildActor,
  type GuildAuthorityKind,
  type GuildCommand,
  type GuildHost,
  type ManagedGuild,
} from './guild-storage-contracts';

export * from './guild-storage-contracts';
function fail(code: GuildStorageError['code']): never {
  throw new GuildStorageError(code);
}
function validateActor(actor: GuildActor) {
  if (!InternalId.safeParse(actor?.accountId).success) fail('INVALID_INPUT');
  if (typeof actor.sessionHash !== 'string' || !/^[a-f0-9]{64}$/.test(actor.sessionHash))
    fail('UNAUTHENTICATED');
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
    if (error instanceof GuildStorageError || error instanceof CommandReceiptError) throw error;
    return fail('STORAGE_UNAVAILABLE');
  }
}
/** User → Session, with the database clock after any row wait. Held to commit. */
async function authorize(tx: CommandReceiptTransaction, actor: GuildActor) {
  const users = await query<{ suspended: boolean }>(
    tx,
    'SELECT "suspended" FROM "User" WHERE "id"=$1 FOR NO KEY UPDATE',
    [actor.accountId],
  );
  if (users.length !== 1) fail('UNAUTHENTICATED');
  if (users[0].suspended) fail('ACCOUNT_RESTRICTED');
  const sessions = await query<{ userId: string; via: string; valid: boolean }>(
    tx,
    `SELECT "userId","via","expiresAt">(clock_timestamp() AT TIME ZONE 'UTC') AS valid FROM "Session" WHERE "tokenHash"=$1 FOR SHARE`,
    [actor.sessionHash],
  );
  if (
    sessions.length !== 1 ||
    sessions[0].userId !== actor.accountId ||
    !['wallet', 'x'].includes(sessions[0].via) ||
    sessions[0].valid !== true
  )
    fail('UNAUTHENTICATED');
}
async function loadGuild(tx: CommandReceiptTransaction, id: string): Promise<ManagedGuild> {
  const rows = await query<Record<string, unknown>>(
    tx,
    `SELECT g."id"::text,g."slug",v."name",v."description",g."founderAccountId",g."revision"
     FROM "Guild" g JOIN "GuildProfileVersion" v ON v."id"=g."currentVersionId" WHERE g."id"=$1::uuid`,
    [id],
  );
  if (rows.length !== 1) fail('NOT_FOUND');
  const parsed = ManagedGuildSchema.safeParse({
    version: 'v1',
    ...rows[0],
    state: 'ACTIVE',
    primaryToken: null,
  });
  if (!parsed.success) fail('STORAGE_CONTRACT');
  return parsed.data;
}
/** The Guild as one stored profile version recorded it, so a replay never exposes later revisions. */
async function loadVersion(
  tx: CommandReceiptTransaction,
  guildId: string,
  versionId: string,
): Promise<ManagedGuild> {
  const rows = await query<Record<string, unknown>>(
    tx,
    `SELECT g."id"::text,g."slug",v."name",v."description",g."founderAccountId",v."revision"
     FROM "GuildProfileVersion" v JOIN "Guild" g ON g."id"=v."guildId" WHERE v."id"=$1::uuid AND v."guildId"=$2::uuid`,
    [versionId, guildId],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const parsed = ManagedGuildSchema.safeParse({
    version: 'v1',
    ...rows[0],
    state: 'ACTIVE',
    primaryToken: null,
  });
  if (!parsed.success) fail('STORAGE_CONTRACT');
  return parsed.data;
}
/** Founder implies profile and work management only; treasury and dispute need their own explicit grant. */
async function authorityKinds(
  tx: CommandReceiptTransaction,
  accountId: string,
  guildId: string,
): Promise<{ founder: boolean; kinds: GuildAuthorityKind[] }> {
  const rows = await query<{ founder: boolean; kinds: string[] | null }>(
    tx,
    `SELECT g."founderAccountId"=$2 AS founder,
       (SELECT array_agg(DISTINCT r."kind") FROM "GuildRoleGrant" r
         WHERE r."guildId"=g."id" AND r."granteeAccountId"=$2 AND r."revokedAt" IS NULL
          AND r."validFrom"<=clock_timestamp() AND (r."expiresAt" IS NULL OR r."expiresAt">clock_timestamp())) AS kinds
     FROM "Guild" g JOIN "User" u ON u."id"=$2 AND NOT u."suspended" WHERE g."id"=$1::uuid`,
    [guildId, accountId],
  );
  if (rows.length === 0) return { founder: false, kinds: [] };
  const granted = new Set(rows[0].kinds ?? []);
  if (rows[0].founder) {
    granted.add('PROFILE');
    granted.add('WORK');
  }
  return {
    founder: rows[0].founder,
    kinds: GUILD_AUTHORITY_KINDS.filter((kind) => granted.has(kind)),
  };
}
/**
 * Current authority of an account in one Guild for one kind. Informational for hosts such as the work boundary: it
 * is recomputed on every call, never cached, and a token balance or role elsewhere never enters it.
 */
export async function hasGuildAuthority(
  tx: CommandReceiptTransaction,
  accountId: string,
  guildId: string,
  kind: GuildAuthorityKind,
): Promise<boolean> {
  if (
    !InternalId.safeParse(accountId).success ||
    !z.uuid().safeParse(guildId).success ||
    !GUILD_AUTHORITY_KINDS.includes(kind)
  )
    return false;
  return (await authorityKinds(tx, accountId, guildId)).kinds.includes(kind);
}
/** Records an operator's approval of an owner's draft as an active Guild; the draft owner becomes its Founder. */
export async function activateGuild(
  tx: CommandReceiptTransaction,
  command: GuildCommand,
  host: GuildActivationHost,
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; guild: ManagedGuild }> {
  validateActor(command?.actor);
  if (typeof host?.allowNewWrites !== 'boolean' || typeof host.authorizeActivation !== 'function')
    fail('STORAGE_CONTRACT');
  const parsed = ActivateGuildInputSchema.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const input = parsed.data,
    actor = command.actor;
  const approved = async () => {
    await authorize(tx, actor);
    if ((await host.authorizeActivation(tx, { accountId: actor.accountId })) !== true)
      fail('FORBIDDEN');
  };
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'ActivateGuild',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: input,
    },
    async ({ receiptId }) => {
      await approved();
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      // The draft writer locks the owner's User row and then the draft; take them in that order here too.
      // The owner is immutable, so it can be read before any lock and confirmed after.
      const found = await query<{ ownerAccountId: string }>(
        tx,
        'SELECT "ownerAccountId" FROM "GuildDraft" WHERE "id"=$1::uuid',
        [input.guildDraftId],
      );
      if (found.length !== 1) fail('NOT_FOUND');
      // Founder control is approved by someone other than the Founder, whatever the host policy says.
      if (found[0].ownerAccountId === actor.accountId) fail('FORBIDDEN');
      const owners = await query<{ suspended: boolean }>(
        tx,
        'SELECT "suspended" FROM "User" WHERE "id"=$1 FOR SHARE',
        [found[0].ownerAccountId],
      );
      if (owners.length !== 1 || owners[0].suspended) fail('ACCOUNT_RESTRICTED');
      const drafts = await query<{
        ownerAccountId: string;
        revision: number;
        slug: string;
        profile: { name: string; description: string };
      }>(
        tx,
        `SELECT d."ownerAccountId",d."revision",d."slug",v."profile" FROM "GuildDraft" d JOIN "GuildDraftVersion" v ON v."id"=d."currentVersionId" WHERE d."id"=$1::uuid FOR UPDATE OF d`,
        [input.guildDraftId],
      );
      if (drafts.length !== 1 || drafts[0].ownerAccountId !== found[0].ownerAccountId)
        fail('STORAGE_CONTRACT');
      // Row acquisition can wait; the approver must still hold authority afterwards.
      await approved();
      const draft = drafts[0];
      if (draft.revision !== input.expectedDraftRevision) fail('REVISION_CONFLICT');
      const existing = await query(tx, 'SELECT 1 FROM "Guild" WHERE "sourceDraftId"=$1::uuid', [
        input.guildDraftId,
      ]);
      if (existing.length) fail('GUILD_EXISTS');
      const ids = await query<{ id: string }>(tx, 'SELECT gen_random_uuid()::text AS id', []);
      if (ids.length !== 1 || !z.uuid().safeParse(ids[0].id).success) fail('STORAGE_CONTRACT');
      const guildId = ids[0].id;
      const versions = await query<{ id: string }>(
        tx,
        `INSERT INTO "GuildProfileVersion" ("guildId","revision","name","description","receiptId","actorAccountId","requestId") VALUES ($1::uuid,1,$2,$3,$4::uuid,$5,$6) RETURNING "id"::text`,
        [
          guildId,
          draft.profile.name,
          draft.profile.description,
          receiptId,
          actor.accountId,
          command.requestId,
        ],
      );
      if (versions.length !== 1) fail('STORAGE_CONTRACT');
      const inserted = await query<{ id: string }>(
        tx,
        `INSERT INTO "Guild" ("id","slug","founderAccountId","revision","currentVersionId","activationRef","activatedByAccountId","sourceDraftId") VALUES ($1::uuid,$2,$3,1,$4::uuid,$5,$6,$7::uuid) ON CONFLICT DO NOTHING RETURNING "id"::text`,
        [
          guildId,
          draft.slug,
          draft.ownerAccountId,
          versions[0].id,
          input.activationRef,
          actor.accountId,
          input.guildDraftId,
        ],
      );
      if (inserted.length === 0) {
        const again = await query(tx, 'SELECT 1 FROM "Guild" WHERE "sourceDraftId"=$1::uuid', [
          input.guildDraftId,
        ]);
        return again.length ? fail('GUILD_EXISTS') : fail('SLUG_UNAVAILABLE');
      }
      await approved();
      return {
        resultRef: guildId,
        events: [
          {
            type: 'guild.activated.v1',
            aggregateId: guildId,
            aggregateVersion: 1,
            guildId,
            payload: { guildProfileVersionId: versions[0].id },
            publish: false,
          },
        ],
      };
    },
  );
  // A replay skips the handler and must still prove the approver's current authority.
  await approved();
  return { status: result.status, guild: await loadGuild(tx, result.resultRef) };
}
/** Edits the public profile fields the actor may change, as the Founder or under a live field-scoped grant. */
export async function editGuildProfile(
  tx: CommandReceiptTransaction,
  command: GuildCommand,
  host: GuildHost,
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; guild: ManagedGuild }> {
  validateActor(command?.actor);
  if (typeof host?.allowNewWrites !== 'boolean') fail('STORAGE_CONTRACT');
  const parsed = EditGuildProfileInputSchema.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const input = parsed.data,
    actor = command.actor;
  const fields = Object.keys(input.profile).filter(
    (k) => input.profile[k as 'name' | 'description'] !== undefined,
  );
  /**
   * Rebuilds the trusted facts for the pure policy under the current database clock and requires the actor to be
   * allowed to change exactly the requested fields. Locks the Guild row when it will write.
   */
  async function permitted(
    lock: boolean,
  ): Promise<{ revision: number; name: string; description: string }> {
    const rows = await query<{
      id: string;
      founderAccountId: string;
      revision: number;
      name: string;
      description: string;
      now: Date;
    }>(
      tx,
      `SELECT g."id"::text,g."founderAccountId",g."revision",v."name",v."description",date_trunc('milliseconds',clock_timestamp()) AS now
       FROM "Guild" g JOIN "GuildProfileVersion" v ON v."id"=g."currentVersionId" WHERE g."id"=$1::uuid${lock ? ' FOR UPDATE OF g' : ''}`,
      [input.guildId],
    );
    if (rows.length !== 1) fail('NOT_FOUND');
    await authorize(tx, actor);
    const guild = rows[0];
    // Window bounds are rounded conservatively to the policy's millisecond precision (start up, expiry down).
    const grants = await query<{
      id: string;
      fields: string[];
      validFrom: Date;
      expiresAt: Date | null;
    }>(
      tx,
      `SELECT "id"::text,"fields",
         date_trunc('milliseconds',"validFrom")+CASE WHEN "validFrom">date_trunc('milliseconds',"validFrom") THEN interval '1 millisecond' ELSE interval '0' END AS "validFrom",
         date_trunc('milliseconds',"expiresAt") AS "expiresAt"
       FROM "GuildRoleGrant" WHERE "guildId"=$1::uuid AND "granteeAccountId"=$2 AND "kind"='PROFILE' AND "revokedAt" IS NULL
        AND "validFrom"<=clock_timestamp() AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp())`,
      [input.guildId, actor.accountId],
    );
    const decision = evaluateGuildProfilePermission(
      {
        version: 'v1',
        guild: {
          id: guild.id,
          founderAccountId: guild.founderAccountId,
          revision: guild.revision,
          primaryToken: null,
        },
        // The activation record is the verified relationship; it exists for every row of this table.
        founderControlVerified: true,
        actorAccountId: actor.accountId,
        actorSessionAuthorized: true,
        actorRestricted: false,
        holderEligible: null,
        now: guild.now.toISOString(),
        grants: grants.map((g) => ({
          id: g.id,
          guildId: guild.id,
          granteeAccountId: actor.accountId,
          status: 'ACTIVE',
          fields: g.fields,
          canDelegateProfile: false,
          validFrom: g.validFrom.toISOString(),
          expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
        })),
      },
      { guildId: guild.id, expectedRevision: guild.revision, action: 'EDIT_PROFILE', fields },
    );
    if (!decision.allowed) fail('FORBIDDEN');
    return guild;
  }
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'EditGuildProfile',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: input,
    },
    async ({ receiptId }) => {
      await authorize(tx, actor);
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      const guild = await permitted(true);
      // Permission is judged before the caller's revision so a stranger learns nothing about it.
      if (guild.revision !== input.expectedRevision) fail('REVISION_CONFLICT');
      const next = guild.revision + 1;
      const versions = await query<{ id: string }>(
        tx,
        `INSERT INTO "GuildProfileVersion" ("guildId","revision","name","description","receiptId","actorAccountId","requestId") VALUES ($1::uuid,$2::int,$3,$4,$5::uuid,$6,$7) RETURNING "id"::text`,
        [
          input.guildId,
          String(next),
          input.profile.name ?? guild.name,
          input.profile.description ?? guild.description,
          receiptId,
          actor.accountId,
          command.requestId,
        ],
      );
      if (versions.length !== 1) fail('STORAGE_CONTRACT');
      const updated = await query(
        tx,
        `UPDATE "Guild" SET "revision"=$2::int,"currentVersionId"=$3::uuid WHERE "id"=$1::uuid AND "revision"=$4::int RETURNING "id"`,
        [input.guildId, String(next), versions[0].id, String(guild.revision)],
      );
      if (updated.length !== 1) fail('STORAGE_CONTRACT');
      await authorize(tx, actor);
      return {
        resultRef: versions[0].id,
        events: [
          {
            type: 'guild.profile_edited.v1',
            aggregateId: input.guildId,
            aggregateVersion: next,
            guildId: input.guildId,
            payload: { guildProfileVersionId: versions[0].id },
            publish: false,
          },
        ],
      };
    },
  );
  // A replay returns the stored result only to an actor whose current authority still covers the same fields.
  await authorize(tx, actor);
  await permitted(false);
  return { status: result.status, guild: await loadVersion(tx, input.guildId, result.resultRef) };
}
/** The approved public projection of an active Guild by stable slug. No private record is read. */
export async function readPublicGuild(tx: CommandReceiptTransaction, slug: string) {
  if (!PublicGuildSchema.shape.slug.safeParse(slug).success) fail('INVALID_INPUT');
  const rows = await query<Record<string, unknown>>(
    tx,
    `SELECT g."id"::text,g."slug",v."name",v."description" FROM "Guild" g JOIN "GuildProfileVersion" v ON v."id"=g."currentVersionId" WHERE g."slug"=$1`,
    [slug],
  );
  if (rows.length !== 1) fail('NOT_FOUND');
  const row = rows[0] as { id: string; slug: string; name: string; description: string };
  // Activation by the approving operator is the host-owned publication decision for the projection.
  return projectPublicGuildProfile({
    version: 'v1',
    guild: { id: row.id, founderAccountId: 'redacted', revision: 1, primaryToken: null },
    publicProfile: { ...row, primaryToken: null },
    publicProfileApproved: true,
  });
}
/** The private management view: the Guild plus only the authority the caller actually holds. */
export async function readManagedGuild(
  tx: CommandReceiptTransaction,
  actor: GuildActor,
  guildId: string,
) {
  validateActor(actor);
  if (!z.uuid().safeParse(guildId).success) fail('INVALID_INPUT');
  await authorize(tx, actor);
  const authority = await authorityKinds(tx, actor.accountId, guildId);
  if (!authority.kinds.length) fail('FORBIDDEN');
  const guild = await loadGuild(tx, guildId);
  await authorize(tx, actor);
  return { guild, authority };
}
