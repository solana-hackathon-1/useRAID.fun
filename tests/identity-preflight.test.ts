import { describe, expect, it } from 'vitest';
import { identitySubjectKey, inspectAccountRemoval, inspectVerifiedLink } from '../src/identity';

const now = '2026-10-08T12:00:00Z';
const policy = {
  domain: 'identity.test',
  uri: 'https://identity.test',
  walletNetworks: ['synthetic-solana'],
  providers: ['synthetic-provider'],
};
function snapshot(accountId = 'synthetic-account', participantId = 'synthetic-participant') {
  return {
    participant: { id: participantId, kind: 'HUMAN' as const, accountId },
    revision: 3,
    status: 'ACTIVE',
    activeEngagementId: 'synthetic-engagement',
  };
}
function link() {
  const subject = {
    kind: 'WALLET',
    networkIdentity: 'synthetic-solana',
    address: '11111111111111111111111111111111',
  };
  return {
    actorAccountId: 'synthetic-account',
    expectedRevision: 3,
    subject,
    snapshot: snapshot(),
    session: {
      accountId: 'synthetic-account',
      state: 'ACTIVE',
      expiresAt: '2026-10-08T13:00:00Z',
    },
    ownership: { state: 'UNCLAIMED', subject: structuredClone(subject) },
    proof: {
      ref: 'synthetic-proof',
      state: 'VERIFIED',
      accountId: 'synthetic-account',
      intent: 'LINK',
      subject: structuredClone(subject),
      domain: policy.domain,
      uri: policy.uri,
      issuedAt: '2026-10-08T11:59:00Z',
      expiresAt: '2026-10-08T12:01:00Z',
      consumed: false,
    },
  };
}

describe('T006 verified-link preflight (trusted synthetic observations only)', () => {
  it('retains the busy participant without changing history, terms, claims or payout authority', () => {
    const command = link();
    const retained = {
      terms: { id: 'synthetic-terms', beneficiary: 'old-wallet', amount: '123456789' },
      skillHistory: ['synthetic-assessment'],
      pendingClaims: ['synthetic-claim'],
      activeCommitment: 'synthetic-engagement',
    };
    const before = JSON.stringify({ command, retained });
    expect(inspectVerifiedLink(command, policy, now)).toEqual({
      stage: 'READY_FOR_TRANSACTION',
      accountId: 'synthetic-account',
      participantId: 'synthetic-participant',
      expectedRevision: 3,
      subjectKey: '["WALLET","SOLANA","synthetic-solana","11111111111111111111111111111111"]',
      proofRef: 'synthetic-proof',
      activeEngagementId: 'synthetic-engagement',
    });
    expect(JSON.stringify({ command, retained })).toBe(before);
  });

  const denied: [string, (c: ReturnType<typeof link>) => void, string][] = [
    ['missing session', (c) => Reflect.deleteProperty(c, 'session'), 'INVALID_COMMAND'],
    [
      'revoked session',
      (c) => {
        c.session.state = 'REVOKED';
      },
      'AUTHENTICATION_REQUIRED',
    ],
    [
      'expired session at boundary',
      (c) => {
        c.session.expiresAt = now;
      },
      'AUTHENTICATION_REQUIRED',
    ],
    [
      'another session account',
      (c) => {
        c.session.accountId = 'other';
      },
      'FORBIDDEN',
    ],
    [
      'another actor',
      (c) => {
        c.actorAccountId = 'other';
      },
      'FORBIDDEN',
    ],
    [
      'restricted account',
      (c) => {
        c.snapshot.status = 'RESTRICTED';
      },
      'ACCOUNT_RESTRICTED',
    ],
    [
      'stale revision',
      (c) => {
        c.expectedRevision = 2;
      },
      'REVISION_CHANGED',
    ],
    [
      'unknown ownership',
      (c) => {
        c.ownership.state = 'UNKNOWN';
      },
      'OWNERSHIP_UNKNOWN',
    ],
    [
      'unverified proof',
      (c) => {
        c.proof.state = 'UNVERIFIED';
      },
      'PROOF_INVALID',
    ],
    [
      'revoked proof',
      (c) => {
        c.proof.state = 'REVOKED';
      },
      'PROOF_INVALID',
    ],
    [
      'consumed proof',
      (c) => {
        c.proof.consumed = true;
      },
      'PROOF_INVALID',
    ],
    [
      'wrong proof account',
      (c) => {
        c.proof.accountId = 'other';
      },
      'PROOF_INVALID',
    ],
    [
      'signin intent',
      (c) => {
        c.proof.intent = 'SIGNIN';
      },
      'PROOF_INVALID',
    ],
    [
      'rotate intent',
      (c) => {
        c.proof.intent = 'ROTATE';
      },
      'PROOF_INVALID',
    ],
    [
      'expired proof at boundary',
      (c) => {
        c.proof.expiresAt = now;
      },
      'PROOF_INVALID',
    ],
    [
      'future-issued proof',
      (c) => {
        c.proof.issuedAt = '2026-10-08T12:00:01Z';
      },
      'PROOF_INVALID',
    ],
    [
      'wrong domain',
      (c) => {
        c.proof.domain = 'attacker.test';
      },
      'PROOF_INVALID',
    ],
    [
      'wrong URI',
      (c) => {
        c.proof.uri = 'https://identity.test/other';
      },
      'PROOF_INVALID',
    ],
    [
      'wrong proof subject',
      (c) => {
        c.proof.subject.networkIdentity = 'other';
      },
      'PROOF_INVALID',
    ],
    [
      'unsupported network',
      (c) => {
        c.subject.networkIdentity = c.proof.subject.networkIdentity = 'other';
      },
      'UNSUPPORTED_IDENTITY',
    ],
  ];
  it.each(denied)('denies %s without partial effects', (_label, change, code) => {
    const command = link();
    change(command);
    const before = JSON.stringify(command);
    expect(inspectVerifiedLink(command, policy, now)).toEqual({ stage: 'BLOCKED', code });
    expect(JSON.stringify(command)).toBe(before);
  });
  it('rejects an ownership collision, even if the other account is considered empty', () => {
    const command = {
      ...link(),
      ownership: { state: 'LINKED', subject: link().subject, accountId: 'other' },
    };
    expect(inspectVerifiedLink(command, policy, now)).toEqual({
      stage: 'BLOCKED',
      code: 'IDENTITY_CONFLICT',
    });
  });
  it('does not use an unclaimed observation for a different subject', () => {
    const command = {
      ...link(),
      ownership: {
        state: 'UNCLAIMED',
        subject: { ...link().subject, networkIdentity: 'different' },
      },
    };
    expect(inspectVerifiedLink(command, policy, now)).toEqual({
      stage: 'BLOCKED',
      code: 'OWNERSHIP_UNKNOWN',
    });
  });
  it('treats an existing own verified link as a proposal, not proof-consumption success', () => {
    const command = {
      ...link(),
      ownership: { state: 'LINKED', subject: link().subject, accountId: 'synthetic-account' },
    };
    expect(inspectVerifiedLink(command, policy, now).stage).toBe('READY_FOR_TRANSACTION');
    expect(
      inspectVerifiedLink({ ...command, proof: { ...command.proof, consumed: true } }, policy, now),
    ).toEqual({ stage: 'BLOCKED', code: 'PROOF_INVALID' });
  });
  it('does not reactivate a revoked credential without its recovery policy', () => {
    expect(
      inspectVerifiedLink(
        {
          ...link(),
          ownership: { state: 'REVOKED', subject: link().subject, accountId: 'synthetic-account' },
        },
        policy,
        now,
      ),
    ).toEqual({ stage: 'BLOCKED', code: 'IDENTITY_REVOKED' });
  });
  it('uses the immutable provider subject independently of a supplier instance', () => {
    const subject = {
      kind: 'PROVIDER',
      provider: 'synthetic-provider',
      subject: 'immutable:Subject/42',
    };
    const a = {
      ...link(),
      subject,
      ownership: { state: 'UNCLAIMED', subject },
      proof: { ...link().proof, subject },
    };
    const b = structuredClone(a);
    expect(inspectVerifiedLink(a, policy, now)).toEqual(inspectVerifiedLink(b, policy, now));
    expect(inspectVerifiedLink(a, { ...policy, providers: [] }, now)).toEqual({
      stage: 'BLOCKED',
      code: 'UNSUPPORTED_IDENTITY',
    });
    expect(
      inspectVerifiedLink(
        { ...b, ownership: { state: 'LINKED', subject, accountId: 'other' } },
        policy,
        now,
      ),
    ).toEqual({ stage: 'BLOCKED', code: 'IDENTITY_CONFLICT' });
  });
  it('rejects client-supplied privilege, payout and private payload fields', () => {
    for (const extra of [
      { role: 'ADMIN' },
      { payoutAddress: 'new' },
      { privateBrief: 'private-canary' },
    ]) {
      const result = inspectVerifiedLink({ ...link(), ...extra }, policy, now);
      expect(result).toEqual({ stage: 'BLOCKED', code: 'INVALID_COMMAND' });
      expect(JSON.stringify(result)).not.toContain('private-canary');
    }
  });
  it('fails closed for malformed clock, missing policy or corrupt participant input', () => {
    expect(inspectVerifiedLink(link(), policy, 'not-time')).toEqual({
      stage: 'BLOCKED',
      code: 'INVALID_COMMAND',
    });
    expect(inspectVerifiedLink(link(), {}, now)).toEqual({
      stage: 'BLOCKED',
      code: 'INVALID_COMMAND',
    });
    expect(
      inspectVerifiedLink(
        {
          ...link(),
          snapshot: { ...snapshot(), participant: { id: 'p', kind: 'AI_AGENT', operatorId: 'o' } },
        },
        policy,
        now,
      ),
    ).toEqual({ stage: 'BLOCKED', code: 'INVALID_COMMAND' });
  });
  it('keys exact network/provider subjects without ambiguous concatenation or case folding', () => {
    expect(identitySubjectKey(link().subject)).not.toBe(
      identitySubjectKey({ ...link().subject, networkIdentity: 'other' }),
    );
    const subject = { kind: 'PROVIDER', provider: 'a', subject: 'b:c' };
    expect(identitySubjectKey(subject)).not.toBe(
      identitySubjectKey({ ...subject, provider: 'a:b', subject: 'c' }),
    );
    expect(identitySubjectKey(subject)).not.toBe(
      identitySubjectKey({ ...subject, subject: 'B:C' }),
    );
    expect(() => identitySubjectKey({ ...subject, adapterId: 'changed' })).toThrow();
  });
});

function removal() {
  return {
    kind: 'MERGE',
    keep: { ...snapshot('synthetic-keep', 'synthetic-keep-participant'), activeEngagementId: null },
    drop: { ...snapshot(), activeEngagementId: null },
    inventory: {
      state: 'COMPLETE',
      accountId: 'synthetic-account',
      participantId: 'synthetic-participant',
      revision: 3,
      references: [] as { kind: string; id: string }[],
    },
  };
}
describe('T006 destructive-identity preflight (never authorizes execution)', () => {
  it('rejects two busy participants without hiding either assignment', () => {
    const command = removal();
    command.keep.activeEngagementId = 'keep-work' as never;
    command.drop.activeEngagementId = 'drop-work' as never;
    const before = JSON.stringify(command);
    expect(inspectAccountRemoval(command)).toEqual({ stage: 'BLOCKED', code: 'CAPACITY_CONFLICT' });
    expect(JSON.stringify(command)).toBe(before);
  });
  it.each([
    'TERMS',
    'CONSENT',
    'WORK_HISTORY',
    'SKILL_EVIDENCE',
    'CLAIM',
    'LEDGER',
    'CASE',
    'ROLE',
    'AUDIT',
    'RECEIPT',
    'OUTBOX',
    'MEDIA',
    'OTHER',
  ])('retains %s even when legacy activity would be empty', (kind) => {
    const command = removal();
    command.inventory.references.push({ kind, id: 'synthetic-retained-right' });
    const before = JSON.stringify(command);
    expect(inspectAccountRemoval(command)).toEqual({ stage: 'BLOCKED', code: 'RIGHTS_RETAINED' });
    expect(JSON.stringify(command)).toBe(before);
  });
  it('retains a sole active commitment even when inventory incorrectly claims zero references', () => {
    const command = removal();
    command.drop.activeEngagementId = 'work' as never;
    expect(inspectAccountRemoval(command)).toEqual({ stage: 'BLOCKED', code: 'RIGHTS_RETAINED' });
  });
  it('blocks unknown, wrong account/participant and stale inventories', () => {
    for (const patch of [
      { state: 'UNKNOWN' },
      { accountId: 'other' },
      { participantId: 'other' },
      { revision: 2 },
    ]) {
      const command = removal();
      Object.assign(command.inventory, patch);
      expect(inspectAccountRemoval(command)).toEqual({
        stage: 'BLOCKED',
        code: 'INVENTORY_UNKNOWN',
      });
    }
  });
  it('rejects unrecognized right types instead of treating them as no rights', () => {
    const command = removal();
    command.inventory.references.push({ kind: 'FUTURE_RIGHT', id: 'new-right' });
    expect(inspectAccountRemoval(command)).toEqual({ stage: 'BLOCKED', code: 'INVALID_COMMAND' });
  });
  it('does not approve merge or deletion from an empty inventory', () => {
    const command = removal();
    expect(inspectAccountRemoval(command)).toEqual({
      stage: 'BLOCKED',
      code: 'SCOPED_REVIEW_REQUIRED',
    });
    expect(
      inspectAccountRemoval({ kind: 'DELETE', drop: command.drop, inventory: command.inventory }),
    ).toEqual({ stage: 'BLOCKED', code: 'SCOPED_REVIEW_REQUIRED' });
  });
  it('rejects self-merge, alias participant and malformed removal commands', () => {
    const command = removal();
    expect(inspectAccountRemoval({ ...command, keep: command.drop })).toEqual({
      stage: 'BLOCKED',
      code: 'INVALID_COMMAND',
    });
    expect(
      inspectAccountRemoval({
        ...command,
        keep: {
          ...command.keep,
          participant: { ...command.keep.participant, id: command.drop.participant.id },
        },
      }),
    ).toEqual({ stage: 'BLOCKED', code: 'INVALID_COMMAND' });
    expect(inspectAccountRemoval({ ...command, approved: true })).toEqual({
      stage: 'BLOCKED',
      code: 'INVALID_COMMAND',
    });
  });
});
