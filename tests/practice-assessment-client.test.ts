import { expect, it, vi } from 'vitest';
import { createAssessmentEditor, writeAssessment } from '../src/skills/practice-assessment-client';
import { assessmentContextFixture as context } from './helpers/practice-assessment-view-fixture';
import {
  assessmentReviewView,
  assessmentDecisionInput,
  assessmentDecisionView,
  assessmentStateView,
} from './helpers/practice-assessment-http-fixture';
const fields = {
  decision: 'MORE_EVIDENCE',
  reason: ' private-reason ',
  confidenceStatement: ' private-confidence ',
  criteria: context.review.definition.rubric.criteria.map((c) => ({
    criterionId: c.id,
    result: 'UNCERTAIN',
    reason: ' specific criterion ',
  })),
  reassessmentAt: null,
};
const decisionFields = {
  action: 'REQUIRE_REASSESSMENT',
  reasonCategory: 'CAPABILITY_RECHECK',
  reason: ' private-decision-reason ',
  findings: [{ kind: 'CAPABILITY_EVIDENCE', detail: ' private-finding ' }],
  dueAt: assessmentDecisionInput.dueAt,
};
const filled = {
  ...context,
  review: {
    ...context.review,
    assignment: { ...context.review.assignment, id: assessmentDecisionInput.assignmentId },
    submission: {
      ...context.review.submission,
      reference: assessmentDecisionView.decision.submissionReference,
    },
  },
  assessmentState: assessmentStateView,
  references: {
    ...context.references,
    currentOwnershipReference: assessmentDecisionInput.expectedOwnershipReference,
    currentReviewReference: assessmentDecisionInput.expectedReviewReference,
    currentAssessmentReference: assessmentDecisionInput.expectedAssessmentReference,
  },
  policy: {
    ...context.policy!,
    policy: {
      ...context.policy!.policy,
      reference: assessmentDecisionInput.expectedPolicyReference,
    },
  },
};
function setup(c: unknown = context) {
  const write = vi.fn().mockResolvedValue({ status: 503, body: {} });
  const key = vi.fn(() => 'stable-key');
  const editor = createAssessmentEditor(c as never, write, key);
  return { editor, write, key };
}
for (const kind of ['review', 'decisions'] as const) {
  const c = kind === 'review' ? context : filled,
    f = kind === 'review' ? fields : decisionFields;
  it(kind + ' binds exact observed context and normalizes editable fields', async () => {
    const { editor, write, key } = setup(c);
    await editor.save(kind, f);
    expect(write).toHaveBeenCalledTimes(1);
    const [k, input, id] = write.mock.calls[0];
    expect(k).toBe(kind);
    expect(id).toBe('stable-key');
    expect(input.expectedPolicyReference).toEqual(c.policy!.policy.reference);
    expect(input.expectedAssessmentReference).toEqual(c.references.currentAssessmentReference);
    expect(input.assignmentId).toBe(c.review.assignment.id);
    expect(input.submissionId).toBe(c.review.submission.reference.recordId);
    expect(input.reason).toBe(f.reason.trim());
    expect(key).toHaveBeenCalledTimes(1);
    expect(editor.snapshot().phase).toBe('UNCERTAIN');
  });
  it(kind + ' locks both forms while pending and retries identical key/body', async () => {
    const { editor, write, key } = setup(c);
    await editor.save(kind, f);
    const first = write.mock.calls[0];
    await editor.save(kind === 'review' ? 'decisions' : 'review', f);
    expect(write).toHaveBeenCalledTimes(1);
    await editor.retry();
    expect(write.mock.calls[1]).toEqual(first);
    expect(key).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 404])(
    kind + ' clears all private context on known denial%s',
    async (status) => {
      const { editor, write } = setup(c);
      write.mockResolvedValue({ status, body: null });
      await editor.save(kind, f);
      expect(editor.snapshot().phase).toBe('DENIED');
      expect(editor.snapshot().context).toBeNull();
    },
  );
  it.each(['REVISION_CHANGED', 'FAMILY_CHANGED', 'CURRENT_HIGHER_ASSESSMENT'])(
    kind + ' requires recheck for%s',
    async (code) => {
      const { editor, write } = setup(c);
      write.mockResolvedValue({ status: 409, body: { error: { code } } });
      await editor.save(kind, f);
      expect(editor.snapshot().phase).toBe('STALE');
      await editor.retry();
      expect(write).toHaveBeenCalledTimes(1);
    },
  );
  it(kind + ' preserves committed status when private view closes', async () => {
    const { editor, write } = setup(c);
    write.mockResolvedValue({
      status: 200,
      body: {
        version: 'v1',
        status: 'EXECUTED',
        readsAvailable: false,
        writesAvailable: false,
        unavailableReason: 'DISABLED',
        view: null,
      },
    });
    await editor.save(kind, f);
    expect(editor.snapshot().phase).toBe('SAVED');
    expect(editor.snapshot().context).toBeNull();
  });
  it(kind + ' rejects source/actor overrides before key or network', async () => {
    const { editor, write, key } = setup(c);
    await editor.save(kind, { ...f, assignmentId: crypto.randomUUID() });
    expect(write).not.toHaveBeenCalled();
    expect(key).not.toHaveBeenCalled();
  });
  it(kind + ' keeps malformed200 uncertain and collisions blocked', async () => {
    const { editor, write } = setup(c);
    write.mockResolvedValue({ status: 200, body: { version: 'v1', view: null } });
    await editor.save(kind, f);
    expect(editor.snapshot().phase).toBe('UNCERTAIN');
    write.mockResolvedValue({ status: 409, body: { error: { code: 'IDEMPOTENCY_KEY_REUSED' } } });
    await editor.retry();
    expect(editor.snapshot().phase).toBe('BLOCKED');
  });
  it(kind + ' prevents duplicate in-flight calls', async () => {
    const { editor, write } = setup(c);
    let finish!: (x: unknown) => void;
    write.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const waiting = editor.save(kind, f);
    expect(editor.snapshot().phase).toBe('BUSY');
    await editor.save(kind, f);
    await editor.retry();
    expect(write).toHaveBeenCalledTimes(1);
    finish({ status: 503, body: null });
    await waiting;
  });
}
it('prevents decision without readable current same-case state and policy/write gates', async () => {
  const { editor, write } = setup();
  await editor.save('decisions', decisionFields);
  expect(write).not.toHaveBeenCalled();
  for (const c of [
    { ...context, policy: null },
    { ...context, reviewWritesAvailable: false, decisionWritesAvailable: false },
  ]) {
    const x = setup(c);
    await x.editor.save('review', fields);
    expect(x.write).not.toHaveBeenCalled();
    expect(x.editor.snapshot().phase).toBe('READ_ONLY');
  }
});
it('returns to editing on a definite domain validation rejection', async () => {
  const { editor, write } = setup();
  write.mockResolvedValue({ status: 422, body: { error: { code: 'EVIDENCE_NOT_CONFIRMED' } } });
  await editor.save('review', fields);
  expect(editor.snapshot().phase).toBe('EDITING');
  expect(editor.snapshot().message).toContain('ownership');
});
it('keeps safe wire status for malformed auth JSON and sends exact same-origin no-store command', async () => {
  const fetch = vi.fn().mockResolvedValue({
    status: 401,
    json: async () => {
      throw Error('private');
    },
  });
  vi.stubGlobal('fetch', fetch);
  try {
    expect(
      await writeAssessment(
        'review',
        { ...fields, assignmentId: 'case', submissionId: 'item' } as never,
        'key',
      ),
    ).toEqual({ status: 401, body: null });
    expect(fetch.mock.calls[0][1]).toMatchObject({
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Idempotency-Key': 'key' },
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
it('does not trust a valid-shaped successful result for a different command', async () => {
  const { editor, write } = setup();
  write.mockResolvedValue({
    status: 200,
    body: {
      version: 'v1',
      status: 'EXECUTED',
      readsAvailable: true,
      writesAvailable: true,
      unavailableReason: null,
      view: assessmentReviewView,
    },
  });
  await editor.save('review', fields);
  expect(editor.snapshot().phase).toBe('UNCERTAIN');
});
it('recovers historical exact decision replay after uncertain outcome', async () => {
  const { editor, write } = setup(filled);
  await editor.save('decisions', decisionFields);
  write.mockResolvedValue({
    status: 200,
    body: {
      version: 'v1',
      status: 'REPLAYED',
      readsAvailable: true,
      writesAvailable: false,
      unavailableReason: 'DISABLED',
      view: {
        ...assessmentDecisionView,
        currentAssessmentReference: {
          ...assessmentDecisionView.currentAssessmentReference,
          revision: 3,
        },
        isCurrent: false,
      },
    },
  });
  await editor.retry();
  expect(editor.snapshot().phase).toBe('SAVED');
  const saved = editor.snapshot().saved;
  expect(saved?.kind).toBe('decisions');
  if (saved?.kind === 'decisions') expect(saved.view?.isCurrent).toBe(false);
});
