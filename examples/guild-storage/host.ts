import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { pool } from './connection';
import {
  retryWholeTransaction,
  CommandReceiptError,
  type CommandReceiptTransaction,
} from './command-receipts';
import { saveGuildDraft } from './guild-profiles/draft-storage';
import { createGuildPublicHandlers } from './guild-profiles/guild-public-http';
import { createGuildUpdatesHandlers } from './guild-profiles/guild-updates-http';
import {
  activateGuild,
  draftGuildUpdate,
  editGuildProfile,
  grantGuildRole,
  listManagedGuildUpdates,
  listPublicGuildUpdates,
  publishGuildUpdate,
  withdrawGuildUpdate,
  hasGuildAuthority,
  proposeOwnershipTransfer,
  respondOwnershipTransfer,
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
  // A treasury-only manager does not see the Founder's account id.
  assert.equal(managed.guild.founderAccountId, null);
  // A public update is drafted, then published only by the Founder; the public list shows text and time alone.
  const news = await transaction((tx) =>
    draftGuildUpdate(
      tx,
      cmd(
        founder,
        { guildId: active.guild.id, title: 'Hello', body: 'First release shipped.' },
        'u-1',
      ),
      host,
    ),
  );
  assert.equal((await transaction((tx) => listPublicGuildUpdates(tx, slug, {}))).updates.length, 0);
  await transaction((tx) =>
    publishGuildUpdate(
      tx,
      cmd(founder, { guildId: active.guild.id, updateId: news.update.id }, 'u-2'),
      host,
    ),
  );
  const feed = await transaction((tx) => listPublicGuildUpdates(tx, slug, {}));
  assert.deepEqual(Object.keys(feed.updates[0]).sort(), ['body', 'id', 'publishedAt', 'title']);
  // The same public reads over HTTP with the host's own flag, throttle and transaction; no session is involved.
  let open = true;
  const publicHttp = createGuildPublicHandlers({
    version: 'v1',
    requestId: randomUUID,
    available: () => open,
    rateLimit: () => undefined,
    guild: (name) => transaction((tx) => readPublicGuild(tx, name)),
    updates: (name, query) => transaction((tx) => listPublicGuildUpdates(tx, name, query)),
  });
  const visit = (path: string) => new Request(`https://host.example/api/v1/guilds/${path}`);
  const overHttp = await publicHttp.GUILD(visit(slug), slug);
  assert.equal(overHttp.status, 200);
  assert.equal(overHttp.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(Object.keys(await overHttp.json()).sort(), [
    'description',
    'id',
    'name',
    'primaryToken',
    'slug',
  ]);
  const updatesOverHttp = (await (
    await publicHttp.UPDATES(visit(`${slug}/updates`), slug)
  ).json()) as { updates: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(updatesOverHttp.updates[0]).sort(), [
    'body',
    'id',
    'publishedAt',
    'title',
  ]);
  assert.equal((await publicHttp.GUILD(visit('no-such-guild'), 'no-such-guild')).status, 404);
  // A cursor that names no published update of this Guild is refused, not served as the end of the feed.
  const stale = randomUUID();
  assert.equal(
    (await publicHttp.UPDATES(visit(`${slug}/updates?before=${stale}`), slug)).status,
    422,
  );
  open = false;
  assert.equal((await publicHttp.GUILD(visit(slug), slug)).status, 404);
  // Management over HTTP: the host's own session names the actor; the body never can.
  let signedIn: GuildActor = founder;
  const updatesHttp = createGuildUpdatesHandlers({
    version: 'v1',
    requestId: randomUUID,
    actor: async () => signedIn,
    checkOrigin: () => undefined,
    rateLimit: async () => undefined,
    list: async (who, guildId) => ({
      version: 'v1',
      updates: (await transaction((tx) => listManagedGuildUpdates(tx, who, guildId))).updates,
      writesAvailable: true,
      unavailableReason: null,
    }),
    draft: (command) => transaction((tx) => draftGuildUpdate(tx, command, host)),
    publish: (command) => transaction((tx) => publishGuildUpdate(tx, command, host)),
    withdraw: (command) => transaction((tx) => withdrawGuildUpdate(tx, command, host)),
  });
  const send = (path: string, payload: unknown, key: string) =>
    new Request(`https://host.example${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(payload),
    });
  const madeByHttp = await updatesHttp.DRAFT(
    send(
      '/api/v1/guild-updates',
      { guildId: active.guild.id, title: 'Over HTTP', body: 'Text' },
      'm-1',
    ),
  );
  assert.equal(madeByHttp.status, 200);
  const madeId = ((await madeByHttp.json()) as { update: { id: string } }).update.id;
  const stepOverHttp = (action: string, key: string) =>
    updatesHttp.STEP(
      send(`/api/v1/guild-updates/${madeId}`, { guildId: active.guild.id, action }, key),
      madeId,
    );
  signedIn = await account('stranger');
  assert.equal((await stepOverHttp('PUBLISH', 'm-2')).status, 403);
  signedIn = founder;
  assert.equal((await stepOverHttp('PUBLISH', 'm-3')).status, 200);
  assert.equal((await stepOverHttp('WITHDRAW', 'm-4')).status, 200);
  const mine = await updatesHttp.LIST(
    new Request(`https://host.example/api/v1/guild-updates?guildId=${active.guild.id}`),
  );
  assert.equal(mine.status, 200);
  // The withdrawn update leaves both the managed view and the public feed; the first one stays.
  const listed = (await mine.json()) as { updates: { id: string }[] };
  assert.deepEqual(
    listed.updates.map((u) => u.id),
    [news.update.id],
  );
  assert.deepEqual(
    (await transaction((tx) => listPublicGuildUpdates(tx, slug, {}))).updates.map((u) => u.id),
    [news.update.id],
  );
  // Ownership moves only when the Founder proposes, the recipient accepts and the host approves.
  const successor = await account('successor');
  const proposal = await transaction((tx) =>
    proposeOwnershipTransfer(
      tx,
      cmd(
        founder,
        {
          guildId: active.guild.id,
          toAccountId: successor.accountId,
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
        't-1',
      ),
      host,
    ),
  );
  await assert.rejects(
    transaction((tx) =>
      respondOwnershipTransfer(
        tx,
        cmd(
          founder,
          { guildId: active.guild.id, transferId: proposal.transfer.id, decision: 'ACCEPT' },
          't-2',
        ),
        { ...host, authorizeOwnershipTransfer: async () => true },
      ),
    ),
    (e) => e instanceof GuildStorageError && e.code === 'FORBIDDEN',
  );
  const moved = await transaction((tx) =>
    respondOwnershipTransfer(
      tx,
      cmd(
        successor,
        { guildId: active.guild.id, transferId: proposal.transfer.id, decision: 'ACCEPT' },
        't-3',
      ),
      { ...host, authorizeOwnershipTransfer: async () => true },
    ),
  );
  assert.equal(moved.transfer.applied, true);
  assert.deepEqual([await can(founder, 'PROFILE'), await can(successor, 'PROFILE')], [false, true]);
  console.log(
    'PASS: independent PG host Guild activation by approver, public allowlist, Founder edit, holder denied, treasury separate, consented ownership transfer, public updates, public HTTP reads, management HTTP; SIMULATED ONLY.',
  );
} finally {
  await pool.end();
}
