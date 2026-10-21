import { z } from 'zod';
import {
  PracticeTrialOwnershipViewSchema,
  RecordPracticeTrialOwnershipInputSchema,
} from './practice-trial-ownership-contracts';
export const PracticeOwnershipHttpReadResultSchema = z
  .strictObject({
    version: z.literal('v1'),
    readsAvailable: z.boolean(),
    unavailableReason: z.literal('DISABLED').nullable(),
    view: PracticeTrialOwnershipViewSchema.nullable(),
  })
  .refine(
    (r) =>
      r.readsAvailable === (r.unavailableReason === null) && (r.readsAvailable || r.view === null),
  );
export const PracticeOwnershipHttpWriteResultSchema = z
  .strictObject({
    version: z.literal('v1'),
    status: z.enum(['EXECUTED', 'REPLAYED']),
    readsAvailable: z.boolean(),
    writesAvailable: z.boolean(),
    unavailableReason: z.literal('DISABLED').nullable(),
    view: PracticeTrialOwnershipViewSchema.nullable(),
  })
  .refine(
    (r) =>
      r.writesAvailable === (r.unavailableReason === null) &&
      r.readsAvailable === (r.view !== null),
  );
export function parseOwnershipWriteResult(
  value: unknown,
  input: z.output<typeof RecordPracticeTrialOwnershipInputSchema>,
  accountId: string,
) {
  const result = PracticeOwnershipHttpWriteResultSchema.parse(value);
  const v = result.view;
  if (v) {
    const r = v.record;
    const same = (
      a: { recordId: string; revision: number },
      b: { recordId: string; revision: number },
    ) => a.recordId === b.recordId && a.revision === b.revision;
    if (
      r.assignmentId !== input.assignmentId ||
      r.evaluatorAccountId !== accountId ||
      r.reference.recordId !== input.submissionId ||
      r.reference.revision !== (input.expectedOwnershipReference?.revision ?? 0) + 1 ||
      !same(r.submissionReference, input.expectedSubmissionReference) ||
      !same(r.definitionReference, input.expectedDefinitionReference) ||
      !same(r.rubricReference, input.expectedRubricReference) ||
      !same(r.policyReference, input.expectedPolicyReference) ||
      r.decision !== input.decision ||
      r.reason !== input.reason ||
      JSON.stringify(r.observations) !== JSON.stringify(input.observations) ||
      (result.status === 'EXECUTED' && !v.isCurrent)
    )
      throw new Error('INVALID_RESULT');
  }
  return result;
}
