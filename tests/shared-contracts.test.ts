import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AccountId,
  ParticipantId,
  GuildId,
  TermsVersionId,
  ParticipantSchema,
  PublicGuildSchema,
  AssetIdSchema,
  AssetPolicySnapshotSchema,
  assetKey,
  AmountSchema,
  parseDisplayAmount,
  formatDisplayAmount,
  TermsSnapshotSchema,
  EngagementSchema,
  STATES,
  StateSchema,
  consumesCapacity,
  COMMANDS,
  planCapacityLocks,
  createErrorEnvelope,
  CommandContextSchema,
  API_VERSION,
} from '../src/contracts';

const address = 'So11111111111111111111111111111111111111112';
const asset = {
  chain: 'SOLANA' as const,
  networkIdentity: 'synthetic-genesis',
  kind: 'TOKEN' as const,
  mint: address,
  tokenProgram: address,
};
const native = {
  chain: 'SOLANA',
  networkIdentity: 'synthetic-genesis',
  kind: 'NATIVE_SOL',
} as const;
const at = '2026-10-08T00:00:00Z';
const policy = {
  assetId: asset,
  registryVersion: 'fixture-v1',
  verifiedDecimals: 6,
  observedAuthorities: [],
  supportedExtensionProfile: 'synthetic-only',
  observedAt: at,
  observedSlot: '100',
};
const terms = {
  id: 'terms-1',
  guildId: 'guild-1',
  revision: 1,
  scope: 'Synthetic scope',
  acceptanceCriteria: ['Deliver fixture'],
  rewards: [
    {
      policy,
      amount: '250500000',
      beneficiaryParticipantId: 'participant-1',
      beneficiaryRef: 'synthetic-verified-destination',
    },
  ],
  roster: [
    { participantId: 'participant-1', responsibility: 'Builder', consentRef: 'fixture-consent' },
  ],
  deadlines: {
    preparation: '2026-10-09T00:00:00Z',
    submission: '2026-10-10T00:00:00Z',
    review: '2026-10-11T00:00:00Z',
    operationalClosure: '2026-10-12T00:00:00Z',
  },
  requiredSkills: [],
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
  createdAt: at,
};

describe('T002 canonical identity and public boundary', () => {
  it('keeps account, participant, Guild and terms identifiers distinct', () => {
    const id = AccountId.parse('internal-1');
    expectTypeOf(id).not.toEqualTypeOf(ParticipantId.parse('internal-1'));
    expectTypeOf(GuildId.parse('internal-1')).not.toEqualTypeOf(TermsVersionId.parse('internal-1'));
    expect(() => AccountId.parse('')).toThrow();
    expect(() => AccountId.parse(' padded ')).toThrow();
  });
  it('requires the accountable identity appropriate to each participant kind', () => {
    const human = ParticipantSchema.parse({ id: 'p-1', kind: 'HUMAN', accountId: 'a-1' });
    expect(human.kind).toBe('HUMAN');
    if (human.kind !== 'HUMAN') throw new Error('Expected human identity');
    expect(human.accountId).toBe('a-1');
    expect(() =>
      ParticipantSchema.parse({ id: 'p-1', kind: 'HUMAN', operatorId: 'o-1' }),
    ).toThrow();
    for (const kind of ['AI_AGENT', 'AI_INFLUENCER']) {
      expect(ParticipantSchema.parse({ id: 'p-2', kind, operatorId: 'o-1' }).kind).toBe(kind);
      expect(() => ParticipantSchema.parse({ id: 'p-2', kind, accountId: 'a-1' })).toThrow();
    }
  });
  it('supports a pending Guild without a token and rejects private public fields', () => {
    const guild = {
      id: 'g-1',
      slug: 'fixture-guild',
      name: 'Fixture Guild',
      description: 'Synthetic public summary',
      primaryToken: null,
    };
    expect(PublicGuildSchema.parse(guild).primaryToken).toBeNull();
    for (const key of ['administrators', 'repository', 'privateBrief', 'moderationNotes'])
      expect(() => PublicGuildSchema.parse({ ...guild, [key]: 'secret' })).toThrow();
  });
});

describe('T002 exact instrument and amount contracts', () => {
  it('requires mint/program for tokens and forbids either on native SOL', () => {
    expect(AssetIdSchema.parse(asset)).toEqual(asset);
    expect(AssetIdSchema.parse(native)).toEqual(native);
    expect(() => AssetIdSchema.parse({ ...asset, mint: undefined })).toThrow();
    expect(() => AssetIdSchema.parse({ ...asset, tokenProgram: 'ticker' })).toThrow();
    expect(() => AssetIdSchema.parse({ ...native, mint: address })).toThrow();
    expect(() => AssetIdSchema.parse({ ...asset, networkIdentity: '' })).toThrow();
  });
  it('never keys an asset by display ticker or policy revision', () => {
    expect(assetKey(asset)).not.toBe(assetKey({ ...asset, networkIdentity: 'other-genesis' }));
    expect(assetKey(asset)).not.toBe(assetKey(native));
    const second = AssetPolicySnapshotSchema.parse({ ...policy, registryVersion: 'fixture-v2' });
    expect(assetKey(second.assetId)).toBe(assetKey(policy.assetId));
    expect(() => AssetIdSchema.parse({ ...asset, symbol: 'USDC' })).toThrow();
  });
  it.each([1, 1.5, '-1', '1.5', '1e6', '', '01', '+1'])(
    'rejects noncanonical raw amount %s',
    (value) => {
      expect(() => AmountSchema.parse(value)).toThrow();
    },
  );
  it('round trips large amounts exactly and handles zero/precision without float arithmetic', () => {
    expect(parseDisplayAmount('250.50', 6, 2n ** 64n - 1n)).toBe('250500000');
    expect(formatDisplayAmount('900719925474099312345', 6)).toBe('900719925474099.312345');
    expect(parseDisplayAmount('900719925474099.312345', 6, 10n ** 30n)).toBe(
      '900719925474099312345',
    );
    expect(parseDisplayAmount('0', 0, 0n)).toBe('0');
    expect(formatDisplayAmount('0', 6)).toBe('0');
  });
  it.each(['-1', '1e6', '1.0000001', ' 1', '.5', '1.', '01'])(
    'rejects invalid display amount %s',
    (value) => {
      expect(() => parseDisplayAmount(value, 6, 100000000n)).toThrow();
    },
  );
  it('uses host bounds and checked precision', () => {
    expect(() => parseDisplayAmount('101', 0, 100n)).toThrow();
    expect(() => parseDisplayAmount('1', -1, 100n)).toThrow();
    expect(() => parseDisplayAmount('1', 256, 100n)).toThrow();
    expect(() => AssetPolicySnapshotSchema.parse({ ...policy, verifiedDecimals: 1.5 })).toThrow();
    expect(() => AssetPolicySnapshotSchema.parse({ ...policy, observedSlot: 123 })).toThrow();
  });
});

describe('T002 accepted terms and engagement references', () => {
  it('freezes parsed terms, roster, rewards and policy snapshots', () => {
    const parsed = TermsSnapshotSchema.parse(terms);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.roster[0])).toBe(true);
    expect(Object.isFrozen(parsed.rewards[0].policy.assetId)).toBe(true);
    expect(() => {
      (parsed as unknown as { scope: string }).scope = 'changed';
    }).toThrow();
    terms.scope = 'changed external fixture';
    expect(parsed.scope).toBe('Synthetic scope');
    terms.scope = 'Synthetic scope';
  });
  it('rejects duplicate members, unassigned beneficiaries and unbounded/reversed deadlines', () => {
    expect(() =>
      TermsSnapshotSchema.parse({ ...terms, roster: [terms.roster[0], terms.roster[0]] }),
    ).toThrow();
    expect(() =>
      TermsSnapshotSchema.parse({
        ...terms,
        rewards: [{ ...terms.rewards[0], beneficiaryParticipantId: 'other' }],
      }),
    ).toThrow();
    expect(() =>
      TermsSnapshotSchema.parse({ ...terms, deadlines: { ...terms.deadlines, review: null } }),
    ).toThrow();
    expect(() =>
      TermsSnapshotSchema.parse({ ...terms, deadlines: { ...terms.deadlines, review: at } }),
    ).toThrow();
    expect(() =>
      TermsSnapshotSchema.parse({ ...terms, createdAt: '2026-10-08T05:45:00+05:45' }),
    ).toThrow();
  });
  it('binds exactly one execution source and terms to the same Guild', () => {
    const engagement = {
      id: 'e-1',
      guildId: 'guild-1',
      revision: 1,
      state: 'ACCESS_PENDING',
      source: { kind: 'RAID_SLOT', raidSlotId: 's-1' },
      acceptedTerms: terms,
    };
    expect(EngagementSchema.parse(engagement).acceptedTerms.id).toBe('terms-1');
    expect(() =>
      EngagementSchema.parse({
        ...engagement,
        source: { ...engagement.source, challengeEntryId: 'c-1' },
      }),
    ).toThrow();
    expect(() => EngagementSchema.parse({ ...engagement, guildId: 'other-guild' })).toThrow();
    expect(() => EngagementSchema.parse({ ...engagement, state: 'FINALIZED' })).toThrow();
    for (const source of [
      { kind: 'CHALLENGE_ENTRY', challengeEntryId: 'c-1' },
      { kind: 'ROLE_PERIOD', rolePeriodId: 'r-1' },
    ])
      expect(EngagementSchema.parse({ ...engagement, source }).source).toEqual(source);
  });
});

describe('T002 state, command, error and locking contracts', () => {
  it('keeps listing, money, work, access, dispute, transaction and run vocabularies separate', () => {
    for (const [family, alien] of [
      ['engagement', 'FINALIZED'],
      ['listing', 'IN_PROGRESS'],
      ['claim', 'ACCEPTED'],
      ['access', 'PAID'],
      ['dispute', 'ACTIVE'],
      ['transaction', 'READY'],
      ['run', 'ACCEPTED'],
    ] as const)
      expect(() => StateSchema[family].parse(alien)).toThrow();
    expect(StateSchema.offer.parse('ACCEPTED')).toBe('ACCEPTED');
    expect(StateSchema.engagement.parse('ACCEPTED')).toBe('ACCEPTED');
  });
  it('holds capacity through setup/review and releases terminal work independently of money', () => {
    for (const state of STATES.engagement)
      expect(consumesCapacity(state)).toBe(
        !['ACCEPTED', 'WITHDRAWN', 'CANCELLED', 'TERMINATED'].includes(state),
      );
    expect(() => consumesCapacity('PAID' as never)).toThrow();
  });
  it('assigns lifecycle mutation to an explicit domain command owner with authority and guard contracts', () => {
    expect(COMMANDS.CommitEngagement.owner).toBe('work');
    expect(COMMANDS.StartEngagement.owner).toBe('work');
    expect(COMMANDS.ClaimAsset.owner).toBe('treasury');
    expect(COMMANDS.DecideDispute.owner).toBe('disputes');
    for (const command of Object.values(COMMANDS)) {
      expect(command.authority.length).toBeGreaterThan(0);
      expect(command.guards.length).toBeGreaterThan(0);
      expect(command.reference).toMatch(/^\d/);
    }
  });
  it('plans the same source/operator/participant lock order for all input permutations', () => {
    const input = {
      receiptKey: 'receipt-1',
      admissionIds: ['offer-2', 'offer-1'],
      sourceIds: ['slot-2', 'slot-1'],
      termsIds: ['terms-2'],
      operatorIds: ['op-z', 'op-a', 'op-a'],
      participantIds: ['p-z', 'p-a'],
    };
    const result = planCapacityLocks(input);
    expect(result).toEqual([
      { kind: 'receipt', id: 'receipt-1' },
      { kind: 'admission', id: 'offer-1' },
      { kind: 'admission', id: 'offer-2' },
      { kind: 'source', id: 'slot-1' },
      { kind: 'source', id: 'slot-2' },
      { kind: 'terms', id: 'terms-2' },
      { kind: 'operator', id: 'op-a' },
      { kind: 'operator', id: 'op-z' },
      { kind: 'participant', id: 'p-a' },
      { kind: 'participant', id: 'p-z' },
    ]);
    expect(
      planCapacityLocks({
        ...input,
        operatorIds: [...input.operatorIds].reverse(),
        participantIds: [...input.participantIds].reverse(),
      }),
    ).toEqual(result);
    expect(() => planCapacityLocks({ ...input, participantIds: [''] })).toThrow();
  });
  it('validates retry context without letting a receipt replace authorization', () => {
    expect(API_VERSION).toBe('v1');
    const context = {
      actorId: 'a-1',
      guildId: 'g-1',
      requestId: 'request-1',
      idempotencyKey: 'key-1',
      expectedRevision: 1,
      expectedTermsVersion: 'terms-1',
    };
    expect(CommandContextSchema.parse(context).expectedTermsVersion).toBe('terms-1');
    expect(() => CommandContextSchema.parse({ ...context, expectedRevision: 0 })).toThrow();
    expect(() => CommandContextSchema.parse({ ...context, eligible: true })).toThrow();
  });
  it('emits stable safe error envelopes without private exception content', () => {
    expect(createErrorEnvelope('TERMS_VERSION_CHANGED', 'req-1')).toEqual({
      status: 409,
      body: {
        error: {
          code: 'TERMS_VERSION_CHANGED',
          message: 'Review the current terms before accepting.',
          retryable: false,
          requestId: 'req-1',
        },
      },
    });
    expect(createErrorEnvelope('SERVICE_UNAVAILABLE', 'req-1').body.error.retryable).toBe(true);
    expect(() => createErrorEnvelope('SECRET: private brief' as never, 'req-1')).toThrow();
  });
});
