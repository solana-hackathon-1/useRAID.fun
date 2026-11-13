import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/lib/db';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { saveGuildDraft } from '../src/guild-profiles/draft-storage';
import {
  activateGuild,
  grantGuildRole,
  revokeGuildRole,
  type GuildActor,
} from '../src/guild-profiles/guild-storage';
import { creationStateFromHost } from '../src/lib/work-creation-host';
import { hash } from '../src/lib/auth-primitives';
import { rewardAssets } from './helpers/work-creation-fixture';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

// DEC-2026-11-13-15 (2), #253: the production catalog through the real Guild host, against real grants.
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
let counter = 0;
async function person(): Promise<GuildActor> {
  const user = await db.user.create({ data: { handle: 'synthetic-catalog-user-' + ++counter } });
  const sessionHash = hash(user.id);
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: sessionHash,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  return { accountId: user.id, sessionHash };
}
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
let keys = 0;
const cmd = (actor: GuildActor, input: unknown) => {
  const key = 'catalog-key-' + ++keys;
  return { actor, input, idempotencyKey: key, requestId: 'request-' + key };
};
const writable = { allowNewWrites: true };
async function guild(slug: string) {
  const founder = await person();
  const operator = await person();
  const draft = (
    await run((tx) =>
      saveGuildDraft(
        tx,
        {
          actor: { ...founder, actorAccountId: founder.accountId },
          input: {
            guildDraftId: null,
            expectedRevision: 0,
            profile: { name: 'Synthetic ' + slug, slug, description: 'Synthetic description' },
          },
          idempotencyKey: 'draft-' + slug,
          requestId: 'request-draft-' + slug,
        },
        writable,
      ),
    )
  ).draft;
  const { guild: activated } = await run((tx) =>
    activateGuild(
      tx,
      cmd(operator, {
        guildDraftId: draft.id,
        expectedDraftRevision: draft.revision,
        activationRef: 'evidence-record-' + slug,
      }),
      { ...writable, authorizeActivation: async () => true },
    ),
  );
  return { founder, id: activated.id as string };
}
const grant = (founder: GuildActor, guildId: string, input: Record<string, unknown>) =>
  run((tx) => grantGuildRole(tx, cmd(founder, { guildId, ...input }), writable));
const production = (guildId: string) => {
  vi.stubEnv('RAID_ENVIRONMENT', 'production');
  vi.stubEnv('WORK_CREATION_READS_ENABLED', 'true');
  vi.stubEnv('RAID_WORK_GUILD_ID', guildId);
  vi.stubEnv('WORK_REWARD_ASSETS_JSON', JSON.stringify(rewardAssets()));
};
const labels = async (who: GuildActor) =>
  (await creationStateFromHost(who)).assets.map((asset) => asset.label);

integration('#253 production catalog visibility', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$disconnect();
  });

  it('shows the Founder and a live WORK grantee the catalog and nobody else', async () => {
    const g = await guild('catalog-a');
    const other = await guild('catalog-b');
    production(g.id);
    const worker = await person();
    const profileOnly = await person();
    const treasurer = await person();
    const stranger = await person();
    await grant(g.founder, g.id, { granteeAccountId: worker.accountId, kind: 'WORK' });
    await grant(g.founder, g.id, {
      granteeAccountId: profileOnly.accountId,
      kind: 'PROFILE',
      fields: ['name'],
    });
    await grant(g.founder, g.id, { granteeAccountId: treasurer.accountId, kind: 'TREASURY' });
    expect(await labels(g.founder)).toEqual(['Synthetic SOL', 'Synthetic token']);
    expect(await labels(worker)).toEqual(['Synthetic SOL', 'Synthetic token']);
    for (const denied of [stranger, profileOnly, treasurer, other.founder])
      await expect(creationStateFromHost(denied)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('stops showing the catalog the moment the WORK grant is revoked or expires', async () => {
    const g = await guild('catalog-revoke');
    production(g.id);
    const worker = await person();
    const expiring = await person();
    const made = await grant(g.founder, g.id, { granteeAccountId: worker.accountId, kind: 'WORK' });
    // Grants are immutable, so an already-lapsed WORK grant is inserted directly.
    await db.$executeRawUnsafe(
      `INSERT INTO "GuildRoleGrant" ("guildId","granteeAccountId","kind","validFrom","expiresAt","grantedByAccountId") VALUES ($1::uuid,$2,'WORK',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',$3)`,
      g.id,
      expiring.accountId,
      g.founder.accountId,
    );
    expect(await labels(worker)).toHaveLength(2);
    await run((tx) =>
      revokeGuildRole(tx, cmd(g.founder, { guildId: g.id, grantId: made.grant.id }), writable),
    );
    await expect(creationStateFromHost(worker)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(creationStateFromHost(expiring)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await labels(g.founder)).toHaveLength(2);
  });

  it('fails closed for a suspended Founder and for a configured Guild that is not a stored Guild', async () => {
    const g = await guild('catalog-closed');
    production(g.id);
    await db.user.update({ where: { id: g.founder.accountId }, data: { suspended: true } });
    await expect(creationStateFromHost(g.founder)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const id of ['synthetic-guild', '', '00000000-0000-4000-8000-000000000000']) {
      production(id);
      const who = await person();
      await expect(creationStateFromHost(who)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('leaves the synthetic catalog open to a stranger in a declared non-production environment', async () => {
    const g = await guild('catalog-staging');
    production(g.id);
    vi.stubEnv('RAID_ENVIRONMENT', 'staging');
    expect(await labels(await person())).toEqual(['Synthetic SOL', 'Synthetic token']);
  });
});
