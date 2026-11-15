import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { submitApplication, withdrawApplication } from '../src/work-loop/admission-storage';
import type { AdmissionHost } from '../src/work-loop/admission-contracts';
import {
  recordEvidenceSnapshot,
  withdrawEvidenceSnapshot,
  readEvidenceSnapshot,
} from '../src/work-loop/evidence-snapshot-storage';
import type {
  EvidenceSnapshotHost,
  SkillRecord,
} from '../src/work-loop/evidence-snapshot-contracts';
import { seedWorkHuman, seedWorkSlot } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
type Actor = { accountId: string; sessionHash: string };
const cmd = (actor: Actor, input: unknown, key = randomUUID()) => ({
  actor,
  input,
  idempotencyKey: key,
  requestId: key,
});
const admission: AdmissionHost = {
  allowNewWrites: true,
  applicationLimit: 5,
  authorize: async (_tx, a) => a.accountId.startsWith('founder-'),
};
/** An opaque evidence reference on the application itself: it must never reach any snapshot or view. */
const PRIVATE_REF = 'private-evidence-link-do-not-leak';
/** The skill records a host would read for the applicant. */
let records: SkillRecord[] = [];
const asked: string[][] = [];
const snapshotHost = (over: Partial<EvidenceSnapshotHost> = {}): EvidenceSnapshotHost => ({
  allowNewWrites: true,
  authorize: async (_tx, a) => a.accountId.startsWith('founder-'),
  readSkillRecords: async (_tx, _subject, skillIds) => {
    asked.push([...skillIds]);
    return records.filter((r) => skillIds.includes(r.skillId));
  },
  ...over,
});
async function setup() {
  const applicant = await seedWorkHuman(db),
    founder = await seedWorkHuman(db, 'founder-' + randomUUID());
  const slot = await seedWorkSlot(db, founder.actor.accountId, {
    admission: 'APPLICATION',
    requiredSkills: [
      { skillId: 'writing', minimumRank: 'E', assessmentPolicyVersion: 'starter-v1' },
      { skillId: 'design', minimumRank: 'E', assessmentPolicyVersion: 'starter-v1' },
    ],
  });
  const application = await run((tx) =>
    submitApplication(
      tx,
      cmd(applicant.actor, {
        slotId: slot.slotId,
        termsVersionId: slot.termsVersionId,
        evidenceRefs: [PRIVATE_REF],
      }),
      admission,
    ),
  );
  return { applicant, founder, slot, applicationId: application.application.id };
}
const share = (
  actor: Actor,
  applicationId: string,
  sharedSkillIds = ['writing'],
  host = snapshotHost(),
) =>
  run((tx) =>
    recordEvidenceSnapshot(tx, cmd(actor, { applicationId, sharedSkillIds, consent: true }), host),
  );
const unshare = (actor: Actor, applicationId: string) =>
  run((tx) => withdrawEvidenceSnapshot(tx, cmd(actor, { applicationId })));
const view = (actor: Actor, applicationId: string, host = snapshotHost()) =>
  run((tx) => readEvidenceSnapshot(tx, actor, applicationId, host));

integration('#331 applicant-consented per-application evidence snapshot', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
    asked.length = 0;
    records = [
      { skillId: 'writing', rank: 'C', status: 'VERIFIED', assessedAt: '2026-10-01T00:00:00.000Z' },
      { skillId: 'design', rank: 'B', status: 'VERIFIED', assessedAt: '2026-10-02T00:00:00.000Z' },
    ];
  });
  afterAll(() => db.$disconnect());

  it('shows the reviewer exactly the skills the applicant chose to share, and nothing else', async () => {
    const s = await setup();
    const none = await view(s.founder.actor, s.applicationId);
    expect(none).toMatchObject({ role: 'REVIEWER', availability: 'NOT_SHARED', snapshot: null });
    const saved = await share(s.applicant.actor, s.applicationId, ['writing']);
    expect(saved.status).toBe('EXECUTED');
    expect(asked).toEqual([['writing']]);
    const seen = await view(s.founder.actor, s.applicationId);
    expect(seen.availability).toBe('SHARED');
    expect(seen.snapshot?.skills).toEqual([
      { skillId: 'writing', rank: 'C', status: 'VERIFIED', assessedAt: '2026-10-01T00:00:00.000Z' },
    ]);
    const text = JSON.stringify(seen);
    for (const hidden of ['design', PRIVATE_REF, 'evidenceRefs', 'participantId'])
      expect(text).not.toContain(hidden);
  });

  it('requires explicit consent and only the Raid-relevant skills', async () => {
    const s = await setup();
    const id = s.applicationId;
    for (const input of [
      { applicationId: id, sharedSkillIds: ['writing'] },
      { applicationId: id, sharedSkillIds: ['writing'], consent: false },
      { applicationId: id, sharedSkillIds: [], consent: true },
      { applicationId: id, sharedSkillIds: ['writing', 'writing'], consent: true },
      { applicationId: id, sharedSkillIds: ['cooking'], consent: true },
    ])
      await expect(
        run((tx) => recordEvidenceSnapshot(tx, cmd(s.applicant.actor, input), snapshotHost())),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "ApplicantEvidenceSnapshot"')).toHaveLength(0);
    expect(asked).toEqual([]);
  });

  it('marks a relevant skill with no record as not assessed instead of inventing a rank', async () => {
    const s = await setup();
    records = [];
    await share(s.applicant.actor, s.applicationId, ['writing', 'design']);
    const seen = await view(s.founder.actor, s.applicationId);
    expect(seen.snapshot?.skills).toEqual([
      { skillId: 'writing', rank: null, status: 'NOT_ASSESSED', assessedAt: null },
      { skillId: 'design', rank: null, status: 'NOT_ASSESSED', assessedAt: null },
    ]);
  });

  it('is immutable once taken: later records and a second snapshot change nothing', async () => {
    const s = await setup();
    await share(s.applicant.actor, s.applicationId, ['writing']);
    records = [
      { skillId: 'writing', rank: 'A', status: 'REVOKED', assessedAt: '2026-11-01T00:00:00.000Z' },
    ];
    expect((await view(s.founder.actor, s.applicationId)).snapshot?.skills[0]).toMatchObject({
      rank: 'C',
      status: 'VERIFIED',
    });
    await expect(share(s.applicant.actor, s.applicationId, ['design'])).rejects.toMatchObject({
      code: 'EVIDENCE_SNAPSHOT_EXISTS',
    });
    await expect(
      db.$executeRawUnsafe('UPDATE "ApplicantEvidenceSnapshot" SET "skills"=\'[]\'::jsonb'),
    ).rejects.toThrow(/immutable/);
    await expect(db.$executeRawUnsafe('DELETE FROM "ApplicantEvidenceSnapshot"')).rejects.toThrow(
      /immutable/,
    );
    expect((await view(s.founder.actor, s.applicationId)).snapshot?.skills).toHaveLength(1);
  });

  it('replays the same command without taking a second snapshot', async () => {
    const s = await setup();
    const key = randomUUID();
    const input = { applicationId: s.applicationId, sharedSkillIds: ['writing'], consent: true };
    const record = () =>
      run((tx) => recordEvidenceSnapshot(tx, cmd(s.applicant.actor, input, key), snapshotHost()));
    const a = await record();
    const b = await record();
    expect(b.status).toBe('REPLAYED');
    expect(b.snapshot.id).toBe(a.snapshot.id);
  });

  it('refuses a non-reviewer and any other person, leaking nothing', async () => {
    const s = await setup();
    await share(s.applicant.actor, s.applicationId, ['writing']);
    const stranger = await seedWorkHuman(db),
      rival = await seedWorkHuman(db),
      otherFounder = await seedWorkHuman(db, 'founder-' + randomUUID());
    await run((tx) =>
      submitApplication(
        tx,
        cmd(rival.actor, {
          slotId: s.slot.slotId,
          termsVersionId: s.slot.termsVersionId,
          evidenceRefs: [],
        }),
        admission,
      ),
    );
    for (const actor of [stranger.actor, rival.actor, otherFounder.actor]) {
      await expect(view(actor, s.applicationId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(unshare(actor, s.applicationId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(share(actor, s.applicationId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    // The creator whose scoped authority is gone is also refused.
    await expect(
      view(s.founder.actor, s.applicationId, snapshotHost({ authorize: async () => false })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A missing application is indistinguishable from one the caller may not touch: no existence oracle.
    const missing = randomUUID();
    for (const call of [
      () => view(stranger.actor, missing),
      () => share(stranger.actor, missing),
      () => unshare(stranger.actor, missing),
    ])
      await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(view(s.founder.actor, missing)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      view({ ...s.founder.actor, sessionHash: 'e'.repeat(64) }, s.applicationId),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('lets the applicant withdraw while pending: the reviewer view drops it, for good', async () => {
    const s = await setup();
    await share(s.applicant.actor, s.applicationId, ['writing']);
    const own = await view(s.applicant.actor, s.applicationId);
    expect(own).toMatchObject({ role: 'APPLICANT', availability: 'SHARED' });
    expect((await unshare(s.applicant.actor, s.applicationId)).status).toBe('EXECUTED');
    // The reviewer is only told nothing is shared; the applicant alone is told it was withdrawn.
    const seen = await view(s.founder.actor, s.applicationId);
    expect(seen).toMatchObject({ role: 'REVIEWER', availability: 'NOT_SHARED', snapshot: null });
    expect(JSON.stringify(seen)).not.toContain('writing');
    expect(await view(s.applicant.actor, s.applicationId)).toMatchObject({
      role: 'APPLICANT',
      availability: 'WITHDRAWN',
      snapshot: null,
    });
    await expect(unshare(s.applicant.actor, s.applicationId)).rejects.toMatchObject({
      code: 'EVIDENCE_SNAPSHOT_UNAVAILABLE',
    });
    await expect(share(s.applicant.actor, s.applicationId, ['design'])).rejects.toMatchObject({
      code: 'EVIDENCE_SNAPSHOT_EXISTS',
    });
    expect((await view(s.founder.actor, s.applicationId)).availability).toBe('NOT_SHARED');
  });

  it('ends reviewer access when the application closes', async () => {
    const s = await setup();
    await share(s.applicant.actor, s.applicationId, ['writing']);
    await run((tx) =>
      withdrawApplication(
        tx,
        cmd(s.applicant.actor, { applicationId: s.applicationId }),
        admission,
      ),
    );
    expect(await view(s.founder.actor, s.applicationId)).toMatchObject({
      role: 'REVIEWER',
      availability: 'NOT_SHARED',
      snapshot: null,
    });
    expect(await view(s.applicant.actor, s.applicationId)).toMatchObject({
      role: 'APPLICANT',
      availability: 'CLOSED',
      snapshot: null,
    });
    await expect(unshare(s.applicant.actor, s.applicationId)).rejects.toMatchObject({
      code: 'EVIDENCE_SNAPSHOT_UNAVAILABLE',
    });
    await expect(share(s.applicant.actor, s.applicationId)).rejects.toMatchObject({
      code: 'APPLICATION_CLOSED',
    });
  });

  it('is backed by the database: no snapshot for a closed application or another participant', async () => {
    const s = await setup();
    const rival = await seedWorkHuman(db);
    const insert = (participantId: string) =>
      db.$executeRawUnsafe(
        `INSERT INTO "ApplicantEvidenceSnapshot" ("applicationId","slotId","termsVersionId","participantId","skills") SELECT a."id",a."slotId",a."termsVersionId",$1::uuid,'[{"skillId":"writing","rank":null,"status":"NOT_ASSESSED","assessedAt":null}]'::jsonb FROM "RaidApplication" a WHERE a."id"=$2::uuid`,
        participantId,
        s.applicationId,
      );
    await expect(insert(rival.participantId)).rejects.toThrow(/foreign key/i);
    await run((tx) =>
      withdrawApplication(
        tx,
        cmd(s.applicant.actor, { applicationId: s.applicationId }),
        admission,
      ),
    );
    await expect(insert(s.applicant.participantId)).rejects.toThrow(/pending application/);
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "ApplicantEvidenceSnapshot"')).toHaveLength(0);
  });

  it('constrains the frozen element shape and withdrawal-after-close at the database', async () => {
    const s = await setup();
    const insert = (skills: string) =>
      db.$executeRawUnsafe(
        `INSERT INTO "ApplicantEvidenceSnapshot" ("applicationId","slotId","termsVersionId","participantId","skills") SELECT a."id",a."slotId",a."termsVersionId",a."participantId",$1::jsonb FROM "RaidApplication" a WHERE a."id"=$2::uuid`,
        skills,
        s.applicationId,
      );
    const element = {
      skillId: 'writing',
      rank: 'C',
      status: 'VERIFIED',
      assessedAt: '2026-10-01T00:00:00.000Z',
    };
    for (const bad of [
      [{ ...element, evidenceUrl: 'https://private.example/x' }],
      [{ skillId: 'writing', rank: 'C', status: 'VERIFIED' }],
      [{ ...element, status: 'GRANTED' }],
      [{ ...element, rank: 'Z' }],
      [{ ...element, rank: null }],
      [{ skillId: 'writing', rank: 'C', status: 'NOT_ASSESSED', assessedAt: null }],
      [{ ...element, skillId: 'bad id!' }],
      ['writing'],
      [],
    ])
      await expect(insert(JSON.stringify(bad))).rejects.toThrow(/skills_check/);
    await insert(JSON.stringify([element]));
    await run((tx) =>
      withdrawApplication(
        tx,
        cmd(s.applicant.actor, { applicationId: s.applicationId }),
        admission,
      ),
    );
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "ApplicantEvidenceSnapshotWithdrawal" ("snapshotId","participantId") SELECT "id","participantId" FROM "ApplicantEvidenceSnapshot"`,
      ),
    ).rejects.toThrow(/pending application/);
  });

  it('serializes a share against a concurrent close of the application (two connections)', async () => {
    const s = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let closing!: () => void;
    const closed = new Promise<void>((resolve) => (closing = resolve));
    // Connection 1 closes the application but has not committed yet.
    const holder = db.$transaction(
      async (t) => {
        await t.$executeRawUnsafe(
          `UPDATE "RaidApplication" SET "state"='CLOSED' WHERE "id"=$1::uuid`,
          s.applicationId,
        );
        closing();
        await gate;
      },
      { timeout: 30000 },
    );
    await closed;
    // Connection 2 shares meanwhile: it must wait on the application row, not race past it.
    let settled = false;
    const sharing = share(s.applicant.actor, s.applicationId, ['writing']).then(
      () => ((settled = true), 'shared'),
      (e: { code: string }) => ((settled = true), e.code),
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(settled).toBe(false);
    release();
    await holder;
    expect(await sharing).toBe('APPLICATION_CLOSED');
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "ApplicantEvidenceSnapshot"')).toHaveLength(0);
  });

  it('keeps new snapshots behind the write switch while withdrawal needs no host', async () => {
    const s = await setup();
    await expect(
      share(
        s.applicant.actor,
        s.applicationId,
        ['writing'],
        snapshotHost({ allowNewWrites: false }),
      ),
    ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    await share(s.applicant.actor, s.applicationId, ['writing']);
    expect((await unshare(s.applicant.actor, s.applicationId)).status).toBe('EXECUTED');
  });
});
