import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { createRootEvidenceSnapshotHost } from '../src/lib/work-evidence-snapshot-host';
import {
  recordEvidenceSnapshot,
  readEvidenceSnapshot,
} from '../src/work-loop/evidence-snapshot-storage';
import { submitApplication } from '../src/work-loop/admission-storage';
import { seedWorkHuman, seedWorkSlot } from './helpers/work-loop-db';
import { seedOwnAssessmentFixture, db } from './helpers/own-assessment-fixture';
import { assertTestDatabase } from './helpers/db-guard';

/** #331: the shared Root host reads the applicant's REAL current assessment for exactly the skills they chose. */
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
const cmd = (actor: { accountId: string; sessionHash: string }, input: unknown) => {
  const key = randomUUID();
  return { actor, input, idempotencyKey: key, requestId: key };
};
const admission = {
  allowNewWrites: true,
  applicationLimit: 5,
  authorize: async () => true,
};

integration('#331 Root evidence-snapshot host over real skill assessments', () => {
  afterAll(() => db.$disconnect());

  it('freezes the verified rank, ignores a later revocation, and never reads unchosen skills', async () => {
    assertTestDatabase();
    const fx = await seedOwnAssessmentFixture(true);
    const applicant = { accountId: fx.ownerId, sessionHash: fx.cookieHash };
    const founder = await seedWorkHuman(db as never, 'founder-' + randomUUID());
    const slot = await seedWorkSlot(db as never, founder.actor.accountId, {
      admission: 'APPLICATION',
      requiredSkills: [
        { skillId: 'frontend', minimumRank: 'E', assessmentPolicyVersion: 'p1' },
        { skillId: 'backend', minimumRank: 'E', assessmentPolicyVersion: 'p1' },
      ],
    });
    const application = await run((tx) =>
      submitApplication(
        tx,
        cmd(applicant, {
          slotId: slot.slotId,
          termsVersionId: slot.termsVersionId,
          evidenceRefs: [],
        }),
        admission,
      ),
    );
    const host = createRootEvidenceSnapshotHost({
      allowNewWrites: true,
      isOperator: (id) => id === founder.actor.accountId,
    });
    const applicationId = application.application.id;
    // Sharing a required skill the applicant has no assessment for, beside one they do, never invents a rank.
    const saved = await run((tx) =>
      recordEvidenceSnapshot(
        tx,
        cmd(applicant, { applicationId, sharedSkillIds: ['frontend', 'backend'], consent: true }),
        host,
      ),
    );
    expect(saved.snapshot.skills).toEqual([
      {
        skillId: 'frontend',
        rank: expect.stringMatching(/^[EDCBA]$/),
        status: 'VERIFIED',
        assessedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
      },
      { skillId: 'backend', rank: null, status: 'NOT_ASSESSED', assessedAt: null },
    ]);
    await fx.decide('REVOKE');
    const live = await run((tx) =>
      host.readSkillRecords(tx, { accountId: fx.ownerId, participantId: fx.participantId }, [
        'frontend',
      ]),
    );
    expect(live).toEqual([expect.objectContaining({ skillId: 'frontend', status: 'REVOKED' })]);
    const seen = await run((tx) => readEvidenceSnapshot(tx, founder.actor, applicationId, host));
    expect(seen.snapshot?.skills[0]).toMatchObject({ skillId: 'frontend', status: 'VERIFIED' });
    // The synthetic operator allowlist, not any account, is the reviewer authority.
    await expect(
      run((tx) =>
        readEvidenceSnapshot(
          tx,
          founder.actor,
          applicationId,
          createRootEvidenceSnapshotHost({ allowNewWrites: true, isOperator: () => false }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
