import { expect, it } from 'vitest';
import {
  GuildSchema,
  PublicGuildSchema,
  TermsSnapshotSchema,
  EventEnvelopeSchema,
} from '../src/contracts';

export const reviewedTerms = {
  id: 'terms-review',
  guildId: 'guild-review',
  revision: 1,
  scope: 'Synthetic task',
  acceptanceCriteria: ['Fixture'],
  roster: [{ participantId: 'p-review', responsibility: 'Builder', consentRef: 'consent-review' }],
  rewards: [],
  deadlines: {
    preparation: '2026-10-09T00:00:00Z',
    submission: '2026-10-10T00:00:00Z',
    review: '2026-10-11T00:00:00Z',
    operationalClosure: '2026-10-11T00:00:00Z',
  },
  requiredSkills: [
    { skillId: 'frontend', minimumRank: 'C', assessmentPolicyVersion: 'fixture-assessment' },
  ],
  eligibilityPolicyVersion: 'fixture-fit',
  allowedToolsPolicyVersion: 'fixture-tools',
  revisionPolicyVersion: 'fixture-revision',
  withdrawalPolicyVersion: 'fixture-withdrawal',
  terminationPolicyVersion: 'fixture-termination',
  rubricVersion: null,
  rightsPolicyVersion: 'fixture-rights',
  reviewPolicyVersion: 'fixture-review',
  disputePolicyVersion: 'fixture-dispute',
  finalityPolicyVersion: 'fixture-finality',
  createdAt: '2026-10-08T00:00:00Z',
};

it('rejects native SOL as a Guild project token independently of membership or founder authority', () => {
  const primaryToken = { chain: 'SOLANA', networkIdentity: 'synthetic', kind: 'NATIVE_SOL' };
  expect(() =>
    GuildSchema.parse({ id: 'g-1', founderAccountId: 'a-1', revision: 1, primaryToken }),
  ).toThrow();
  expect(() =>
    PublicGuildSchema.parse({
      id: 'g-1',
      slug: 'fixture',
      name: 'Fixture',
      description: '',
      primaryToken,
    }),
  ).toThrow();
});
it('preserves immutable skill/tools/revision/exit references and permits coincident final deadlines', () => {
  const parsed = TermsSnapshotSchema.parse(reviewedTerms);
  expect(parsed).toMatchObject({
    requiredSkills: reviewedTerms.requiredSkills,
    allowedToolsPolicyVersion: 'fixture-tools',
    revisionPolicyVersion: 'fixture-revision',
    withdrawalPolicyVersion: 'fixture-withdrawal',
    terminationPolicyVersion: 'fixture-termination',
    rubricVersion: null,
  });
  expect(
    Object.isFrozen((parsed as unknown as { requiredSkills: object[] }).requiredSkills[0]),
  ).toBe(true);
  expect(() =>
    TermsSnapshotSchema.parse({ ...reviewedTerms, revisionPolicyVersion: undefined }),
  ).toThrow();
  expect(() =>
    TermsSnapshotSchema.parse({
      ...reviewedTerms,
      requiredSkills: [
        { skillId: 'frontend', minimumRank: 'PURCHASED', assessmentPolicyVersion: 'fixture' },
      ],
    }),
  ).toThrow();
});
it('carries global identity events without inventing a Guild and keeps the canonical payload key safe', () => {
  const event = {
    eventId: 'evt-1',
    type: 'identity.wallet_verified.v1',
    aggregateId: 'account-1',
    aggregateVersion: 1,
    occurredAt: '2026-10-08T00:00:00Z',
    actorId: 'account-1',
    guildId: null,
    correlationId: 'req-1',
    payload: { identityLinkId: 'link-1' },
  };
  expect(EventEnvelopeSchema.parse(event).guildId).toBeNull();
  expect(() =>
    EventEnvelopeSchema.parse({
      ...event,
      payload: { identityLinkId: 'link-1', privateBrief: 'secret' },
    }),
  ).toThrow();
});
