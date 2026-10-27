import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { SkillRankSchema } from '../contracts/entities';
import { SaveDraftInput, type SaveDraftResultSchema } from './creation-contracts';
import { WorkClientError, describeWorkFailure } from '../work-http/workspace-client';

const text = z.string().max(20000);
const day = z.number().int().min(0).max(3650);
/** An incomplete form is allowed; malformed nested values and unbounded stored data are not. */
export const WizardFormSchema = z.strictObject({
  title: text,
  publicSummary: text,
  category: text,
  outcome: text,
  deliverables: text,
  acceptanceCriteria: text,
  exclusions: text,
  dependencies: text,
  difficulty: SkillRankSchema,
  skills: z
    .array(
      z.strictObject({
        skillId: text,
        minimumRank: SkillRankSchema,
        assessmentPolicyVersion: text,
      }),
    )
    .max(20),
  admission: z.enum(['INSTANT', 'APPLICATION']),
  visibility: z.enum(['PUBLIC', 'TRUSTED_LISTING', 'CONFIDENTIAL_LISTING', 'INVITE_ONLY']),
  rewards: z.array(z.strictObject({ assetKey: text, amount: text })).max(10),
  reviewerAccountId: text,
  reviewEvidence: text,
  maxRevisionRounds: z.number().int().min(0).max(100),
  days: z.strictObject({
    commitment: day,
    preparation: day,
    submission: day,
    review: day,
    operationalClosure: day,
  }),
  allowedToolsPolicy: text,
  startCondition: text,
  rightsPolicy: text,
  portfolioPolicy: text,
  withdrawalPolicy: text,
  terminationPolicy: text,
  disputePolicy: text,
  finalityPolicy: text,
  fundingSourceRef: text,
});
const Binding = z.strictObject({
  listingId: z.uuid(),
  termsVersionId: z.uuid(),
  revision: z.number().int().min(1).max(2147483646),
});
const Recovery = z.strictObject({
  version: z.literal('v1'),
  accountId: InternalId,
  form: WizardFormSchema,
  binding: Binding.nullable(),
  pending: z
    .strictObject({ input: SaveDraftInput, key: z.uuid(), fingerprint: z.string().max(400000) })
    .nullable(),
});
export type WizardRecovery = z.infer<typeof Recovery>;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
const PREFIX = 'raid-wizard-recovery-v1:';
const keyFor = (accountId: string) => PREFIX + encodeURIComponent(InternalId.parse(accountId));
export function readWizardRecovery(store: Store, accountId: string): WizardRecovery | null {
  // Never import an earlier account's unscoped private text.
  store.removeItem('raid-wizard-form-v1');
  const key = keyFor(accountId),
    raw = store.getItem(key);
  try {
    const parsed = raw && raw.length <= 500000 ? Recovery.safeParse(JSON.parse(raw)) : null;
    if (parsed?.success && parsed.data.accountId === accountId) return parsed.data;
  } catch {}
  if (raw !== null) store.removeItem(key);
  return null;
}
export function writeWizardRecovery(store: Store, value: WizardRecovery) {
  const checked = Recovery.parse(value);
  const raw = JSON.stringify(checked);
  if (raw.length > 500000) throw new Error('Draft recovery is too large.');
  store.setItem(keyFor(checked.accountId), raw);
}
export function clearWizardRecovery(store: Store, accountId?: string) {
  store.removeItem('raid-wizard-form-v1');
  if (accountId) {
    store.removeItem(keyFor(accountId));
    return;
  }
  // Successful sign-out clears this feature's private recovery only.
  for (let i = store.length - 1; i >= 0; i--) {
    const key = store.key(i);
    if (key?.startsWith(PREFIX)) store.removeItem(key);
  }
}
/** Persist exact intent before transport. Resolve a pending first save before addressing edited intent. */
export async function saveWizardIntent(options: {
  recovery: WizardRecovery;
  input: z.input<typeof SaveDraftInput>;
  fingerprint: string;
  key: string;
  save: (
    input: z.input<typeof SaveDraftInput>,
    key: string,
  ) => Promise<z.output<typeof SaveDraftResultSchema>>;
  persist: (value: WizardRecovery) => void;
}) {
  let current = options.recovery;
  async function send(
    pending: NonNullable<WizardRecovery['pending']>,
    previouslyUnconfirmed = false,
  ) {
    current = { ...current, pending };
    options.persist(current); // Fail before sending if durable recovery cannot be written.
    let result: z.output<typeof SaveDraftResultSchema>;
    try {
      result = await options.save(pending.input, pending.key);
    } catch (error) {
      if (
        !previouslyUnconfirmed &&
        describeWorkFailure(error).kind !== 'RETRY_SAME_REQUEST' &&
        !(
          error instanceof WorkClientError &&
          (error.status === null ||
            error.status >= 500 ||
            (error.code === 'CONTRACT' && error.status >= 200 && error.status < 300))
        )
      ) {
        current = { ...current, pending: null };
        options.persist(current);
      }
      throw error;
    }
    current = {
      ...current,
      pending: null,
      binding: {
        listingId: result.draft.listingId,
        termsVersionId: result.draft.termsVersionId,
        revision: result.draft.revision,
      },
    };
    options.persist(current);
    return result;
  }
  const pending = current.pending;
  if (pending) {
    // Rejection of a retry says nothing about whether the original request committed.
    const result = await send(pending, true);
    if (pending.fingerprint === options.fingerprint) return result;
  }
  const input = {
    ...options.input,
    listingId: current.binding?.listingId ?? options.input.listingId,
    expectedRevision: current.binding?.revision ?? options.input.expectedRevision,
  };
  return send({
    input: SaveDraftInput.parse(input),
    key: options.key,
    fingerprint: options.fingerprint,
  });
}
