import { z } from 'zod';
import { InternalId, ParticipantId, UtcTimestamp } from '../contracts/ids';
import { SkillVersionReferenceSchema } from './contracts';
import {
  PracticeTrialDefinitionSchema,
  type PracticeTrialDefinition,
} from './practice-trial-contracts';
import { PracticePortalCatalogSchema } from './practice-portal-contracts';
export { PracticePortalCatalogSchema };
export type PracticePortalCatalog = z.output<typeof PracticePortalCatalogSchema>;

/**
 * Portable browser-side view of the protected practice-portal HTTP boundary. These mirror the
 * server's strict response schemas without importing its Node-only storage modules; a parity test
 * checks both parse the same records. Practice never verifies a skill, grants access, takes
 * capacity or creates a financial obligation, and each flag below must stay literally false.
 */
const Reference = SkillVersionReferenceSchema.unwrap()
  .extend({ revision: z.number().int().min(1).max(2147483647) })
  .readonly();
const unsupported = (value: string) =>
  /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
// Code and prose bytes remain exact; trim is used solely to reject invisible empty input.
const Text = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0)
    .refine((value) => !unsupported(value));
const Tools = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !unsupported(value)),
  )
  .max(50)
  .refine((items) => new Set(items).size === items.length)
  .readonly();
const Inert = {
  persisted: z.literal(true),
  verifiesSkill: z.literal(false),
  isAuthorizationToken: z.literal(false),
  createsPermissionGrant: z.literal(false),
  consumesCapacity: z.literal(false),
  createsFinancialObligation: z.literal(false),
};
export const PracticePortalStartRecordSchema = z
  .strictObject({
    version: z.literal('v1'),
    id: z.uuid(),
    state: z.literal('STARTED'),
    participantId: ParticipantId,
    definition: PracticeTrialDefinitionSchema,
    taxonomyReference: Reference,
    accommodationReference: z.null(),
    attemptNumber: z.number().int().min(1).max(10000),
    startedAt: UtcTimestamp,
    ...Inert,
  })
  .readonly();
export const PracticePortalSubmissionRecordSchema = z
  .strictObject({
    version: z.literal('v1'),
    reference: Reference.unwrap()
      .extend({ revision: z.literal(1) })
      .readonly(),
    startId: z.uuid(),
    participantId: ParticipantId,
    skillId: InternalId,
    skillDomain: InternalId,
    definitionReference: Reference,
    rubricReference: Reference,
    state: z.literal('SUBMITTED'),
    submittedAt: UtcTimestamp,
    answer: Text(40000),
    explanation: Text(4000),
    toolsUsed: Tools,
    aiAssistanceUsed: z.boolean(),
    assistanceDisclosure: Text(4000),
    ownership: z.literal('UNCONFIRMED'),
    ...Inert,
  })
  .readonly();
export type PracticePortalStartRecord = z.output<typeof PracticePortalStartRecordSchema>;
export type PracticePortalSubmissionRecord = z.output<typeof PracticePortalSubmissionRecordSchema>;
const config = {
  version: z.literal('v1'),
  status: z.enum(['EXECUTED', 'REPLAYED']),
  writesAvailable: z.boolean(),
  unavailableReason: z.enum(['DISABLED']).nullable(),
};
export const PracticePortalStartResultSchema = z
  .strictObject({ ...config, start: PracticePortalStartRecordSchema })
  .refine((v) => v.writesAvailable === (v.unavailableReason === null))
  .readonly();
export const PracticePortalSubmitResultSchema = z
  .strictObject({ ...config, submission: PracticePortalSubmissionRecordSchema })
  .refine((v) => v.writesAvailable === (v.unavailableReason === null))
  .readonly();
function same(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
              .map(([k, x]) => [k, canon(x)]),
          )
        : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}
export const PracticePortalProgressSchema = z
  .strictObject({
    version: z.literal('v1'),
    progress: z.enum(['STARTED', 'SUBMITTED']),
    start: PracticePortalStartRecordSchema,
    submission: PracticePortalSubmissionRecordSchema.nullable(),
  })
  .superRefine((v, ctx) => {
    const s = v.submission,
      a = v.start;
    if (
      (v.progress === 'SUBMITTED') !== (s !== null) ||
      (s &&
        (s.startId !== a.id ||
          s.participantId !== a.participantId ||
          s.skillId !== a.definition.skillId ||
          s.skillDomain !== a.definition.skillDomain ||
          !same(s.definitionReference, a.definition.reference) ||
          !same(s.rubricReference, a.definition.rubric.reference) ||
          Date.parse(s.submittedAt) < Date.parse(a.startedAt)))
    )
      ctx.addIssue({ code: 'custom', message: 'Incoherent original source.' });
  })
  .readonly();
export type PracticePortalProgress = z.output<typeof PracticePortalProgressSchema>;

export const PracticePortalSubmitInputSchema = z
  .strictObject({
    version: z.literal('v1'),
    startId: z.uuid(),
    expectedDefinitionReference: Reference,
    expectedRubricReference: Reference,
    answer: Text(40000),
    explanation: Text(4000),
    toolsUsed: Tools,
    aiAssistanceUsed: z.boolean(),
    assistanceDisclosure: Text(4000),
  })
  .readonly();
export type PracticePortalSubmitInput = z.output<typeof PracticePortalSubmitInputSchema>;

/** One tool per line: trimmed, blanks dropped, later duplicates ignored. */
export function parseToolLines(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}
export interface SubmitFormValues {
  readonly startId: string;
  readonly definition: PracticeTrialDefinition;
  readonly answer: string;
  readonly explanation: string;
  readonly toolsText: string;
  readonly aiAssistanceUsed: boolean;
  readonly assistanceDisclosure: string;
}
export type BuiltInput =
  | { readonly ok: true; readonly value: PracticePortalSubmitInput }
  | { readonly ok: false; readonly message: string };
/** Binds the exact original definition/rubric and keeps answer bytes unchanged. */
export function buildSubmitInput(values: SubmitFormValues): BuiltInput {
  const { definition } = values;
  if (values.aiAssistanceUsed && definition.tools.aiAssistance === 'PROHIBITED')
    return { ok: false, message: 'AI assistance is prohibited for this practice trial.' };
  const parsed = PracticePortalSubmitInputSchema.safeParse({
    version: 'v1',
    startId: values.startId,
    expectedDefinitionReference: definition.reference,
    expectedRubricReference: definition.rubric.reference,
    answer: values.answer,
    explanation: values.explanation,
    toolsUsed: parseToolLines(values.toolsText),
    aiAssistanceUsed: values.aiAssistanceUsed,
    assistanceDisclosure: values.assistanceDisclosure,
  });
  if (!parsed.success)
    return {
      ok: false,
      message:
        'Check the form: answer (up to 40,000 characters), explanation and assistance disclosure ' +
        '(up to 4,000 each) are required, and at most 50 distinct tools may be listed.',
    };
  return { ok: true, value: parsed.data };
}

const failures: Record<string, string> = {
  AUTHENTICATION_REQUIRED: 'Sign in to continue.',
  ACCOUNT_RESTRICTED: 'Practice is unavailable for your account.',
  FORBIDDEN: 'Practice is unavailable for your account.',
  NOT_FOUND: 'This practice trial is no longer available.',
  INVALID_COMMAND: 'The request was not accepted. Check your input and try again.',
  PRACTICE_ATTEMPT_LIMIT_REACHED: 'The published attempt limit for this trial has been reached.',
  PRACTICE_COOLDOWN_ACTIVE: 'The published retry waiting period for this trial is still active.',
  PRACTICE_ALREADY_SUBMITTED: 'This attempt was already submitted.',
  PRACTICE_ACCOMMODATION_UNAVAILABLE: 'The requested accommodation is unavailable.',
  REVISION_CHANGED: 'The trial definition changed. Reload to review the current terms.',
  IDEMPOTENCY_KEY_REUSED: 'This request conflicts with an earlier one. Refresh and try again.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  SERVICE_UNAVAILABLE: 'Practice is currently unavailable. Try again later.',
};
/** Safe user text from a canonical error code; unknown codes never surface server detail. */
export function describePracticeFailure(status: number, code: unknown): string {
  void status;
  return (typeof code === 'string' && failures[code]) || failures.SERVICE_UNAVAILABLE!;
}

export type PracticePortalReference = z.output<typeof Reference>;
export interface PracticePortalTransport {
  list(after: string | null): Promise<Response>;
  start(definitionReference: PracticePortalReference, key: string): Promise<Response>;
  read(startId: string): Promise<Response>;
  submit(startId: string, input: PracticePortalSubmitInput, key: string): Promise<Response>;
}
/** Default same-origin transport. Hosts may inject another that preserves these semantics. */
export function createPracticePortalTransport(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): PracticePortalTransport {
  const get = { method: 'GET', credentials: 'same-origin', cache: 'no-store' } as const;
  const post = (body: unknown, key: string): RequestInit => ({
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': InternalId.parse(key) },
    body: JSON.stringify(body),
  });
  return {
    list(after) {
      const cursor = after === null ? null : InternalId.parse(after);
      return fetchImpl(
        '/api/v1/practice' + (cursor === null ? '' : '?after=' + encodeURIComponent(cursor)),
        { ...get, headers: { Accept: 'application/json' } },
      );
    },
    start(definitionReference, key) {
      return fetchImpl(
        '/api/v1/practice/starts',
        post(
          {
            version: 'v1',
            definitionReference: Reference.parse(definitionReference),
            accommodationReference: null,
          },
          key,
        ),
      );
    },
    read(startId) {
      return fetchImpl('/api/v1/practice/starts/' + z.uuid().parse(startId), {
        ...get,
        headers: { Accept: 'application/json' },
      });
    },
    submit(startId, input, key) {
      return fetchImpl(
        '/api/v1/practice/starts/' + z.uuid().parse(startId) + '/submission',
        post(input, key),
      );
    },
  };
}
