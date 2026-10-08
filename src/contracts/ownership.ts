import { z } from 'zod';
import { InternalId } from './ids';

export type DomainOwner =
  'identity' | 'guilds' | 'work' | 'challenges' | 'treasury' | 'disputes' | 'access' | 'execution';
type CommandContract = {
  owner: DomainOwner;
  authority: readonly string[];
  guards: readonly string[];
  reference: string;
};
/** Declarations only. No command executes or grants authority through this registry. */
export const COMMANDS = {
  LinkWallet: {
    owner: 'identity',
    authority: ['Authenticated account; verified control and explicit link intent'],
    guards: ['One-use proof; unique subject; preserve canonical participant/history/claims'],
    reference: '07.1–2',
  },
  ManageGuild: {
    owner: 'guilds',
    authority: ['Verified Founder or delegated Guild field permission'],
    guards: ['Current revision; holder status supplies no administration'],
    reference: '06.1–2',
  },
  PublishRaid: {
    owner: 'work',
    authority: ['Guild creation/publication permission'],
    guards: ['Complete current terms; full verified funding; visibility/admission policy'],
    reference: '11,26.2',
  },
  ChangeListingAvailability: {
    owner: 'work',
    authority: ['Guild listing permission'],
    guards: ['Current revision; preserve active engagements and obligations'],
    reference: '25.7',
  },
  ManageApplication: {
    owner: 'work',
    authority: ['Own applicant or scoped Guild selection authority'],
    guards: ['Current target/terms; no capacity reservation; retain history'],
    reference: '13.1,26.2',
  },
  ManageOffer: {
    owner: 'work',
    authority: ['Guild offer authority; recipient decides decline'],
    guards: ['Current vacancy/terms; finite expiry; offer alone consumes no capacity'],
    reference: '13.1,26.2',
  },
  CommitEngagement: {
    owner: 'work',
    authority: ['Authenticated canonical participants with individual acceptance consent'],
    guards: [
      'Receipt digest; source vacancy; current terms/funding; eligibility/restrictions; atomic operator and participant capacity',
    ],
    reference: '13.3–4',
  },
  StartEngagement: {
    owner: 'work',
    authority: ['Authorized work actor or current scoped preparation handler'],
    guards: [
      'ACCESS_PENDING; current generation/terms; finalized paid binding; required resources ready',
    ],
    reference: '13.3,13.5',
  },
  SubmitWork: {
    owner: 'work',
    authority: ['Assigned consenting participant'],
    guards: ['Accepted terms; active submission duty; immutable submission version'],
    reference: '12,26.2',
  },
  ReviewSubmission: {
    owner: 'work',
    authority: ['Assigned independent reviewer; no self-review'],
    guards: ['Exact terms/submission; bounded duty; no direct payment'],
    reference: '12,17,26.2',
  },
  CloseEngagement: {
    owner: 'work',
    authority: ['Authorized work actor or versioned deadline/recovery handler'],
    guards: [
      'Atomic terminal outcome and engagement-matched capacity release; retain money/case/access incidents; silence decides no fault',
    ],
    reference: '13.5',
  },
  AmendAcceptedTerms: {
    owner: 'work',
    authority: ['All affected consenting parties and scoped proposal authority'],
    guards: [
      'New immutable version; prior terms survive; required additional funding; audited roster/split/beneficiary change',
    ],
    reference: '29.2,35.AC72',
  },
  ReplaceEngagementMember: {
    owner: 'work',
    authority: ['Affected consenting participants and assignment authority'],
    guards: [
      'Global lock order; current restrictions/capacity; new roster/terms; preserve old claims',
    ],
    reference: '13.3,35.AC25',
  },
  ManageChallenge: {
    owner: 'challenges',
    authority: ['Guild challenge authority and independent judges'],
    guards: [
      'Frozen mode/rubric; funded maximum liability; bounded duties/rights; no own submission judging',
    ],
    reference: '15',
  },
  HandoffChallenge: {
    owner: 'work',
    authority: ['Main-work participants explicitly accepting; coordinated Challenge command'],
    guards: [
      'Atomic source/target capacity transfer; separately funded target; source compensation preserved; failed preparation closes unstarted target',
    ],
    reference: '13.5,15,35.AC55–56',
  },
  ReconcileFunding: {
    owner: 'treasury',
    authority: ['Scoped pinned-operation verifier'],
    guards: [
      'Actual asset/vault/net effect/finality; semantic dedupe; signature submission is not credit',
    ],
    reference: '16.11',
  },
  BindEscrow: {
    owner: 'treasury',
    authority: ['Selected escrow binding authority under accepted terms'],
    guards: [
      'Pinned operation/asset/terms/beneficiaries; finalized binding; refund race; late-binding incident',
    ],
    reference: '16.6–8',
  },
  AllocateSettlement: {
    owner: 'treasury',
    authority: ['Declared accepted settlement/finality authority'],
    guards: [
      'Verified funds/protected reserves; authorized decision/beneficiaries; per-asset conservation',
    ],
    reference: '16.6–10,17',
  },
  ClaimAsset: {
    owner: 'treasury',
    authority: ['Permitted beneficiary under allocation/finality policy'],
    guards: [
      'Semantic single-use claim; current hold/appeal; finalized effect; reconcile unknown before retry',
    ],
    reference: '16.9–12,17',
  },
  RefundAsset: {
    owner: 'treasury',
    authority: ['Permitted uncommitted funder or authorized allocated-refund beneficiary'],
    guards: [
      'No protected reward withdrawal; binding/hold race; exact asset conservation; semantic receipt',
    ],
    reference: '16.6–10',
  },
  ReconcileTransaction: {
    owner: 'treasury',
    authority: ['Scoped pinned-operation verifier'],
    guards: [
      'Actual effect/finality; preserve semantic ID/attempts; unknown success lookup before retry',
    ],
    reference: '16.11–12,27',
  },
  DecideDispute: {
    owner: 'disputes',
    authority: ['Declared independent case authority under snapshotted policy'],
    guards: [
      'Evidence/version; permitted appeal/hold/finality; no arbitrary confiscation; history-preserving correction',
    ],
    reference: '17,28.4',
  },
  ManageAccessGrant: {
    owner: 'access',
    authority: ['Explicit resource grantor; provider worker on current scoped intent'],
    guards: [
      'Resource/purpose/scope/expiry; desired generation versus observed rights; independent rights preserved; stale-success compensation',
    ],
    reference: '10,13.5',
  },
  ManageAgentRun: {
    owner: 'execution',
    authority: ['Authorized operator within participant/tool policy'],
    guards: [
      'Work/operator capacity; scoped resources; total retry/subagent budget; cancellation/reconciliation; no self-approval or withdrawal',
    ],
    reference: '19',
  },
} as const satisfies Record<string, CommandContract>;

export const STATE_OWNERS = {
  listing: { owner: 'work', commands: ['PublishRaid', 'ChangeListingAvailability'] },
  slot: {
    owner: 'work',
    commands: ['CommitEngagement', 'CloseEngagement', 'ReplaceEngagementMember'],
  },
  application: { owner: 'work', commands: ['ManageApplication', 'ManageOffer'] },
  offer: { owner: 'work', commands: ['ManageOffer', 'CommitEngagement'] },
  engagement: {
    owner: 'work',
    commands: [
      'CommitEngagement',
      'StartEngagement',
      'SubmitWork',
      'ReviewSubmission',
      'CloseEngagement',
      'ReplaceEngagementMember',
      'HandoffChallenge',
    ],
  },
  challenge: { owner: 'challenges', commands: ['ManageChallenge'] },
  agreement: {
    owner: 'treasury',
    commands: ['BindEscrow', 'AllocateSettlement', 'ClaimAsset', 'RefundAsset'],
  },
  funding: { owner: 'treasury', commands: ['ReconcileFunding'] },
  claim: { owner: 'treasury', commands: ['AllocateSettlement', 'ClaimAsset'] },
  transaction: { owner: 'treasury', commands: ['ReconcileTransaction'] },
  dispute: { owner: 'disputes', commands: ['DecideDispute'] },
  access: { owner: 'access', commands: ['ManageAccessGrant'] },
  run: { owner: 'execution', commands: ['ManageAgentRun'] },
} as const satisfies Record<
  string,
  { owner: DomainOwner; commands: readonly (keyof typeof COMMANDS)[] }
>;

const LockPlanInput = z.strictObject({
  receiptKey: InternalId,
  admissionIds: z.array(InternalId),
  sourceIds: z.array(InternalId),
  termsIds: z.array(InternalId),
  operatorIds: z.array(InternalId),
  participantIds: z.array(InternalId),
});
export type CapacityLockInput = z.input<typeof LockPlanInput>;
export type CapacityLock = {
  kind: 'receipt' | 'admission' | 'source' | 'terms' | 'operator' | 'participant';
  id: string;
};
/** Pure plan, not locks: host executes every group in ONE database transaction. */
export function planCapacityLocks(input: CapacityLockInput): CapacityLock[] {
  const value = LockPlanInput.parse(input);
  const plan: CapacityLock[] = [{ kind: 'receipt', id: value.receiptKey }];
  for (const [kind, ids] of [
    ['admission', value.admissionIds],
    ['source', value.sourceIds],
    ['terms', value.termsIds],
    ['operator', value.operatorIds],
    ['participant', value.participantIds],
  ] as const)
    for (const id of [...new Set(ids)].sort()) plan.push({ kind, id });
  return plan;
}
