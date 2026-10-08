import { UtcTimestamp } from '../contracts';
import {
  AccountRemovalPreflightSchema, IdentityLinkPolicySchema, IdentitySubjectSchema,
  VerifiedLinkPreflightSchema, type IdentityLinkProposal,
  type IdentityPreflightBlocked, type IdentityPreflightReason,
} from './contracts';

function blocked(code: IdentityPreflightReason): IdentityPreflightBlocked {
  return Object.freeze({ stage: 'BLOCKED', code });
}
/** Exact immutable subject key. Adapter instance/display name are not identity. */
export function identitySubjectKey(input: unknown): string {
  const subject = IdentitySubjectSchema.parse(input);
  return JSON.stringify(subject.kind === 'WALLET'
    ? ['WALLET', 'SOLANA', subject.networkIdentity, subject.address]
    : ['PROVIDER', subject.provider, subject.subject]);
}
/** Pure proposal only. Host must revalidate and consume proof atomically at commit. */
export function inspectVerifiedLink(
  input: unknown, configuredPolicy: unknown, clock: unknown,
): IdentityLinkProposal | IdentityPreflightBlocked {
  const command = VerifiedLinkPreflightSchema.safeParse(input);
  const policy = IdentityLinkPolicySchema.safeParse(configuredPolicy);
  const time = UtcTimestamp.safeParse(clock);
  if (!command.success || !policy.success || !time.success) return blocked('INVALID_COMMAND');
  const { actorAccountId, expectedRevision, subject, snapshot, session, ownership, proof } = command.data;
  const now = Date.parse(time.data);
  const accountId = snapshot.participant.accountId;
  if (session.state !== 'ACTIVE' || Date.parse(session.expiresAt) <= now)
    return blocked('AUTHENTICATION_REQUIRED');
  if (session.accountId !== actorAccountId || actorAccountId !== accountId)
    return blocked('FORBIDDEN');
  if (snapshot.status !== 'ACTIVE') return blocked('ACCOUNT_RESTRICTED');
  if (expectedRevision !== snapshot.revision) return blocked('REVISION_CHANGED');
  const subjectKey = identitySubjectKey(subject);
  if (proof.state !== 'VERIFIED' || proof.consumed || proof.intent !== 'LINK'
    || proof.accountId !== accountId || identitySubjectKey(proof.subject) !== subjectKey
    || proof.domain !== policy.data.domain || proof.uri !== policy.data.uri
    || Date.parse(proof.issuedAt) > now || Date.parse(proof.expiresAt) <= now)
    return blocked('PROOF_INVALID');
  const supported = subject.kind === 'WALLET'
    ? policy.data.walletNetworks.includes(subject.networkIdentity)
    : policy.data.providers.includes(subject.provider);
  if (!supported) return blocked('UNSUPPORTED_IDENTITY');
  if (ownership.state === 'UNKNOWN') return blocked('OWNERSHIP_UNKNOWN');
  if (ownership.state === 'LINKED' || ownership.state === 'REVOKED') {
    if (ownership.accountId !== accountId) return blocked('IDENTITY_CONFLICT');
    if (ownership.state === 'REVOKED') return blocked('IDENTITY_REVOKED');
  }
  return Object.freeze({
    stage: 'READY_FOR_TRANSACTION', accountId, participantId: snapshot.participant.id,
    expectedRevision, subjectKey, proofRef: proof.ref,
    activeEngagementId: snapshot.activeEngagementId,
  });
}
/** Conservative retained-rights guard. No path authorizes merge or deletion. */
export function inspectAccountRemoval(input: unknown): IdentityPreflightBlocked {
  const parsed = AccountRemovalPreflightSchema.safeParse(input);
  if (!parsed.success) return blocked('INVALID_COMMAND');
  const command = parsed.data;
  const { drop, inventory } = command;
  if (command.kind === 'MERGE') {
    const { keep } = command;
    if (keep.participant.accountId === drop.participant.accountId
      || keep.participant.id === drop.participant.id) return blocked('INVALID_COMMAND');
    if (keep.activeEngagementId && drop.activeEngagementId) return blocked('CAPACITY_CONFLICT');
  }
  if (inventory.state !== 'COMPLETE' || inventory.accountId !== drop.participant.accountId
    || inventory.participantId !== drop.participant.id || inventory.revision !== drop.revision)
    return blocked('INVENTORY_UNKNOWN');
  if (drop.activeEngagementId || inventory.references.length) return blocked('RIGHTS_RETAINED');
  return blocked('SCOPED_REVIEW_REQUIRED');
}
