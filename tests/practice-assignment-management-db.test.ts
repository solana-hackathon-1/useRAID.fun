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
  describe('ascending existing-appointment mutexes (seed 12017) with several appointments', () => {
    const MUTEX = 'pg_advisory_xact_lock';
    type Wrapped = Parameters<typeof readPracticeAssignmentManagement>[0];
    const within = <T>(work: Promise<T>, label: string, ms = 10000) =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out (deadlock?): ' + label)), ms);
        work.then(
          (v) => (clearTimeout(timer), resolve(v)),
          (e) => (clearTimeout(timer), reject(e)),
        );
      });
    // Bounded polling of PostgreSQL's own lock tables; no fixed-duration sleep.
    async function until<T>(probe: () => Promise<T | null | false>, label: string): Promise<T> {
      const deadline = Date.now() + 10000;
      for (;;) {
        const value = await probe();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const mutexState = (pid: number, appointmentId: string) =>
      db.$queryRawUnsafe<{ granted: boolean }[]>(
        `SELECT granted FROM pg_locks WHERE locktype='advisory' AND pid=$1 AND (classid::bigint<<32)|objid::bigint = hashtextextended($2,12017)`,
        pid,
        appointmentId,
      );
    const holdsMutex = async (pid: number, appointmentId: string) =>
      (await mutexState(pid, appointmentId)).some((r) => r.granted === true);
    const waitsOnMutex = async (pid: number, appointmentId: string) =>
      (await mutexState(pid, appointmentId)).some((r) => r.granted === false);
    async function twoAppointments() {
      const issued = await runCommandTransaction(db, (tx) =>
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
              reason: 'synthetic second appointment for mutex ordering',
            },
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-mutex-second-appointment',
          },
          { allowNewWrites: true, canManage: () => true },
        ),
      );
      const [first, second] = [f.assignment.id, issued.assignment.id].sort();
      expect(first < second).toBe(true);
      return { first, second };
    }
    async function secondManager() {
      const user = await db.user.create({
        data: { handle: 'synthetic-mutex-manager', role: 'ADMIN', xId: randomUUID() },
      });
      const actor = { accountId: user.id, sessionHash: 'e'.repeat(64) };
      await db.session.create({
        data: {
          tokenHash: actor.sessionHash,
          userId: user.id,
          via: 'x',
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      return actor;
    }
    const revokeAs = (
      actor: { accountId: string; sessionHash: string },
      assignmentId: string,
      wrap?: (tx: Wrapped) => Wrapped,
    ) =>
      runCommandTransaction(db, (tx) =>
        revokePracticeReviewAssignment(
          wrap ? wrap(tx) : tx,
          {
            actor,
            input: { version: 'v1', assignmentId, reason: 'Synthetic mutex-order revocation.' },
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-mutex-order',
          },
          { allowNewWrites: true, canManage: () => true },
        ),
      );
    const states = (page: { entries: { assignment: { id: string }; currentState: string }[] }) =>
      Object.fromEntries(page.entries.map((e) => [e.assignment.id, e.currentState]));

    it('does not block or deadlock revoking the second appointment while a reader holds only the first mutex; the reader then observes it revoked', async () => {
      const { first, second } = await twoAppointments();
      const other = await secondManager();
      let release!: () => void, held!: () => void, pidReady!: (pid: number) => void;
      const pause = new Promise<void>((resolve) => (release = resolve)),
        reached = new Promise<void>((resolve) => (held = resolve)),
        readerPid = new Promise<number>((resolve) => (pidReady = resolve));
      const reading = runCommandTransaction(db, async (tx) => {
        const [row] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', []);
        pidReady(row.pid);
        return readPracticeAssignmentManagement(
          {
            ...tx,
            async query<Row>(q: string, b: readonly (string | null)[]) {
              const rows = await tx.query<Row>(q, b);
              if (q.includes(MUTEX) && b[0] === first) {
                held();
                await pause;
              }
              return rows;
            },
          },
          admin,
          input(),
          options(),
        );
      });
      try {
        await within(reached, 'reader to take the first appointment mutex');
        const pid = await readerPid;
        expect(await holdsMutex(pid, first)).toBe(true);
        expect(await mutexState(pid, second)).toHaveLength(0);
        // The reader has not locked the second appointment, so revoking it is not delayed.
        await within(revokeAs(other, second), 'second-appointment revoke behind the reader');
      } finally {
        release();
        // Drain the reader without throwing so an assertion failure above is not masked and no transaction is orphaned.
        await Promise.allSettled([reading]);
      }
      const outcome = await within(reading, 'reader after release');
      // Contract: reads are READ_COMMITTED per statement, not a page snapshot. The reader took the
      // second mutex only after that revocation committed, so it observes the committed REVOKED.
      expect(states(outcome.page)).toEqual({ [first]: 'ACTIVE', [second]: 'REVOKED' });
      expect((await read()).page.entries.map((e) => e.assignment.id)).toEqual([first, second]);
    }, 40000);

    it('makes the reader wait on the second mutex held by an in-flight revocation (holding the first), without deadlock, then observes it revoked', async () => {
      const { first, second } = await twoAppointments();
      const other = await secondManager();
      let release!: () => void, held!: () => void, revokerPidReady!: (pid: number) => void;
      const pause = new Promise<void>((resolve) => (release = resolve)),
        reached = new Promise<void>((resolve) => (held = resolve)),
        revokerPid = new Promise<number>((resolve) => (revokerPidReady = resolve));
      const revoking = revokeAs(other, second, (tx) => ({
        ...tx,
        async query<Row>(q: string, b: readonly (string | null)[]) {
          if (q.includes('SELECT pg_backend_pid()')) return tx.query<Row>(q, b);
          const rows = await tx.query<Row>(q, b);
          if (q.includes(MUTEX) && b[0] === second) {
            const [row] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', []);
            revokerPidReady(row.pid);
            held();
            await pause;
          }
          return rows;
        },
      }));
      let readerPid: number | undefined;
      let reading: ReturnType<typeof read> | undefined;
      try {
        await within(reached, 'revoker to take the second appointment mutex');
        const holder = await revokerPid;
        reading = runCommandTransaction(db, async (tx) => {
          const [row] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', []);
          readerPid = row.pid;
          return readPracticeAssignmentManagement(tx, admin, input(), options());
        });
        const pid = await until(async () => readerPid ?? null, 'reader backend');
        // Ascending order: reader owns the lower mutex, then waits for the higher one held by the revoker.
        await until(() => waitsOnMutex(pid, second), 'reader to wait on the second mutex');
        expect(await holdsMutex(pid, first)).toBe(true);
        const [blocked] = await db.$queryRawUnsafe<{ blockers: number[] }[]>(
          'SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1',
          pid,
        );
        expect(blocked.blockers).toContain(holder);
      } finally {
        release();
        // Drain both transactions without throwing so the original failure surfaces and nothing stays open.
        await Promise.allSettled([revoking, reading]);
      }
      const committed = await within(revoking, 'revoker completion');
      expect(committed.status).toBe('EXECUTED');
      const outcome = await within(reading!, 'reader after the revocation committed');
      expect(states(outcome.page)).toEqual({ [first]: 'ACTIVE', [second]: 'REVOKED' });
    }, 40000);
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
