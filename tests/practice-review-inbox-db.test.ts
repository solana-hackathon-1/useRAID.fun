import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedPracticeReviewFixture, db } from './helpers/practice-review-browser-fixture';
import { assertTestDatabase } from './helpers/db-guard';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { listPracticeReviewInbox } from '../src/skills/practice-review-inbox-storage';
import { issuePracticeReviewAssignment } from '../src/skills/practice-review-assignment-storage';
import type { SkillTaxonomyActor } from '../src/skills/taxonomy-storage-contracts';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const list = (actor: SkillTaxonomyActor, after: string | null = null, enabled = true) =>
  runCommandTransaction(db, (tx) =>
    listPracticeReviewInbox(tx, actor, { version: 'v1', after }, () => enabled),
  );
integration('current own assignment discovery with actual PostgreSQL', () => {
  beforeAll(() => assertTestDatabase());
  afterAll(() => db.$disconnect());
  it('discovers exact own finite metadata, with identifier-only audit before query and no private columns/body audit', async () => {
    const f = await seedPracticeReviewFixture(),
      actor = { accountId: f.evaluatorId, sessionHash: f.sessionHash };
    const queries: string[] = [];
    const result = await runCommandTransaction(db, (tx) =>
      listPracticeReviewInbox(
        {
          ...tx,
          async query<Row>(sql: string, bindings: readonly (string | null)[]) {
            queries.push(sql);
            return tx.query<Row>(sql, bindings);
          },
        },
        actor,
        { version: 'v1', after: null },
        () => true,
      ),
    );
    expect(result.page.entries).toEqual([
      {
        assignmentId: f.assignment.id,
        submissionId: f.assignment.submissionId,
        purpose: f.assignment.purpose,
        issuedAt: f.assignment.issuedAt,
        expiresAt: f.assignment.expiresAt,
      },
    ]);
    const text = JSON.stringify(result.page);
    expect(text).not.toMatch(
      /answer|reason|explanation|evaluatorAccountId|subject|definition|rubric/,
    );
    expect(
      queries.filter((q) => q.includes('FROM "PracticeTrialReviewAssignment"')).join(' '),
    ).not.toMatch(/answer|reason|PracticeTrialSubmission|PracticeTrialVersion/);
    const audit = await db.auditEvent.findMany({
      where: {
        eventType: 'skill.practice_review_inbox_access_authorized.v1',
        actorId: f.evaluatorId,
      },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toEqual({});
    expect(
      await db.auditEvent.count({
        where: { eventType: 'skill.practice_review_access_authorized.v1', actorId: f.evaluatorId },
      }),
    ).toBe(0);
    expect(await db.practiceTrialSubmission.count()).toBe(1);
    expect(await db.practiceTrialReviewAssignment.count()).toBe(1);
  });
  it('does not expose another evaluator appointments even to current admin, nor with a foreign ordering cursor', async () => {
    const f = await seedPracticeReviewFixture();
    const s = await db.session.findFirstOrThrow({ where: { via: 'x' } });
    const actor = { accountId: s.userId, sessionHash: s.tokenHash };
    expect((await list(actor)).page.entries).toEqual([]);
    expect((await list(actor, f.assignment.id)).page.entries).toEqual([]);
  });
  it('returns no revoked appointment and retains original immutable assignment', async () => {
    const f = await seedPracticeReviewFixture();
    await f.revoke();
    expect(
      (await list({ accountId: f.evaluatorId, sessionHash: f.sessionHash })).page.entries,
    ).toEqual([]);
    expect(await db.practiceTrialReviewAssignment.count()).toBe(1);
    expect(await db.practiceTrialReviewRevocation.count()).toBe(1);
  });
  it('excludes already expired appointments using DB time', async () => {
    const f = await seedPracticeReviewFixture({ expiresMs: 120 });
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(
      (await list({ accountId: f.evaluatorId, sessionHash: f.sessionHash })).page.entries,
    ).toEqual([]);
  });
  it('removes assignment expiry that occurs during held post-selection checks', async () => {
    const f = await seedPracticeReviewFixture({ expiresMs: 600 });
    const actor = { accountId: f.evaluatorId, sessionHash: f.sessionHash };
    const result = await runCommandTransaction(db, (tx) =>
      listPracticeReviewInbox(
        {
          ...tx,
          async query<Row>(sql: string, bindings: readonly (string | null)[]) {
            const rows = await tx.query<Row>(sql, bindings);
            if (sql.includes('FROM "PracticeTrialReviewAssignment"'))
              await tx.query('SELECT pg_sleep(0.7)::text', []);
            return rows;
          },
        },
        actor,
        { version: 'v1', after: null },
        () => true,
      ),
    );
    expect(result.page.entries).toEqual([]);
  });
  it('rejects session expiry during SQL waits even for no appointments', async () => {
    const f = await seedPracticeReviewFixture();
    await db.session.update({
      where: { tokenHash: f.sessionHash },
      data: { expiresAt: new Date(Date.now() + 600) },
    });
    await expect(
      runCommandTransaction(db, (tx) =>
        listPracticeReviewInbox(
          {
            ...tx,
            async query<Row>(sql: string, bindings: readonly (string | null)[]) {
              const rows = await tx.query<Row>(sql, bindings);
              if (sql.includes('FROM "PracticeTrialReviewAssignment"'))
                await tx.query('SELECT pg_sleep(0.7)::text', []);
              return rows;
            },
          },
          { accountId: f.evaluatorId, sessionHash: f.sessionHash },
          { version: 'v1', after: null },
          () => true,
        ),
      ),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    expect(
      await db.auditEvent.count({
        where: {
          actorId: f.evaluatorId,
          eventType: 'skill.practice_review_inbox_access_authorized.v1',
        },
      }),
    ).toBe(0);
  });
  it('rejects revoked session, restriction and disabled metadata policy without discovery audit', async () => {
    const f = await seedPracticeReviewFixture();
    const actor = { accountId: f.evaluatorId, sessionHash: f.sessionHash };
    await expect(list(actor, null, false)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db.user.update({ where: { id: f.evaluatorId }, data: { suspended: true } });
    await expect(list(actor)).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
    await db.user.update({ where: { id: f.evaluatorId }, data: { suspended: false } });
    await f.signOut();
    await expect(list(actor)).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    expect(
      await db.auditEvent.count({
        where: {
          actorId: f.evaluatorId,
          eventType: 'skill.practice_review_inbox_access_authorized.v1',
        },
      }),
    ).toBe(0);
  });
  it('paginates own mixed-purpose assignments with20+1 lookahead without duplicate/missing rows', async () => {
    const f = await seedPracticeReviewFixture();
    const s = await db.session.findFirstOrThrow({ where: { via: 'x' } });
    const actor = { accountId: f.evaluatorId, sessionHash: f.sessionHash };
    for (let i = 0; i < 22; i++)
      await runCommandTransaction(db, (tx) =>
        issuePracticeReviewAssignment(
          tx,
          {
            actor: { accountId: s.userId, sessionHash: s.tokenHash },
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-inbox-pages',
            input: {
              version: 'v1',
              submissionId: f.assignment.submissionId,
              evaluatorAccountId: f.evaluatorId,
              purpose: i % 2 ? 'OWNERSHIP_REVIEW' : 'ASSESSMENT_REVIEW',
              reason: 'synthetic only',
              expiresAt: new Date(Date.now() + 60000).toISOString(),
            },
          },
          { allowNewWrites: true, canManage: () => true },
        ),
      );
    const first = (await list(actor)).page;
    expect(first.entries).toHaveLength(20);
    expect(first.nextCursor).toBe(first.entries.at(-1)?.assignmentId);
    const second = (await list(actor, first.nextCursor)).page;
    expect(second.entries).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.entries, ...second.entries].map((row) => row.assignmentId);
    expect(new Set(ids).size).toBe(23);
    expect(ids).toEqual([...ids].sort());
  });
  it('serializes current revocation behind the held evaluator lock, then next observation omits it', async () => {
    const f = await seedPracticeReviewFixture();
    const actor = { accountId: f.evaluatorId, sessionHash: f.sessionHash };
    let release!: () => void, selected!: () => void;
    const paused = new Promise<void>((resolve) => (release = resolve)),
      ready = new Promise<void>((resolve) => (selected = resolve));
    const pending = runCommandTransaction(db, (tx) =>
      listPracticeReviewInbox(
        {
          ...tx,
          async query<Row>(sql: string, bindings: readonly (string | null)[]) {
            const rows = await tx.query<Row>(sql, bindings);
            if (sql.includes('FROM "PracticeTrialReviewAssignment"')) {
              selected();
              await paused;
            }
            return rows;
          },
        },
        actor,
        { version: 'v1', after: null },
        () => true,
      ),
    );
    await ready;
    let revoked = false;
    const revoking = f.revoke().then(() => {
      revoked = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(revoked).toBe(false);
    } finally {
      release();
    }
    expect((await pending).page.entries).toHaveLength(1);
    await revoking;
    expect((await list(actor)).page.entries).toEqual([]);
  });
});
