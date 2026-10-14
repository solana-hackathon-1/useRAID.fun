import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import { publishSkillTaxonomyFromHost } from '../src/lib/skill-taxonomy-host';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
integration('actual Root taxonomy publisher policy with PostgreSQL', () => {
  let actor: { accountId: string; sessionHash: string };
  const input = {
    taxonomyId: 'synthetic-root-catalog',
    expectedRevision: 0,
    skills: [
      {
        id: 'frontend',
        domain: 'software.frontend',
        name: 'Frontend',
        status: 'ACTIVE',
        aliases: ['frontend'],
      },
    ],
  };
  const command = (key = randomUUID(), revision = 0) => ({
    actor,
    input: { ...input, expectedRevision: revision },
    idempotencyKey: key,
    requestId: 'synthetic-root-policy',
  });
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
    vi.stubEnv('X_ADMIN_USER_ID', 'synthetic-current-x');
    vi.stubEnv('ADMIN_X_IDS', '');
    const user = await db.user.create({
      data: { handle: 'synthetic-root-publisher', role: 'ADMIN', xId: 'synthetic-current-x' },
    });
    actor = { accountId: user.id, sessionHash: hash(randomUUID()) };
    await db.session.create({
      data: {
        tokenHash: actor.sessionHash,
        userId: user.id,
        via: 'x',
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(() => db.$disconnect());
  it('default-off configuration rejects a new publication and leaves no receipt/version/audit', async () => {
    vi.stubEnv('SKILL_TAXONOMY_PUBLICATION_ENABLED', undefined);
    await expect(publishSkillTaxonomyFromHost(command())).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    expect(await db.$queryRawUnsafe('SELECT count(*)::int n FROM "SkillTaxonomyVersion"')).toEqual([
      { n: 0 },
    ]);
    expect(await db.commandReceipt.count()).toBe(0);
    expect(await db.auditEvent.count()).toBe(0);
  });
  it('returns the exact original version after a later publication and flag disablement, denying new intent', async () => {
    vi.stubEnv('SKILL_TAXONOMY_PUBLICATION_ENABLED', 'true');
    const firstCommand = command();
    const first = await publishSkillTaxonomyFromHost(firstCommand);
    await publishSkillTaxonomyFromHost(command(randomUUID(), 1));
    vi.stubEnv('SKILL_TAXONOMY_PUBLICATION_ENABLED', 'false');
    expect(await publishSkillTaxonomyFromHost(firstCommand)).toEqual({
      ...first,
      status: 'REPLAYED',
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    });
    await expect(publishSkillTaxonomyFromHost(command(randomUUID(), 2))).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    expect(await db.$queryRawUnsafe('SELECT count(*)::int n FROM "SkillTaxonomyVersion"')).toEqual([
      { n: 2 },
    ]);
    expect(await db.outboxEvent.count()).toBe(0);
  });
  it('current environment allowlist revocation denies original replay without deleting saved history', async () => {
    vi.stubEnv('SKILL_TAXONOMY_PUBLICATION_ENABLED', 'true');
    const firstCommand = command();
    await publishSkillTaxonomyFromHost(firstCommand);
    vi.stubEnv('X_ADMIN_USER_ID', '');
    await expect(publishSkillTaxonomyFromHost(firstCommand)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await db.$queryRawUnsafe('SELECT count(*)::int n FROM "SkillTaxonomyVersion"')).toEqual([
      { n: 1 },
    ]);
    expect(await db.commandReceipt.count()).toBe(1);
  });
  it('an actual wallet session is denied despite ADMIN role and an allowed connected X identity', async () => {
    vi.stubEnv('SKILL_TAXONOMY_PUBLICATION_ENABLED', 'true');
    await db.session.update({ where: { tokenHash: actor.sessionHash }, data: { via: 'wallet' } });
    await expect(publishSkillTaxonomyFromHost(command())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await db.commandReceipt.count()).toBe(0);
  });
});
