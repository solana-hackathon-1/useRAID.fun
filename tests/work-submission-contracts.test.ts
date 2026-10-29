import { describe, expect, it } from 'vitest';
import { DecideReviewInput, SubmitWorkInput } from '../src/work-loop/submission-contracts';

const submission = (overrides: Record<string, unknown> = {}) => ({
  engagementId: '3f1c5a52-5b0c-4d52-9a35-0d6a8e0d6f11',
  expectedSubmissionNumber: 1,
  explanation: 'Guide written and verified.',
  artifacts: [
    { kind: 'COMMIT', ref: 'synthetic://repo/setup.md', immutableVersion: 'a'.repeat(40) },
  ],
  dependencies: ['Public synthetic repository'],
  aiUsage: null,
  ...overrides,
});
const review = (overrides: Record<string, unknown> = {}) => ({
  submissionId: '3f1c5a52-5b0c-4d52-9a35-0d6a8e0d6f12',
  decision: 'ACCEPT',
  reason: 'Reviewed against the accepted criteria.',
  criteria: [{ index: 0, result: 'MET', evidence: 'Installation output attached.' }],
  revisionDeadline: null,
  ...overrides,
});
// jsonb cannot store U+0000 (22P05) or a lone surrogate (22P02): refuse them as input, not as a raw database error.
const unstorable = [
  ['U+0000', 'before\u0000after'],
  ['a lone high surrogate', 'before\ud800after'],
  ['a lone low surrogate', 'before\udc00after'],
];

describe('submission and review text must be storable', () => {
  it('accepts well-formed text, including characters outside the BMP', () => {
    expect(
      SubmitWorkInput.safeParse(submission({ explanation: 'Done \u{1f680} ok' })).success,
    ).toBe(true);
    expect(DecideReviewInput.safeParse(review()).success).toBe(true);
  });
  describe.each(unstorable)('%s', (_name, bad) => {
    const artifact = { kind: 'COMMIT', ref: 'synthetic://repo/setup.md', immutableVersion: 'v1' };
    it.each([
      ['explanation', submission({ explanation: bad })],
      ['artifact ref', submission({ artifacts: [{ ...artifact, ref: bad }] })],
      [
        'artifact immutableVersion',
        submission({ artifacts: [{ ...artifact, immutableVersion: bad }] }),
      ],
      ['dependency', submission({ dependencies: [bad] })],
      ['aiUsage', submission({ aiUsage: bad })],
    ])('refuses it in submit %s', (_field, input) => {
      expect(SubmitWorkInput.safeParse(input).success).toBe(false);
    });
    it.each([
      ['reason', review({ reason: bad })],
      ['criterion evidence', review({ criteria: [{ index: 0, result: 'MET', evidence: bad }] })],
    ])('refuses it in review %s', (_field, input) => {
      expect(DecideReviewInput.safeParse(input).success).toBe(false);
    });
  });
});
