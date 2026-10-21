import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import type { CommandReceiptTransaction } from '../src/command-receipts';
const audit = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../src/command-receipts', async (original) => ({
  ...(await original<object>()),
  executeIdempotentCommand: audit.execute,
}));
import { listPracticeReviewInbox } from '../src/skills/practice-review-inbox-storage';
import { PracticeReviewInboxPageSchema } from '../src/skills/practice-review-inbox-contracts';
const actor = { accountId: 'own-evaluator', sessionHash: 'a'.repeat(64) };
const now = new Date('2026-10-21T12:00:00.000Z');
const entry = (n: number) => ({
  assignmentId: '00000000-0000-4000-8000-' + String(n).padStart(12, '0'),
  submissionId: randomUUID(),
  purpose: 'OWNERSHIP_REVIEW',
  issuedAt: new Date(now.getTime() - 60000),
  expiresAt: new Date(now.getTime() + 60000),
});
let rows: ReturnType<typeof entry>[], calls: string[], valid: boolean, restricted: boolean;
const tx: CommandReceiptTransaction = {
  dialect: 'POSTGRESQL',
  isolation: 'READ_COMMITTED',
  async query<Row>(sql: string, bindings: readonly (string | null)[]) {
    calls.push(sql);
    if (sql.includes('FROM "User"'))
      return [{ id: actor.accountId, suspended: restricted, role: 'CREATOR', xId: null }] as Row[];
    if (sql.includes('FROM "Session"'))
      return (
        sql.includes(' AS valid')
          ? [{ valid, observedAt: now }]
          : [{ userId: actor.accountId, via: 'wallet' }]
      ) as Row[];
    if (sql.includes('FROM "PracticeTrialReviewAssignment"')) {
      expect(bindings[0]).toBe(actor.accountId);
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain('clock_timestamp()');
      expect(sql).toContain('LIMIT 21');
      expect(sql).toContain('ORDER BY');
      expect(sql).not.toMatch(
        /answer|explanation|reason|definition|Participant|PracticeTrialSubmission/,
      );
      return rows.map((r) => ({ ...r, observedAt: now })) as Row[];
    }
    if (sql.includes('clock_timestamp()')) return [{ observedAt: now }] as Row[];
    throw new Error('Unexpected query');
  },
};
beforeEach(() => {
  rows = [entry(1)];
  calls = [];
  valid = true;
  restricted = false;
  audit.execute.mockReset();
  audit.execute.mockImplementation(async (_tx, _command, work) => {
    await work({ receiptId: randomUUID() });
    return { status: 'EXECUTED' };
  });
});
it('lists bounded own current metadata only, audits before selecting, and binds the internal owner', async () => {
  const result = await listPracticeReviewInbox(
    tx,
    actor,
    { version: 'v1', after: null },
    () => true,
  );
  expect(result.accountId).toBe(actor.accountId);
  expect(result.page.entries).toEqual([
    {
      ...rows[0],
      issuedAt: rows[0].issuedAt.toISOString(),
      expiresAt: rows[0].expiresAt.toISOString(),
    },
  ]);
  expect(result.page).toMatchObject({
    private: true,
    isAuthorizationToken: false,
    nextCursor: null,
  });
  expect(audit.execute).toHaveBeenCalledOnce();
  const command = audit.execute.mock.calls[0][1];
  expect(command.actorId).toBe(actor.accountId);
  expect(command.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(command.request).toEqual({ version: 'v1', after: null });
  expect(PracticeReviewInboxPageSchema.safeParse(result.page).success).toBe(true);
});
it('uses own UUID ordering position with20 entries and one lookahead; never returns the lookahead', async () => {
  rows = Array.from({ length: 21 }, (_, i) => entry(i + 1));
  const result = await listPracticeReviewInbox(
    tx,
    actor,
    { version: 'v1', after: entry(0).assignmentId },
    () => true,
  );
  expect(result.page.entries).toHaveLength(20);
  expect(result.page.nextCursor).toBe(rows[19].assignmentId);
  expect(JSON.stringify(result)).not.toContain(rows[20].submissionId);
});
it('returns an honest empty current observation', async () => {
  rows = [];
  const result = await listPracticeReviewInbox(
    tx,
    actor,
    { version: 'v1', after: null },
    () => true,
  );
  expect(result.page.entries).toEqual([]);
  expect(result.page.nextCursor).toBeNull();
});
it.each([
  { version: 'v1', after: null, accountId: 'foreign' },
  { version: 'v1', after: 'bad' },
  { version: 'v2', after: null },
])('rejects client authority/invalid ordering input before SQL %s', async (input) => {
  await expect(listPracticeReviewInbox(tx, actor, input, () => true)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(calls).toEqual([]);
  expect(audit.execute).not.toHaveBeenCalled();
});
it('denies a revoked session before discovering even an empty inbox', async () => {
  valid = false;
  await expect(
    listPracticeReviewInbox(tx, actor, { version: 'v1', after: null }, () => true),
  ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  expect(calls.join(' ')).not.toContain('FROM "PracticeTrialReviewAssignment"');
  expect(audit.execute).not.toHaveBeenCalled();
});
it('denies restricted accounts', async () => {
  restricted = true;
  await expect(
    listPracticeReviewInbox(tx, actor, { version: 'v1', after: null }, () => true),
  ).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
});
it.each([false, 'true', undefined])(
  'fails closed for nontrue metadata policy %s',
  async (value) => {
    await expect(
      listPracticeReviewInbox(tx, actor, { version: 'v1', after: null }, () => value as boolean),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls.join(' ')).not.toContain('FROM "PracticeTrialReviewAssignment"');
  },
);
it('rechecks current session and policy after audit waits before selection', async () => {
  audit.execute.mockImplementation(async () => {
    valid = false;
    return { status: 'EXECUTED' };
  });
  await expect(
    listPracticeReviewInbox(tx, actor, { version: 'v1', after: null }, () => true),
  ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  expect(calls.join(' ')).not.toContain('FROM "PracticeTrialReviewAssignment"');
});
it('does not return metadata after current policy closes during selection', async () => {
  let enabled = true;
  const waited = {
    ...tx,
    async query<Row>(sql: string, b: readonly (string | null)[]) {
      const result = await tx.query<Row>(sql, b);
      if (sql.includes('FROM "PracticeTrialReviewAssignment"')) enabled = false;
      return result;
    },
  };
  await expect(
    listPracticeReviewInbox(waited, actor, { version: 'v1', after: null }, () => enabled),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
it('does not select metadata if the access audit fails', async () => {
  audit.execute.mockRejectedValue(new Error('private driver secret'));
  await expect(
    listPracticeReviewInbox(tx, actor, { version: 'v1', after: null }, () => true),
  ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  expect(calls.join(' ')).not.toContain('FROM "PracticeTrialReviewAssignment"');
});
it.each(['duplicate', 'expired', 'unsorted', 'extra'])(
  'rejects incoherent host rows %s',
  async (kind) => {
    if (kind === 'duplicate') rows = [entry(1), entry(1)];
    if (kind === 'expired') rows[0].expiresAt = now;
    if (kind === 'unsorted') rows = [entry(2), entry(1)];
    if (kind === 'extra') Object.assign(rows[0], { answer: 'secret' });
    await expect(
      listPracticeReviewInbox(tx, actor, { version: 'v1', after: null }, () => true),
    ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
  },
);
