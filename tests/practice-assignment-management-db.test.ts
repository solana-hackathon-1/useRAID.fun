import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { seedPracticeReviewFixture, db } from './helpers/practice-review-browser-fixture';
import { assertTestDatabase } from './helpers/db-guard';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import {
  readPracticeAssignmentManagement,
  issuePracticeReviewAssignment,
  revokePracticeReviewAssignment,
} from '../src/skills/practice-review-assignment-storage';
import { PracticeAssignmentManagementPageSchema } from '../src/skills/practice-review-assignment-management-contracts';
import { CommandReceiptError } from '../src/command-receipts';
import { createPracticeAssignmentManagementHandlers } from '../src/skills/practice-assignment-management-http';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
let f: Awaited<ReturnType<typeof seedPracticeReviewFixture>>,
  admin: { accountId: string; sessionHash: string },
  xId: string;
const input = (
  submissionId: string | null = f.assignment.submissionId,
  after: string | null = null,
) => ({ version: 'v1', submissionId, after });
const options = () => ({
  canInspect: (s: { accountId: string; xId: string }) =>
    s.accountId === admin.accountId && s.xId === xId,
  canManage: (s: { subjectAccountId: string; evaluatorAccountId: string; skillId: string }) =>
    s.evaluatorAccountId === f.evaluatorId && s.skillId === f.definition.skillId,
});
const read = (body: unknown = input(), actor = admin, opts = options()) =>
  runCommandTransaction(db, (tx) => readPracticeAssignmentManagement(tx, actor, body, opts));
integration('current protected assignment management reads', () => {
  beforeEach(async () => {
    assertTestDatabase();
    f = await seedPracticeReviewFixture();
    const session = await db.session.findFirstOrThrow({
      where: { userId: f.assignment.issuedByAccountId },
    });
    admin = { accountId: session.userId, sessionHash: session.tokenHash };
    xId = (await db.user.findUniqueOrThrow({ where: { id: admin.accountId } })).xId!;
  });
  afterAll(() => db.$disconnect());
  it('audits HEAD with one committed management receipt and event while returning no body', async () => {
    const receiptWhere = {
      actorId: admin.accountId,
      commandKind: 'ListPracticeReviewAssignmentsManagement',
    };
    const auditWhere = {
      actorId: admin.accountId,
      eventType: 'skill.practice_review_assignment_management_access.v1',
    };
    const receiptsBefore = await db.commandReceipt.count({ where: receiptWhere });
    const auditsBefore = await db.auditEvent.count({ where: auditWhere });
    const handlers = createPracticeAssignmentManagementHandlers({
      version: 'v1',
      requestId: randomUUID,
      actor: async () => admin,
      rateLimit: () => {},
      read: async (actor, body) => ({
        version: 'v1',
        writesAvailable: true,
        unavailableReason: null,
        result: await read(body, actor),
      }),
    });
    const response = await handlers.HEAD(
      new Request(
        'http://raid.test/api/v1/admin/practice/review-assignments?submissionId=' +
          f.assignment.submissionId,
        { method: 'HEAD' },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Cookie');
    expect(await db.commandReceipt.count({ where: receiptWhere })).toBe(receiptsBefore + 1);
    const audits = await db.auditEvent.findMany({ where: auditWhere });
    expect(audits).toHaveLength(auditsBefore + 1);
    expect(audits.at(-1)?.payload).toEqual({ submissionId: f.assignment.submissionId });
  });
  it('returns actual immutable appointment/current state and audited private metadata without case answers', async () => {
    const sql: string[] = [];
    const result = await runCommandTransaction(db, (tx) =>
      readPracticeAssignmentManagement(
        {
          ...tx,
          async query<Row>(q: string, b: readonly (string | null)[]) {
            sql.push(q);
            return tx.query<Row>(q, b);
          },
        },
        admin,
        input(),
        options(),
      ),
    );
    expect(result.managerXId).toBe(xId);
    expect(result.page.entries).toEqual([
      { assignment: f.assignment, revocation: null, currentState: 'ACTIVE' },
    ]);
    expect(PracticeAssignmentManagementPageSchema.safeParse(result.page).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /review-private-answer-marker|review-private-explanation-marker|sessionHash/,
    );
    expect(sql.join(' ')).not.toMatch(/s\."answer"|s\."explanation"|s\."assistanceDisclosure"/);
    const audit = await db.auditEvent.findMany({
      where: {
        actorId: admin.accountId,
        eventType: 'skill.practice_review_assignment_management_access.v1',
      },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toEqual({ submissionId: f.assignment.submissionId });
  });
  it('authenticates/authorizes even blank screen or missing submission before exposing target metadata', async () => {
    expect((await read(input(null))).page).toMatchObject({
      actorAccountId: admin.accountId,
      submissionId: null,
      entries: [],
      nextCursor: null,
    });
    expect((await read(input(randomUUID()))).page.entries).toEqual([]);
    await expect(
      read(input(null), { ...admin, sessionHash: 'f'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });
  it.each(['wallet', 'non-admin', 'restricted', 'allowlist'])(
    'rejects current%s without metadata access audit',
    async (kind) => {
      if (kind === 'wallet')
        await db.session.update({
          where: { tokenHash: admin.sessionHash },
          data: { via: 'wallet' },
        });
      if (kind === 'non-admin')
        await db.user.update({ where: { id: admin.accountId }, data: { role: 'CREATOR' } });
      if (kind === 'restricted')
        await db.user.update({ where: { id: admin.accountId }, data: { suspended: true } });
      const opts = options();
      if (kind === 'allowlist') opts.canInspect = () => false;
      await expect(read(input(), admin, opts)).rejects.toMatchObject({
        code: kind === 'restricted' ? 'ACCOUNT_RESTRICTED' : 'FORBIDDEN',
      });
      expect(
        await db.auditEvent.count({
          where: {
            actorId: admin.accountId,
            eventType: 'skill.practice_review_assignment_management_access.v1',
          },
        }),
      ).toBe(0);
    },
  );
  it('requires actual scoped per-record policy and rolls audit back on denied page, without cursor leakage', async () => {
    await expect(
      read(input(), admin, { ...options(), canManage: () => false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await db.auditEvent.count({
        where: {
          actorId: admin.accountId,
          eventType: 'skill.practice_review_assignment_management_access.v1',
        },
      }),
    ).toBe(0);
  });
  it('shows actual saved revocation while original assignment remains historical ISSUED', async () => {
    await f.revoke();
    const page = (await read()).page;
    expect(page.entries[0]).toMatchObject({
      currentState: 'REVOKED',
      assignment: { state: 'ISSUED' },
      revocation: { assignmentId: f.assignment.id, state: 'REVOKED' },
    });
  });
  it('observes expiry after a wait under held locks, without claiming current active state', async () => {
    const prior = f;
    f = await seedPracticeReviewFixture({ expiresMs: 650 });
    const session = await db.session.findFirstOrThrow({
      where: { userId: f.assignment.issuedByAccountId },
    });
    admin = { accountId: session.userId, sessionHash: session.tokenHash };
    xId = (await db.user.findUniqueOrThrow({ where: { id: admin.accountId } })).xId!;
    const result = await runCommandTransaction(db, (tx) =>
      readPracticeAssignmentManagement(
        {
          ...tx,
          async query<Row>(q: string, b: readonly (string | null)[]) {
            const rows = await tx.query<Row>(q, b);
            if (q.includes('SELECT "id" FROM "PracticeTrialReviewRevocation"'))
              await tx.query('SELECT pg_sleep(0.7)::text', []);
            return rows;
          },
        },
        admin,
        input(),
        options(),
      ),
    );
    expect(prior.assignment.id).not.toBe(f.assignment.id);
    expect(result.page.entries[0].currentState).toBe('EXPIRED');
  });
  it('rejects session expiry during metadata waits and rolls audit back', async () => {
    await db.session.update({
      where: { tokenHash: admin.sessionHash },
      data: { expiresAt: new Date(Date.now() + 650) },
    });
    await expect(
      runCommandTransaction(db, (tx) =>
        readPracticeAssignmentManagement(
          {
            ...tx,
            async query<Row>(q: string, b: readonly (string | null)[]) {
              const rows = await tx.query<Row>(q, b);
              if (q.includes('SELECT "id" FROM "PracticeTrialReviewRevocation"'))
                await tx.query('SELECT pg_sleep(0.7)::text', []);
              return rows;
            },
          },
          admin,
          input(),
          options(),
        ),
      ),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });
  it('paginates exact submission20+1 and current policy sees actual saved evaluator/subject/expiry', async () => {
    for (let i = 0; i < 22; i++)
      await runCommandTransaction(db, (tx) =>
        issuePracticeReviewAssignment(
          tx,
          {
            actor: admin,
            input: {
              version: 'v1',
              submissionId: f.assignment.submissionId,
              evaluatorAccountId: f.evaluatorId,
              purpose: 'ASSESSMENT_REVIEW',
              expiresAt: new Date(Date.now() + 60000).toISOString(),
              reason: 'synthetic management paging',
            },
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-management-pages',
          },
          { allowNewWrites: true, canManage: () => true },
        ),
      );
    const seen: unknown[] = [];
    const opts = {
      ...options(),
      canManage: (s: Parameters<ReturnType<typeof options>['canManage']>[0]) => {
        seen.push(s);
        return true;
      },
    };
    const first = (await read(input(), admin, opts)).page;
    expect(first.entries).toHaveLength(20);
    expect(first.nextCursor).toBe(first.entries.at(-1)?.assignment.id);
    const second = (await read(input(f.assignment.submissionId, first.nextCursor))).page;
    expect(second.entries).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.entries, ...second.entries].map((e) => e.assignment.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(23);
    expect(seen[0]).toMatchObject({
      evaluatorAccountId: f.evaluatorId,
      submissionId: f.assignment.submissionId,
      skillId: f.definition.skillId,
      issuerAccountId: admin.accountId,
      xId,
    });
  });
  it('serializes another administrator revocation behind the exact appointment lock, then next read shows REVOKED', async () => {
    const user = await db.user.create({
      data: { handle: 'synthetic-second-manager', role: 'ADMIN', xId: randomUUID() },
    });
    const second = { accountId: user.id, sessionHash: 'd'.repeat(64) };
    await db.session.create({
      data: {
        tokenHash: second.sessionHash,
        userId: user.id,
        via: 'x',
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    let release!: () => void, selected!: () => void;
    const pause = new Promise<void>((resolve) => (release = resolve)),
      ready = new Promise<void>((resolve) => (selected = resolve));
    const reading = runCommandTransaction(db, (tx) =>
      readPracticeAssignmentManagement(
        {
          ...tx,
          async query<Row>(q: string, b: readonly (string | null)[]) {
            const rows = await tx.query<Row>(q, b);
            if (q.includes('SELECT "id" FROM "PracticeTrialReviewRevocation"')) {
              selected();
              await pause;
            }
            return rows;
          },
        },
        admin,
        input(),
        options(),
      ),
    );
    await ready;
    let finished = false;
    const revoking = runCommandTransaction(db, (tx) =>
      revokePracticeReviewAssignment(
        tx,
        {
          actor: second,
          input: {
            version: 'v1',
            assignmentId: f.assignment.id,
            reason: 'Synthetic second manager revocation.',
          },
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-management-race',
        },
        { allowNewWrites: true, canManage: () => true },
      ),
    ).then(() => {
      finished = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(finished).toBe(false);
    } finally {
      release();
    }
    expect((await reading).page.entries[0].currentState).toBe('ACTIVE');
    await revoking;
    expect((await read()).page.entries[0].currentState).toBe('REVOKED');
  });
  it('rolls back and returns no metadata when current inspection policy closes during query waits', async () => {
    let enabled = true;
    const opts = { ...options(), canInspect: () => enabled };
    await expect(
      runCommandTransaction(db, (tx) =>
        readPracticeAssignmentManagement(
          {
            ...tx,
            async query<Row>(q: string, b: readonly (string | null)[]) {
              const rows = await tx.query<Row>(q, b);
              if (q.includes('SELECT "id" FROM "PracticeTrialReviewRevocation"')) enabled = false;
              return rows;
            },
          },
          admin,
          input(),
          opts,
        ),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await db.auditEvent.count({
        where: {
          actorId: admin.accountId,
          eventType: 'skill.practice_review_assignment_management_access.v1',
        },
      }),
    ).toBe(0);
  });
  it('does not select any appointment metadata if access audit cannot commit', async () => {
    let selected = false;
    await expect(
      runCommandTransaction(db, (tx) =>
        readPracticeAssignmentManagement(
          {
            ...tx,
            async query<Row>(q: string, b: readonly (string | null)[]) {
              if (q.includes('INSERT INTO "AuditEvent"'))
                throw new CommandReceiptError('STORAGE_UNAVAILABLE');
              if (q.includes('FROM "PracticeTrialReviewAssignment"')) selected = true;
              return tx.query<Row>(q, b);
            },
          },
          admin,
          input(),
          options(),
        ),
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(selected).toBe(false);
  });
  it.each([
    { version: 'v1', submissionId: null, after: randomUUID() },
    { version: 'v1', submissionId: 'bad', after: null },
    { version: 'v1', submissionId: null, after: null, admin: true },
  ])('rejects forged/invalid target before reads %s', async (body) => {
    await expect(read(body)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
