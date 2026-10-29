import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { pool } from './connection';
import {
  retryWholeTransaction,
  CommandReceiptError,
  type CommandReceiptTransaction,
} from './command-receipts';
import { saveGuildDraft } from './guild-profiles/draft-storage';
import {
  activateGuild,
  editGuildProfile,
  grantGuildRole,
  hasGuildAuthority,
  readManagedGuild,
  readPublicGuild,
  GuildStorageError,
  type GuildActor,
} from './guild-profiles/guild-storage';

// A synthetic host: its own accounts, its own definition of who may approve activations, no RAID application state.
async function transaction<T>(work: (tx: CommandReceiptTransaction) => Promise<T>): Promise<T> {
  return retryWholeTransaction(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const port: CommandReceiptTransaction = {
        dialect: 'POSTGRESQL',
        isolation: 'READ_COMMITTED',
        async query<Row>(sql: string, bindings: readonly (string | null)[]) {
          try {
            return (await client.query<Row>(sql, bindings)).rows;
          } catch (error) {
            const state = (error as { code?: string }).code;
            throw new CommandReceiptError(
              state === '40001' || state === '40P01' ? 'RETRY_TRANSACTION' : 'STORAGE_UNAVAILABLE',
            );
          }
        },
      };
      const result = await work(port);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}
async function account(label: string): Promise<GuildActor> {
  const id = `synthetic-${label}-${randomUUID()}`;
  const sessionHash = createHash('sha256').update(id).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('INSERT INTO "User" (id) VALUES ($1)', [id]);
    await client.query(
      `INSERT INTO "Session" ("tokenHash","userId","expiresAt") VALUES ($1,$2,(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 hour')`,
      [sessionHash, id],
    );
  } finally {
    client.release();
  }
  return { accountId: id, sessionHash };
}
const founder = await account('founder');
const operator = await account('operator');
const delegate = await account('delegate');
const stranger = await account('holder');
// The host owns this policy: here only the operator account may record a project's verified activation.
const host = {
  allowNewWrites: true,
  authorizeActivation: async (_tx: CommandReceiptTransaction, who: { accountId: string }) =>
    who.accountId === operator.accountId,
};
const cmd = (actor: GuildActor, input: unknown, key: string) => ({
  actor,
  input,
  idempotencyKey: key,
  requestId: 'request-' + key,
});
try {
  const slug = 'synthetic-' + randomUUID();
  const draft = (
    await transaction((tx) =>
      saveGuildDraft(
        tx,
        {
          actor: { ...founder, actorAccountId: founder.accountId },
          input: {
            guildDraftId: null,
            expectedRevision: 0,
            profile: { name: 'Synthetic Guild', slug, description: 'Prepared privately' },
          },
          idempotencyKey: 'draft-' + slug,
          requestId: 'request-draft',
        },
        { allowNewWrites: true },
      ),
    )
  ).draft;
  const input = {
    guildDraftId: draft.id,
    expectedDraftRevision: draft.revision,
    activationRef: 'synthetic-evidence-1',
  };
  await assert.rejects(
    transaction((tx) => activateGuild(tx, cmd(founder, input, 'a-1'), host)),
    (e) => e instanceof GuildStorageError && e.code === 'FORBIDDEN',
  );
  const active = await transaction((tx) => activateGuild(tx, cmd(operator, input, 'a-2'), host));
  assert.equal(active.guild.founderAccountId, founder.accountId);
  assert.equal(
    (await transaction((tx) => activateGuild(tx, cmd(operator, input, 'a-2'), host))).status,
    'REPLAYED',
  );
  const publicView = await transaction((tx) => readPublicGuild(tx, slug));
  assert.deepEqual(Object.keys(publicView).sort(), [
    'description',
    'id',
    'name',
    'primaryToken',
    'slug',
  ]);
  const edited = await transaction((tx) =>
    editGuildProfile(
      tx,
      cmd(
        founder,
        { guildId: active.guild.id, expectedRevision: 1, profile: { name: 'Renamed' } },
        'e-1',
      ),
      host,
    ),
  );
  assert.equal(edited.guild.revision, 2);
  // Holding a token (or any account without a grant) administers nothing.
  await assert.rejects(
    transaction((tx) =>
      editGuildProfile(
        tx,
        cmd(
          stranger,
          { guildId: active.guild.id, expectedRevision: 2, profile: { name: 'Hijack' } },
          'e-2',
        ),
        host,
      ),
    ),
    (e) => e instanceof GuildStorageError && e.code === 'FORBIDDEN',
  );
  // A delegated treasury grant is its own authority: it does not edit the profile, and the Founder has none by role.
  await transaction((tx) =>
    grantGuildRole(
      tx,
      cmd(
        founder,
        { guildId: active.guild.id, granteeAccountId: delegate.accountId, kind: 'TREASURY' },
        'g-1',
      ),
      host,
    ),
  );
  const can = (who: GuildActor, kind: 'PROFILE' | 'WORK' | 'TREASURY' | 'DISPUTE') =>
    transaction((tx) => hasGuildAuthority(tx, who.accountId, active.guild.id, kind));
  assert.deepEqual(
    [
      await can(founder, 'PROFILE'),
      await can(founder, 'TREASURY'),
      await can(delegate, 'TREASURY'),
      await can(delegate, 'PROFILE'),
    ],
    [true, false, true, false],
  );
  await assert.rejects(
    transaction((tx) =>
      editGuildProfile(
        tx,
        cmd(
          delegate,
          { guildId: active.guild.id, expectedRevision: 2, profile: { name: 'Via treasury' } },
          'e-3',
        ),
        host,
      ),
    ),
    (e) => e instanceof GuildStorageError && e.code === 'FORBIDDEN',
  );
  const managed = await transaction((tx) => readManagedGuild(tx, delegate, active.guild.id));
  assert.deepEqual(managed.authority, { founder: false, kinds: ['TREASURY'] });
  console.log(
    'PASS: independent PG host Guild activation by approver, public allowlist, Founder edit, holder denied, treasury separate; SIMULATED ONLY.',
  );
} finally {
  await pool.end();
}
