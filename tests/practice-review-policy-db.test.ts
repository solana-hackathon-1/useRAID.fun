import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { executeIdempotentCommand, type CommandReceiptTransaction } from '../src/command-receipts';
import { publishSkillTaxonomy, type SkillTaxonomyActor } from '../src/skills/taxonomy-storage';
import { publishPracticeTrialDefinition } from '../src/skills/practice-trial-storage';
import { startPracticeTrial } from '../src/skills/practice-trial-attempt-storage';
import { submitPracticeTrial } from '../src/skills/practice-trial-submission-storage';
import {
  issuePracticeReviewAssignment,
  revokePracticeReviewAssignment,
  lockPracticeReviewAssignment,
  type PracticeReviewAssignmentOptions,
} from '../src/skills/practice-review-assignment-storage';
import { definition as fixture } from '../examples/skill-assessments/fixtures';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const catalogId = 'synthetic-submission-catalog',
  trialId = 'synthetic-submission-trial';
let publisher: SkillTaxonomyActor,
  subject: SkillTaxonomyActor,
  startId: string,
  participantId: string;
const skills = [
  { id: 'frontend', domain: 'web', name: 'Frontend', status: 'ACTIVE', aliases: ['frontend'] },
];
async function actor(admin = false, mapped = true) {
  const user = await db.user.create({
    data: {
      handle: 'synthetic',
      role: admin ? 'ADMIN' : 'CREATOR',
      xId: admin ? randomUUID() : null,
    },
  });
  const sessionHash = hash(randomUUID());
  await db.session.create({
    data: {
      tokenHash: sessionHash,
      userId: user.id,
      via: admin ? 'x' : 'wallet',
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  if (mapped)
    await db.participant.create({
      data: {
        accountId: user.id,
        provisionActorAccountId: user.id,
        provisionRequestId: 'synthetic-provision',
      },
    });
  return { accountId: user.id, sessionHash };
}
const publishCatalog = (revision = 0, entries: unknown = skills) =>
  runCommandTransaction(db, (tx) =>
    publishSkillTaxonomy(
      tx,
      {
        actor: publisher,
        input: { taxonomyId: catalogId, expectedRevision: revision, skills: entries },
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-catalog',
      },
      { allowNewWrites: true, canPublish: () => true },
    ),
  );
function definitionInput(revision = 0, availability = 'AVAILABLE') {
  const draft = structuredClone(fixture);
  for (const field of ['reference', 'publishedAt', 'state']) Reflect.deleteProperty(draft, field);
  return {
    trialId,
    expectedRevision: revision,
    taxonomyReference: { recordId: catalogId, revision: 1 },
    availability,
    draft: {
      ...draft,
      maximumAttempts: 3,
      cooldownSeconds: 0,
      rubric: {
        ...draft.rubric,
        reference: { recordId: 'synthetic-submission-rubric', revision: 1 },
      },
    },
  };
}
const publish = (revision = 0, availability = 'AVAILABLE') =>
  runCommandTransaction(db, (tx) =>
    publishPracticeTrialDefinition(
      tx,
      {
        actor: publisher,
        input: definitionInput(revision, availability),
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-definition',
      },
      { allowNewWrites: true, canPublish: () => true },
    ),
  );
const begin = (a = subject) =>
  runCommandTransaction(db, (tx) =>
    startPracticeTrial(
      tx,
      {
        actor: a,
        input: {
          version: 'v1',
          definitionReference: { recordId: trialId, revision: 1 },
          accommodationReference: null,
        },
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-start',
      },
      { allowNewWrites: true },
    ),
  );
function input() {
  return {
    version: 'v1',
    startId,
    expectedDefinitionReference: { recordId: trialId, revision: 1 },
    expectedRubricReference: { recordId: 'synthetic-submission-rubric', revision: 1 },
    answer: '\n  const answer = "<script>literal</script>";\r\n',
    explanation: 'I can explain and modify this invented solution.',
    toolsUsed: ['editor'],
    aiAssistanceUsed: false,
    assistanceDisclosure: 'No AI assistance declared.',
  };
}
const submit = (a = subject, body: unknown = input(), key = randomUUID(), enabled = true) =>
  runCommandTransaction(db, (tx) =>
    submitPracticeTrial(
      tx,
      { actor: a, input: body, idempotencyKey: key, requestId: 'synthetic-submit' },
      { allowNewWrites: enabled },
    ),
  );

let evaluator: SkillTaxonomyActor, submissionId: string;
const policy: PracticeReviewAssignmentOptions = {
  allowNewWrites: true,
  canManage: (s) =>
    s.issuerAccountId === publisher.accountId &&
    s.evaluatorAccountId === evaluator.accountId &&
    s.subjectAccountId === subject.accountId &&
    s.participantId === participantId &&
    s.skillId === 'frontend',
};
const grantInput = () => ({
  version: 'v1',
  submissionId,
  evaluatorAccountId: evaluator.accountId,
  purpose: 'OWNERSHIP_REVIEW',
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  reason: 'Synthetic bounded ownership review.',
});
const issue = (body: unknown = grantInput(), a = publisher, opts = policy, key = randomUUID()) =>
  runCommandTransaction(db, (tx) =>
    issuePracticeReviewAssignment(
      tx,
      { actor: a, input: body, idempotencyKey: key, requestId: 'synthetic-issue' },
      opts,
    ),
  );
const revoke = (
  id: string,
  a = publisher,
  opts = policy,
  key = randomUUID(),
  reason = 'Synthetic case access revoked.',
) =>
  runCommandTransaction(db, (tx) =>
    revokePracticeReviewAssignment(
      tx,
      {
        actor: a,
        input: { version: 'v1', assignmentId: id, reason },
        idempotencyKey: key,
        requestId: 'synthetic-revoke',
      },
      opts,
    ),
  );
const use = (
  id: string,
  a = evaluator,
  sub = submissionId,
  purpose: 'OWNERSHIP_REVIEW' | 'ASSESSMENT_REVIEW' = 'OWNERSHIP_REVIEW',
  canUse: Parameters<typeof lockPracticeReviewAssignment>[3] = () => true,
) =>
  runCommandTransaction(db, (tx) =>
    lockPracticeReviewAssignment(tx, a, { assignmentId: id, submissionId: sub, purpose }, canUse),
  );

import {
  publishPracticeReviewPolicy,
  observeApprovedPracticeReviewPolicy,
  readPracticeReviewPolicyAsAdmin,
  lockApprovedPracticeReviewPolicy,
  type PracticeReviewPolicyOptions,
} from '../src/skills/practice-review-policy-storage';
const policyId = 'synthetic-ownership-policy';
let assignmentId: string;
const policyInput = () => ({
  version: 'v1',
  policyId,
  expectedRevision: 0,
  definitionReference: { recordId: trialId, revision: 1 },
  purpose: 'OWNERSHIP_REVIEW',
  state: 'APPROVED',
  guidance:
    'Synthetic manual review guidance; original accepted rubric/tool rules remain authoritative.',
});
const publicationOptions: PracticeReviewPolicyOptions = {
  allowNewWrites: true,
  canPublish: (scope) =>
    scope.accountId === publisher.accountId &&
    scope.definitionReference.recordId === trialId &&
    scope.skillId === 'frontend',
};
const publishPolicy = (
  body: unknown = policyInput(),
  a = publisher,
  options = publicationOptions,
  key = randomUUID(),
) =>
  runCommandTransaction(db, (tx) =>
    publishPracticeReviewPolicy(
      tx,
      { actor: a, input: body, idempotencyKey: key, requestId: 'synthetic-policy' },
      options,
    ),
  );
const adminRead = (
  id = policyId,
  revision: number | undefined = undefined,
  a = publisher,
  canPublish = publicationOptions.canPublish,
) =>
  runCommandTransaction(db, (tx) =>
    readPracticeReviewPolicyAsAdmin(tx, a, id, revision, canPublish),
  );
const policyLookupInput = () => ({
  version: 'v1',
  assignmentId,
  submissionId,
  purpose: 'OWNERSHIP_REVIEW',
  expectedPolicyReference: { recordId: policyId, revision: 1 },
});
const lookupPolicy = (
  body: unknown = policyLookupInput(),
  a = evaluator,
  canUse: Parameters<typeof lockApprovedPracticeReviewPolicy>[3] = () => true,
) => runCommandTransaction(db, (tx) => lockApprovedPracticeReviewPolicy(tx, a, body, canUse));
integration('T013D3 actual approved review policy source', () => {
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    await truncateAll(db);
    publisher = await actor(true, false);
    subject = await actor();
    evaluator = await actor(false, false);
    await publishCatalog();
    await publish();
    const started = await begin();
    startId = started.start.id;
    participantId = started.start.participantId;
    submissionId = (await submit()).submission.reference.recordId;
    assignmentId = (await issue()).assignment.id;
  });
  afterAll(() => db.$disconnect());
  it('observes canonical current approved policy from actual case scope without a guessed client version, while decision lookup still requires exact expectation', async () => {
    const r = await publishPolicy();
    const scope = { version: 'v1', assignmentId, submissionId, purpose: 'OWNERSHIP_REVIEW' };
    const view = await runCommandTransaction(db, (tx) =>
      observeApprovedPracticeReviewPolicy(tx, evaluator, scope, () => true),
    );
    expect(view?.policy).toEqual(r.policy);
    await expect(
      lookupPolicy({ ...policyLookupInput(), expectedPolicyReference: null }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await publishPolicy({ ...policyInput(), expectedRevision: 1, state: 'WITHDRAWN' });
    expect(
      await runCommandTransaction(db, (tx) =>
        observeApprovedPracticeReviewPolicy(tx, evaluator, scope, () => true),
      ),
    ).toBeNull();
  });
  it('publishes actual immutable scoped policy provenance and current approved source without ownership or rank', async () => {
    const r = await publishPolicy();
    expect(r.status).toBe('EXECUTED');
    expect(await use(assignmentId)).not.toBeNull();
    expect(r.policy).toMatchObject({
      version: 'v1',
      reference: { recordId: policyId, revision: 1 },
      definitionReference: { recordId: trialId, revision: 1 },
      rubricReference: { recordId: 'synthetic-submission-rubric', revision: 1 },
      skillId: 'frontend',
      skillDomain: 'web',
      purpose: 'OWNERSHIP_REVIEW',
      state: 'APPROVED',
      guidance: policyInput().guidance,
      publishedByAccountId: publisher.accountId,
      persisted: true,
      verifiesSkill: false,
      confirmsOwnership: false,
      createsPermissionGrant: false,
      isAuthorizationToken: false,
      consumesCapacity: false,
      createsFinancialObligation: false,
    });
    expect((await adminRead())?.policy).toEqual(r.policy);
    expect((await lookupPolicy())?.policy).toEqual(r.policy);
  });
  it('keeps original receipts/history with new writes off and after withdrawal; old approval cannot be selected for a new decision', async () => {
    const body = policyInput(),
      key = randomUUID(),
      first = await publishPolicy(body, publisher, publicationOptions, key);
    const withdrawn = await publishPolicy({
      ...body,
      expectedRevision: 1,
      state: 'WITHDRAWN',
      guidance: 'Synthetic withdrawal pending review.',
    });
    expect(withdrawn.policy.reference.revision).toBe(2);
    await expect(lookupPolicy()).rejects.toMatchObject({ code: 'REVISION_CHANGED' });
    expect(
      await lookupPolicy({
        ...policyLookupInput(),
        expectedPolicyReference: { recordId: policyId, revision: 2 },
      }),
    ).toBeNull();
    expect((await adminRead(policyId, 1))?.policy).toEqual(first.policy);
    const replay = await publishPolicy(
      body,
      publisher,
      { ...publicationOptions, allowNewWrites: false },
      key,
    );
    expect(replay.status).toBe('REPLAYED');
    expect(replay.policy).toEqual(first.policy);
    await expect(
      publishPolicy({ ...body, guidance: 'Changed body' }, publisher, publicationOptions, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
  it('requires approved initial version and gates new writes without deleting approved records', async () => {
    await expect(publishPolicy({ ...policyInput(), state: 'WITHDRAWN' })).rejects.toMatchObject({
      code: 'INITIAL_STATE_INVALID',
    });
    await expect(
      publishPolicy(policyInput(), publisher, { ...publicationOptions, allowNewWrites: false }),
    ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    await publishPolicy();
    expect(await lookupPolicy()).not.toBeNull();
  });
  it('requires CAS/current contiguous history and permits explicit reapproval as the next version', async () => {
    await publishPolicy();
    await expect(publishPolicy()).rejects.toMatchObject({ code: 'REVISION_CHANGED' });
    await publishPolicy({ ...policyInput(), expectedRevision: 1, state: 'WITHDRAWN' });
    const third = await publishPolicy({
      ...policyInput(),
      expectedRevision: 2,
      guidance: 'Synthetic corrected guidance.',
    });
    expect(third.policy.reference.revision).toBe(3);
    expect(
      (
        await lookupPolicy({
          ...policyLookupInput(),
          expectedPolicyReference: { recordId: policyId, revision: 3 },
        })
      )?.policy,
    ).toEqual(third.policy);
  });
  it('prevents competing policy families for the same actual definition and purpose', async () => {
    await publishPolicy();
    await expect(
      publishPolicy({ ...policyInput(), policyId: 'synthetic-weaker-alternative' }),
    ).rejects.toMatchObject({ code: 'POLICY_SCOPE_EXISTS' });
  });
  it('does not migrate a policy family to another actual definition version or purpose', async () => {
    await publishPolicy();
    await publish(1);
    await expect(
      publishPolicy({
        ...policyInput(),
        expectedRevision: 1,
        definitionReference: { recordId: trialId, revision: 2 },
      }),
    ).rejects.toMatchObject({ code: 'FAMILY_CHANGED' });
    await expect(
      publishPolicy({ ...policyInput(), expectedRevision: 1, purpose: 'ASSESSMENT_REVIEW' }),
    ).rejects.toMatchObject({ code: 'FAMILY_CHANGED' });
  });
  it('resolves canonical policy by actual accepted definition/purpose, never a caller-selected other scope', async () => {
    await publishPolicy();
    await publish(1);
    await publishPolicy({
      ...policyInput(),
      policyId: 'synthetic-later-policy',
      definitionReference: { recordId: trialId, revision: 2 },
    });
    await expect(
      lookupPolicy({
        ...policyLookupInput(),
        expectedPolicyReference: { recordId: 'synthetic-later-policy', revision: 1 },
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CHANGED' });
    expect((await lookupPolicy())?.policy.definitionReference).toEqual({
      recordId: trialId,
      revision: 1,
    });
  });
  it('preserves original definition/rubric scope after retirement', async () => {
    await publish(1, 'RETIRED');
    const r = await publishPolicy();
    expect((await lookupPolicy())?.policy).toEqual(r.policy);
  });
  it('handles separately approved assessment purpose only with its own actual assignment', async () => {
    const r = await publishPolicy({
      ...policyInput(),
      policyId: 'synthetic-assessment-policy',
      purpose: 'ASSESSMENT_REVIEW',
    });
    expect(
      await lookupPolicy({
        ...policyLookupInput(),
        purpose: 'ASSESSMENT_REVIEW',
        expectedPolicyReference: r.policy.reference,
      }),
    ).toBeNull();
    const g = await issue({ ...grantInput(), purpose: 'ASSESSMENT_REVIEW' });
    expect(
      (
        await lookupPolicy({
          ...policyLookupInput(),
          assignmentId: g.assignment.id,
          purpose: 'ASSESSMENT_REVIEW',
          expectedPolicyReference: r.policy.reference,
        })
      )?.policy,
    ).toEqual(r.policy);
  });
  it.each(['wallet', 'CREATOR', 'no-x', 'suspended', 'expired', 'deleted'])(
    'requires current actual X-admin publication authority: %s',
    async (change) => {
      if (change === 'wallet')
        await db.session.update({
          where: { tokenHash: publisher.sessionHash },
          data: { via: 'wallet' },
        });
      if (change === 'CREATOR')
        await db.user.update({ where: { id: publisher.accountId }, data: { role: 'CREATOR' } });
      if (change === 'no-x')
        await db.user.update({ where: { id: publisher.accountId }, data: { xId: null } });
      if (change === 'suspended')
        await db.user.update({ where: { id: publisher.accountId }, data: { suspended: true } });
      if (change === 'expired')
        await db.session.update({
          where: { tokenHash: publisher.sessionHash },
          data: { expiresAt: new Date(0) },
        });
      if (change === 'deleted')
        await db.session.delete({ where: { tokenHash: publisher.sessionHash } });
      await expect(publishPolicy()).rejects.toMatchObject({
        code:
          change === 'suspended'
            ? 'ACCOUNT_RESTRICTED'
            : ['expired', 'deleted'].includes(change)
              ? 'AUTHENTICATION_REQUIRED'
              : 'FORBIDDEN',
      });
    },
  );
  it.each([false, undefined, 'true'])(
    'requires exact true current scoped publication/use authority %s',
    async (value) => {
      await expect(
        publishPolicy(policyInput(), publisher, {
          ...publicationOptions,
          canPublish: () => value as boolean,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await publishPolicy();
      expect(await adminRead(policyId, undefined, publisher, () => value as boolean)).toBeNull();
      expect(await lookupPolicy(policyLookupInput(), evaluator, () => value as boolean)).toBeNull();
    },
  );
  it('rechecks management authority on replay and does not treat a saved policy as a bearer token', async () => {
    const body = policyInput(),
      key = randomUUID();
    await publishPolicy(body, publisher, publicationOptions, key);
    await db.user.update({ where: { id: publisher.accountId }, data: { role: 'CREATOR' } });
    await expect(publishPolicy(body, publisher, publicationOptions, key)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await lookupPolicy()).not.toBeNull();
  });
  it.each(['admin', 'subject', 'other-evaluator', 'wrong-submission', 'wrong-purpose', 'revoked'])(
    'denies %s policy guidance before private selection',
    async (denial) => {
      await publishPolicy();
      let a = evaluator,
        body = policyLookupInput();
      if (denial === 'admin') a = publisher;
      if (denial === 'subject') a = subject;
      if (denial === 'other-evaluator') a = await actor(false, false);
      if (denial === 'wrong-submission') {
        const foreign = await actor(),
          started = await begin(foreign),
          saved = await submit(foreign, { ...input(), startId: started.start.id }, randomUUID());
        body = { ...body, submissionId: saved.submission.reference.recordId };
      }
      if (denial === 'wrong-purpose') body = { ...body, purpose: 'ASSESSMENT_REVIEW' };
      if (denial === 'revoked') await revoke(assignmentId);
      let privateQueries = 0;
      expect(
        await runCommandTransaction(db, (tx) =>
          lockApprovedPracticeReviewPolicy(
            {
              ...tx,
              async query<Row>(sql: string, bindings: readonly (string | null)[]) {
                if (sql.includes('"guidance"')) privateQueries++;
                return tx.query<Row>(sql, bindings);
              },
            },
            a,
            body,
            () => true,
          ),
        ),
      ).toBeNull();
      expect(privateQueries).toBe(0);
    },
  );
  it.each(['expired', 'deleted', 'foreign-session', 'suspended'])(
    'requires evaluator current own session at use: %s',
    async (change) => {
      await publishPolicy();
      if (change === 'expired')
        await db.session.update({
          where: { tokenHash: evaluator.sessionHash },
          data: { expiresAt: new Date(0) },
        });
      if (change === 'deleted')
        await db.session.delete({ where: { tokenHash: evaluator.sessionHash } });
      if (change === 'suspended')
        await db.user.update({ where: { id: evaluator.accountId }, data: { suspended: true } });
      const a =
        change === 'foreign-session'
          ? { ...evaluator, sessionHash: subject.sessionHash }
          : evaluator;
      await expect(lookupPolicy(policyLookupInput(), a)).rejects.toMatchObject({
        code: change === 'suspended' ? 'ACCOUNT_RESTRICTED' : 'AUTHENTICATION_REQUIRED',
      });
    },
  );
  it('does not let ordinary authenticated users inspect private administration guidance', async () => {
    await publishPolicy();
    await expect(adminRead(policyId, undefined, subject)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
  it('returns current policy-unavailable for missing canonical scope without inventing approval', async () => {
    expect(await lookupPolicy()).toBeNull();
    expect(await adminRead()).toBeNull();
    await expect(
      publishPolicy({
        ...policyInput(),
        definitionReference: { recordId: 'missing-trial', revision: 1 },
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });
  it('stores only opaque private policy references in audit/outbox, never guidance or answer', async () => {
    const r = await publishPolicy();
    await adminRead();
    await lookupPolicy();
    const events = await db.$queryRawUnsafe<{ payload: unknown }[]>(
      `SELECT "payload" FROM "AuditEvent" WHERE "eventType" LIKE 'skill.practice_review_policy_%'`,
    );
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const e of events) {
      expect(Object.keys(e.payload as object)).toEqual(['practiceReviewPolicyVersionId']);
      expect(JSON.stringify(e)).not.toContain(r.policy.guidance);
      expect(JSON.stringify(e)).not.toContain(input().answer);
    }
    expect(await db.outboxEvent.count()).toBe(0);
  });
  async function waitForPolicyLock(pid: number) {
    for (let i = 0; i < 100; i++) {
      const [r] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
        "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
        pid,
      );
      if (r?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Expected owned policy backend to wait on actual PostgreSQL lock');
  }
  it('rechecks expired assignment after canonical policy wait before authorizing or auditing policy use', async () => {
    await publishPolicy();
    assignmentId = (
      await issue({ ...grantInput(), expiresAt: new Date(Date.now() + 2000).toISOString() })
    ).assignment.id;
    const [d] = await db.$queryRawUnsafe<{ id: string }[]>(
      'SELECT "id"::text FROM "PracticeTrialVersion" WHERE "trialId"=$1 AND "revision"=1',
      trialId,
    );
    let release!: () => void, locked!: () => void, pidReady!: (id: number) => void;
    const hold = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (locked = r)),
      waitingPid = new Promise<number>((r) => (pidReady = r));
    const blocker = runCommandTransaction(db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,12019))::text', [
        d.id + ':OWNERSHIP_REVIEW',
      ]);
      locked();
      await hold;
    });
    await ready;
    let policyChecks = 0;
    const reading = runCommandTransaction(db, async (tx) => {
      const [r] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', []);
      pidReady(r.pid);
      return lockApprovedPracticeReviewPolicy(tx, evaluator, policyLookupInput(), () => {
        policyChecks++;
        return true;
      });
    }).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    try {
      await waitForPolicyLock(await waitingPid);
      await new Promise((r) => setTimeout(r, 2100));
    } finally {
      release();
      await blocker;
    }
    const outcome = await reading;
    expect(outcome.error).toBeNull();
    expect(outcome.value).toBeNull();
    expect(policyChecks).toBe(0);
    expect(
      await db.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM "AuditEvent" WHERE "eventType"='skill.practice_review_policy_use_authorized.v1'`,
      ),
    ).toEqual([{ n: 0 }]);
  });
  async function rawPolicy(
    patch: {
      guidance?: string;
      revision?: number;
      state?: string;
      purpose?: string;
      definitionId?: string;
      publishedAt?: string;
      publisherId?: string;
      kind?: string;
      wrongActor?: boolean;
      noAudit?: boolean;
      publishOutbox?: boolean;
      wrongPayload?: boolean;
      wrongResult?: boolean;
      noFamily?: boolean;
      wrongFamilyPurpose?: boolean;
      wrongPointer?: boolean;
    } = {},
  ) {
    const [d] = await db.$queryRawUnsafe<{ id: string }[]>(
      'SELECT "id"::text FROM "PracticeTrialVersion" WHERE "trialId"=$1 AND "revision"=1',
      trialId,
    );
    const id = randomUUID(),
      familyId = 'synthetic-raw-policy-' + randomUUID(),
      purpose = patch.purpose ?? 'OWNERSHIP_REVIEW',
      revision = patch.revision ?? 1,
      definitionId = patch.definitionId ?? d.id;
    await runCommandTransaction(db, (tx) =>
      executeIdempotentCommand(
        tx,
        {
          actorId: patch.wrongActor ? evaluator.accountId : publisher.accountId,
          commandKind: patch.kind ?? 'PublishPracticeReviewPolicy',
          idempotencyKey: randomUUID(),
          requestId: 'raw-policy',
          request: patch,
        },
        async ({ receiptId }) => {
          await tx.query(
            'INSERT INTO "PracticeReviewPolicyVersion"("id","policyId","definitionVersionId","purpose","revision","state","guidance","publishedByAccountId","publishedAt","receiptId","requestId") VALUES($1::uuid,$2,$3::uuid,$4,$5::int,$6,$7,$8,COALESCE($9::timestamptz,date_trunc(\'milliseconds\',clock_timestamp())),$10::uuid,$11)',
            [
              id,
              familyId,
              definitionId,
              purpose,
              String(revision),
              patch.state ?? 'APPROVED',
              patch.guidance ?? 'Synthetic raw approved guidance',
              patch.publisherId ?? publisher.accountId,
              patch.publishedAt ?? null,
              receiptId,
              'raw-policy',
            ],
          );
          if (!patch.noFamily)
            await tx.query(
              'INSERT INTO "PracticeReviewPolicy"("id","definitionVersionId","purpose","revision","currentVersionId") VALUES($1,$2::uuid,$3,$4::int,$5::uuid)',
              [
                familyId,
                definitionId,
                patch.wrongFamilyPurpose ? 'ASSESSMENT_REVIEW' : purpose,
                String(revision),
                patch.wrongPointer ? randomUUID() : id,
              ],
            );
          return {
            resultRef: patch.wrongResult ? randomUUID() : id,
            events: patch.noAudit
              ? []
              : [
                  {
                    type: 'skill.practice_review_policy_published.v1',
                    aggregateId: familyId,
                    aggregateVersion: revision,
                    payload: {
                      practiceReviewPolicyVersionId: patch.wrongPayload ? randomUUID() : id,
                    },
                    publish: patch.publishOutbox ?? false,
                  },
                ],
          };
        },
      ),
    );
    return { id, familyId };
  }
  it('raw SQL valid control commits actual scoped policy only with finalized matching admin receipt/private audit', async () => {
    const r = await rawPolicy();
    expect(
      (
        await lookupPolicy({
          ...policyLookupInput(),
          expectedPolicyReference: { recordId: r.familyId, revision: 1 },
        })
      )?.policy.id,
    ).toBe(r.id);
  });
  it.each([
    { guidance: ' ' },
    { guidance: ' untrimmed ' },
    { guidance: '😀'.repeat(2001) },
    { revision: 0 },
    { revision: 2 },
    { state: 'WITHDRAWN' },
    { state: 'AUTO_APPROVED' },
    { purpose: 'ANY' },
    { definitionId: '00000000-0000-4000-8000-000000000000' },
    { publishedAt: '2000-01-01T00:00:00.000Z' },
    { publishedAt: '2100-01-01T00:00:00.000Z' },
    { kind: 'WrongKind' },
    { wrongActor: true },
    { noAudit: true },
    { publishOutbox: true },
    { wrongPayload: true },
    { wrongResult: true },
    { noFamily: true },
    { wrongFamilyPurpose: true },
    { wrongPointer: true },
  ])('raw SQL rejects invalid policy shape/scope/receipt/audit %s', async (patch) => {
    await expect(rawPolicy(patch)).rejects.toBeDefined();
    expect(
      await db.$queryRawUnsafe(
        'SELECT (SELECT count(*)::int FROM "PracticeReviewPolicy") families,(SELECT count(*)::int FROM "PracticeReviewPolicyVersion") versions',
      ),
    ).toEqual([{ families: 0, versions: 0 }]);
  });
  it('raw SQL rejects nonadministrator policy approver regardless of a forged finalization envelope', async () => {
    await expect(rawPolicy({ publisherId: evaluator.accountId })).rejects.toBeDefined();
  });
  it('raw SQL cannot create a second policy family for the same original definition/purpose', async () => {
    const first = await publishPolicy();
    await expect(rawPolicy()).rejects.toBeDefined();
    expect((await lookupPolicy())?.policy).toEqual(first.policy);
  });
  it.each([
    'UPDATE "PracticeReviewPolicyVersion" SET "guidance"=\'rewritten\' WHERE "id"=$1::uuid',
    'UPDATE "PracticeReviewPolicyVersion" SET "id"="id" WHERE "id"=$1::uuid',
    'DELETE FROM "PracticeReviewPolicyVersion" WHERE "id"=$1::uuid',
  ])('SQL preserves immutable approval history %s', async (sql) => {
    const first = await publishPolicy();
    await expect(db.$executeRawUnsafe(sql, first.policy.id)).rejects.toBeDefined();
    expect((await adminRead())?.policy).toEqual(first.policy);
  });
  it('SQL cannot delete canonical policy identity or rewind its current version', async () => {
    const first = await publishPolicy();
    await publishPolicy({ ...policyInput(), expectedRevision: 1, state: 'WITHDRAWN' });
    await expect(
      db.$executeRawUnsafe('DELETE FROM "PracticeReviewPolicy" WHERE "id"=$1', policyId),
    ).rejects.toBeDefined();
    await expect(
      db.$executeRawUnsafe(
        'UPDATE "PracticeReviewPolicy" SET "revision"=1,"currentVersionId"=$2::uuid WHERE "id"=$1',
        policyId,
        first.policy.id,
      ),
    ).rejects.toBeDefined();
    expect(
      await lookupPolicy({
        ...policyLookupInput(),
        expectedPolicyReference: { recordId: policyId, revision: 2 },
      }),
    ).toBeNull();
  });
  it('normalizes exact-bound supplementary guidance before UTF16 storage and original receipt digest', async () => {
    const guidance = '😀'.repeat(2000),
      body = { ...policyInput(), guidance: ' ' + guidance + ' ' },
      key = randomUUID();
    const first = await publishPolicy(body, publisher, publicationOptions, key);
    expect(first.policy.guidance).toBe(guidance);
    expect(
      (
        await publishPolicy(
          { ...body, guidance },
          publisher,
          { ...publicationOptions, allowNewWrites: false },
          key,
        )
      ).policy,
    ).toEqual(first.policy);
  });
  it('serializes simultaneous canonical scope publication across actual distinct administrators', async () => {
    const other = await actor(true, false),
      opts = { ...publicationOptions, canPublish: () => true };
    const results = await Promise.allSettled([
      publishPolicy(policyInput(), publisher, opts),
      publishPolicy({ ...policyInput(), policyId: 'synthetic-competitor' }, other, opts),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected');
    expect(failure?.status === 'rejected' ? failure.reason : null).toMatchObject({
      code: 'POLICY_SCOPE_EXISTS',
    });
    expect(await db.$queryRawUnsafe('SELECT count(*)::int n FROM "PracticeReviewPolicy"')).toEqual([
      { n: 1 },
    ]);
  });
  it('serializes simultaneous same-family CAS updates without rewriting the winning snapshot', async () => {
    await publishPolicy();
    const results = await Promise.allSettled([
      publishPolicy({
        ...policyInput(),
        expectedRevision: 1,
        guidance: 'First concurrent guidance',
      }),
      publishPolicy({
        ...policyInput(),
        expectedRevision: 1,
        guidance: 'Second concurrent guidance',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected');
    expect(failed?.status === 'rejected' ? failed.reason : null).toMatchObject({
      code: 'REVISION_CHANGED',
    });
    expect((await adminRead())?.policy.reference.revision).toBe(2);
  });
  it.each(['admin', 'reviewer'])(
    'records %s private guidance access before selecting it and fails closed if audit persistence fails',
    async (who) => {
      await publishPolicy();
      const event =
        who === 'admin'
          ? 'skill.practice_review_policy_access_authorized.v1'
          : 'skill.practice_review_policy_use_authorized.v1';
      const [before] = await db.$queryRawUnsafe<{ n: number }[]>(
        'SELECT count(*)::int n FROM "AuditEvent" WHERE "eventType"=$1',
        event,
      );
      let observed = false;
      const run = (failAudit: boolean) =>
        runCommandTransaction(db, (tx) => {
          const wrapped: CommandReceiptTransaction = {
            ...tx,
            async query<Row>(sql: string, bindings: readonly (string | null)[]) {
              if (failAudit && sql.includes('INSERT INTO "AuditEvent"'))
                throw new Error('private-policy-audit-marker');
              if (sql.includes('SELECT "guidance"')) {
                const [row] = await tx.query<{ n: number }>(
                  'SELECT count(*)::int n FROM "AuditEvent" WHERE "eventType"=$1',
                  [event],
                );
                expect(row.n).toBe(before.n + 1);
                observed = true;
              }
              return tx.query<Row>(sql, bindings);
            },
          };
          return who === 'admin'
            ? readPracticeReviewPolicyAsAdmin(
                wrapped,
                publisher,
                policyId,
                undefined,
                publicationOptions.canPublish,
              )
            : lockApprovedPracticeReviewPolicy(wrapped, evaluator, policyLookupInput(), () => true);
        });
      expect((await run(false))?.private).toBe(true);
      expect(observed).toBe(true);
      observed = false;
      const failure = run(true);
      await expect(failure).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      await expect(failure).rejects.not.toThrow('private-policy-audit-marker');
      expect(observed).toBe(false);
    },
  );
  it('does not return guidance after current scoped use policy changes during its query', async () => {
    await publishPolicy();
    let enabled = true;
    const r = await runCommandTransaction(db, (tx) =>
      lockApprovedPracticeReviewPolicy(
        {
          ...tx,
          async query<Row>(sql: string, bindings: readonly (string | null)[]) {
            const rows = await tx.query<Row>(sql, bindings);
            if (sql.includes('SELECT "guidance"')) enabled = false;
            return rows;
          },
        },
        evaluator,
        policyLookupInput(),
        () => enabled,
      ),
    );
    expect(r).toBeNull();
  });
  it('sanitizes thrown publication or current use policy and never returns private error text', async () => {
    const broken = () => {
      throw new Error('private-policy-marker');
    };
    await expect(
      publishPolicy(policyInput(), publisher, { ...publicationOptions, canPublish: broken }),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await publishPolicy();
    const r = lookupPolicy(policyLookupInput(), evaluator, broken);
    await expect(r).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(r).rejects.not.toThrow('private-policy-marker');
  });
});
it.each([
  { guidance: ' ' },
  { guidance: '😀'.repeat(2001) },
  { guidance: 'a\0b' },
  { guidance: 'a\ud800b' },
  { state: 'AUTO_APPROVED' },
  { expectedRevision: 2147483647 },
  { definitionReference: { recordId: 'trial', revision: 0 } },
  { approved: true },
])('rejects malformed policy before any receipt/query %s', async (patch) => {
  let calls = 0;
  const tx: CommandReceiptTransaction = {
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    async query() {
      calls++;
      return [];
    },
  };
  await expect(
    publishPracticeReviewPolicy(
      tx,
      {
        actor: { accountId: 'a', sessionHash: 'a'.repeat(64) },
        input: {
          version: 'v1',
          policyId: 'p',
          expectedRevision: 0,
          definitionReference: { recordId: 'trial', revision: 1 },
          purpose: 'OWNERSHIP_REVIEW',
          state: 'APPROVED',
          guidance: 'Synthetic guidance',
          ...patch,
        },
        idempotencyKey: 'key',
        requestId: 'r',
      },
      { allowNewWrites: true, canPublish: () => true },
    ),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(calls).toBe(0);
});
