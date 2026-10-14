import { describe, expect, it } from 'vitest';
import { preparePracticeTrialAttempt, readPracticeTrial } from '../src/skills/practice-trials';

const now = '2026-10-14T15:00:00.000Z';
const until = '2026-10-14T15:01:00.000Z';
const reference = { recordId: 'synthetic-frontend-trial', revision: 2 };
const rubricReference = { recordId: 'synthetic-rubric', revision: 3 };
const definition = {
  version: 'v1',
  reference,
  state: 'PUBLISHED',
  publishedAt: '2026-10-13T00:00:00.000Z',
  purpose: 'UNPAID_PLATFORM_PRACTICE',
  skillId: 'frontend',
  skillDomain: 'web',
  targetRank: 'A',
  title: 'Synthetic interface exercise',
  brief: 'Build and explain a synthetic accessible interface.',
  variantId: 'synthetic-variant-two',
  inputs: [{ label: 'Fixture', material: 'SYNTHETIC', content: 'Invented records only.' }],
  tools: {
    permitted: ['editor', 'browser'],
    aiAssistance: 'ALLOWED',
    disclosure: 'Explain and modify your work; disclose assistance.',
  },
  expectedMinutes: 60,
  rubric: {
    reference: rubricReference,
    criteria: [
      { id: 'behavior', description: 'Working behavior and edge cases', required: true },
      { id: 'ownership', description: 'Explain and modify the solution', required: true },
    ],
  },
  evaluatorMethod: 'MANUAL',
  passConditions: 'The authorized reviewer applies every required criterion.',
  maximumAttempts: 3,
  cooldownSeconds: 60,
  accommodationPolicy: 'Request an approved scoped accommodation.',
};
const taxonomy = {
  version: 'v1',
  id: 'synthetic-catalog',
  revision: 1,
  state: 'PUBLISHED',
  publishedByAccountId: 'admin',
  publishedAt: '2026-10-13T00:00:00.000Z',
  skills: [
    { id: 'frontend', domain: 'web', name: 'Frontend', status: 'ACTIVE', aliases: ['frontend'] },
  ],
};
const discovery = () => ({ version: 'v1', now, taxonomy, definition: structuredClone(definition) });
const context = () => ({
  ...discovery(),
  actorAccountId: 'alice-account',
  actorSessionAuthorized: true,
  actorRestricted: false,
  participant: { kind: 'HUMAN', id: 'alice-participant', accountId: 'alice-account' },
  attemptHistory: {
    status: 'CURRENT',
    participantId: 'alice-participant',
    trialId: reference.recordId,
    observedAt: now,
    validUntil: until,
    attemptsUsed: 0,
    lastAttemptAt: null,
  },
  accommodation: null,
});
const input = () => ({
  version: 'v1',
  definitionReference: { ...reference },
  accommodationReference: null,
});
const ports = () => ({
  isApprovedDefinition: (value: unknown) => JSON.stringify(value) === JSON.stringify(definition),
  isApprovedAccommodation: () => false,
});
const grant = () => ({
  version: 'v1',
  reference: { recordId: 'synthetic-accommodation', revision: 1 },
  participantId: 'alice-participant',
  definitionReference: { ...reference },
  observedAt: now,
  validUntil: until,
  maximumAttempts: 5,
  expectedMinutes: 90,
  cooldownSeconds: 0,
});
function rejected(
  code: string,
  ctx: unknown,
  command: unknown = input(),
  policy: unknown = ports(),
) {
  expect(() => preparePracticeTrialAttempt(ctx, command, policy)).toThrow(code);
}

describe('approved practice definition', () => {
  it('requires a declared bounded rank, variant, tool policy and qualitative rubric', () => {
    const changes = [
      { targetRank: 'SUPER' },
      { variantId: '' },
      { maximumAttempts: 0 },
      { expectedMinutes: 0.5 },
      { cooldownSeconds: -1 },
      { publishedAt: '2026-10-13T00:00:00.0001Z' },
      { tools: { ...definition.tools, aiAssistance: 'UNDECLARED' } },
      { tools: { ...definition.tools, permitted: ['editor', 'editor'] } },
      { rubric: { ...definition.rubric, criteria: [] } },
      { rubric: { ...definition.rubric, reference: { ...rubricReference, revision: 0 } } },
      { inputs: [] },
    ];
    for (const change of changes)
      expect(() =>
        readPracticeTrial({ ...discovery(), definition: { ...definition, ...change } }, ports()),
      ).toThrow('INVALID_HOST_CONTRACT');
  });
  it('does not approve changed rubric, tools, rank or variant under an approved ID', () => {
    for (const change of [
      { targetRank: 'S' },
      { variantId: 'another-variant' },
      { tools: { ...definition.tools, aiAssistance: 'PROHIBITED' } },
      { rubric: { ...definition.rubric, reference: { ...rubricReference, revision: 4 } } },
    ])
      expect(() =>
        readPracticeTrial({ ...discovery(), definition: { ...definition, ...change } }, ports()),
      ).toThrow('DEFINITION_UNAVAILABLE');
  });
  it('exposes the full approved version/tool/rubric policy with no granted rank or hidden answers', () => {
    const result = readPracticeTrial(discovery(), ports());
    expect(result).toEqual(definition);
    expect(Object.isFrozen(result.rubric.criteria[0])).toBe(true);
    expect(Object.isFrozen(result.tools.permitted)).toBe(true);
    expect(result).not.toHaveProperty('assessedRank');
  });
  it.each(['brief', 'passConditions', 'accommodationPolicy'])(
    'rejects changed approved %s under the same reference',
    (key) => {
      const ctx = discovery();
      Reflect.set(ctx.definition, key, 'Changed immutable content');
      expect(() => readPracticeTrial(ctx, ports())).toThrow('DEFINITION_UNAVAILABLE');
    },
  );
  it.each(['PRIVATE', 'CUSTOMER_PRODUCTION'])('rejects unsafe material %s', (material) => {
    const ctx = discovery();
    ctx.definition.inputs[0].material = material;
    expect(() => readPracticeTrial(ctx, ports())).toThrow('INVALID_HOST_CONTRACT');
  });
  it('rejects founder work, duplicate rubric IDs and hidden-answer fields', () => {
    for (const change of [
      { purpose: 'CUSTOMER_PRODUCTION' },
      { hiddenAnswers: 'private sentinel' },
      {
        rubric: {
          reference: rubricReference,
          criteria: [definition.rubric.criteria[0], definition.rubric.criteria[0]],
        },
      },
    ]) {
      expect(() =>
        readPracticeTrial({ ...discovery(), definition: { ...definition, ...change } }, ports()),
      ).toThrow('INVALID_HOST_CONTRACT');
    }
  });
  it('does not trust a client approval flag or missing policy', () => {
    expect(() => readPracticeTrial({ ...discovery(), approved: true }, ports())).toThrow(
      'INVALID_HOST_CONTRACT',
    );
    expect(() => readPracticeTrial(discovery(), {})).toThrow('INVALID_HOST_CONTRACT');
    expect(() =>
      readPracticeTrial(discovery(), { ...ports(), isApprovedDefinition: () => 'yes' }),
    ).toThrow('DEFINITION_UNAVAILABLE');
  });
  it('sanitizes a failed host policy without leaking private exceptions', () => {
    expect(() =>
      readPracticeTrial(discovery(), {
        ...ports(),
        isApprovedDefinition: () => {
          throw new Error('private policy sentinel');
        },
      }),
    ).toThrow(/^HOST_POLICY_UNAVAILABLE$/);
  });
  it('rejects future publication and mismatched/retired catalog skills', () => {
    for (const ctx of [
      { ...discovery(), now: '2026-10-12T00:00:00Z' },
      { ...discovery(), definition: { ...definition, skillDomain: 'chain' } },
      {
        ...discovery(),
        taxonomy: { ...taxonomy, skills: [{ ...taxonomy.skills[0], status: 'RETIRED' }] },
      },
    ]) {
      expect(() =>
        readPracticeTrial(ctx, { ...ports(), isApprovedDefinition: () => true }),
      ).toThrow(/INVALID_HOST_CONTRACT|SKILL_UNAVAILABLE/);
    }
  });
});

describe('private unpersisted practice preparation', () => {
  it('keeps experienced A-rank entry separate from assessment and capacity', () => {
    const candidate = preparePracticeTrialAttempt(context(), input(), ports());
    expect(candidate).toMatchObject({
      version: 'v1',
      state: 'PREPARED',
      definitionReference: reference,
      rubricReference,
      participantId: 'alice-participant',
      skillId: 'frontend',
      skillDomain: 'web',
      targetRank: 'A',
      attemptNumber: 1,
      expectedMinutes: 60,
      persisted: false,
      verifiesSkill: false,
      isAuthorizationToken: false,
      createsPermissionGrant: false,
      consumesCapacity: false,
      createsFinancialObligation: false,
    });
    expect(candidate).not.toHaveProperty('assessedRank');
    expect(candidate).not.toHaveProperty('actorAccountId');
    expect(Object.isFrozen(candidate.definitionReference)).toBe(true);
  });
  it.each([
    ['actorAccountId', null, 'AUTHENTICATION_REQUIRED'],
    ['actorSessionAuthorized', false, 'AUTHENTICATION_REQUIRED'],
    ['actorRestricted', true, 'ACCOUNT_RESTRICTED'],
    ['actorAccountId', 'foreign-account', 'FORBIDDEN'],
  ])('denies %s=%s', (key, value, code) => {
    const ctx = context();
    Reflect.set(ctx, key, value);
    rejected(String(code), ctx);
  });
  it('cannot supply canonical identity or authority in the command', () => {
    for (const field of ['participantId', 'approved', 'maximumAttempts', 'assessedRank', 'role'])
      rejected('INVALID_INPUT', context(), { ...input(), [field]: 'forged' });
  });
  it('requires exact current definition and accommodation consent', () => {
    rejected('REVISION_CHANGED', context(), {
      ...input(),
      definitionReference: { ...reference, revision: 1 },
    });
    rejected('REVISION_CHANGED', context(), {
      ...input(),
      definitionReference: { ...reference, recordId: 'other-trial' },
    });
    rejected('ACCOMMODATION_UNAVAILABLE', context(), {
      ...input(),
      accommodationReference: { recordId: 'forged', revision: 1 },
    });
  });
  it.each(['STALE', 'UNAVAILABLE'])('denies %s attempt observations', (status) =>
    rejected('ATTEMPT_HISTORY_UNAVAILABLE', { ...context(), attemptHistory: { status } }),
  );
  it('binds attempt counts to the canonical subject and stable trial family', () => {
    for (const change of [
      { participantId: 'other' },
      { trialId: 'other' },
      { observedAt: until },
      { validUntil: now },
    ])
      rejected('ATTEMPT_HISTORY_UNAVAILABLE', {
        ...context(),
        attemptHistory: { ...context().attemptHistory, ...change },
      });
  });
  it('rejects malformed or inconsistent attempt history', () => {
    for (const change of [
      { attemptsUsed: -1 },
      { attemptsUsed: 0, lastAttemptAt: now },
      { attemptsUsed: 1, lastAttemptAt: null },
      { attemptsUsed: 1, lastAttemptAt: until },
    ])
      rejected('INVALID_HOST_CONTRACT', {
        ...context(),
        attemptHistory: { ...context().attemptHistory, ...change },
      });
  });
  it('enforces family-wide attempt exhaustion and exact cooldown boundary', () => {
    const hist = {
      ...context().attemptHistory,
      attemptsUsed: 3,
      lastAttemptAt: '2026-10-14T14:58:00.000Z',
    };
    rejected('ATTEMPT_LIMIT_REACHED', { ...context(), attemptHistory: hist });
    rejected('COOLDOWN_ACTIVE', {
      ...context(),
      attemptHistory: { ...hist, attemptsUsed: 1, lastAttemptAt: '2026-10-14T14:59:00.001Z' },
    });
    expect(
      preparePracticeTrialAttempt(
        {
          ...context(),
          attemptHistory: { ...hist, attemptsUsed: 1, lastAttemptAt: '2026-10-14T14:59:00.000Z' },
        },
        input(),
        ports(),
      ).attemptNumber,
    ).toBe(2);
  });
  it('uses only the exact current host-approved participant accommodation', () => {
    const accommodation = grant(),
      ctx = {
        ...context(),
        accommodation,
        attemptHistory: { ...context().attemptHistory, attemptsUsed: 3, lastAttemptAt: now },
      };
    const command = { ...input(), accommodationReference: accommodation.reference };
    const policy = {
      ...ports(),
      isApprovedAccommodation: (value: unknown) =>
        JSON.stringify(value) === JSON.stringify(accommodation),
    };
    expect(preparePracticeTrialAttempt(ctx, command, policy)).toMatchObject({
      attemptNumber: 4,
      expectedMinutes: 90,
      accommodationReference: accommodation.reference,
    });
    rejected('ACCOMMODATION_UNAVAILABLE', ctx, command);
    rejected('ACCOMMODATION_UNAVAILABLE', ctx, input(), policy);
    for (const change of [
      { participantId: 'foreign' },
      { definitionReference: { ...reference, revision: 1 } },
      { validUntil: now },
      { observedAt: until },
      { expectedMinutes: 91 },
    ])
      rejected(
        'ACCOMMODATION_UNAVAILABLE',
        { ...ctx, accommodation: { ...accommodation, ...change } },
        command,
        policy,
      );
  });
  it('rejects a non-HUMAN canonical mapping', () => {
    rejected('RESOURCE_UNAVAILABLE', {
      ...context(),
      participant: { kind: 'AI_AGENT', id: 'agent', operatorId: 'operator' },
    });
  });
  it('freezes candidate facts without mutating the inputs or creating a receipt', () => {
    const ctx = context(),
      before = JSON.stringify(ctx);
    const a = preparePracticeTrialAttempt(ctx, input(), ports()),
      b = preparePracticeTrialAttempt(ctx, input(), ports());
    expect(a).toEqual(b);
    expect(JSON.stringify(ctx)).toBe(before);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a).not.toHaveProperty('receipt');
  });
});
