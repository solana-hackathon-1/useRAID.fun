import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { EventEnvelopeSchema } from '../src/contracts/protocol';
import {
  publishSkillTaxonomy,
  readPublishedSkillTaxonomy,
  PublishSkillTaxonomyInputSchema,
} from '../src/skills/taxonomy-storage';
import { CommandReceiptError, type CommandReceiptTransaction } from '../src/command-receipts';
it('accepts an identifier-only skill taxonomy audit while rejecting catalog bodies and rank assertions', () => {
  const event = {
    eventId: 'e',
    type: 'skill.taxonomy_published.v1',
    aggregateId: 'catalog',
    aggregateVersion: 1,
    occurredAt: '2026-10-14T00:00:00Z',
    actorId: 'admin',
    guildId: null,
    correlationId: 'r',
    payload: { skillTaxonomyVersionId: 'version' },
  };
  expect(EventEnvelopeSchema.safeParse(event).success).toBe(true);
  for (const field of ['skills', 'assessedRank', 'claimedLevel', 'evidence'])
    expect(
      EventEnvelopeSchema.safeParse({ ...event, payload: { ...event.payload, [field]: 'private' } })
        .success,
    ).toBe(false);
});
const actor = { accountId: 'synthetic-admin', sessionHash: 'a'.repeat(64) };
const input = {
  taxonomyId: 'synthetic',
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
const command = { actor, input, idempotencyKey: 'k', requestId: 'r' };
it('limits persisted revisions to the existing integer audit store without changing pure taxonomy preparation', () => {
  expect(
    PublishSkillTaxonomyInputSchema.safeParse({ ...input, expectedRevision: 2147483646 }).success,
  ).toBe(true);
  for (const expectedRevision of [-1, 0.5, 2147483647, Number.MAX_SAFE_INTEGER])
    expect(PublishSkillTaxonomyInputSchema.safeParse({ ...input, expectedRevision }).success).toBe(
      false,
    );
});
it('rejects forged actor/options/body contracts before any query', async () => {
  let calls = 0;
  const tx: CommandReceiptTransaction = {
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    async query() {
      calls++;
      return [];
    },
  };
  for (const field of ['role', 'isAdmin', 'publishedByAccountId', 'xId'])
    await expect(
      publishSkillTaxonomy(
        tx,
        { ...command, actor: { ...actor, [field]: 'forged' } },
        { allowNewWrites: true, canPublish: () => true },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    publishSkillTaxonomy(
      tx,
      { ...command, input: { ...input, publishedAt: '2026-10-14T00:00:00Z' } },
      { allowNewWrites: true, canPublish: () => true },
    ),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(readPublishedSkillTaxonomy(tx, actor, 'bad identifier')).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(calls).toBe(0);
});
it('sanitizes unknown driver failures while retaining host-classified retry failures', async () => {
  const tx: CommandReceiptTransaction = {
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    async query() {
      throw Error('private-driver-password');
    },
  };
  await expect(readPublishedSkillTaxonomy(tx, actor, 'catalog')).rejects.toMatchObject({
    code: 'STORAGE_UNAVAILABLE',
    message: 'STORAGE_UNAVAILABLE',
  });
  const retry: CommandReceiptTransaction = {
    ...tx,
    async query() {
      throw new CommandReceiptError('RETRY_TRANSACTION');
    },
  };
  await expect(readPublishedSkillTaxonomy(retry, actor, 'catalog')).rejects.toMatchObject({
    code: 'RETRY_TRANSACTION',
  });
});
it('declares all storage dependencies without hidden app/database/provider authority', async () => {
  const allowed = new Set([
    'zod',
    '../contracts/ids',
    '../command-receipts',
    './index',
    './contracts',
    './taxonomy-storage-contracts',
  ]);
  for (const file of ['taxonomy-storage.ts', 'taxonomy-storage-contracts.ts']) {
    const text = await readFile('src/skills/' + file, 'utf8');
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g))
      expect(allowed.has(match[1]), match[1]).toBe(true);
    expect(text).not.toMatch(/process\.env|\bfetch\s*\(|\bconsole\.|@\/|@prisma|from ['"]pg['"]/);
  }
});
