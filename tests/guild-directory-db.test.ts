import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { listPublicGuilds } from '../src/guild-profiles/guild-storage';
import { GUILD_DIRECTORY_PAGE_MAX } from '../src/guild-profiles/guild-storage-contracts';
import { saveGuildDraft } from '../src/guild-profiles/draft-storage';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import { syntheticGuild, syntheticPerson } from './helpers/guild-public-page-fixture';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const list = (options?: unknown) =>
  runCommandTransaction(db, (tx) => listPublicGuilds(tx, options));

integration('T015 public Guild directory over real PostgreSQL', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());

  it('lists active Guilds by slug with only the approved fields, never ids or authority', async () => {
    const delegate = await syntheticPerson();
    const b = await syntheticGuild('bravo-guild', 'Bravo Guild', 'Second.');
    const a = await syntheticGuild('alpha-guild', 'Alpha Guild', 'First.');
    const page = await list();
    expect(page).toEqual({
      guilds: [
        { slug: 'alpha-guild', name: 'Alpha Guild', description: 'First.' },
        { slug: 'bravo-guild', name: 'Bravo Guild', description: 'Second.' },
      ],
      nextCursor: null,
    });
    const json = JSON.stringify(page);
    for (const secret of [
      a.guild.id,
      b.guild.id,
      a.founder.accountId,
      b.founder.accountId,
      a.operator.accountId,
      a.activationRef,
      delegate.accountId,
      'founderAccountId',
    ])
      expect(json).not.toContain(secret);
  });

  it('pages by slug cursor with a stable order and ends with a null cursor', async () => {
    for (const slug of ['g-one', 'g-two', 'g-three', 'g-four', 'g-five'])
      await syntheticGuild(slug, slug.toUpperCase(), '');
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await list({ limit: 2, after });
      expect(page.guilds.length).toBeLessThanOrEqual(2);
      seen.push(...page.guilds.map((g) => g.slug));
      after = page.nextCursor ?? undefined;
      pages++;
    } while (after);
    expect(pages).toBe(3);
    expect(seen).toEqual(['g-five', 'g-four', 'g-one', 'g-three', 'g-two']);
  });

  it('is empty without Guilds, and a never-activated draft is not listed', async () => {
    expect(await list({})).toEqual({ guilds: [], nextCursor: null });
    const founder = await syntheticPerson();
    await runCommandTransaction(db, (tx) =>
      saveGuildDraft(
        tx,
        {
          actor: {
            accountId: founder.accountId,
            actorAccountId: founder.accountId,
            sessionHash: founder.sessionHash,
          },
          input: {
            guildDraftId: null,
            expectedRevision: 0,
            profile: { name: 'Draft Only', slug: 'draft-only', description: 'x' },
          },
          idempotencyKey: 'directory-draft-1',
          requestId: 'request-directory-draft-1',
        },
        { allowNewWrites: true },
      ),
    );
    expect(await list()).toEqual({ guilds: [], nextCursor: null });
  });

  it('a cursor slug that names no Guild simply continues after it, and the last slug ends the list', async () => {
    await syntheticGuild('only-guild', 'Only Guild', 'd');
    expect((await list({ after: 'only-guild' })).guilds).toEqual([]);
    expect((await list({ after: 'zzz' })).nextCursor).toBeNull();
  });

  it.each([
    [{ limit: 0 }],
    [{ limit: GUILD_DIRECTORY_PAGE_MAX + 1 }],
    [{ limit: 1.5 }],
    [{ after: 'Bad_Slug' }],
    [{ after: 'a'.repeat(101) }],
    [{ unknown: 1 }],
    ['not-an-object'],
  ])('refuses invalid options %j', async (options) => {
    await expect(list(options)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
