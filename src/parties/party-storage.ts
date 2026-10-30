import { z } from 'zod';
import {
  canonicalRequestDigest,
  executeIdempotentCommand,
  type CommandReceiptTransaction as Tx,
} from '../command-receipts';
import type { WorkCommand } from '../work-loop/contracts';
import {
  fail,
  validate,
  session,
  currentHuman,
  clock,
  definition,
  source,
} from '../work-loop/engagement-authority';
import {
  CreatePartyInput,
  CreatePartyResultSchema,
  PartyProposalSchema,
  ProposePartyRosterInput,
  ProposePartyRosterResultSchema,
  RecordPartyConsentInput,
  RecordPartyConsentResultSchema,
  type CreatePartyResult,
  type PartyHost,
  type PartyProposal,
  type ProposePartyRosterResult,
  type RecordPartyConsentResult,
} from './contracts';

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
function requireHost(tx: Tx, command: WorkCommand, host: PartyHost) {
  validate(tx, command?.actor);
  if (typeof host?.allowNewWrites !== 'boolean') fail('STORAGE_CONTRACT');
}

/** Creates a Party led by the commanding human's own participant. The label grants no skill, consent or payout. */
export async function createParty(
  tx: Tx,
  command: WorkCommand,
  host: PartyHost,
): Promise<CreatePartyResult> {
  requireHost(tx, command, host);
  const parsed = CreatePartyInput.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const actor = command.actor;
  await session(tx, actor);
  let auth: Awaited<ReturnType<typeof currentHuman>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'CreateParty',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: parsed.data,
    },
    async ({ receiptId }) => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      auth = await currentHuman(tx, actor);
      const [row] = await tx.query<{ id: string }>(
        'INSERT INTO "Party" ("name","leaderParticipantId","receiptId") VALUES ($1,$2::uuid,$3::uuid) RETURNING "id"::text',
        [parsed.data.name, auth.participantId, receiptId],
      );
      if (!row) fail('STORAGE_CONTRACT');
      await currentHuman(tx, actor, auth.locks);
      return {
        resultRef: row.id,
        events: [
          {
            type: 'work.party_created.v1',
            aggregateId: row.id,
            aggregateVersion: 1,
            guildId: null,
            payload: {},
          },
        ],
      };
    },
  );
  auth = await currentHuman(tx, actor, auth?.locks);
  const rows = await tx.query<Record<string, unknown>>(
    `SELECT "id"::text,"name","leaderParticipantId"::text,"createdAt" FROM "Party" WHERE "id"=$1::uuid AND "leaderParticipantId"=$2::uuid`,
    [receipt.resultRef, auth.participantId],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const result = CreatePartyResultSchema.safeParse({
    status: receipt.status,
    party: { ...rows[0], createdAt: iso(rows[0].createdAt) },
  });
  if (!result.success) fail('STORAGE_CONTRACT');
  return result.data;
}

interface ProposalRow {
  id: string;
  partyId: string;
  leaderParticipantId: string;
  slotId: string;
  termsVersionId: string;
  termsDigest: string;
  snapshotDigest: string;
  createdAt: unknown;
}
const PROPOSAL_COLUMNS =
  'p."id"::text,p."partyId"::text,p."leaderParticipantId"::text,p."slotId"::text,p."termsVersionId"::text,p."termsDigest",p."snapshotDigest",p."createdAt"';

async function loadProposal(tx: Tx, proposalId: string): Promise<PartyProposal | null> {
  const rows = await tx.query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM "PartyProposal" p WHERE p."id"=$1::uuid`,
    [proposalId],
  );
  if (rows.length !== 1) return null;
  const members = await tx.query<{
    participantId: string;
    role: string;
    allocations: unknown;
    consentedAt: unknown;
  }>(
    `SELECT m."participantId"::text,m."role",m."allocations",c."consentedAt"
     FROM "PartyProposalMember" m
     LEFT JOIN "PartyMemberConsent" c ON c."proposalId"=m."proposalId" AND c."participantId"=m."participantId"
     WHERE m."proposalId"=$1::uuid ORDER BY m."participantId"`,
    [proposalId],
  );
  const parsed = PartyProposalSchema.safeParse({
    ...rows[0],
    createdAt: iso(rows[0].createdAt),
    members: members.map((m) => ({ ...m, consentedAt: m.consentedAt ? iso(m.consentedAt) : null })),
    allConsented: members.length > 0 && members.every((m) => m.consentedAt),
  });
  if (!parsed.success) fail('STORAGE_CONTRACT');
  return parsed.data;
}

/**
 * The Party leader proposes an immutable roster and per-asset split for one available PARTY slot. Allocations are
 * exact integer base units, one per reward leg, and must sum to the leg's amount with no dust. This accepts nothing,
 * holds no capacity and moves no money; each human member must still consent to the returned digest.
 */
export async function proposePartyRoster(
  tx: Tx,
  command: WorkCommand,
  host: PartyHost,
): Promise<ProposePartyRosterResult> {
  requireHost(tx, command, host);
  const parsed = ProposePartyRosterInput.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const value = parsed.data,
    actor = command.actor;
  await session(tx, actor);
  let auth: Awaited<ReturnType<typeof currentHuman>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'ProposePartyRoster',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async ({ receiptId }) => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      // Listing then slot, then identity: the same order as acceptance.
      const slot = await source(tx, value.slotId);
      auth = await currentHuman(tx, actor);
      const parties = await tx.query<{ leader: string }>(
        'SELECT "leaderParticipantId"::text AS leader FROM "Party" WHERE "id"=$1::uuid',
        [value.partyId],
      );
      if (parties.length !== 1) fail('NOT_FOUND');
      if (parties[0].leader !== auth.participantId) fail('FORBIDDEN');
      if (slot.state === 'FILLED') fail('SLOT_FILLED');
      if (slot.state !== 'AVAILABLE' || slot.listingState !== 'OPEN') fail('PUBLICATION_BLOCKED');
      if (
        slot.termsVersionId !== value.termsVersionId ||
        slot.currentTermsVersionId !== value.termsVersionId
      )
        fail('TERMS_VERSION_CHANGED');
      const terms = await definition(tx, value.termsVersionId);
      if (canonicalRequestDigest(terms) !== value.termsDigest) fail('TERMS_VERSION_CHANGED');
      // Only human members consent in this milestone; an AI operator's consent for its worker is a later slice.
      if (terms.execution !== 'PARTY' || terms.participantKinds.some((kind) => kind !== 'HUMAN'))
        fail('PUBLICATION_BLOCKED');
      if (Date.parse(terms.deadlines.commitment) <= (await clock(tx)).getTime())
        fail('DEADLINE_PASSED');
      const ids = value.members.map((m) => m.participantId);
      if (new Set(ids).size !== ids.length) fail('INVALID_INPUT');
      // Exact, deterministic allocation: one amount per reward leg, summing to the leg with no dust or shortfall.
      terms.rewards.forEach((leg, index) => {
        let total = 0n;
        for (const member of value.members) {
          if (member.allocations.length !== terms.rewards.length) fail('INVALID_INPUT');
          total += BigInt(member.allocations[index].amount);
        }
        if (total !== BigInt(leg.amount)) fail('INVALID_INPUT');
      });
      const known = await tx.query<{ id: string }>(
        `SELECT p."id"::text FROM "Participant" p JOIN "User" u ON u."id"=p."accountId"
         WHERE p."id"=ANY(string_to_array($1,',')::uuid[]) AND p."kind"='HUMAN' AND u."suspended"=false`,
        [ids.join(',')],
      );
      if (known.length !== ids.length) fail('INVALID_INPUT');
      const members = [...value.members].sort((a, b) =>
        a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0,
      );
      // The digest members consent to binds the party, slot, exact terms and every role and allocation.
      const snapshotDigest = canonicalRequestDigest({
        partyId: value.partyId,
        slotId: value.slotId,
        termsVersionId: value.termsVersionId,
        termsDigest: value.termsDigest,
        members,
      });
      const [proposal] = await tx.query<{ id: string }>(
        `INSERT INTO "PartyProposal" ("partyId","leaderParticipantId","slotId","termsVersionId","termsDigest","snapshot","snapshotDigest","receiptId")
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::jsonb,$7,$8::uuid) RETURNING "id"::text`,
        [
          value.partyId,
          auth.participantId,
          value.slotId,
          value.termsVersionId,
          value.termsDigest,
          JSON.stringify({ members }),
          snapshotDigest,
          receiptId,
        ],
      );
      if (!proposal) fail('STORAGE_CONTRACT');
      for (const member of members)
        await tx.query(
          `INSERT INTO "PartyProposalMember" ("proposalId","participantId","role","allocations") VALUES ($1::uuid,$2::uuid,$3,$4::jsonb)`,
          [proposal.id, member.participantId, member.role, JSON.stringify(member.allocations)],
        );
      await currentHuman(tx, actor, auth.locks);
      return {
        resultRef: proposal.id,
        events: [
          {
            type: 'work.party_roster_proposed.v1',
            aggregateId: proposal.id,
            aggregateVersion: 1,
            guildId: slot.guildId,
            payload: { raidSlotId: value.slotId, termsVersionId: value.termsVersionId },
          },
        ],
      };
    },
  );
  auth = await currentHuman(tx, actor, auth?.locks);
  const proposal = await loadProposal(tx, receipt.resultRef);
  // A replay still answers only the leader who proposed.
  if (!proposal || proposal.leaderParticipantId !== auth.participantId) fail('STORAGE_CONTRACT');
  const result = ProposePartyRosterResultSchema.safeParse({ status: receipt.status, proposal });
  if (!result.success) fail('STORAGE_CONTRACT');
  return result.data;
}

/**
 * Records the commanding human's own consent to one proposal's exact digest. The participant comes from the session,
 * never from input, and the database rejects any consent whose commanding account does not own the participant, so a
 * leader cannot consent for another human. Append-only and idempotent; it accepts nothing by itself.
 */
export async function recordPartyMemberConsent(
  tx: Tx,
  command: WorkCommand,
  host: PartyHost,
): Promise<RecordPartyConsentResult> {
  requireHost(tx, command, host);
  const parsed = RecordPartyConsentInput.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const value = parsed.data,
    actor = command.actor;
  await session(tx, actor);
  let auth: Awaited<ReturnType<typeof currentHuman>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'RecordPartyMemberConsent',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async ({ receiptId }) => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      // Listing then slot, then identity, as propose and acceptance do. A proposal's slot never changes, so it is read
      // before locking; the locks keep the state below, and the consent guard's own reads, stable until commit.
      const slots = await tx.query<{ slotId: string }>(
        'SELECT "slotId"::text FROM "PartyProposal" WHERE "id"=$1::uuid',
        [value.proposalId],
      );
      if (slots.length !== 1) fail('NOT_FOUND');
      await source(tx, slots[0].slotId);
      auth = await currentHuman(tx, actor);
      // Someone outside the roster learns nothing about the proposal.
      const rows = await tx.query<{
        snapshotDigest: string;
        slotId: string;
        termsVersionId: string;
        state: string;
        listingState: string;
        currentTermsVersionId: string;
        guildId: string;
        commitment: string;
      }>(
        `SELECT p."snapshotDigest",p."slotId"::text,p."termsVersionId"::text,s."state",l."state" AS "listingState",l."currentTermsVersionId"::text,l."guildId",t."snapshot"->'deadlines'->>'commitment' AS "commitment"
         FROM "PartyProposal" p JOIN "PartyProposalMember" m ON m."proposalId"=p."id" AND m."participantId"=$2::uuid
         JOIN "RaidSlot" s ON s."id"=p."slotId" JOIN "WorkListing" l ON l."id"=s."listingId" JOIN "TermsVersion" t ON t."id"=p."termsVersionId"
         WHERE p."id"=$1::uuid`,
        [value.proposalId, auth.participantId],
      );
      if (rows.length !== 1) fail('NOT_FOUND');
      const proposal = rows[0];
      if (proposal.snapshotDigest !== value.snapshotDigest) fail('REVISION_CONFLICT');
      if (proposal.state === 'FILLED') fail('SLOT_FILLED');
      if (proposal.state !== 'AVAILABLE' || proposal.listingState !== 'OPEN')
        fail('PUBLICATION_BLOCKED');
      if (proposal.currentTermsVersionId !== proposal.termsVersionId) fail('TERMS_VERSION_CHANGED');
      if (Date.parse(proposal.commitment) <= (await clock(tx)).getTime()) fail('DEADLINE_PASSED');
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO "PartyMemberConsent" ("proposalId","participantId","snapshotDigest","receiptId") VALUES ($1::uuid,$2::uuid,$3,$4::uuid)
         ON CONFLICT ("proposalId","participantId") DO NOTHING RETURNING "id"::text`,
        [value.proposalId, auth.participantId, value.snapshotDigest, receiptId],
      );
      // A member who already consented to this proposal keeps that one consent.
      const id =
        inserted[0]?.id ??
        (
          await tx.query<{ id: string }>(
            'SELECT "id"::text FROM "PartyMemberConsent" WHERE "proposalId"=$1::uuid AND "participantId"=$2::uuid',
            [value.proposalId, auth.participantId],
          )
        )[0]?.id;
      if (!id) fail('STORAGE_CONTRACT');
      await currentHuman(tx, actor, auth.locks);
      return {
        resultRef: id,
        events: [
          {
            type: 'work.party_member_consented.v1',
            aggregateId: value.proposalId,
            aggregateVersion: 1,
            guildId: proposal.guildId,
            payload: { raidSlotId: proposal.slotId, termsVersionId: proposal.termsVersionId },
          },
        ],
      };
    },
  );
  auth = await currentHuman(tx, actor, auth?.locks);
  const rows = await tx.query<Record<string, unknown>>(
    `SELECT "id"::text,"proposalId"::text,"participantId"::text,"snapshotDigest","consentedAt" FROM "PartyMemberConsent" WHERE "id"=$1::uuid AND "participantId"=$2::uuid`,
    [receipt.resultRef, auth.participantId],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const result = RecordPartyConsentResultSchema.safeParse({
    status: receipt.status,
    consent: { ...rows[0], consentedAt: iso(rows[0].consentedAt) },
  });
  if (!result.success) fail('STORAGE_CONTRACT');
  return result.data;
}

const ReadInput = z.strictObject({ proposalId: z.uuid() });
/**
 * Current authorized read of one proposal and each member's consent state. Only the Party's leader and the named
 * members see it; anyone else gets NOT_FOUND. Available while new writes are off.
 */
export async function readPartyProposal(
  tx: Tx,
  actor: WorkCommand['actor'],
  input: unknown,
): Promise<PartyProposal> {
  validate(tx, actor);
  const parsed = ReadInput.safeParse(input);
  if (!parsed.success) fail('INVALID_INPUT');
  await session(tx, actor);
  const auth = await currentHuman(tx, actor);
  const proposal = await loadProposal(tx, parsed.data.proposalId);
  if (
    !proposal ||
    (proposal.leaderParticipantId !== auth.participantId &&
      !proposal.members.some((m) => m.participantId === auth.participantId))
  )
    fail('NOT_FOUND');
  await currentHuman(tx, actor, auth.locks);
  return proposal;
}
