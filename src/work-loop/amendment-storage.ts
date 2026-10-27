import {
  canonicalRequestDigest,
  executeIdempotentCommand,
  type CommandReceiptTransaction as Tx,
} from '../command-receipts';
import { TermsSnapshotSchema, type TermsSnapshot } from '../contracts/entities';
import { fromJsonAmount } from '../asset-registry/amounts';
import { InternalId } from '../contracts/ids';
import type { WorkActor, WorkCommand } from './contracts';
import {
  AmendmentResultSchema,
  AmendmentSchema,
  ProposeAmendmentInput,
  RespondAmendmentInput,
  WithdrawAmendmentInput,
  type Amendment,
  type AmendmentHost,
  type RewardIncrease,
} from './amendment-contracts';
import { fail, validate, session, currentActor, currentHuman, clock } from './engagement-authority';

const AMENDABLE = new Set(['ACCESS_PENDING', 'IN_PROGRESS']);
interface Row {
  id: string;
  engagementId: string;
  sequence: number;
  state: string;
  digest: string;
  snapshot: unknown;
  expiresAt: Date;
  additionalFundingRef: string | null;
  proposedByAccountId: string;
}
const COLUMNS =
  'a."id"::text,a."engagementId"::text,a."sequence",a."state",a."digest",a."snapshot",a."expiresAt",a."additionalFundingRef",a."proposedByAccountId"';
function hostContract(host: AmendmentHost) {
  if (
    typeof host?.allowNewWrites !== 'boolean' ||
    typeof host.authorize !== 'function' ||
    typeof host.authorizeProposer !== 'function' ||
    typeof host.reserveAdditionalFunding !== 'function' ||
    typeof host.fundingAvailable !== 'function' ||
    typeof host.assessConsent !== 'function'
  )
    fail('STORAGE_CONTRACT');
}
function view(row: Row): Amendment {
  const terms = TermsSnapshotSchema.safeParse(row.snapshot);
  if (!terms.success || canonicalRequestDigest(terms.data) !== row.digest) fail('STORAGE_CONTRACT');
  const parsed = AmendmentSchema.safeParse({
    id: row.id,
    engagementId: row.engagementId,
    sequence: row.sequence,
    state: row.state,
    digest: row.digest,
    terms: terms.data,
    expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt,
    requiresFunding: row.additionalFundingRef !== null,
  });
  if (!parsed.success) fail('STORAGE_CONTRACT');
  return parsed.data;
}
/** Added obligation per reward leg; a decrease or an unchanged leg adds nothing. */
function increases(before: TermsSnapshot, after: TermsSnapshot): RewardIncrease[] {
  const added: RewardIncrease[] = [];
  after.rewards.forEach((leg, i) => {
    const was = fromJsonAmount(before.rewards[i].amount);
    const now = fromJsonAmount(leg.amount);
    if (now > was) added.push({ policy: leg.policy, amount: String(now - was) });
  });
  return added;
}
function apply(
  before: TermsSnapshot,
  changes: ReturnType<typeof ProposeAmendmentInput.parse>['changes'],
): TermsSnapshot {
  if (changes.rewards && changes.rewards.length !== before.rewards.length) fail('INVALID_INPUT');
  const deadlines = { ...before.deadlines };
  for (const [key, value] of Object.entries(changes.deadlines ?? {}))
    if (value !== undefined) deadlines[key as keyof typeof deadlines] = value;
  const parsed = TermsSnapshotSchema.safeParse({
    ...before,
    scope: changes.scope ?? before.scope,
    acceptanceCriteria: changes.acceptanceCriteria ?? before.acceptanceCriteria,
    rewards: changes.rewards
      ? before.rewards.map((leg, i) => ({ ...leg, amount: changes.rewards![i].amount }))
      : before.rewards,
    deadlines,
  });
  if (!parsed.success) fail('INVALID_INPUT');
  return parsed.data;
}
async function effective(tx: Tx, engagementId: string) {
  const rows = await tx.query<{ terms: unknown; digest: string }>(
    `SELECT raid_effective_terms(e."id") AS terms,COALESCE((SELECT a."digest" FROM "EngagementAmendment" a WHERE a."engagementId"=e."id" AND a."state"='ACCEPTED' ORDER BY a."sequence" DESC LIMIT 1),e."acceptedDigest") AS digest FROM "Engagement" e WHERE e."id"=$1::uuid`,
    [engagementId],
  );
  const parsed = TermsSnapshotSchema.safeParse(rows[0]?.terms);
  if (
    rows.length !== 1 ||
    !parsed.success ||
    canonicalRequestDigest(parsed.data) !== rows[0].digest
  )
    fail('STORAGE_CONTRACT');
  return parsed.data;
}
/** Only the listing's Founder with current host authority; never an affected member. Null covers missing and denied. */
async function founderBinding(tx: Tx, engagementId: string, accountId: string) {
  const rows = await tx.query<{ guildId: string; creatorAccountId: string }>(
    'SELECT e."guildId",l."creatorAccountId" FROM "Engagement" e JOIN "RaidSlot" s ON s."id"=e."slotId" JOIN "WorkListing" l ON l."id"=s."listingId" WHERE e."id"=$1::uuid',
    [engagementId],
  );
  const member = await tx.query(
    'SELECT 1 FROM "EngagementMember" m JOIN "Participant" p ON p."id"=m."participantId" WHERE m."engagementId"=$1::uuid AND p."accountId"=$2',
    [engagementId, accountId],
  );
  return rows.length === 1 && !member.length && rows[0].creatorAccountId === accountId
    ? rows[0].guildId
    : null;
}
async function founderAuthority(
  tx: Tx,
  engagementId: string,
  actor: WorkActor,
  host: AmendmentHost,
) {
  const guildId = await founderBinding(tx, engagementId, actor.accountId);
  return guildId !== null && (await host.authorize(tx, actor, { engagementId, guildId })) === true
    ? guildId
    : null;
}
/** Missing and denied are one answer. */
async function founderTarget(tx: Tx, engagementId: string, actor: WorkActor, host: AmendmentHost) {
  const guildId = await founderAuthority(tx, engagementId, actor, host);
  if (guildId === null) fail('FORBIDDEN');
  return guildId;
}
/** A proposal is acceptable only while its proposer still holds the Founder authority it was made under. */
async function proposerStillAuthorized(tx: Tx, amendment: Row, host: AmendmentHost) {
  // The proposer has no session in the member's request: the host judges the account's current scoped authority.
  const account = amendment.proposedByAccountId;
  const guildId = await founderBinding(tx, amendment.engagementId, account);
  if (
    guildId === null ||
    (await host.authorizeProposer(
      tx,
      { accountId: account },
      {
        engagementId: amendment.engagementId,
        guildId,
      },
    )) !== true
  )
    fail('AMENDMENT_UNAVAILABLE');
}
const lapsed = (terms: TermsSnapshot, at: Date) =>
  Date.parse(terms.deadlines.submission) <= at.getTime() ||
  Date.parse(terms.deadlines.operationalClosure) <= at.getTime();
async function lockEngagement(tx: Tx, engagementId: string) {
  const rows = await tx.query<{ state: string; guildId: string }>(
    'SELECT "state","guildId" FROM "Engagement" WHERE "id"=$1::uuid FOR UPDATE',
    [engagementId],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  return rows[0];
}
async function readOne(tx: Tx, id: string) {
  const rows = await tx.query<Row>(
    `SELECT ${COLUMNS} FROM "EngagementAmendment" a WHERE a."id"=$1::uuid`,
    [id],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  return rows[0];
}
/** Founder proposes a change. Nothing becomes effective until the affected member consents. */
export async function proposeAmendment(tx: Tx, command: WorkCommand, host: AmendmentHost) {
  validate(tx, command?.actor);
  hostContract(host);
  const parsed = ProposeAmendmentInput.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const value = parsed.data,
    actor = command.actor;
  await session(tx, actor);
  let locks: Awaited<ReturnType<typeof currentActor>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'ProposeAmendment',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async () => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      locks = await currentActor(tx, actor);
      await founderTarget(tx, value.engagementId, actor, host);
      const engagement = await lockEngagement(tx, value.engagementId);
      if (!AMENDABLE.has(engagement.state)) fail('ENGAGEMENT_STATE');
      const open = await tx.query(
        'SELECT 1 FROM "EngagementAmendment" WHERE "engagementId"=$1::uuid AND "state"=\'PROPOSED\'',
        [value.engagementId],
      );
      if (open.length) fail('AMENDMENT_EXISTS');
      const before = await effective(tx, value.engagementId);
      const next = apply(before, value.changes);
      const digest = canonicalRequestDigest(next);
      if (digest === canonicalRequestDigest(before)) fail('INVALID_INPUT');
      const now = (await clock(tx)).getTime();
      if (
        Date.parse(next.deadlines.submission) <= now ||
        Date.parse(next.deadlines.operationalClosure) <= now ||
        Date.parse(value.expiresAt) <= now ||
        Date.parse(value.expiresAt) > Date.parse(before.deadlines.submission)
      )
        fail('INVALID_INPUT');
      const [ids] = await tx.query<{ id: string; sequence: number }>(
        'SELECT gen_random_uuid()::text AS id,(COALESCE((SELECT max("sequence") FROM "EngagementAmendment" WHERE "engagementId"=$1::uuid),0)+1)::int AS sequence',
        [value.engagementId],
      );
      const added = increases(before, next);
      let fundingRef: string | null = null;
      if (added.length) {
        const reserved = await host.reserveAdditionalFunding(tx, {
          engagementId: value.engagementId,
          amendmentId: ids.id,
          increase: added,
          terms: next,
        });
        if (!InternalId.safeParse(reserved).success) fail('FUNDING_REQUIRED');
        // One reservation backs one obligation: a slot's or an earlier amendment's reference is not new funding.
        const reused = await tx.query(
          'SELECT 1 FROM "RaidSlot" WHERE "fundingRef"=$1 UNION ALL SELECT 1 FROM "EngagementAmendment" WHERE "additionalFundingRef"=$1',
          [reserved],
        );
        if (reused.length) fail('FUNDING_REQUIRED');
        fundingRef = reserved;
      }
      await tx.query(
        'INSERT INTO "EngagementAmendment" ("id","engagementId","sequence","snapshot","digest","proposedByAccountId","additionalFundingRef","expiresAt") VALUES ($1::uuid,$2::uuid,$3::int,$4::jsonb,$5,$6,$7,$8::timestamptz) RETURNING "id"',
        [
          ids.id,
          value.engagementId,
          String(ids.sequence),
          JSON.stringify(next),
          digest,
          actor.accountId,
          fundingRef,
          value.expiresAt,
        ],
      );
      // Authority is proven again after every lock and host callback wait.
      await currentActor(tx, actor, locks);
      await founderTarget(tx, value.engagementId, actor, host);
      return {
        resultRef: ids.id,
        events: [
          {
            type: 'work.amendment_proposed.v1',
            aggregateId: value.engagementId,
            aggregateVersion: ids.sequence,
            guildId: engagement.guildId,
            payload: { amendmentId: ids.id, engagementId: value.engagementId },
          },
        ],
      };
    },
  );
  await currentActor(tx, actor, locks);
  const row = await readOne(tx, receipt.resultRef);
  if (row.proposedByAccountId !== actor.accountId) fail('FORBIDDEN');
  await founderTarget(tx, row.engagementId, actor, host);
  const result = AmendmentResultSchema.parse({ status: receipt.status, amendment: view(row) });
  await session(tx, actor);
  return result;
}
/** The affected member accepts or declines. Only an accepted amendment changes the effective terms. */
export async function respondToAmendment(tx: Tx, command: WorkCommand, host: AmendmentHost) {
  validate(tx, command?.actor);
  hostContract(host);
  const parsed = RespondAmendmentInput.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const value = parsed.data,
    actor = command.actor;
  await session(tx, actor);
  let auth: Awaited<ReturnType<typeof currentHuman>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'RespondToAmendment',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async () => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      auth = await currentHuman(tx, actor);
      // Only an actual member sees the proposal; absent and foreign proposals are indistinguishable.
      const ref = await tx.query<{ engagementId: string }>(
        'SELECT a."engagementId"::text FROM "EngagementAmendment" a JOIN "EngagementMember" m ON m."engagementId"=a."engagementId" WHERE a."id"=$1::uuid AND m."participantId"=$2::uuid',
        [value.amendmentId, auth.participantId],
      );
      if (ref.length !== 1) fail('NOT_FOUND');
      const engagement = await lockEngagement(tx, ref[0].engagementId);
      const rows = await tx.query<Row>(
        `SELECT ${COLUMNS} FROM "EngagementAmendment" a WHERE a."id"=$1::uuid FOR UPDATE`,
        [value.amendmentId],
      );
      if (rows.length !== 1) fail('STORAGE_CONTRACT');
      const amendment = rows[0];
      const now = await clock(tx);
      if (amendment.state !== 'PROPOSED' || amendment.expiresAt.getTime() <= now.getTime())
        fail('AMENDMENT_UNAVAILABLE');
      if (!AMENDABLE.has(engagement.state)) fail('ENGAGEMENT_STATE');
      let state = 'DECLINED';
      let consentRef: string | null = null;
      let agreed: TermsSnapshot | null = null;
      if (value.decision === 'ACCEPT') {
        const proposed = view(amendment);
        if (lapsed(proposed.terms, now)) fail('AMENDMENT_UNAVAILABLE');
        agreed = proposed.terms;
        const before = await effective(tx, amendment.engagementId);
        const consent = await host.assessConsent(tx, {
          actor,
          participantId: auth.participantId,
          engagementId: amendment.engagementId,
          amendmentId: amendment.id,
          digest: proposed.digest,
          terms: proposed.terms,
        });
        if (!consent || !InternalId.safeParse(consent.consentRef).success) fail('CONSENT_REQUIRED');
        const added = increases(before, proposed.terms);
        if (added.length) {
          if (
            amendment.additionalFundingRef === null ||
            (await host.fundingAvailable(tx, {
              engagementId: amendment.engagementId,
              amendmentId: amendment.id,
              fundingRef: amendment.additionalFundingRef,
              increase: added,
            })) !== true
          )
            fail('FUNDING_REQUIRED');
        }
        state = 'ACCEPTED';
        consentRef = consent.consentRef;
      }
      // Host callbacks and lock waits cannot carry an expired session, proposal or proposer authority across the boundary.
      await currentHuman(tx, actor, auth.locks);
      const decidedAt = await clock(tx);
      if (amendment.expiresAt.getTime() <= decidedAt.getTime()) fail('AMENDMENT_UNAVAILABLE');
      if (agreed) {
        if (lapsed(agreed, decidedAt)) fail('AMENDMENT_UNAVAILABLE');
        await proposerStillAuthorized(tx, amendment, host);
      }
      await tx.query(
        'UPDATE "EngagementAmendment" SET "state"=$2,"decidedByAccountId"=$3,"consentRef"=$4,"decidedAt"=clock_timestamp() WHERE "id"=$1::uuid RETURNING "id"',
        [amendment.id, state, actor.accountId, consentRef],
      );
      return {
        resultRef: amendment.id,
        events: [
          {
            type:
              state === 'ACCEPTED' ? 'work.amendment_accepted.v1' : 'work.amendment_declined.v1',
            aggregateId: amendment.engagementId,
            aggregateVersion: amendment.sequence,
            guildId: engagement.guildId,
            payload: { amendmentId: amendment.id, engagementId: amendment.engagementId },
          },
        ],
      };
    },
  );
  auth = await currentHuman(tx, actor, auth?.locks);
  const rows = await tx.query<Row>(
    `SELECT ${COLUMNS} FROM "EngagementAmendment" a JOIN "EngagementMember" m ON m."engagementId"=a."engagementId" WHERE a."id"=$1::uuid AND m."participantId"=$2::uuid`,
    [receipt.resultRef, auth.participantId],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const result = AmendmentResultSchema.parse({ status: receipt.status, amendment: view(rows[0]) });
  await session(tx, actor);
  return result;
}
/** The proposer withdraws a still-open proposal. */
export async function withdrawAmendment(tx: Tx, command: WorkCommand, host: AmendmentHost) {
  validate(tx, command?.actor);
  hostContract(host);
  const parsed = WithdrawAmendmentInput.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const value = parsed.data,
    actor = command.actor;
  await session(tx, actor);
  let locks: Awaited<ReturnType<typeof currentActor>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'WithdrawAmendment',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async () => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      locks = await currentActor(tx, actor);
      const ref = await tx.query<{ engagementId: string; proposer: string }>(
        'SELECT "engagementId"::text,"proposedByAccountId" AS proposer FROM "EngagementAmendment" WHERE "id"=$1::uuid',
        [value.amendmentId],
      );
      if (ref.length !== 1 || ref[0].proposer !== actor.accountId) fail('FORBIDDEN');
      await founderTarget(tx, ref[0].engagementId, actor, host);
      const engagement = await lockEngagement(tx, ref[0].engagementId);
      const rows = await tx.query<Row>(
        `SELECT ${COLUMNS} FROM "EngagementAmendment" a WHERE a."id"=$1::uuid FOR UPDATE`,
        [value.amendmentId],
      );
      if (rows.length !== 1) fail('STORAGE_CONTRACT');
      if (rows[0].state !== 'PROPOSED') fail('AMENDMENT_UNAVAILABLE');
      await currentActor(tx, actor, locks);
      await founderTarget(tx, ref[0].engagementId, actor, host);
      await tx.query(
        'UPDATE "EngagementAmendment" SET "state"=\'WITHDRAWN\',"decidedByAccountId"=$2,"decidedAt"=clock_timestamp() WHERE "id"=$1::uuid RETURNING "id"',
        [value.amendmentId, actor.accountId],
      );
      return {
        resultRef: value.amendmentId,
        events: [
          {
            type: 'work.amendment_withdrawn.v1',
            aggregateId: ref[0].engagementId,
            aggregateVersion: rows[0].sequence,
            guildId: engagement.guildId,
            payload: { amendmentId: value.amendmentId, engagementId: ref[0].engagementId },
          },
        ],
      };
    },
  );
  await currentActor(tx, actor, locks);
  const row = await readOne(tx, receipt.resultRef);
  if (row.proposedByAccountId !== actor.accountId) fail('FORBIDDEN');
  await founderTarget(tx, row.engagementId, actor, host);
  const result = AmendmentResultSchema.parse({ status: receipt.status, amendment: view(row) });
  await session(tx, actor);
  return result;
}
/** The member's current promise: the original accepted terms or the latest amendment they agreed to. */
export async function readEffectiveTerms(tx: Tx, actor: WorkActor, engagementId: string) {
  validate(tx, actor);
  if (!/^[0-9a-f-]{36}$/.test(String(engagementId))) fail('INVALID_INPUT');
  const auth = await currentHuman(tx, actor);
  const member = await tx.query(
    'SELECT 1 FROM "EngagementMember" WHERE "engagementId"=$1::uuid AND "participantId"=$2::uuid',
    [engagementId, auth.participantId],
  );
  if (member.length !== 1) fail('NOT_FOUND');
  const terms = await effective(tx, engagementId);
  await currentHuman(tx, actor, auth.locks);
  return terms;
}
/** Every version of one engagement's terms, for its member or its authorized Founder. */
export async function readEngagementAmendments(
  tx: Tx,
  actor: WorkActor,
  engagementId: string,
  host: Pick<AmendmentHost, 'authorize'>,
) {
  validate(tx, actor);
  if (!/^[0-9a-f-]{36}$/.test(String(engagementId)) || typeof host?.authorize !== 'function')
    fail('INVALID_INPUT');
  await currentActor(tx, actor);
  const member = await tx.query(
    'SELECT 1 FROM "EngagementMember" m JOIN "Participant" p ON p."id"=m."participantId" WHERE m."engagementId"=$1::uuid AND p."accountId"=$2',
    [engagementId, actor.accountId],
  );
  if (!member.length) await founderTarget(tx, engagementId, actor, host as AmendmentHost);
  const rows = await tx.query<Row>(
    `SELECT ${COLUMNS} FROM "EngagementAmendment" a WHERE a."engagementId"=$1::uuid ORDER BY a."sequence"`,
    [engagementId],
  );
  return rows.map(view);
}
