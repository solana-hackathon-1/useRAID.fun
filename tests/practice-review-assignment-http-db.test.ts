import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedPracticeReviewFixture, db } from './helpers/practice-review-browser-fixture';
import { assertTestDatabase } from './helpers/db-guard';
import { hash } from '../src/lib/auth-primitives';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import {
  issuePracticeReviewAssignment,
  revokePracticeReviewAssignment,
  type PracticeReviewAssignmentCommand,
} from '../src/skills/practice-review-assignment-storage';
import { createPracticeReviewAssignmentHandlers } from '../src/skills/practice-review-assignment-http';
import type { SkillTaxonomyActor } from '../src/skills/taxonomy-storage-contracts';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
async function account(role: 'ADMIN' | 'CREATOR', via: 'x' | 'wallet') {
  const user = await db.user.create({
    data: {
      handle: 'synthetic-' + randomUUID().slice(0, 8),
      role,
      xId: via === 'x' ? randomUUID() : null,
    },
  });
  const sessionHash = hash(randomUUID());
  await db.session.create({
    data: {
      tokenHash: sessionHash,
      userId: user.id,
      via,
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  return { accountId: user.id, sessionHash } satisfies SkillTaxonomyActor;
}
function harness(current: { actor: SkillTaxonomyActor; writes: boolean }) {
  const options = () => ({
    allowNewWrites: current.writes,
    canManage: () => true,
  });
  const result = (outcome: object) => ({
    version: 'v1' as const,
    ...outcome,
    writesAvailable: current.writes,
    unavailableReason: current.writes ? null : ('DISABLED' as const),
  });
  return createPracticeReviewAssignmentHandlers({
    version: 'v1',
    requestId: randomUUID,
    origin: () => undefined,
    actor: async () => current.actor,
    rateLimit: () => undefined,
    issue: async (command: PracticeReviewAssignmentCommand) =>
      result(
        await runCommandTransaction(db, (tx) =>
          issuePracticeReviewAssignment(tx, command, options()),
        ),
      ),
    revoke: async (command: PracticeReviewAssignmentCommand) =>
      result(
        await runCommandTransaction(db, (tx) =>
          revokePracticeReviewAssignment(tx, command, options()),
        ),
      ),
  });
}
const post = (path: string, body: unknown, key = randomUUID()) =>
  new Request('http://raid.test' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
const ISSUE = '/api/v1/admin/practice/review-assignments';
integration('T013 administrator assignment HTTP over actual PostgreSQL', () => {
  beforeAll(() => assertTestDatabase());
  afterAll(() => db.$disconnect());
  async function setup() {
    const f = await seedPracticeReviewFixture();
    const submission = await db.practiceTrialSubmission.findFirstOrThrow({
      where: { id: f.submission.reference.recordId },
    });
    const evaluator = await account('CREATOR', 'wallet');
    const admin = await account('ADMIN', 'x');
    const body = (over: Record<string, unknown> = {}) => ({
      version: 'v1',
      submissionId: submission.id,
      evaluatorAccountId: evaluator.accountId,
      purpose: 'ASSESSMENT_REVIEW',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      reason: 'Synthetic administrator HTTP appointment.',
      ...over,
    });
    return { f, submission, evaluator, admin, body };
  }
  it('issues once, replays the same key, rejects key reuse and records exactly one appointment', async () => {
    const s = await setup();
    const handlers = harness({ actor: s.admin, writes: true });
    const input = s.body();
    const key = randomUUID();
    const first = await handlers.issue(post(ISSUE, input, key));
    expect(first.status).toBe(200);
    const issued = await first.json();
    expect(issued).toMatchObject({
      status: 'EXECUTED',
      assignment: {
        evaluatorAccountId: s.evaluator.accountId,
        issuedByAccountId: s.admin.accountId,
      },
    });
    const replay = await (await handlers.issue(post(ISSUE, input, key))).json();
    expect(replay).toMatchObject({ status: 'REPLAYED', assignment: { id: issued.assignment.id } });
    expect((await handlers.issue(post(ISSUE, s.body({ reason: 'Different.' }), key))).status).toBe(
      409,
    );
    expect(
      await db.practiceTrialReviewAssignment.count({
        where: { evaluatorAccountId: s.evaluator.accountId },
      }),
    ).toBe(1);
  });
  it('revokes once, then reports a conflict for a new key; unknown assignment is 404', async () => {
    const s = await setup();
    const handlers = harness({ actor: s.admin, writes: true });
    const id = (await (await handlers.issue(post(ISSUE, s.body()))).json()).assignment.id;
    const path = `${ISSUE}/${id}/revocations`;
    const revokeBody = { version: 'v1', assignmentId: id, reason: 'Synthetic revoke.' };
    const key = randomUUID();
    const ok = await handlers.revoke(post(path, revokeBody, key), { assignmentId: id });
    expect(ok.status).toBe(200);
    expect((await ok.json()).revocation.assignmentId).toBe(id);
    expect((await handlers.revoke(post(path, revokeBody, key), { assignmentId: id })).status).toBe(
      200,
    );
    expect((await handlers.revoke(post(path, revokeBody), { assignmentId: id })).status).toBe(409);
    const missing = randomUUID();
    const unknown = await handlers.revoke(
      post(`${ISSUE}/${missing}/revocations`, { ...revokeBody, assignmentId: missing }),
      { assignmentId: missing },
    );
    expect(unknown.status).toBe(404);
    expect(await db.practiceTrialReviewRevocation.count({ where: { assignmentId: id } })).toBe(1);
  });
  it('denies wallet-only and non-admin sessions, self-review, past expiry and disabled writes without any row', async () => {
    const s = await setup();
    const before = await db.practiceTrialReviewAssignment.count();
    const walletOnly = harness({ actor: await account('CREATOR', 'wallet'), writes: true });
    expect((await walletOnly.issue(post(ISSUE, s.body()))).status).toBe(403);
    const nonAdmin = harness({ actor: await account('CREATOR', 'x'), writes: true });
    expect((await nonAdmin.issue(post(ISSUE, s.body()))).status).toBe(403);
    const admin = harness({ actor: s.admin, writes: true });
    expect(
      (await admin.issue(post(ISSUE, s.body({ evaluatorAccountId: s.submission.accountId }))))
        .status,
    ).toBe(403);
    expect(
      (
        await admin.issue(
          post(ISSUE, s.body({ expiresAt: new Date(Date.now() - 1000).toISOString() })),
        )
      ).status,
    ).toBe(422);
    expect((await admin.issue(post(ISSUE, s.body({ submissionId: randomUUID() })))).status).toBe(
      404,
    );
    const disabled = harness({ actor: s.admin, writes: false });
    expect((await disabled.issue(post(ISSUE, s.body()))).status).toBe(503);
    expect(await db.practiceTrialReviewAssignment.count()).toBe(before);
  });
});
