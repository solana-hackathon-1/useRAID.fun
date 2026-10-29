import { db } from '../../src/lib/db';
import { runCommandTransaction } from '../../src/lib/command-receipts-adapter';
import { saveGuildDraft } from '../../src/guild-profiles/draft-storage';
import {
  activateGuild,
  draftGuildUpdate,
  publishGuildUpdate,
  withdrawGuildUpdate,
  type GuildActor,
} from '../../src/guild-profiles/guild-storage';
import { hash } from '../../src/lib/auth-primitives';

/** Synthetic-only fixtures for the public Guild page: an operator-activated Guild and its updates. */
let counter = 0;
const operators = new Set<string>();
const host = {
  allowNewWrites: true,
  authorizeActivation: async (_tx: unknown, who: { accountId: string }) =>
    operators.has(who.accountId),
};
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
const key = () => 'guild-page-' + Date.now().toString(36) + '-' + ++counter;
const cmd = (actor: GuildActor, input: unknown) => {
  const id = key();
  return { actor, input, idempotencyKey: id, requestId: 'request-' + id };
};
export async function syntheticPerson(): Promise<GuildActor> {
  const user = await db.user.create({ data: { handle: 'synthetic-guild-page-' + key() } });
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
export async function syntheticGuild(slug: string, name: string, description: string) {
  const founder = await syntheticPerson();
  const operator = await syntheticPerson();
  operators.add(operator.accountId);
  const saved = await run((tx) =>
    saveGuildDraft(
      tx,
      {
        actor: {
          accountId: founder.accountId,
          actorAccountId: founder.accountId,
          sessionHash: founder.sessionHash,
        },
        input: { guildDraftId: null, expectedRevision: 0, profile: { name, slug, description } },
        idempotencyKey: key(),
        requestId: 'request-draft-' + slug,
      },
      { allowNewWrites: true },
    ),
  );
  const activationRef = 'synthetic-activation-' + slug;
  const activated = await run((tx) =>
    activateGuild(
      tx,
      cmd(operator, {
        guildDraftId: saved.draft.id,
        expectedDraftRevision: saved.draft.revision,
        activationRef,
      }),
      host,
    ),
  );
  return { founder, operator, activationRef, guild: activated.guild };
}
export async function draftUpdate(actor: GuildActor, guildId: string, title: string, body: string) {
  const drafted = await run((tx) =>
    draftGuildUpdate(tx, cmd(actor, { guildId, title, body }), host),
  );
  return drafted.update.id as string;
}
export async function publishedUpdate(
  actor: GuildActor,
  guildId: string,
  title: string,
  body: string,
) {
  const updateId = await draftUpdate(actor, guildId, title, body);
  await run((tx) => publishGuildUpdate(tx, cmd(actor, { guildId, updateId }), host));
  return updateId;
}
export async function withdrawUpdate(actor: GuildActor, guildId: string, updateId: string) {
  await run((tx) => withdrawGuildUpdate(tx, cmd(actor, { guildId, updateId }), host));
}
