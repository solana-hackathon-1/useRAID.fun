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
  DELEGATED_GRANT_LIMIT,
  EditGuildProfileInputSchema,
  GUILD_AUTHORITY_KINDS,
  GUILD_GRANT_LIMIT,
  GrantGuildRoleInputSchema,
  GuildRoleGrantViewSchema,
  OWNERSHIP_TRANSFER_MAX_DAYS,
  OwnershipTransferViewSchema,
  ProposeOwnershipTransferInputSchema,
  RespondOwnershipTransferInputSchema,
  RevokeGuildRoleInputSchema,
  type GuildOwnershipHost,
  type GuildRoleGrantView,
  type OwnershipTransferView,
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
/**
 * Asks the pure policy whether the actor may take a profile action over these fields, from facts rebuilt here under the
 * database clock. Window bounds are rounded conservatively to the policy's millisecond precision (start up, expiry down).
 */
async function profileDecision(
  tx: CommandReceiptTransaction,
  actor: GuildActor,
  guild: { id: string; founderAccountId: string; revision: number; now: Date },
  action: 'EDIT_PROFILE' | 'DELEGATE_PROFILE',
  fields: string[],
) {
  const grants = await query<{
    id: string;
    fields: string[];
    canDelegate: boolean;
    validFrom: Date;
    expiresAt: Date | null;
  }>(
    tx,
    `SELECT "id"::text,"fields","canDelegate",
       date_trunc('milliseconds',"validFrom")+CASE WHEN "validFrom">date_trunc('milliseconds',"validFrom") THEN interval '1 millisecond' ELSE interval '0' END AS "validFrom",
       date_trunc('milliseconds',"expiresAt") AS "expiresAt"
     FROM "GuildRoleGrant" WHERE "guildId"=$1::uuid AND "granteeAccountId"=$2 AND "kind"='PROFILE' AND "revokedAt" IS NULL
      AND "validFrom"<=clock_timestamp() AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp())`,
    [guild.id, actor.accountId],
  );
  return evaluateGuildProfilePermission(
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
        canDelegateProfile: g.canDelegate,
        validFrom: g.validFrom.toISOString(),
        expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
      })),
    },
    { guildId: guild.id, expectedRevision: guild.revision, action, fields },
  );
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
    const decision = await profileDecision(tx, actor, guild, 'EDIT_PROFILE', fields);
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
const LIVE_R = `r."revokedAt" IS NULL AND r."validFrom"<=clock_timestamp() AND (r."expiresAt" IS NULL OR r."expiresAt">clock_timestamp())`;
const LIVE = `"revokedAt" IS NULL AND "validFrom"<=clock_timestamp() AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp())`;
async function loadGrant(
  tx: CommandReceiptTransaction,
  guildId: string,
  grantId: string,
): Promise<GuildRoleGrantView> {
  const rows = await query<Record<string, unknown>>(
    tx,
    `SELECT "id"::text,"guildId"::text,"granteeAccountId","kind","fields","canDelegate","validFrom","expiresAt","revokedAt","grantedByAccountId"
     FROM "GuildRoleGrant" WHERE "id"=$1::uuid AND "guildId"=$2::uuid`,
    [grantId, guildId],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
  const parsed = GuildRoleGrantViewSchema.safeParse({
    version: 'v1',
    ...rows[0],
    validFrom: iso(rows[0].validFrom),
    expiresAt: iso(rows[0].expiresAt),
    revokedAt: iso(rows[0].revokedAt),
  });
  if (!parsed.success) fail('STORAGE_CONTRACT');
  return parsed.data;
}
/**
 * Delegates a role. The Founder may grant any kind to another account (never to themselves, and never treasury or
 * dispute authority to themselves). A grantee with a live delegating profile grant may pass on only profile fields
 * they hold, without delegation rights, and not beyond their own expiry.
 */
export async function grantGuildRole(
  tx: CommandReceiptTransaction,
  command: GuildCommand,
  host: GuildHost,
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; grant: GuildRoleGrantView }> {
  validateActor(command?.actor);
  if (typeof host?.allowNewWrites !== 'boolean') fail('STORAGE_CONTRACT');
  const parsed = GrantGuildRoleInputSchema.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const input = parsed.data,
    actor = command.actor;
  /** May this actor issue roles in this Guild at all (Founder, or holding a live delegating profile grant)? */
  async function mayDelegate() {
    const rows = await query<{ founder: boolean; delegating: boolean }>(
      tx,
      `SELECT g."founderAccountId"=$2 AS founder,
         EXISTS(SELECT 1 FROM "GuildRoleGrant" WHERE "guildId"=g."id" AND "granteeAccountId"=$2 AND "kind"='PROFILE' AND "canDelegate" AND ${LIVE}) AS delegating
       FROM "Guild" g WHERE g."id"=$1::uuid`,
      [input.guildId, actor.accountId],
    );
    return rows.length === 1 && (rows[0].founder || rows[0].delegating);
  }
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'GrantGuildRole',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: input,
    },
    async ({ receiptId }) => {
      await authorize(tx, actor);
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      const guilds = await query<{
        id: string;
        founderAccountId: string;
        revision: number;
        now: Date;
      }>(
        tx,
        `SELECT "id"::text,"founderAccountId","revision",date_trunc('milliseconds',clock_timestamp()) AS now FROM "Guild" WHERE "id"=$1::uuid FOR UPDATE`,
        [input.guildId],
      );
      if (guilds.length !== 1) fail('NOT_FOUND');
      await authorize(tx, actor);
      const guild = guilds[0];
      const founder = guild.founderAccountId === actor.accountId;
      // Nobody grants themselves a role, and the Founder already holds profile and work by role.
      if (
        input.granteeAccountId === actor.accountId ||
        input.granteeAccountId === guild.founderAccountId
      )
        fail('FORBIDDEN');
      if (input.expiresAt !== null) {
        const ok = await query<{ ok: boolean }>(
          tx,
          'SELECT $1::timestamptz>clock_timestamp() AS ok',
          [input.expiresAt],
        );
        if (ok[0]?.ok !== true) fail('INVALID_INPUT');
      }
      if (!founder) {
        // Redelegation: profile fields the actor holds with delegation rights, nothing more, nothing longer.
        if (input.kind !== 'PROFILE' || input.canDelegate) fail('FORBIDDEN');
        const decision = await profileDecision(tx, actor, guild, 'DELEGATE_PROFILE', input.fields);
        if (!decision.allowed) fail('FORBIDDEN');
        const bounds = await query<{ field: string; bound: Date | null; unbounded: boolean }>(
          tx,
          `SELECT f AS field,max("expiresAt") AS bound,bool_or("expiresAt" IS NULL) AS unbounded
           FROM "GuildRoleGrant" r CROSS JOIN LATERAL unnest(r."fields") f
           WHERE r."guildId"=$1::uuid AND r."granteeAccountId"=$2 AND r."kind"='PROFILE' AND r."canDelegate" AND ${LIVE_R} AND f=ANY($3::text[])
           GROUP BY f`,
          [input.guildId, actor.accountId, `{${input.fields.join(',')}}`],
        );
        // The latest expiry among the covering grants, per field; the earliest of those bounds the new grant.
        const finite = bounds.filter((b) => !b.unbounded && b.bound);
        if (finite.length) {
          const earliest = Math.min(...finite.map((b) => b.bound!.getTime()));
          if (input.expiresAt === null || Date.parse(input.expiresAt) > earliest) fail('FORBIDDEN');
        }
        const passed = await query<{ n: number }>(
          tx,
          `SELECT count(*)::int AS n FROM "GuildRoleGrant" WHERE "guildId"=$1::uuid AND "grantedByAccountId"=$2 AND ${LIVE}`,
          [input.guildId, actor.accountId],
        );
        if ((passed[0]?.n ?? 0) >= DELEGATED_GRANT_LIMIT) fail('GRANT_LIMIT');
      }
      const live = await query<{ n: number }>(
        tx,
        `SELECT count(*)::int AS n FROM "GuildRoleGrant" WHERE "guildId"=$1::uuid AND ${LIVE}`,
        [input.guildId],
      );
      if ((live[0]?.n ?? 0) >= GUILD_GRANT_LIMIT) fail('GRANT_LIMIT');
      // Read without a lock: locking the grantee here would invert the grantee-then-Guild order other commands use.
      // The foreign key still proves existence, and suspension is re-checked wherever authority is used.
      const grantees = await query<{ suspended: boolean }>(
        tx,
        'SELECT "suspended" FROM "User" WHERE "id"=$1',
        [input.granteeAccountId],
      );
      if (grantees.length !== 1) fail('NOT_FOUND');
      if (grantees[0].suspended) fail('ACCOUNT_RESTRICTED');
      const rows = await query<{ id: string }>(
        tx,
        `INSERT INTO "GuildRoleGrant" ("guildId","granteeAccountId","kind","fields","canDelegate","expiresAt","grantedByAccountId","receiptId") VALUES ($1::uuid,$2,$3,$4::text[],$5::boolean,$6::timestamptz,$7,$8::uuid) RETURNING "id"::text`,
        [
          input.guildId,
          input.granteeAccountId,
          input.kind,
          `{${input.fields.join(',')}}`,
          String(input.canDelegate),
          input.expiresAt,
          actor.accountId,
          receiptId,
        ],
      );
      if (rows.length !== 1) fail('STORAGE_CONTRACT');
      await authorize(tx, actor);
      return {
        resultRef: rows[0].id,
        events: [
          {
            type: 'guild.role_granted.v1',
            aggregateId: input.guildId,
            aggregateVersion: guild.revision,
            guildId: input.guildId,
            payload: { guildRoleGrantId: rows[0].id },
            publish: false,
          },
        ],
      };
    },
  );
  // A replay re-proves the issuing authority and returns the grant as stored, never to anyone else.
  await authorize(tx, actor);
  if (!(await mayDelegate())) fail('FORBIDDEN');
  return { status: result.status, grant: await loadGrant(tx, input.guildId, result.resultRef) };
}
/**
 * Revokes a grant: by the Founder, the account that issued it, or its grantee (surrender). Revoking a delegating profile
 * grant also revokes what that grantee passed on (unless another delegating grant of theirs is still live).
 */
export async function revokeGuildRole(
  tx: CommandReceiptTransaction,
  command: GuildCommand,
  host: GuildHost,
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; grant: GuildRoleGrantView }> {
  validateActor(command?.actor);
  if (typeof host?.allowNewWrites !== 'boolean') fail('STORAGE_CONTRACT');
  const parsed = RevokeGuildRoleInputSchema.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const input = parsed.data,
    actor = command.actor;
  const involved = (row: { founder: boolean; grantedBy: string; grantee: string }) =>
    row.founder || row.grantedBy === actor.accountId || row.grantee === actor.accountId;
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'RevokeGuildRole',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: input,
    },
    async () => {
      await authorize(tx, actor);
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      // The Guild row serializes revocation with profile edits, grants and other revocations.
      const guilds = await query<{ founderAccountId: string; revision: number }>(
        tx,
        'SELECT "founderAccountId","revision" FROM "Guild" WHERE "id"=$1::uuid FOR UPDATE',
        [input.guildId],
      );
      if (guilds.length !== 1) fail('NOT_FOUND');
      await authorize(tx, actor);
      const grants = await query<{
        kind: string;
        canDelegate: boolean;
        grantee: string;
        grantedBy: string;
        revoked: boolean;
      }>(
        tx,
        `SELECT "kind","canDelegate","granteeAccountId" AS grantee,"grantedByAccountId" AS "grantedBy","revokedAt" IS NOT NULL AS revoked
         FROM "GuildRoleGrant" WHERE "id"=$1::uuid AND "guildId"=$2::uuid FOR UPDATE`,
        [input.grantId, input.guildId],
      );
      if (grants.length !== 1) fail('NOT_FOUND');
      const grant = grants[0];
      if (!involved({ founder: guilds[0].founderAccountId === actor.accountId, ...grant }))
        fail('FORBIDDEN');
      if (grant.revoked) fail('REVISION_CONFLICT');
      await query(
        tx,
        'UPDATE "GuildRoleGrant" SET "revokedAt"=clock_timestamp() WHERE "id"=$1::uuid AND "revokedAt" IS NULL RETURNING "id"',
        [input.grantId],
      );
      const passedOn: string[] = [];
      if (grant.kind === 'PROFILE' && grant.canDelegate) {
        // Only grants that are still live and no longer backed are revoked; each of their fields needs a remaining live
        // delegating grant of the grantee that covers the field and lasts at least as long. Expired rows grant nothing,
        // are not counted by any cap and stay as history, so they cannot inflate the audit events of this command.
        const cascaded = await query<{ id: string }>(
          tx,
          `UPDATE "GuildRoleGrant" s SET "revokedAt"=clock_timestamp()
           WHERE s."guildId"=$1::uuid AND s."grantedByAccountId"=$2 AND s."kind"='PROFILE' AND s."revokedAt" IS NULL
             AND (s."expiresAt" IS NULL OR s."expiresAt">clock_timestamp())
             AND EXISTS (
               SELECT 1 FROM unnest(s."fields") f WHERE NOT EXISTS (
                 SELECT 1 FROM "GuildRoleGrant" d
                 WHERE d."guildId"=$1::uuid AND d."granteeAccountId"=$2 AND d."kind"='PROFILE' AND d."canDelegate"
                   AND d."revokedAt" IS NULL AND d."validFrom"<=clock_timestamp()
                   AND (d."expiresAt" IS NULL OR d."expiresAt">clock_timestamp())
                   AND f=ANY(d."fields")
                   AND (d."expiresAt" IS NULL OR (s."expiresAt" IS NOT NULL AND s."expiresAt"<=d."expiresAt"))))
           RETURNING s."id"::text`,
          [input.guildId, grant.grantee],
        );
        passedOn.push(...cascaded.map((row) => row.id));
      }
      await authorize(tx, actor);
      return {
        resultRef: input.grantId,
        events: [input.grantId, ...passedOn].map((id) => ({
          type: 'guild.role_revoked.v1',
          aggregateId: input.guildId,
          aggregateVersion: guilds[0].revision,
          guildId: input.guildId,
          payload: { guildRoleGrantId: id },
          publish: false,
        })),
      };
    },
  );
  // A replay is for the people involved in the grant, judged by identity rather than by whether the grant is live.
  await authorize(tx, actor);
  const again = await query<{ founder: boolean; grantedBy: string; grantee: string }>(
    tx,
    `SELECT g."founderAccountId"=$3 AS founder,r."grantedByAccountId" AS "grantedBy",r."granteeAccountId" AS grantee
     FROM "GuildRoleGrant" r JOIN "Guild" g ON g."id"=r."guildId" WHERE r."id"=$1::uuid AND r."guildId"=$2::uuid`,
    [input.grantId, input.guildId, actor.accountId],
  );
  if (again.length !== 1 || !involved(again[0])) fail('FORBIDDEN');
  return { status: result.status, grant: await loadGrant(tx, input.guildId, result.resultRef) };
}
async function loadTransfer(
  tx: CommandReceiptTransaction,
  guildId: string,
  id: string,
): Promise<OwnershipTransferView> {
  const rows = await query<Record<string, unknown>>(
    tx,
    `SELECT "id"::text,"guildId"::text,"fromAccountId","toAccountId","state","expiresAt","decidedAt","appliedAt" IS NOT NULL AS applied
     FROM "GuildOwnershipTransfer" WHERE "id"=$1::uuid AND "guildId"=$2::uuid`,
    [id, guildId],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
  const parsed = OwnershipTransferViewSchema.safeParse({
    version: 'v1',
    ...rows[0],
    expiresAt: iso(rows[0].expiresAt),
    decidedAt: iso(rows[0].decidedAt),
  });
  if (!parsed.success) fail('STORAGE_CONTRACT');
  return parsed.data;
}
/** The current Founder offers the Founder role to another account; nothing changes until that account accepts. */
export async function proposeOwnershipTransfer(
  tx: CommandReceiptTransaction,
  command: GuildCommand,
  host: GuildHost,
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; transfer: OwnershipTransferView }> {
  validateActor(command?.actor);
  if (typeof host?.allowNewWrites !== 'boolean') fail('STORAGE_CONTRACT');
  const parsed = ProposeOwnershipTransferInputSchema.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const input = parsed.data,
    actor = command.actor;
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'ProposeOwnershipTransfer',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: input,
    },
    async ({ receiptId }) => {
      await authorize(tx, actor);
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      const guilds = await query<{ founderAccountId: string; revision: number }>(
        tx,
        'SELECT "founderAccountId","revision" FROM "Guild" WHERE "id"=$1::uuid FOR UPDATE',
        [input.guildId],
      );
      if (guilds.length !== 1) fail('NOT_FOUND');
      await authorize(tx, actor);
      if (guilds[0].founderAccountId !== actor.accountId) fail('FORBIDDEN');
      if (input.toAccountId === actor.accountId) fail('INVALID_INPUT');
      const window = await query<{ ok: boolean }>(
        tx,
        `SELECT $1::timestamptz>clock_timestamp() AND $1::timestamptz<=clock_timestamp()+($2||' days')::interval AS ok`,
        [input.expiresAt, String(OWNERSHIP_TRANSFER_MAX_DAYS)],
      );
      if (window[0]?.ok !== true) fail('INVALID_INPUT');
      // Read without a lock: the foreign key proves existence and acceptance re-checks the recipient's own session.
      const recipients = await query<{ suspended: boolean }>(
        tx,
        'SELECT "suspended" FROM "User" WHERE "id"=$1',
        [input.toAccountId],
      );
      if (recipients.length !== 1) fail('NOT_FOUND');
      if (recipients[0].suspended) fail('ACCOUNT_RESTRICTED');
      const lapsed = await query<{ id: string }>(
        tx,
        `UPDATE "GuildOwnershipTransfer" SET "state"='EXPIRED',"decidedAt"=clock_timestamp(),"decidedByAccountId"=$2,"decideReceiptId"=$3::uuid
         WHERE "guildId"=$1::uuid AND "state"='PROPOSED' AND "expiresAt"<=clock_timestamp() RETURNING "id"::text`,
        [input.guildId, actor.accountId, receiptId],
      );
      const open = await query(
        tx,
        `SELECT 1 FROM "GuildOwnershipTransfer" WHERE "guildId"=$1::uuid AND "state"='PROPOSED'`,
        [input.guildId],
      );
      if (open.length) fail('TRANSFER_PENDING');
      const rows = await query<{ id: string }>(
        tx,
        `INSERT INTO "GuildOwnershipTransfer" ("guildId","fromAccountId","toAccountId","expiresAt","proposeReceiptId") VALUES ($1::uuid,$2,$3,$4::timestamptz,$5::uuid) RETURNING "id"::text`,
        [input.guildId, actor.accountId, input.toAccountId, input.expiresAt, receiptId],
      );
      if (rows.length !== 1) fail('STORAGE_CONTRACT');
      await authorize(tx, actor);
      const event = (type: string, id: string) => ({
        type,
        aggregateId: input.guildId,
        aggregateVersion: guilds[0].revision,
        guildId: input.guildId,
        payload: { guildOwnershipTransferId: id },
        publish: false,
      });
      return {
        resultRef: rows[0].id,
        events: [
          ...lapsed.map((row) => event('guild.ownership_expired.v1', row.id)),
          event('guild.ownership_proposed.v1', rows[0].id),
        ],
      };
    },
  );
  // A replay is for the proposing Founder, judged by identity.
  await authorize(tx, actor);
  const transfer = await loadTransfer(tx, input.guildId, result.resultRef);
  if (transfer.fromAccountId !== actor.accountId) fail('FORBIDDEN');
  return { status: result.status, transfer };
}
/**
 * The recipient accepts or declines; the proposing Founder withdraws. Accepting changes the Guild's Founder in the same
 * transaction, after the host approves the change. Responding to a lapsed proposal records it as expired.
 */
export async function respondOwnershipTransfer(
  tx: CommandReceiptTransaction,
  command: GuildCommand,
  host: GuildOwnershipHost,
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; transfer: OwnershipTransferView }> {
  validateActor(command?.actor);
  if (
    typeof host?.allowNewWrites !== 'boolean' ||
    typeof host.authorizeOwnershipTransfer !== 'function'
  )
    fail('STORAGE_CONTRACT');
  const parsed = RespondOwnershipTransferInputSchema.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const input = parsed.data,
    actor = command.actor;
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'RespondOwnershipTransfer',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: input,
    },
    async ({ receiptId }) => {
      await authorize(tx, actor);
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      const guilds = await query<{ founderAccountId: string; revision: number }>(
        tx,
        'SELECT "founderAccountId","revision" FROM "Guild" WHERE "id"=$1::uuid FOR UPDATE',
        [input.guildId],
      );
      if (guilds.length !== 1) fail('NOT_FOUND');
      await authorize(tx, actor);
      const transfers = await query<{
        fromAccountId: string;
        toAccountId: string;
        state: string;
        lapsed: boolean;
      }>(
        tx,
        `SELECT "fromAccountId","toAccountId","state","expiresAt"<=clock_timestamp() AS lapsed
         FROM "GuildOwnershipTransfer" WHERE "id"=$1::uuid AND "guildId"=$2::uuid FOR UPDATE`,
        [input.transferId, input.guildId],
      );
      if (transfers.length !== 1) fail('NOT_FOUND');
      const transfer = transfers[0];
      const mine =
        input.decision === 'WITHDRAW'
          ? transfer.fromAccountId === actor.accountId &&
            guilds[0].founderAccountId === actor.accountId
          : transfer.toAccountId === actor.accountId;
      if (!mine) fail('FORBIDDEN');
      if (transfer.state !== 'PROPOSED') fail('REVISION_CONFLICT');
      const decide = (state: string) =>
        query(
          tx,
          `UPDATE "GuildOwnershipTransfer" SET "state"=$2,"decidedAt"=clock_timestamp(),"decidedByAccountId"=$3,"decideReceiptId"=$4::uuid WHERE "id"=$1::uuid AND "state"='PROPOSED' RETURNING "id"`,
          [input.transferId, state, actor.accountId, receiptId],
        );
      let type: string;
      if (transfer.lapsed) {
        await decide('EXPIRED');
        type = 'guild.ownership_expired.v1';
      } else if (input.decision === 'ACCEPT') {
        if (
          (await host.authorizeOwnershipTransfer(tx, {
            guildId: input.guildId,
            fromAccountId: transfer.fromAccountId,
            toAccountId: transfer.toAccountId,
          })) !== true
        )
          fail('FORBIDDEN');
        await authorize(tx, actor);
        await decide('ACCEPTED');
        const moved = await query(
          tx,
          `UPDATE "Guild" SET "founderAccountId"=$2 WHERE "id"=$1::uuid AND "founderAccountId"=$3 RETURNING "id"`,
          [input.guildId, transfer.toAccountId, transfer.fromAccountId],
        );
        if (moved.length !== 1) fail('STORAGE_CONTRACT');
        await query(
          tx,
          `UPDATE "GuildOwnershipTransfer" SET "appliedAt"=clock_timestamp() WHERE "id"=$1::uuid AND "state"='ACCEPTED' AND "appliedAt" IS NULL RETURNING "id"`,
          [input.transferId],
        );
        type = 'guild.ownership_transferred.v1';
      } else if (input.decision === 'DECLINE') {
        await decide('DECLINED');
        type = 'guild.ownership_declined.v1';
      } else {
        await decide('WITHDRAWN');
        type = 'guild.ownership_withdrawn.v1';
      }
      await authorize(tx, actor);
      return {
        resultRef: input.transferId,
        events: [
          {
            type,
            aggregateId: input.guildId,
            aggregateVersion: guilds[0].revision,
            guildId: input.guildId,
            payload: { guildOwnershipTransferId: input.transferId },
            publish: false,
          },
        ],
      };
    },
  );
  // A replay is for the two parties of the transfer, judged by identity.
  await authorize(tx, actor);
  const transfer = await loadTransfer(tx, input.guildId, result.resultRef);
  if (transfer.fromAccountId !== actor.accountId && transfer.toAccountId !== actor.accountId)
    fail('FORBIDDEN');
  return { status: result.status, transfer };
}
