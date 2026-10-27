import type { CommandReceiptTransaction as Tx } from '../command-receipts';
import type { WorkActor } from '../work-loop/contracts';
import { fail, validate, currentActor } from '../work-loop/engagement-authority';
import {
  NotificationListSchema,
  PreferencesSchema,
  describeNotification,
  type NotificationKind,
} from './contracts';

type Audience = 'MEMBERS' | 'REVIEWER' | 'FOUNDER';
/** Work event -> who is told what. Events carry identifiers only; recipients are derived from current records. */
const RULES: Readonly<Record<string, readonly { kind: NotificationKind; to: Audience }[]>> = {
  'work.engagement_committed.v1': [
    { kind: 'ENGAGEMENT_ACCEPTED', to: 'MEMBERS' },
    { kind: 'RAID_ACCEPTED', to: 'FOUNDER' },
  ],
  'work.submission_recorded.v1': [{ kind: 'SUBMISSION_RECEIVED', to: 'REVIEWER' }],
  'work.review_decided.v1': [{ kind: 'REVIEW_DECIDED', to: 'MEMBERS' }],
  'work.engagement_closed.v1': [
    { kind: 'WORK_CLOSED', to: 'MEMBERS' },
    { kind: 'RAID_CLOSED', to: 'FOUNDER' },
  ],
  'work.amendment_proposed.v1': [{ kind: 'AMENDMENT_PROPOSED', to: 'MEMBERS' }],
  'work.amendment_accepted.v1': [{ kind: 'AMENDMENT_DECIDED', to: 'FOUNDER' }],
  'work.amendment_declined.v1': [{ kind: 'AMENDMENT_DECIDED', to: 'FOUNDER' }],
  'work.amendment_withdrawn.v1': [{ kind: 'AMENDMENT_WITHDRAWN', to: 'MEMBERS' }],
};
const RECIPIENTS: Record<Audience, string> = {
  MEMBERS:
    'SELECT p."accountId" FROM "EngagementMember" m JOIN "Participant" p ON p."id"=m."participantId" WHERE m."engagementId"=$1::uuid',
  REVIEWER:
    'SELECT t."snapshot"->\'review\'->>\'reviewerAccountId\' AS "accountId" FROM "Engagement" e JOIN "TermsVersion" t ON t."id"=e."termsVersionId" WHERE e."id"=$1::uuid',
  FOUNDER:
    'SELECT l."creatorAccountId" AS "accountId" FROM "Engagement" e JOIN "RaidSlot" s ON s."id"=e."slotId" JOIN "WorkListing" l ON l."id"=s."listingId" WHERE e."id"=$1::uuid',
};
const BATCH_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
function bounded(value: number, fallback: number) {
  return Number.isInteger(value) && value >= 1 && value <= BATCH_MAX ? value : fallback;
}
/** First enabled pass suppresses committed history once. No timestamp watermark can lose late commits. */
async function initializeDispatch(tx: Tx) {
  const initialized = await tx.query(
    'SELECT "key" FROM "NotificationDispatchInitialization" WHERE "key"=\'work.v1\'',
    [],
  );
  if (initialized.length) return;
  // The unique singleton serializes only initialization. Its row and historical markers commit together.
  const acquired = await tx.query(
    'INSERT INTO "NotificationDispatchInitialization" ("key") VALUES (\'work.v1\') ON CONFLICT DO NOTHING RETURNING "key"',
    [],
  );
  if (!acquired.length) return;
  await tx.query(
    `INSERT INTO "NotificationDispatch" ("outboxEventId")
     SELECT o."id" FROM "OutboxEvent" o JOIN "AuditEvent" a ON a."id"=o."eventId"
     WHERE a."eventType" LIKE 'work.%'
     ON CONFLICT DO NOTHING RETURNING "outboxEventId"`,
    [],
  );
}
/**
 * System job: turns work events from the outbox into in-app notifications. At least once and order-independent:
 * handled events are marked, rows are claimed with SKIP LOCKED, and the notification dedupe key makes a repeat,
 * a race or a lost marker harmless.
 */
export async function dispatchWorkNotifications(tx: Tx, options: { limit?: number } = {}) {
  await initializeDispatch(tx);
  const limit = bounded(options.limit ?? 100, 100);
  const events = await tx.query<{
    outboxId: string;
    eventId: string;
    eventType: string;
    payload: { engagementId?: string } | null;
  }>(
    `SELECT o."id"::text AS "outboxId",a."id"::text AS "eventId",a."eventType",a."payload"
     FROM "OutboxEvent" o JOIN "AuditEvent" a ON a."id"=o."eventId"
     WHERE a."eventType" LIKE 'work.%' AND NOT EXISTS (SELECT 1 FROM "NotificationDispatch" d WHERE d."outboxEventId"=o."id")
     ORDER BY o."createdAt",o."id" LIMIT ${limit} FOR UPDATE OF o SKIP LOCKED`,
    [],
  );
  let created = 0;
  for (const event of events) {
    const engagementId = event.payload?.engagementId;
    for (const rule of RULES[event.eventType] ?? []) {
      // Invalid payloads are still marked handled below; none can reach a PostgreSQL UUID cast.
      if (!isUuid(engagementId)) continue;
      const people = await tx.query<{ accountId: string | null }>(RECIPIENTS[rule.to], [
        engagementId,
      ]);
      for (const person of people) {
        if (!person.accountId) continue;
        const inserted = await tx.query(
          `INSERT INTO "Notification" ("accountId","kind","category","dedupeKey","payload")
           SELECT u."id",$2,'TRANSACTIONAL',$3,jsonb_build_object('engagementId',$4::text) FROM "User" u WHERE u."id"=$1
           ON CONFLICT ("dedupeKey") DO NOTHING RETURNING "id"`,
          [
            person.accountId,
            rule.kind,
            `${event.eventId}|${rule.kind}|${person.accountId}`,
            engagementId,
          ],
        );
        created += inserted.length;
      }
    }
    await tx.query(
      'INSERT INTO "NotificationDispatch" ("outboxEventId") VALUES ($1::uuid) ON CONFLICT DO NOTHING RETURNING "outboxEventId"',
      [event.outboxId],
    );
  }
  return { handled: events.length, created };
}
const REMINDER = (kind: NotificationKind, dueSql: string, state: string, who: string) => `
  INSERT INTO "Notification" ("accountId","kind","category","dedupeKey","payload")
  SELECT x."accountId",'${kind}','TRANSACTIONAL',
         'deadline|'||x."engagementId"||'|${kind}|'||x."due"||'|'||x."accountId",
         jsonb_build_object('engagementId',x."engagementId",'deadline',x."due")
  FROM (
   SELECT e."id"::text AS "engagementId",${who} AS "accountId",
          to_char(d."due" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "due"
   FROM "Engagement" e ${dueSql}
   WHERE e."state"=${state} AND d."due">clock_timestamp() AND d."due"<=clock_timestamp()+make_interval(hours=>$1::int)
  ) x
  WHERE x."accountId" IS NOT NULL AND EXISTS (SELECT 1 FROM "User" u WHERE u."id"=x."accountId")
    AND NOT EXISTS (SELECT 1 FROM "Notification" n WHERE n."dedupeKey"='deadline|'||x."engagementId"||'|${kind}|'||x."due"||'|'||x."accountId")
  LIMIT $2::int
  ON CONFLICT ("dedupeKey") DO NOTHING RETURNING "id"`;
const MEMBER_JOIN = `JOIN "EngagementMember" m ON m."engagementId"=e."id" JOIN "Participant" p ON p."id"=m."participantId"`;
const SUBMISSION_DUE = `CROSS JOIN LATERAL (SELECT (raid_effective_terms(e."id")->'deadlines'->>'submission')::timestamptz AS "due") d ${MEMBER_JOIN}`;
const REVISION_DUE = `CROSS JOIN LATERAL (SELECT r."revisionDeadline" AS "due" FROM "WorkReview" r JOIN "WorkSubmission" s ON s."id"=r."submissionId" WHERE s."engagementId"=e."id" ORDER BY s."submissionNumber" DESC LIMIT 1) d ${MEMBER_JOIN}`;
const REVIEW_DUE = `CROSS JOIN LATERAL (SELECT (raid_effective_terms(e."id")->'deadlines'->>'review')::timestamptz AS "due") d JOIN "TermsVersion" t ON t."id"=e."termsVersionId"`;
/**
 * System job: one reminder per person and deadline VERSION (an amended deadline is a new business notification).
 * Members are told of submission and revision deadlines, the terms reviewer of the review deadline.
 */
export async function dispatchDeadlineReminders(
  tx: Tx,
  options: { withinHours?: number; limit?: number } = {},
) {
  const hours = bounded(options.withinHours ?? 24, 24);
  const limit = bounded(options.limit ?? 100, 100);
  let created = 0;
  for (const sql of [
    REMINDER('DEADLINE_APPROACHING', SUBMISSION_DUE, `'IN_PROGRESS'`, 'p."accountId"'),
    REMINDER('DEADLINE_APPROACHING', REVISION_DUE, `'REVISION_REQUESTED'`, 'p."accountId"'),
    REMINDER(
      'REVIEW_DEADLINE_APPROACHING',
      REVIEW_DUE,
      `'SUBMITTED'`,
      `t."snapshot"->'review'->>'reviewerAccountId'`,
    ),
  ])
    created += (await tx.query(sql, [String(hours), String(limit)])).length;
  return { created };
}
const LIST_LIMIT = 50;
async function listRows(tx: Tx, actor: WorkActor) {
  const rows = await tx.query<{ id: string; kind: string; createdAt: Date; readAt: Date | null }>(
    `SELECT "id"::text,"kind","createdAt","readAt" FROM "Notification" WHERE "accountId"=$1 ORDER BY "createdAt" DESC,"id" DESC LIMIT ${LIST_LIMIT}`,
    [actor.accountId],
  );
  const [unread] = await tx.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM "Notification" WHERE "accountId"=$1 AND "readAt" IS NULL',
    [actor.accountId],
  );
  const parsed = NotificationListSchema.safeParse({
    version: 'v1',
    items: rows.map((row) => {
      const text = describeNotification(row.kind as NotificationKind);
      return {
        id: row.id,
        kind: row.kind,
        message: text.message,
        link: text.link,
        createdAt: row.createdAt.toISOString(),
        read: row.readAt !== null,
      };
    }),
    unread: unread?.n ?? 0,
  });
  if (!parsed.success) fail('STORAGE_CONTRACT');
  return parsed.data;
}
async function preferenceRow(tx: Tx, actor: WorkActor) {
  const rows = await tx.query<{ promotional: boolean }>(
    'SELECT "promotional" FROM "NotificationPreference" WHERE "accountId"=$1',
    [actor.accountId],
  );
  return PreferencesSchema.parse({ promotional: rows[0]?.promotional ?? false });
}
/** The person's own notifications, newest first, with an unread count. Text comes from the kind, never storage. */
export async function listOwnNotifications(tx: Tx, actor: WorkActor) {
  validate(tx, actor);
  await currentActor(tx, actor);
  return listRows(tx, actor);
}
/** List and preferences under one current-Session proof. */
export async function readOwnNotificationState(tx: Tx, actor: WorkActor) {
  validate(tx, actor);
  await currentActor(tx, actor);
  return { ...(await listRows(tx, actor)), preferences: await preferenceRow(tx, actor) };
}
/** Marks the person's own notification read. Idempotent; another person's or an absent id is one NOT_FOUND. */
export async function markNotificationRead(tx: Tx, actor: WorkActor, id: string) {
  validate(tx, actor);
  if (!isUuid(id)) fail('INVALID_INPUT');
  await currentActor(tx, actor);
  const rows = await tx.query<{ readAt: Date | null }>(
    'SELECT "readAt" FROM "Notification" WHERE "id"=$1::uuid AND "accountId"=$2 FOR UPDATE',
    [id, actor.accountId],
  );
  if (rows.length !== 1) fail('NOT_FOUND');
  if (rows[0].readAt === null)
    await tx.query(
      'UPDATE "Notification" SET "readAt"=clock_timestamp() WHERE "id"=$1::uuid RETURNING "id"',
      [id],
    );
  return { id, read: true as const };
}
export async function readNotificationPreferences(tx: Tx, actor: WorkActor) {
  validate(tx, actor);
  await currentActor(tx, actor);
  return preferenceRow(tx, actor);
}
export async function setNotificationPreferences(
  tx: Tx,
  actor: WorkActor,
  value: { promotional: boolean },
) {
  validate(tx, actor);
  const parsed = PreferencesSchema.safeParse(value);
  if (!parsed.success) fail('INVALID_INPUT');
  await currentActor(tx, actor);
  await tx.query(
    `INSERT INTO "NotificationPreference" ("accountId","promotional") VALUES ($1,$2::boolean)
     ON CONFLICT ("accountId") DO UPDATE SET "promotional"=EXCLUDED."promotional","updatedAt"=clock_timestamp() RETURNING "accountId"`,
    [actor.accountId, String(parsed.data!.promotional)],
  );
  return parsed.data!;
}
