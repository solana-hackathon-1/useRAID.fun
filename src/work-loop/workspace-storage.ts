import type { CommandReceiptTransaction as Tx } from '../command-receipts';
import { TermsSnapshotSchema } from '../contracts/entities';
import type { WorkActor } from './contracts';
import type { AdmissionHost } from './admission-contracts';
import {
  ActiveRaidSchema,
  ApplicantQueueSchema,
  MyRaidsSchema,
  ReviewQueueSchema,
  type ActiveRaid,
  type MyRaids,
} from './workspace-contracts';
import { fail, validate, currentActor, currentHuman } from './engagement-authority';

const LIMIT = 50;
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
const NEXT_STEP: Readonly<Record<string, string>> = {
  ACCESS_PENDING: 'WAIT_FOR_START',
  IN_PROGRESS: 'SUBMIT_WORK',
  REVISION_REQUESTED: 'REVISE_AND_RESUBMIT',
  ACCEPTED: 'CLOSED',
  TERMINATED: 'CLOSED',
};
const SETUP: Readonly<Record<string, 'PENDING' | 'NOT_APPLICABLE'>> = {
  ACCESS_PENDING: 'PENDING',
  WITHDRAWN: 'NOT_APPLICABLE',
  CANCELLED: 'NOT_APPLICABLE',
  TERMINATED: 'NOT_APPLICABLE',
};
interface EngagementRow {
  id: string;
  state: string;
  acceptedTerms: unknown;
  title: string;
  rounds: number;
  held: boolean;
  submissions: number;
}
function offerView(row: {
  offer_id: string | null;
  offer_state: string | null;
  offer_expires: unknown;
  offer_expired: boolean | null;
}) {
  return row.offer_id
    ? {
        offerId: row.offer_id,
        state: row.offer_state,
        expiresAt: iso(row.offer_expires),
        expired: row.offer_expired === true,
      }
    : null;
}
const OFFER_COLUMNS = `o."id"::text AS offer_id,o."state" AS offer_state,o."expiresAt" AS offer_expires,(o."expiresAt"<=clock_timestamp()) AS offer_expired`;
const LATEST_OFFER = `LEFT JOIN LATERAL (SELECT * FROM "RaidOffer" x WHERE x."applicationId"=a."id" ORDER BY x."createdAt" DESC LIMIT 1) o ON true`;
/**
 * The Raid that currently holds the actor's own capacity reservation, read from `ActiveCommitment` (the R13 slot),
 * so it disappears as soon as closure releases capacity. Another account always gets null.
 */
export async function readActiveRaid(tx: Tx, actor: WorkActor): Promise<ActiveRaid> {
  validate(tx, actor);
  const auth = await currentHuman(tx, actor);
  const [row] = await tx.query<{ engagementId: string; title: string }>(
    `SELECT c."engagementId"::text AS "engagementId",t."snapshot"->>'title' AS title
     FROM "ActiveCommitment" c JOIN "TermsVersion" t ON t."id"=c."termsVersionId" WHERE c."participantId"=$1::uuid`,
    [auth.participantId],
  );
  const result = ActiveRaidSchema.parse(row ? { version: 'v1', ...row } : null);
  await currentHuman(tx, actor, auth.locks);
  return result;
}
/** The member's own engagements (progress, feedback, closure, preserved claims) and applications/offers. */
export async function readMyRaids(tx: Tx, actor: WorkActor): Promise<MyRaids> {
  validate(tx, actor);
  const auth = await currentHuman(tx, actor);
  const rows = await tx.query<EngagementRow>(
    `SELECT e."id"::text AS id,e."state",raid_effective_terms(e."id") AS "acceptedTerms",t."snapshot"->>'title' AS title,(t."snapshot"->'review'->>'maxRevisionRounds')::int AS rounds,
      EXISTS (SELECT 1 FROM "ActiveCommitment" c WHERE c."engagementId"=e."id" AND c."participantId"=m."participantId") AS held,
      (SELECT count(*)::int FROM "WorkSubmission" s WHERE s."engagementId"=e."id") AS submissions
     FROM "Engagement" e JOIN "EngagementMember" m ON m."engagementId"=e."id" JOIN "TermsVersion" t ON t."id"=e."termsVersionId"
     WHERE m."participantId"=$1::uuid ORDER BY e."createdAt" DESC LIMIT ${LIMIT}`,
    [auth.participantId],
  );
  const engagements = [];
  for (const row of rows) {
    const terms = TermsSnapshotSchema.safeParse(row.acceptedTerms);
    if (!terms.success) fail('STORAGE_CONTRACT');
    const [latest] = await tx.query<{
      decision: string | null;
      reason: string | null;
      criteria: { index: number; result: string; evidence: string | null }[] | null;
      revisionDeadline: unknown;
    }>(
      `SELECT r."decision",r."reason",r."criteria",r."revisionDeadline" FROM "WorkSubmission" s LEFT JOIN "WorkReview" r ON r."submissionId"=s."id" WHERE s."engagementId"=$1::uuid ORDER BY s."submissionNumber" DESC LIMIT 1`,
      [row.id],
    );
    const [closure] = await tx.query<Record<string, unknown>>(
      'SELECT "engagementId"::text,"reason","finalState","financialResolution","closedAt" FROM "EngagementClosure" WHERE "engagementId"=$1::uuid',
      [row.id],
    );
    const judged = new Map((latest?.criteria ?? []).map((c) => [c.index, c]));
    engagements.push({
      engagementId: row.id,
      title: row.title,
      state: row.state,
      capacityHeld: row.held,
      acceptedTerms: {
        termsVersionId: terms.data.id,
        revision: terms.data.revision,
        scope: terms.data.scope,
        requiredSkills: terms.data.requiredSkills.map((k) => ({
          skillId: k.skillId,
          minimumRank: k.minimumRank,
        })),
        roster: terms.data.roster.map((m) => ({
          participantId: m.participantId,
          responsibility: m.responsibility,
        })),
        rewards: terms.data.rewards.map((r) => ({
          policy: r.policy,
          amount: r.amount,
          beneficiaryParticipantId: r.beneficiaryParticipantId,
        })),
        deadlines: terms.data.deadlines,
      },
      setup: {
        status: SETUP[row.state] ?? 'READY',
        preparationDeadline: terms.data.deadlines.preparation,
      },
      nextStep:
        row.state === 'SUBMITTED'
          ? latest?.decision === 'DISPUTE'
            ? 'DISPUTE_OPEN'
            : 'AWAIT_REVIEW'
          : NEXT_STEP[row.state],
      deadlines: {
        submission: terms.data.deadlines.submission,
        review: terms.data.deadlines.review,
        operationalClosure: terms.data.deadlines.operationalClosure,
      },
      submissionCount: row.submissions,
      maxSubmissions: 1 + row.rounds,
      criteria: terms.data.acceptanceCriteria.map((text, index) => ({
        index,
        text,
        result: judged.get(index)?.result ?? null,
        evidence: judged.get(index)?.evidence ?? null,
      })),
      latestReview: latest?.decision
        ? {
            decision: latest.decision,
            reason: latest.reason,
            revisionDeadline: iso(latest.revisionDeadline ?? null),
          }
        : null,
      closure: closure ? { ...closure, closedAt: iso(closure.closedAt) } : null,
      claims: closure
        ? terms.data.rewards.map((r) => ({
            policy: r.policy,
            amount: r.amount,
            beneficiaryParticipantId: r.beneficiaryParticipantId,
            status: 'UNSETTLED',
          }))
        : [],
    });
  }
  const applications = await tx.query<Record<string, unknown> & Parameters<typeof offerView>[0]>(
    `SELECT a."id"::text AS "applicationId",a."slotId"::text,a."termsVersionId"::text,a."state",t."snapshot"->>'title' AS title,${OFFER_COLUMNS}
     FROM "RaidApplication" a JOIN "TermsVersion" t ON t."id"=a."termsVersionId" ${LATEST_OFFER}
     WHERE a."participantId"=$1::uuid ORDER BY a."createdAt" DESC LIMIT ${LIMIT}`,
    [auth.participantId],
  );
  const [held] = await tx.query<{ engagementId: string; title: string }>(
    `SELECT c."engagementId"::text AS "engagementId",t."snapshot"->>'title' AS title
     FROM "ActiveCommitment" c JOIN "TermsVersion" t ON t."id"=c."termsVersionId" WHERE c."participantId"=$1::uuid`,
    [auth.participantId],
  );
  const result = MyRaidsSchema.parse({
    version: 'v1',
    capacity: {
      limit: 1,
      held: !!held,
      engagementId: held?.engagementId ?? null,
      title: held?.title ?? null,
    },
    engagements,
    applications: applications.map((a) => ({
      applicationId: a.applicationId,
      slotId: a.slotId,
      termsVersionId: a.termsVersionId,
      state: a.state,
      title: a.title,
      offer: offerView(a),
    })),
  });
  await currentHuman(tx, actor, auth.locks);
  return result;
}
/** Latest unreviewed submissions awaiting the exact reviewer named by the accepted terms. */
export async function readReviewQueue(tx: Tx, actor: WorkActor) {
  validate(tx, actor);
  const locks = await currentActor(tx, actor);
  const rows = await tx.query<Record<string, unknown>>(
    `SELECT e."id"::text AS "engagementId",s."id"::text AS "submissionId",s."submissionNumber",t."snapshot"->>'title' AS title,s."explanation",s."artifacts",s."dependencies",s."aiUsage",s."createdAt" AS "submittedAt",
      raid_effective_terms(e."id") AS "acceptedTerms",(t."snapshot"->'review'->>'maxRevisionRounds')::int AS rounds
     FROM "Engagement" e JOIN "TermsVersion" t ON t."id"=e."termsVersionId" JOIN "WorkSubmission" s ON s."engagementId"=e."id"
     WHERE t."snapshot"->'review'->>'reviewerAccountId'=$1 AND e."state"='SUBMITTED'
      AND s."submissionNumber"=(SELECT max("submissionNumber") FROM "WorkSubmission" WHERE "engagementId"=e."id")
      AND NOT EXISTS (SELECT 1 FROM "WorkReview" r WHERE r."submissionId"=s."id")
      AND NOT EXISTS (SELECT 1 FROM "EngagementMember" m JOIN "Participant" p ON p."id"=m."participantId" WHERE m."engagementId"=e."id" AND p."accountId"=$1)
     ORDER BY s."createdAt" LIMIT ${LIMIT}`,
    [actor.accountId],
  );
  const items = rows.map((row) => {
    const terms = TermsSnapshotSchema.safeParse(row.acceptedTerms);
    if (!terms.success) fail('STORAGE_CONTRACT');
    return {
      engagementId: row.engagementId,
      submissionId: row.submissionId,
      submissionNumber: row.submissionNumber,
      title: row.title,
      explanation: row.explanation,
      artifacts: row.artifacts,
      dependencies: row.dependencies,
      aiUsage: row.aiUsage,
      submittedAt: iso(row.submittedAt),
      reviewDue: terms.data.deadlines.review,
      operationalClosure: terms.data.deadlines.operationalClosure,
      revisionsRemaining: Math.max(
        0,
        (row.rounds as number) - ((row.submissionNumber as number) - 1),
      ),
      criteria: terms.data.acceptanceCriteria.map((text, index) => ({ index, text })),
    };
  });
  const result = ReviewQueueSchema.parse({ version: 'v1', items });
  await currentActor(tx, actor, locks);
  return result;
}
/** Applicants on the actor's own current listings, limited to listings the host currently authorizes. */
export async function readApplicantQueue(
  tx: Tx,
  actor: WorkActor,
  host: Pick<AdmissionHost, 'authorize'>,
) {
  validate(tx, actor);
  if (typeof host?.authorize !== 'function') fail('STORAGE_CONTRACT');
  const locks = await currentActor(tx, actor);
  const slots = await tx.query<{
    slotId: string;
    termsVersionId: string;
    guildId: string;
    title: string;
  }>(
    `SELECT s."id"::text AS "slotId",s."termsVersionId"::text,l."guildId",t."snapshot"->>'title' AS title
     FROM "RaidSlot" s JOIN "WorkListing" l ON l."id"=s."listingId" JOIN "TermsVersion" t ON t."id"=s."termsVersionId"
     WHERE l."creatorAccountId"=$1 AND s."state"='AVAILABLE' AND l."state"='OPEN' AND l."currentTermsVersionId"=s."termsVersionId"
      AND EXISTS (SELECT 1 FROM "RaidApplication" a WHERE a."slotId"=s."id" AND a."state"='SUBMITTED')
     ORDER BY s."createdAt" DESC LIMIT ${LIMIT}`,
    [actor.accountId],
  );
  const listings = [];
  for (const slot of slots) {
    if ((await host.authorize(tx, actor, slot.guildId, 'MANAGE_LISTING')) !== true) continue;
    const applicants = await tx.query<Record<string, unknown> & Parameters<typeof offerView>[0]>(
      `SELECT a."id"::text AS "applicationId",a."evidenceRefs",a."state",a."createdAt" AS "appliedAt",${OFFER_COLUMNS}
       FROM "RaidApplication" a ${LATEST_OFFER}
       WHERE a."slotId"=$1::uuid AND a."state"='SUBMITTED' ORDER BY a."createdAt" LIMIT 100`,
      [slot.slotId],
    );
    listings.push({
      slotId: slot.slotId,
      termsVersionId: slot.termsVersionId,
      title: slot.title,
      applicants: applicants.map((a) => ({
        applicationId: a.applicationId,
        evidenceRefs: a.evidenceRefs,
        state: a.state,
        appliedAt: iso(a.appliedAt),
        offer: offerView(a),
      })),
    });
  }
  const result = ApplicantQueueSchema.parse({ version: 'v1', listings });
  await currentActor(tx, actor, locks);
  return result;
}
