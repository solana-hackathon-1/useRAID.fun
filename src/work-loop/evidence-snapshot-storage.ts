import { z } from 'zod';
import {
  executeIdempotentCommand,
  type CommandReceiptTransaction as Tx,
} from '../command-receipts';
import type { WorkActor, WorkCommand } from './contracts';
import {
  EvidenceSnapshotResultSchema,
  EvidenceSnapshotViewSchema,
  EvidenceSnapshotWithdrawalResultSchema,
  RecordEvidenceSnapshotInput,
  SkillRecordSchema,
  SnapshotSkillSchema,
  WithdrawEvidenceSnapshotInput,
  type EvidenceSnapshotHost,
} from './evidence-snapshot-contracts';
import {
  fail,
  validate,
  session,
  currentActor,
  currentHuman,
  source,
  definition,
} from './engagement-authority';

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail('STORAGE_CONTRACT');
  return parsed.data;
}
function input<T>(schema: z.ZodType<T>, command: WorkCommand, tx: Tx): T {
  validate(tx, command?.actor);
  const parsed = schema.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  return parsed.data;
}
/**
 * The binding of an application, read without its private evidence references. A missing application is FORBIDDEN, the
 * same answer as one the caller may not touch, so these commands are no existence oracle.
 */
async function application(tx: Tx, id: string, lock = false) {
  const rows = await tx.query<{
    id: string;
    slotId: string;
    termsVersionId: string;
    participantId: string;
    state: string;
  }>(
    'SELECT "id"::text,"slotId"::text,"termsVersionId"::text,"participantId"::text,"state" FROM "RaidApplication" WHERE "id"=$1::uuid' +
      (lock ? ' FOR UPDATE' : ''),
    [id],
  );
  if (rows.length !== 1) fail('FORBIDDEN');
  return rows[0];
}
const event = (type: string, s: Awaited<ReturnType<typeof source>>, termsVersionId: string) => ({
  type,
  aggregateId: s.listingId,
  aggregateVersion: s.revision,
  guildId: s.guildId,
  payload: { termsVersionId },
});

/**
 * The applicant's explicit consent to show a Founder reviewer their records for the Raid's required skills (and only
 * those they choose) for THIS application (DEC-2026-11-14-12). The values read now are frozen in an immutable row; applying
 * shares nothing by itself. Only the application's own participant may do this, only while it is pending, and once.
 */
export async function recordEvidenceSnapshot(
  tx: Tx,
  command: WorkCommand,
  host: EvidenceSnapshotHost,
) {
  const value = input(RecordEvidenceSnapshotInput, command, tx),
    actor = command.actor;
  if (typeof host?.allowNewWrites !== 'boolean' || typeof host.readSkillRecords !== 'function')
    fail('STORAGE_CONTRACT');
  await session(tx, actor);
  let auth: Awaited<ReturnType<typeof currentHuman>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'RecordApplicantEvidenceSnapshot',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async () => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      const ref = await application(tx, value.applicationId);
      // Listing then slot then application, as every admission writer; SHARE because nothing on the source changes.
      const s = await source(tx, ref.slotId, 'SHARE');
      auth = await currentHuman(tx, actor);
      if (ref.participantId !== auth.participantId) fail('FORBIDDEN');
      const a = await application(tx, ref.id, true);
      if (a.state !== 'SUBMITTED') fail('APPLICATION_CLOSED');
      const prior = await tx.query(
        'SELECT 1 FROM "ApplicantEvidenceSnapshot" WHERE "applicationId"=$1::uuid',
        [ref.id],
      );
      if (prior.length) fail('EVIDENCE_SNAPSHOT_EXISTS');
      const required = new Set(
        (await definition(tx, ref.termsVersionId)).requiredSkills.map((r) => r.skillId),
      );
      if (!value.sharedSkillIds.every((id) => required.has(id))) fail('INVALID_INPUT');
      const read = parse(
        z.array(SkillRecordSchema).max(value.sharedSkillIds.length),
        await host.readSkillRecords(
          tx,
          { accountId: actor.accountId, participantId: auth.participantId },
          value.sharedSkillIds,
        ),
      );
      const bySkill = new Map(read.map((r) => [r.skillId, r]));
      if (
        bySkill.size !== read.length ||
        read.some((r) => !value.sharedSkillIds.includes(r.skillId))
      )
        fail('STORAGE_CONTRACT');
      const skills = value.sharedSkillIds.map((skillId) => {
        const r = bySkill.get(skillId);
        return r
          ? { skillId, rank: r.rank, status: r.status, assessedAt: r.assessedAt }
          : { skillId, rank: null, status: 'NOT_ASSESSED', assessedAt: null };
      });
      const [saved] = await tx.query<{ id: string }>(
        'INSERT INTO "ApplicantEvidenceSnapshot" ("applicationId","slotId","termsVersionId","participantId","skills") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb) RETURNING "id"::text',
        [ref.id, ref.slotId, ref.termsVersionId, auth.participantId, JSON.stringify(skills)],
      );
      if (!saved) fail('STORAGE_CONTRACT');
      await currentHuman(tx, actor, auth.locks);
      return {
        resultRef: saved.id,
        events: [event('work.applicant_evidence_shared.v1', s, ref.termsVersionId)],
      };
    },
  );
  auth = await currentHuman(tx, actor, auth?.locks);
  const rows = await tx.query<Record<string, unknown>>(
    'SELECT "id"::text,"applicationId"::text,"takenAt","skills" FROM "ApplicantEvidenceSnapshot" WHERE "id"=$1::uuid AND "participantId"=$2::uuid',
    [receipt.resultRef, auth.participantId],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  return parse(EvidenceSnapshotResultSchema, {
    status: receipt.status,
    snapshot: { ...rows[0], takenAt: iso(rows[0].takenAt) },
  });
}

/**
 * The applicant withdraws their snapshot while the application is pending. Deliberately takes no host: it only reduces
 * what is shown, so no switch gates it (as application and consent withdrawal). Final for that application. Content a
 * reviewer already saw cannot be recalled.
 */
export async function withdrawEvidenceSnapshot(tx: Tx, command: WorkCommand) {
  const value = input(WithdrawEvidenceSnapshotInput, command, tx),
    actor = command.actor;
  await session(tx, actor);
  let auth: Awaited<ReturnType<typeof currentHuman>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'WithdrawApplicantEvidenceSnapshot',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async () => {
      const ref = await application(tx, value.applicationId);
      const s = await source(tx, ref.slotId, 'SHARE');
      auth = await currentHuman(tx, actor);
      if (ref.participantId !== auth.participantId) fail('FORBIDDEN');
      const a = await application(tx, ref.id, true);
      if (a.state !== 'SUBMITTED') fail('EVIDENCE_SNAPSHOT_UNAVAILABLE');
      const snapshot = await tx.query<{ id: string }>(
        'SELECT "id"::text FROM "ApplicantEvidenceSnapshot" WHERE "applicationId"=$1::uuid FOR UPDATE',
        [ref.id],
      );
      if (snapshot.length !== 1) fail('EVIDENCE_SNAPSHOT_UNAVAILABLE');
      const done = await tx.query(
        'SELECT 1 FROM "ApplicantEvidenceSnapshotWithdrawal" WHERE "snapshotId"=$1::uuid',
        [snapshot[0].id],
      );
      if (done.length) fail('EVIDENCE_SNAPSHOT_UNAVAILABLE');
      const [saved] = await tx.query<{ id: string }>(
        'INSERT INTO "ApplicantEvidenceSnapshotWithdrawal" ("snapshotId","participantId") VALUES ($1::uuid,$2::uuid) RETURNING "id"::text',
        [snapshot[0].id, auth.participantId],
      );
      if (!saved) fail('STORAGE_CONTRACT');
      await currentHuman(tx, actor, auth.locks);
      return {
        resultRef: saved.id,
        events: [event('work.applicant_evidence_withdrawn.v1', s, ref.termsVersionId)],
      };
    },
  );
  auth = await currentHuman(tx, actor, auth?.locks);
  const rows = await tx.query<Record<string, unknown>>(
    'SELECT sn."applicationId"::text,w."withdrawnAt" FROM "ApplicantEvidenceSnapshotWithdrawal" w JOIN "ApplicantEvidenceSnapshot" sn ON sn."id"=w."snapshotId" WHERE w."id"=$1::uuid AND w."participantId"=$2::uuid',
    [receipt.resultRef, auth.participantId],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  return parse(EvidenceSnapshotWithdrawalResultSchema, {
    status: receipt.status,
    applicationId: rows[0].applicationId,
    withdrawnAt: iso(rows[0].withdrawnAt),
  });
}

/**
 * The one view of a snapshot. The applicant sees their own; the listing's creator with current scoped authority sees it
 * as reviewer; everyone else is FORBIDDEN. The snapshot content is returned only while the application is pending and
 * the applicant has not withdrawn it, so access ends when the application closes. The view is the snapshot alone: no
 * evidence references, other skills, profile or other-Guild data are ever read here.
 */
export async function readEvidenceSnapshot(
  tx: Tx,
  actor: WorkActor,
  applicationId: string,
  host: Pick<EvidenceSnapshotHost, 'authorize'>,
) {
  validate(tx, actor);
  if (typeof host?.authorize !== 'function') fail('STORAGE_CONTRACT');
  const id = z.uuid().safeParse(applicationId);
  if (!id.success) fail('INVALID_INPUT');
  const locks = await currentActor(tx, actor);
  const rows = await tx.query<Record<string, unknown>>(
    `SELECT a."state",p."accountId" AS "applicantAccountId",l."creatorAccountId",l."guildId",
       sn."id"::text AS "snapshotId",sn."takenAt",sn."skills",w."id" AS "withdrawalId"
     FROM "RaidApplication" a JOIN "Participant" p ON p."id"=a."participantId"
     JOIN "RaidSlot" s ON s."id"=a."slotId" JOIN "WorkListing" l ON l."id"=s."listingId"
     LEFT JOIN "ApplicantEvidenceSnapshot" sn ON sn."applicationId"=a."id"
     LEFT JOIN "ApplicantEvidenceSnapshotWithdrawal" w ON w."snapshotId"=sn."id"
     WHERE a."id"=$1::uuid`,
    [id.data],
  );
  if (rows.length !== 1) fail('FORBIDDEN');
  const row = rows[0];
  let role: 'APPLICANT' | 'REVIEWER';
  if (row.applicantAccountId === actor.accountId) role = 'APPLICANT';
  else if (
    row.creatorAccountId === actor.accountId &&
    (await host.authorize(tx, actor, row.guildId as string, 'MANAGE_LISTING')) === true
  )
    role = 'REVIEWER';
  else fail('FORBIDDEN');
  // The applicant is told why nothing is shared; the reviewer is only ever told that nothing is, so a withdrawal or the
  // application's end is not disclosed to them.
  const shared = row.state === 'SUBMITTED' && row.snapshotId && !row.withdrawalId;
  const availability = shared
    ? 'SHARED'
    : role === 'REVIEWER'
      ? 'NOT_SHARED'
      : row.state !== 'SUBMITTED'
        ? 'CLOSED'
        : !row.snapshotId
          ? 'NOT_SHARED'
          : 'WITHDRAWN';
  const snapshot = shared
    ? {
        id: row.snapshotId,
        applicationId: id.data,
        takenAt: iso(row.takenAt),
        skills: parse(z.array(SnapshotSkillSchema), row.skills),
      }
    : null;
  const result = parse(EvidenceSnapshotViewSchema, {
    version: 'v1',
    role,
    applicationId: id.data,
    availability,
    snapshot,
  });
  await currentActor(tx, actor, locks);
  return result;
}
