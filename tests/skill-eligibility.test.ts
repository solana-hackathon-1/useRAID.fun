import { describe, expect, it } from 'vitest';
import { explainSkillEligibility } from '../src/skills/eligibility';
const now = '2026-10-14T01:00:00.000Z';
const taxonomy = {
  version: 'v1',
  id: 'catalog',
  revision: 3,
  state: 'PUBLISHED',
  publishedByAccountId: 'admin',
  publishedAt: '2026-10-13T00:00:00.000Z',
  skills: [
    { id: 'react', domain: 'frontend', name: 'React', status: 'ACTIVE', aliases: ['react'] },
    { id: 'vue', domain: 'frontend', name: 'Vue', status: 'ACTIVE', aliases: ['vue'] },
    {
      id: 'solana',
      domain: 'solana-programs',
      name: 'Solana',
      status: 'ACTIVE',
      aliases: ['solana'],
    },
  ],
};
function assessment(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'ASSESSMENT',
    skillId: 'react',
    domain: 'frontend',
    state: 'VERIFIED',
    assessedRank: 'A',
    assessmentReference: { recordId: 'assessment', revision: 2 },
    rubricReference: { recordId: 'rubric', revision: 1 },
    assessmentPolicyVersion: 'policy-1',
    evaluatorAccountId: 'reviewer',
    issuedAt: '2026-10-13T00:00:00.000Z',
    reassessmentAt: null,
    ...overrides,
  };
}
function member(
  id = 'alice',
  skills: unknown[] = [assessment()],
  overrides: Record<string, unknown> = {},
) {
  return {
    participant: { id, kind: 'HUMAN', accountId: id + '-account' },
    evidence: {
      status: 'CURRENT',
      observedAt: now,
      validUntil: '2026-10-14T01:01:00.000Z',
      skills,
      ...overrides,
    },
  };
}
function context(participants: unknown[] = [member()], overrides: Record<string, unknown> = {}) {
  return { version: 'v1', now, taxonomy, participants, ...overrides };
}
function leaf(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'SKILL',
    skillId: 'react',
    minimumRank: 'C',
    verificationRequired: true,
    assessmentPolicyVersion: 'policy-1',
    ...overrides,
  };
}
function input(requirement: unknown = leaf(), coverage = 'ONE_MEMBER') {
  return { version: 'v1', coverage, requirement };
}
function status(c: unknown, i: unknown) {
  return explainSkillEligibility(c, i).status;
}

describe('relevant current evidence', () => {
  it('explains verified A React as satisfying C React without granting authority', () => {
    expect(explainSkillEligibility(context(), input())).toMatchObject({
      version: 'v1',
      status: 'MET',
      informational: true,
      isAuthorizationToken: false,
      verifiesSkill: false,
      createsPermissionGrant: false,
      consumesCapacity: false,
      persisted: false,
      taxonomyReference: { recordId: 'catalog', revision: 3 },
      evaluations: [
        {
          participantIds: ['alice'],
          explanation: {
            kind: 'SKILL',
            status: 'MET',
            members: [
              {
                participantId: 'alice',
                reason: 'VERIFIED_RANK',
                evidenceKind: 'VERIFIED_ASSESSMENT',
                assessedRank: 'A',
              },
            ],
          },
        },
      ],
    });
  });
  it('never uses A frontend to satisfy B Solana (AC05)', () => {
    const result = explainSkillEligibility(
      context(),
      input(leaf({ skillId: 'solana', minimumRank: 'B' })),
    );
    expect(result).toMatchObject({
      status: 'UNMET',
      evaluations: [
        {
          explanation: {
            skillId: 'solana',
            skillDomain: 'solana-programs',
            members: [{ reason: 'MISSING_SKILL' }],
          },
        },
      ],
    });
  });
  it.each(['E', 'D', 'C', 'B', 'A', 'S'])(
    'uses descriptive ordinal %s only within the same skill',
    (rank) => {
      const order = ['E', 'D', 'C', 'B', 'A', 'S'];
      for (const min of order)
        expect(
          status(
            context([member('alice', [assessment({ assessedRank: rank })])]),
            input(leaf({ minimumRank: min })),
          ),
        ).toBe(order.indexOf(rank) >= order.indexOf(min) ? 'MET' : 'UNMET');
    },
  );
  it('does not parse a free-text S claim or proof link into verified rank', () => {
    const claim = {
      kind: 'CLAIM',
      skillId: 'react',
      domain: 'frontend',
      claimedLevel: 'S, famous wealthy founder',
    };
    expect(status(context([member('alice', [claim])]), input())).toBe('UNMET');
    expect(
      status(context([member('alice', [claim])]), input(leaf({ verificationRequired: false }))),
    ).toBe('UNKNOWN');
  });
  it('labels explicitly permitted pending rank evidence as unverified', () => {
    const c = context([member('alice', [assessment({ state: 'UNDER_REVIEW' })])]);
    expect(status(c, input())).toBe('UNMET');
    expect(explainSkillEligibility(c, input(leaf({ verificationRequired: false })))).toMatchObject({
      status: 'MET',
      evaluations: [
        {
          explanation: {
            members: [{ reason: 'UNVERIFIED_EVIDENCE', evidenceKind: 'UNVERIFIED_ASSESSMENT' }],
          },
        },
      ],
    });
  });
  it.each(['REVOKED', 'REASSESSMENT_REQUIRED'])(
    'does not qualify %s even for unverified admission',
    (state) => {
      expect(
        status(
          context([member('alice', [assessment({ state })])]),
          input(leaf({ verificationRequired: false })),
        ),
      ).toBe('UNMET');
    },
  );
  it('does not qualify an assessment at its exact reassessment boundary', () => {
    expect(status(context([member('alice', [assessment({ reassessmentAt: now })])]), input())).toBe(
      'UNMET',
    );
  });
  it('preserves existing skill assessment when taxonomy retires its category', () => {
    const t = structuredClone(taxonomy);
    t.skills[0].status = 'RETIRED';
    expect(status(context(undefined, { taxonomy: t }), input())).toBe('MET');
  });
  it('rejects an old assessment policy rather than silently substituting it', () => {
    expect(
      explainSkillEligibility(context(), input(leaf({ assessmentPolicyVersion: 'new-policy' }))),
    ).toMatchObject({
      status: 'UNMET',
      evaluations: [{ explanation: { members: [{ reason: 'ASSESSMENT_POLICY_CHANGED' }] } }],
    });
  });
  it.each(['STALE', 'UNAVAILABLE'])(
    'preserves %s as unknown rather than deleting skill evidence',
    (s) => {
      const evidence =
        s === 'STALE' ? { status: s, observedAt: '2026-10-13T00:00:00.000Z' } : { status: s };
      const c = context([
        { participant: { id: 'alice', kind: 'HUMAN', accountId: 'alice-account' }, evidence },
      ]);
      expect(status(c, input())).toBe('UNKNOWN');
    },
  );
  it('expires a current observation at its exact deadline and recovers with a refreshed snapshot', () => {
    expect(status(context([member('alice', [assessment()], { validUntil: now })]), input())).toBe(
      'UNKNOWN',
    );
    expect(status(context(), input())).toBe('MET');
  });
  it('allows an explicit starter without fabricating a skill or waiving other checks', () => {
    expect(
      explainSkillEligibility(
        context([
          {
            participant: { id: 'alice', kind: 'HUMAN', accountId: 'alice-account' },
            evidence: { status: 'UNAVAILABLE' },
          },
        ]),
        input(null),
      ),
    ).toMatchObject({
      status: 'MET',
      isAuthorizationToken: false,
      verifiesSkill: false,
      evaluations: [{ explanation: { kind: 'NO_REQUIREMENTS' } }],
    });
  });
});

describe('explicit grouping and Party coverage', () => {
  const both = { kind: 'AND', children: [leaf(), leaf({ skillId: 'solana' })] };
  const party = context([
    member(),
    member('bob', [assessment({ skillId: 'solana', domain: 'solana-programs' })]),
  ]);
  it('requires a single member to cover an entire AND unless distribution is explicit', () => {
    expect(status(party, input(both, 'ONE_MEMBER'))).toBe('UNMET');
    expect(status(party, input(both, 'DISTRIBUTED_PARTY'))).toBe('MET');
    expect(status(party, input(both, 'EVERY_MEMBER'))).toBe('UNMET');
  });
  it('supports React OR Vue without requiring both', () => {
    expect(
      status(context(), input({ kind: 'OR', children: [leaf(), leaf({ skillId: 'vue' })] })),
    ).toBe('MET');
  });
  it('requires every member when the requirements declare EVERY_MEMBER', () => {
    expect(status(context([member(), member('bob', [])]), input(leaf(), 'EVERY_MEMBER'))).toBe(
      'UNMET',
    );
    expect(status(context([member(), member('bob')]), input(leaf(), 'EVERY_MEMBER'))).toBe('MET');
  });
  it('evaluates nested alternatives without mixing different skills', () => {
    const tree = {
      kind: 'AND',
      children: [
        { kind: 'OR', children: [leaf(), leaf({ skillId: 'vue' })] },
        leaf({ skillId: 'solana' }),
      ],
    };
    expect(status(party, input(tree, 'DISTRIBUTED_PARTY'))).toBe('MET');
    expect(status(party, input(tree, 'ONE_MEMBER'))).toBe('UNMET');
  });
  it('uses three-state truth tables for every group and coverage decision', () => {
    const cases = ['MET', 'UNMET', 'UNKNOWN'];
    function fact(s: string, id: string) {
      return s === 'UNKNOWN'
        ? {
            kind: 'CLAIM',
            skillId: id,
            domain: id === 'solana' ? 'solana-programs' : 'frontend',
            claimedLevel: 'unranked',
          }
        : assessment({
            skillId: id,
            domain: id === 'solana' ? 'solana-programs' : 'frontend',
            assessedRank: s === 'MET' ? 'A' : 'E',
          });
    }
    for (const a of cases)
      for (const b of cases)
        for (const kind of ['AND', 'OR']) {
          const expected =
            kind === 'AND'
              ? a === 'UNMET' || b === 'UNMET'
                ? 'UNMET'
                : a === 'UNKNOWN' || b === 'UNKNOWN'
                  ? 'UNKNOWN'
                  : 'MET'
              : a === 'MET' || b === 'MET'
                ? 'MET'
                : a === 'UNKNOWN' || b === 'UNKNOWN'
                  ? 'UNKNOWN'
                  : 'UNMET';
          const expression = {
            kind,
            children: [
              leaf({ verificationRequired: false }),
              leaf({ skillId: 'solana', verificationRequired: false }),
            ],
          };
          expect(
            status(
              context([member('alice', [fact(a, 'react'), fact(b, 'solana')])]),
              input(expression),
            ),
          ).toBe(expected);
          const p = context([
            member('alice', [fact(a, 'react')]),
            member('bob', [fact(b, 'react')]),
          ]);
          expect(
            status(
              p,
              input(
                leaf({ verificationRequired: false }),
                kind === 'AND' ? 'EVERY_MEMBER' : 'ONE_MEMBER',
              ),
            ),
          ).toBe(expected);
        }
  });
});

describe('strict host and request boundary', () => {
  it('accepts the declared maximum depth and node count with independent JSON nodes', () => {
    let tree: unknown = leaf();
    for (let n = 0; n < 7; n++) tree = { kind: 'AND', children: [tree] };
    expect(status(context(), input(tree))).toBe('MET');
    const groups = Array.from({ length: 8 }, (_, index) => ({
      kind: 'OR',
      children: Array.from({ length: index < 7 ? 16 : 7 }, () => leaf()),
    }));
    expect(status(context(), input({ kind: 'AND', children: groups }))).toBe('MET');
    groups[7].children.push(leaf());
    expect(() =>
      explainSkillEligibility(context(), input({ kind: 'AND', children: groups })),
    ).toThrow('INVALID_INPUT');
  });

  it.each([
    input(leaf({ minimumRank: 'Z' })),
    input(leaf({ eligible: true })),
    input({ kind: 'AND', children: [] }),
    input({ kind: 'OR', children: Array(17).fill(leaf()) }),
    input('React, Solana'),
    input(leaf(), 'implicit'),
    input(leaf({ skillId: 'missing' })),
  ])('rejects an invalid requirement instead of guessing', (i) => {
    expect(() => explainSkillEligibility(context(), i)).toThrow('INVALID_INPUT');
  });
  it.each([
    context([]),
    context([member(), member()]),
    context([
      member(),
      { ...member('bob'), participant: { id: 'bob', kind: 'HUMAN', accountId: 'alice-account' } },
    ]),
    context([member('alice', [assessment(), assessment()])]),
    context([member('alice', [assessment({ domain: 'solana-programs' })])]),
    context([member('alice', [assessment({ issuedAt: '2026-10-15T00:00:00.000Z' })])]),
    context([member('alice', [assessment({ rubricReference: null })])]),
    context([member('alice', [assessment()], { observedAt: '2026-10-15T00:00:00.000Z' })]),
    context(undefined, {
      wealth: '999999999',
      reputation: 100,
      guildTrust: 'CORE',
      privateAccess: true,
    }),
  ])('rejects ambiguous, future, foreign or authority-shaped host input', (c) => {
    expect(() => explainSkillEligibility(c, input())).toThrow('INVALID_HOST_CONTRACT');
  });
  it('rejects excessive depth, node count and cyclic input before recursive parsing', () => {
    let tree: unknown = leaf();
    for (let n = 0; n < 9; n++) tree = { kind: 'AND', children: [tree] };
    expect(() => explainSkillEligibility(context(), input(tree))).toThrow('INVALID_INPUT');
    const big = {
      kind: 'AND',
      children: Array.from({ length: 16 }, () => ({
        kind: 'OR',
        children: Array.from({ length: 16 }, () => leaf()),
      })),
    };
    expect(() => explainSkillEligibility(context(), input(big))).toThrow('INVALID_INPUT');
    const cycle: { kind: string; children: unknown[] } = { kind: 'AND', children: [] };
    cycle.children.push(cycle);
    expect(() => explainSkillEligibility(context(), input(cycle))).toThrow('INVALID_INPUT');
  });
  it('does not mutate inputs; returns deeply frozen explanations without private claim/evaluator evidence', () => {
    const c = context([member('alice', [assessment()])]);
    const i = input();
    const before = JSON.stringify({ c, i });
    const result = explainSkillEligibility(c, i);
    expect(JSON.stringify({ c, i })).toBe(before);
    function check(v: unknown) {
      if (v && typeof v === 'object') {
        expect(Object.isFrozen(v)).toBe(true);
        for (const x of Object.values(v)) check(x);
      }
    }
    check(result);
    expect(JSON.stringify(result)).not.toMatch(
      /reviewer|rubric|issuedAt|supportingReferences|claimedLevel|assessmentReference/,
    );
    expect(explainSkillEligibility(c, i)).toEqual(result);
  });
});
