import { describe, expect, it, vi } from 'vitest';
import {
  prepareSkillAssessmentReview,
  prepareSkillAssessmentReassessment,
} from '../src/skills/assessment-review';
import { SkillEvidenceFactSchema } from '../src/skills/eligibility-contracts';
import {
  definition,
  now,
  until,
  reviewContext,
  reviewInput,
  reassessmentContext,
  reassessmentInput,
  previousAssessment,
  assessmentReference,
  submissionReference,
} from '../examples/skill-assessments/fixtures';
const policy = () => ({
  isApprovedDefinition: (value: unknown) => JSON.stringify(value) === JSON.stringify(definition),
  canPrepareReview: (ctx: { actorAccountId: string; assessmentPolicyVersion: string }) =>
    ctx.actorAccountId === 'synthetic-reviewer' &&
    ctx.assessmentPolicyVersion === 'synthetic-policy-current',
  canPrepareReassessment: (ctx: { actorAccountId: string; assessmentPolicyVersion: string }) =>
    ctx.actorAccountId === 'synthetic-reviewer' &&
    ctx.assessmentPolicyVersion === 'synthetic-policy-current',
});
const rejectReview = (
  code: string,
  ctx: unknown,
  input: unknown = reviewInput(),
  port: unknown = policy(),
) => expect(() => prepareSkillAssessmentReview(ctx, input, port)).toThrow(code);
const rejectReassessment = (
  code: string,
  ctx: unknown,
  input: unknown = reassessmentInput(),
  port: unknown = policy(),
) => expect(() => prepareSkillAssessmentReassessment(ctx, input, port)).toThrow(code);
function proposedAssessment(result: ReturnType<typeof prepareSkillAssessmentReview>) {
  expect(result.proposedAssessment).not.toBeNull();
  if (result.proposedAssessment === null) throw new Error('VERIFY must propose assessment data');
  return result.proposedAssessment;
}

describe('authorized private manual review', () => {
  it('preserves a historical assessment already due at its issuance boundary', () => {
    const old = previousAssessment();
    const record = { ...old, state: 'REASSESSMENT_REQUIRED', reassessmentAt: old.issuedAt };
    const ctx = {
      ...reviewContext(),
      assessmentObservation: { ...reviewContext().assessmentObservation, record },
    };
    const result = prepareSkillAssessmentReview(
      ctx,
      {
        ...reviewInput(),
        decision: 'MORE_EVIDENCE',
        expectedAssessmentReference: assessmentReference,
      },
      policy(),
    );
    expect(result.proposedAssessment).toBeNull();
    expect(result.previousAssessmentReference).toEqual(assessmentReference);
    expect(ctx.assessmentObservation.record).toEqual(record);
  });
  it('passes immutable private snapshots to the scoped authority port', () => {
    const port = {
      ...policy(),
      canPrepareReview: (ctx: unknown, command: unknown) => {
        expect(Object.isFrozen(ctx)).toBe(true);
        expect(Object.isFrozen(command)).toBe(true);
        if (
          typeof ctx !== 'object' ||
          ctx === null ||
          !('subject' in ctx) ||
          !('submission' in ctx)
        )
          return false;
        expect(Object.isFrozen(ctx.subject)).toBe(true);
        expect(Object.isFrozen(ctx.submission)).toBe(true);
        return true;
      },
    };
    expect(prepareSkillAssessmentReview(reviewContext(), reviewInput(), port).state).toBe(
      'PROPOSED',
    );
  });
  it('prepares a reasoned relevant advanced assessment without persisted eligibility or grants', () => {
    const result = prepareSkillAssessmentReview(reviewContext(), reviewInput(), policy());
    expect(result).toMatchObject({
      version: 'v1',
      state: 'PROPOSED',
      decision: 'VERIFY',
      participantId: 'synthetic-alice-participant',
      evaluatorAccountId: 'synthetic-reviewer',
      persisted: false,
      verifiesSkill: false,
      isAuthorizationToken: false,
      createsPermissionGrant: false,
      consumesCapacity: false,
      createsFinancialObligation: false,
    });
    expect(result.proposedAssessment).toMatchObject({
      reference: { recordId: 'synthetic-assessment', revision: 1 },
      proposedRank: 'A',
      state: 'PROPOSED',
      proposedState: 'VERIFIED',
      rubricReference: definition.rubric.reference,
      submissionReference,
      sampleSize: 2,
    });
    expect(Object.isFrozen(proposedAssessment(result).evidenceReferences)).toBe(true);
    expect(result.proposedAssessment).not.toHaveProperty('assessedRank');
    expect(proposedAssessment(result).persisted).toBe(false);
    expect(proposedAssessment(result).verifiesSkill).toBe(false);
    expect(Object.isFrozen(result.criteria[0])).toBe(true);
    expect(SkillEvidenceFactSchema.safeParse(result).success).toBe(false);
    expect(SkillEvidenceFactSchema.safeParse(result.proposedAssessment).success).toBe(false);
    expect(JSON.stringify(result)).not.toContain(definition.inputs[0].content);
  });
  it.each([
    ['actorAccountId', null, 'AUTHENTICATION_REQUIRED'],
    ['actorSessionAuthorized', false, 'AUTHENTICATION_REQUIRED'],
    ['actorRestricted', true, 'ACCOUNT_RESTRICTED'],
    ['actorAccountId', 'synthetic-alice-account', 'SELF_REVIEW_FORBIDDEN'],
    ['actorAccountId', 'unscoped-founder', 'FORBIDDEN'],
    ['assessmentPolicyVersion', 'unapproved-policy', 'FORBIDDEN'],
  ])('denies %s=%s', (key, value, code) => {
    const ctx = reviewContext();
    Reflect.set(ctx, key, value);
    rejectReview(String(code), ctx);
  });
  it('requires current actual scope before disclosing domain or version failures', () => {
    const port = {
      ...policy(),
      canPrepareReview: vi.fn(() => false),
      isApprovedDefinition: vi.fn(() => true),
    };
    rejectReview(
      'FORBIDDEN',
      { ...reviewContext(), definition: { ...definition, skillDomain: 'other' } },
      reviewInput(),
      port,
    );
    expect(port.canPrepareReview).toHaveBeenCalledOnce();
    expect(port.isApprovedDefinition).not.toHaveBeenCalled();
  });
  it('rejects client actor/rank/authority/score fields and missing decision ports', () => {
    for (const key of [
      'actorAccountId',
      'participantId',
      'approved',
      'assessedRank',
      'score',
      'role',
      'tokenBalance',
    ])
      rejectReview('INVALID_INPUT', reviewContext(), { ...reviewInput(), [key]: 'forged' });
    rejectReview('INVALID_HOST_CONTRACT', reviewContext(), reviewInput(), {});
    rejectReview('FORBIDDEN', reviewContext(), reviewInput(), {
      ...policy(),
      canPrepareReview: () => 'yes',
    });
  });
  it('sanitizes private approval failures', () => {
    for (const key of ['canPrepareReview', 'isApprovedDefinition'])
      rejectReview('HOST_POLICY_UNAVAILABLE', reviewContext(), reviewInput(), {
        ...policy(),
        [key]: () => {
          throw new Error('private evidence sentinel');
        },
      });
  });
  it('binds exact definition, rubric, submission and current assessment versions', () => {
    for (const key of [
      'expectedDefinitionReference',
      'expectedRubricReference',
      'expectedSubmissionReference',
    ]) {
      const input = reviewInput();
      Reflect.set(input, key, { recordId: 'foreign', revision: 1 });
      rejectReview('REVISION_CHANGED', reviewContext(), input);
    }
    rejectReview('REVISION_CHANGED', reviewContext(), {
      ...reviewInput(),
      expectedAssessmentReference: assessmentReference,
    });
    const ctx = {
      ...reviewContext(),
      assessmentObservation: {
        ...reviewContext().assessmentObservation,
        record: previousAssessment(),
      },
    };
    rejectReview('REVISION_CHANGED', ctx);
    expect(
      proposedAssessment(
        prepareSkillAssessmentReview(
          ctx,
          { ...reviewInput(), expectedAssessmentReference: assessmentReference },
          policy(),
        ),
      ).reference.revision,
    ).toBe(3);
  });
  it('rejects changed immutable rubric/tool/variant under the approved definition ID', () => {
    for (const change of [
      { targetRank: 'S' },
      { brief: 'Changed accepted work' },
      { tools: { ...definition.tools, aiAssistance: 'PROHIBITED' } },
      { variantId: 'changed' },
    ])
      rejectReview('DEFINITION_UNAVAILABLE', {
        ...reviewContext(),
        definition: { ...definition, ...change },
      });
  });
  it('requires the actual canonical HUMAN subject and matching stable domain', () => {
    rejectReview('RESOURCE_UNAVAILABLE', {
      ...reviewContext(),
      subject: { kind: 'AI_AGENT', id: 'agent', operatorId: 'operator' },
    });
    rejectReview(
      'INVALID_HOST_CONTRACT',
      { ...reviewContext(), definition: { ...definition, skillDomain: 'chain' } },
      reviewInput(),
      { ...policy(), isApprovedDefinition: () => true },
    );
    rejectReview('SUBMISSION_UNAVAILABLE', {
      ...reviewContext(),
      submission: { ...reviewContext().submission, participantId: 'foreign' },
    });
    rejectReview('SUBMISSION_UNAVAILABLE', {
      ...reviewContext(),
      submission: {
        ...reviewContext().submission,
        definitionReference: { recordId: 'foreign', revision: 1 },
      },
    });
  });
  it('preserves actual submitted historical rubric after skill retirement', () => {
    const ctx = reviewContext();
    ctx.taxonomy.skills[0].status = 'RETIRED';
    expect(
      proposedAssessment(prepareSkillAssessmentReview(ctx, reviewInput(), policy())).proposedRank,
    ).toBe('A');
  });
  it('denies expired/future/wrong-scope assessment observations including claimed absence', () => {
    for (const change of [
      { participantId: 'other' },
      { skillId: 'other' },
      { validUntil: now },
      { observedAt: until },
    ])
      rejectReview('ASSESSMENT_UNAVAILABLE', {
        ...reviewContext(),
        assessmentObservation: { ...reviewContext().assessmentObservation, ...change },
      });
    for (const status of ['STALE', 'UNAVAILABLE'])
      rejectReview('ASSESSMENT_UNAVAILABLE', {
        ...reviewContext(),
        assessmentObservation: { status },
      });
  });
  it('denies malformed current assessment bindings without erasing them', () => {
    for (const change of [
      { participantId: 'other' },
      { skillDomain: 'chain' },
      { issuedAt: until },
      { reference: { recordId: 'other', revision: 2 } },
    ]) {
      const record = { ...previousAssessment(), ...change },
        before = JSON.stringify(record);
      rejectReview(
        'INVALID_HOST_CONTRACT',
        {
          ...reviewContext(),
          assessmentObservation: { ...reviewContext().assessmentObservation, record },
        },
        { ...reviewInput(), expectedAssessmentReference: assessmentReference },
      );
      expect(JSON.stringify(record)).toBe(before);
    }
  });
  it('requires fresh actually submitted evidence without future submission/history rewrites', () => {
    for (const change of [{ validUntil: now }, { observedAt: until }])
      rejectReview('SUBMISSION_UNAVAILABLE', {
        ...reviewContext(),
        submission: { ...reviewContext().submission, ...change },
      });
    for (const change of [
      { submittedAt: until },
      { state: 'DRAFT' },
      { sampleSize: 0 },
      { evidenceReferences: [] },
      {
        evidenceReferences: [
          { recordId: 'same', revision: 1 },
          { recordId: 'same', revision: 2 },
        ],
      },
    ])
      rejectReview('INVALID_HOST_CONTRACT', {
        ...reviewContext(),
        submission: { ...reviewContext().submission, ...change },
      });
  });
  it('requires exactly one reasoned finding for every actual rubric criterion', () => {
    const input = reviewInput();
    for (const criteria of [
      input.criteria.slice(1),
      [...input.criteria, input.criteria[0]],
      [...input.criteria.slice(1), { ...input.criteria[0], criterionId: 'foreign' }],
      [{ ...input.criteria[0], reason: '' }, input.criteria[1]],
    ])
      rejectReview('INVALID_INPUT', reviewContext(), { ...input, criteria });
  });
  it('requires confirmed ownership and MET required criteria for verification', () => {
    for (const ownership of ['UNCONFIRMED', 'DISPUTED'])
      rejectReview('EVIDENCE_NOT_CONFIRMED', {
        ...reviewContext(),
        submission: { ...reviewContext().submission, ownership },
      });
    for (const result of ['NOT_MET', 'UNCERTAIN'])
      rejectReview('RUBRIC_NOT_MET', reviewContext(), {
        ...reviewInput(),
        criteria: reviewInput().criteria.map((c, i) => (i === 0 ? { ...c, result } : c)),
      });
  });
  it('keeps incomplete/failed reviews separate from old capability history', () => {
    const ctx = {
        ...reviewContext(),
        assessmentObservation: {
          ...reviewContext().assessmentObservation,
          record: previousAssessment(),
        },
        submission: { ...reviewContext().submission, ownership: 'UNCONFIRMED' },
      },
      before = JSON.stringify(ctx);
    for (const decision of ['MORE_EVIDENCE', 'NOT_DEMONSTRATED']) {
      const result = prepareSkillAssessmentReview(
        ctx,
        {
          ...reviewInput(),
          decision,
          expectedAssessmentReference: assessmentReference,
          criteria: reviewInput().criteria.map((c) => ({ ...c, result: 'UNCERTAIN' })),
        },
        policy(),
      );
      expect(result.proposedAssessment).toBeNull();
      expect(result.previousAssessmentReference).toEqual(assessmentReference);
    }
    expect(JSON.stringify(ctx)).toBe(before);
  });
  it('validates bounded future reassessment date and prevents revision overflow', () => {
    rejectReview('INVALID_INPUT', reviewContext(), { ...reviewInput(), reassessmentAt: now });
    const record = {
      ...previousAssessment(),
      reference: { ...assessmentReference, revision: Number.MAX_SAFE_INTEGER },
    };
    rejectReview(
      'REVISION_EXHAUSTED',
      {
        ...reviewContext(),
        assessmentObservation: { ...reviewContext().assessmentObservation, record },
      },
      { ...reviewInput(), expectedAssessmentReference: record.reference },
    );
  });
});
describe('reasoned private reassessment and fraud revocation', () => {
  it('proposes scoped capability reassessment preserving prior rank/evidence/issuer history', () => {
    const ctx = reassessmentContext(),
      before = JSON.stringify(ctx),
      result = prepareSkillAssessmentReassessment(ctx, reassessmentInput(), policy());
    expect(result).toMatchObject({
      state: 'PROPOSED',
      action: 'REQUIRE_REASSESSMENT',
      previousAssessmentReference: assessmentReference,
      persisted: false,
      verifiesSkill: false,
      createsPermissionGrant: false,
      consumesCapacity: false,
    });
    expect(result.proposedState).toBe('REASSESSMENT_REQUIRED');
    expect(result.dueAt).toBe(reassessmentInput().dueAt);
    expect(result.previousAssessedRank).toBe('B');
    expect(JSON.stringify(ctx)).toBe(before);
  });
  it('allows only a separately authorized reasoned fraud case to propose revocation', () => {
    const input = {
      version: 'v1',
      expectedAssessmentReference: assessmentReference,
      action: 'REVOKE',
      reasonCategory: 'FRAUDULENT_ASSESSMENT_EVIDENCE',
      reason: 'Scoped confirmed evidence establishes fraudulent assessment material.',
    };
    expect(
      prepareSkillAssessmentReassessment(reassessmentContext(), input, policy()),
    ).toMatchObject({
      state: 'PROPOSED',
      proposedState: 'REVOKED',
      previousAssessedRank: 'B',
      dueAt: null,
      persisted: false,
      verifiesSkill: false,
    });
    rejectReassessment('FORBIDDEN', reassessmentContext(), input, {
      ...policy(),
      canPrepareReassessment: () => false,
    });
    for (const reasonCategory of [
      'RELIABILITY_INCIDENT',
      'LOW_TOKEN_BALANCE',
      'SIMILARITY_SIGNAL',
      'CAPABILITY_RECHECK',
    ])
      rejectReassessment('INVALID_INPUT', reassessmentContext(), { ...input, reasonCategory });
  });
  it('denies self-review, restricted/unscoped evaluators and unavailable current case evidence', () => {
    rejectReassessment('SELF_REVIEW_FORBIDDEN', {
      ...reassessmentContext(),
      actorAccountId: 'synthetic-alice-account',
    });
    rejectReassessment('ACCOUNT_RESTRICTED', { ...reassessmentContext(), actorRestricted: true });
    rejectReassessment('FORBIDDEN', { ...reassessmentContext(), actorAccountId: 'foreign' });
    for (const change of [
      { participantId: 'foreign' },
      { assessmentReference: { recordId: 'foreign', revision: 2 } },
      { validUntil: now },
      { observedAt: until },
    ])
      rejectReassessment('CASE_EVIDENCE_UNAVAILABLE', {
        ...reassessmentContext(),
        caseEvidence: { ...reassessmentContext().caseEvidence, ...change },
      });
    for (const status of ['STALE', 'UNAVAILABLE'])
      rejectReassessment('CASE_EVIDENCE_UNAVAILABLE', {
        ...reassessmentContext(),
        caseEvidence: { status },
      });
  });
  it('requires actual existing current assessment and exact original version', () => {
    rejectReassessment('ASSESSMENT_UNAVAILABLE', {
      ...reassessmentContext(),
      assessmentObservation: reviewContext().assessmentObservation,
    });
    rejectReassessment('REVISION_CHANGED', reassessmentContext(), {
      ...reassessmentInput(),
      expectedAssessmentReference: { ...assessmentReference, revision: 1 },
    });
    rejectReassessment('STATE_CONFLICT', {
      ...reassessmentContext(),
      assessmentObservation: {
        ...reassessmentContext().assessmentObservation,
        record: { ...previousAssessment(), state: 'REVOKED' },
      },
    });
    rejectReassessment('INVALID_INPUT', reassessmentContext(), {
      ...reassessmentInput(),
      dueAt: now,
    });
  });
  it('has no automatic provider outage, reputation restriction or mutable history effect', () => {
    const ctx = reassessmentContext(),
      before = JSON.stringify(ctx);
    rejectReassessment('CASE_EVIDENCE_UNAVAILABLE', {
      ...ctx,
      caseEvidence: { status: 'UNAVAILABLE' },
    });
    rejectReassessment('INVALID_HOST_CONTRACT', { ...ctx, reputation: 'RESTRICTED' });
    const result = prepareSkillAssessmentReassessment(ctx, reassessmentInput(), policy());
    expect(SkillEvidenceFactSchema.safeParse(result).success).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(ctx)).toBe(before);
  });
  it('sanitizes a failed scoped reassessment policy', () =>
    rejectReassessment('HOST_POLICY_UNAVAILABLE', reassessmentContext(), reassessmentInput(), {
      ...policy(),
      canPrepareReassessment: () => {
        throw new Error('private sentinel');
      },
    }));
});
