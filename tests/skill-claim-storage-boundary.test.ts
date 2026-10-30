import { expect, it } from 'vitest';
import { EventEnvelopeSchema } from '../src/contracts/protocol';
import { readFile } from 'node:fs/promises';
import {
  SaveSkillClaimInputSchema,
  SavedSkillClaimSchema,
  readSkillClaim,
  saveSkillClaim,
} from '../src/skills/claim-storage';
import { CommandReceiptError, type CommandReceiptTransaction } from '../src/command-receipts';
it('records skill claim versions only through identifier-only private audit references', () => {
  const event = {
    eventId: 'e',
    type: 'skill.claim_recorded.v1',
    aggregateId: 'claim',
    aggregateVersion: 1,
    occurredAt: '2026-10-14T00:00:00Z',
    actorId: 'self',
    guildId: null,
    correlationId: 'r',
    payload: { skillClaimVersionId: 'version' },
  };
  expect(EventEnvelopeSchema.safeParse(event).success).toBe(true);
  for (const field of ['claimedLevel', 'supportingReferences', 'assessedRank', 'assessmentHistory'])
    expect(
      EventEnvelopeSchema.safeParse({ ...event, payload: { ...event.payload, [field]: 'private' } })
        .success,
    ).toBe(false);
});
const actor = { accountId: 'self', sessionHash: 'a'.repeat(64) };
const input = {
  taxonomyId: 'actual-catalog',
  expectedTaxonomyRevision: 1,
  expectedClaimRevision: 0,
  skillId: 'frontend',
  claimedLevel: 'S',
  supportingReferences: [],
};
it('keeps assessment authority outside even the saved claim DTO and freezes nested claimant facts', () => {
  const value = {
    version: 'v1',
    id: '12345678-1234-4234-8234-123456789012',
    revision: 1,
    state: 'CLAIMED',
    participantId: 'canonical-human',
    skillId: 'frontend',
    skillDomain: 'software.frontend',
    taxonomyReference: { recordId: 'actual-catalog', revision: 1 },
    recordedAt: '2026-10-14T00:00:00.000Z',
    claimedLevel: 'S',
    supportingReferences: [],
    persisted: true,
    informational: true,
    isAuthorizationToken: false,
    verifiesSkill: false,
    createsPermissionGrant: false,
    consumesCapacity: false,
  };
  const parsed = SavedSkillClaimSchema.parse(value);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.taxonomyReference)).toBe(true);
  expect(Object.isFrozen(parsed.supportingReferences)).toBe(true);
  for (const field of [
    'assessedRank',
    'assessmentHistory',
    'rubric',
    'evaluator',
    'confidence',
    'sampleSize',
  ])
    expect(SavedSkillClaimSchema.safeParse({ ...value, [field]: 'forged' }).success).toBe(false);
  for (const verifiesSkill of [true, 'true'])
    expect(SavedSkillClaimSchema.safeParse({ ...value, verifiesSkill }).success).toBe(false);
});
it('pins storage revision/time precision and rejects caller-controlled provenance and identity', () => {
  expect(
    SaveSkillClaimInputSchema.safeParse({
      ...input,
      expectedClaimRevision: 2147483646,
      expectedTaxonomyRevision: 2147483647,
    }).success,
  ).toBe(true);
  for (const expectedClaimRevision of [-1, 0.5, 2147483647, Number.MAX_SAFE_INTEGER])
    expect(SaveSkillClaimInputSchema.safeParse({ ...input, expectedClaimRevision }).success).toBe(
      false,
    );
  for (const expectedTaxonomyRevision of [0, 0.5, 2147483648])
    expect(
      SaveSkillClaimInputSchema.safeParse({ ...input, expectedTaxonomyRevision }).success,
    ).toBe(false);
  for (const field of ['participantId', 'verified', 'sampleSize', 'evaluator', 'recordedAt'])
    expect(SaveSkillClaimInputSchema.safeParse({ ...input, [field]: 'forged' }).success).toBe(
      false,
    );
});
it('rejects invalid body/actor/resource before any SQL and sanitizes driver failures', async () => {
  let calls = 0;
  const tx: CommandReceiptTransaction = {
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    async query() {
      calls++;
      throw Error('private-driver-secret');
    },
  };
  await expect(
    saveSkillClaim(
      tx,
      { actor, input: { ...input, assessedRank: 'S' }, idempotencyKey: 'k', requestId: 'r' },
      { allowNewWrites: true },
    ),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    readSkillClaim(tx, { ...actor, sessionHash: 'invalid' }, 'frontend'),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(readSkillClaim(tx, actor, 'bad identifier')).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(calls).toBe(0);
  await expect(readSkillClaim(tx, actor, 'frontend')).rejects.toMatchObject({
    code: 'STORAGE_UNAVAILABLE',
    message: 'STORAGE_UNAVAILABLE',
  });
  const retry: CommandReceiptTransaction = {
    ...tx,
    async query() {
      throw new CommandReceiptError('RETRY_TRANSACTION');
    },
  };
  await expect(readSkillClaim(retry, actor, 'frontend')).rejects.toMatchObject({
    code: 'RETRY_TRANSACTION',
  });
});
it('contains only owned ports and no app/provider/assessment singleton', async () => {
  const allowed = new Set([
    'zod',
    '../contracts/ids',
    '../contracts/entities',
    '../command-receipts',
    './index',
    './contracts',
    './taxonomy-storage',
    './taxonomy-storage-contracts',
    './claim-storage-contracts',
    './evidence-fingerprint',
  ]);
  // The fingerprint helper is pure: Node's digest only, no app, database or provider import.
  const fingerprint = await readFile('src/skills/evidence-fingerprint.ts', 'utf8');
  expect([...fingerprint.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])).toEqual([
    'node:crypto',
  ]);
  for (const file of ['claim-storage.ts', 'claim-storage-contracts.ts']) {
    const source = await readFile('src/skills/' + file, 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g))
      expect(allowed.has(match[1]), match[1]).toBe(true);
    expect(source).not.toMatch(/process\.env|\bfetch\s*\(|\bconsole\.|@\/|@prisma|from ['"]pg['"]/);
  }
});
