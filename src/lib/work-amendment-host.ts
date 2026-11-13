import { WorkError, type WorkActor, type WorkCommand } from '../work-loop/contracts';
import type { AmendmentHost, RewardIncrease } from '../work-loop/amendment-contracts';
import {
  proposeAmendment,
  respondToAmendment,
  withdrawAmendment,
  readAmendmentDeskEntries,
} from '../work-loop/amendment-storage';
import type { AmendmentDesk } from '../work-loop/amendment-desk-contracts';
import { samePolicy, type RewardAsset } from '../work-loop/creation-form';
import { assetKey } from '../contracts/assets';
import { workAmendmentsEnabled } from './config';
import { runCommandTransaction, runSnapshotReadTransaction } from './command-receipts-adapter';
import { isWorkOperator, workWorkspaceConfiguration } from './work-workspace-host';
import { rewardCatalog } from './work-creation-host';
import { db } from './db';

export interface RootAmendmentConfig {
  allowNewWrites: boolean;
  /** Synthetic operator allowlist standing in for Guild authority, which the shared Root cannot recognize yet. */
  isOperator?: (accountId: string) => boolean;
  /** Host-declared synthetic reward coverage (WORK_REWARD_ASSETS_JSON). */
  catalog?: readonly RewardAsset[];
  /** The exact proposal digest the consenting member says they read; null means no consent was given. */
  expectedDigest?: string | null;
}
const reservationRef = (amendmentId: string) => 'sim-amendment-reservation:' + amendmentId;
/**
 * True when EVERY increased leg matches a funded catalog policy exactly (one leg per asset). Coverage is simulated
 * host configuration, not a balance, and no money moves; one uncovered leg leaves the whole increase unfunded.
 */
function covered(catalog: readonly RewardAsset[], increase: readonly RewardIncrease[]) {
  const keys = increase.map((leg) => assetKey(leg.policy.assetId));
  return (
    increase.length > 0 &&
    new Set(keys).size === keys.length &&
    increase.every((leg) =>
      catalog.some((asset) => asset.funded && samePolicy(asset.policy, leg.policy)),
    )
  );
}
/**
 * Amendment host for the shared Root. Founder authority is the explicit synthetic operator allowlist
 * (`RAID_WORK_OPERATOR_ACCOUNT_IDS`) asked inside the command's own transaction, and the storage command additionally
 * requires the proposer to be the listing's creator and not a member: this is NOT Guild or production authority and
 * the Guild id is deliberately ignored. The member's consent is their own request naming the exact proposal digest;
 * a different digest, or none, is `CONSENT_REQUIRED`.
 */
export function createRootAmendmentHost(config: RootAmendmentConfig): AmendmentHost {
  const isOperator = config.isOperator ?? isWorkOperator;
  const catalog = config.catalog ?? rewardCatalog();
  const expected = config.expectedDigest ?? null;
  return {
    allowNewWrites: config.allowNewWrites,
    authorize: async (_tx, actor) => isOperator(actor.accountId),
    /** Desk reads: the same synthetic allowlist, answered without touching the snapshot port. */
    authorizeRead: async (_snapshot, actor) => isOperator(actor.accountId),
    authorizeProposer: async (_tx, proposer) => isOperator(proposer.accountId),
    reserveAdditionalFunding: async (_tx, binding) =>
      covered(catalog, binding.increase) ? reservationRef(binding.amendmentId) : null,
    fundingAvailable: async (_tx, binding) =>
      binding.fundingRef === reservationRef(binding.amendmentId) &&
      covered(catalog, binding.increase),
    assessConsent: async (_tx, context) =>
      expected !== null && expected === context.digest
        ? { consentRef: `root-amendment-consent:${context.participantId}:${context.digest}` }
        : null,
  };
}
const host = (expectedDigest: string | null = null) =>
  createRootAmendmentHost({ allowNewWrites: workAmendmentsEnabled(), expectedDigest });
/** HTTP entries. `WORK_AMENDMENTS_ENABLED` is the only write switch; a replay of an earlier command is still answered. */
export const proposeAmendmentFromHost = (command: WorkCommand) =>
  runCommandTransaction(db, (tx) => proposeAmendment(tx, command, host()));
export const respondToAmendmentFromHost = (command: WorkCommand, expectedDigest: string | null) =>
  runCommandTransaction(db, (tx) => respondToAmendment(tx, command, host(expectedDigest)));
export const withdrawAmendmentFromHost = (command: WorkCommand) =>
  runCommandTransaction(db, (tx) => withdrawAmendment(tx, command, host()));

const LIMIT = 20;
interface Row {
  id: string;
  state: 'ACCESS_PENDING' | 'IN_PROGRESS';
  title: string;
}
/**
 * The caller's own amendable engagements, as member and (for an allowlisted listing creator) as Founder, with every
 * recorded version of their terms. Reads stay available when writes are off; they need the workspace read switch.
 *
 * One snapshot (#361-5): the engagement lists, each history and each effective-terms copy are read in ONE
 * `REPEATABLE READ`, `READ ONLY` transaction (`runSnapshotReadTransaction`), so a consent or withdrawal committing
 * mid-read can never show a history from before it beside terms from after it. The read takes no identity advisory
 * locks (write paths keep their lock order, unchanged); the caller's own current Session and human Participant are
 * checked inside the snapshot and fail the desk closed, but an engagement the caller no longer has authority over is
 * omitted instead of failing the whole desk. The list query alone grants nothing: every entry re-proves authority.
 */
export async function readAmendmentDeskFromHost(actor: WorkActor): Promise<AmendmentDesk> {
  if (!workWorkspaceConfiguration().readsAvailable) throw new WorkError('STORAGE_CONTRACT');
  const readHost = host();
  const engagements = await runSnapshotReadTransaction(db, async (tx) => {
    const members = await tx.query<Row>(
      `SELECT e."id"::text AS id,e."state",t."snapshot"->>'title' AS title FROM "Engagement" e
       JOIN "EngagementMember" m ON m."engagementId"=e."id" JOIN "Participant" p ON p."id"=m."participantId"
       JOIN "TermsVersion" t ON t."id"=e."termsVersionId"
       WHERE p."accountId"=$1 AND e."state" IN ('ACCESS_PENDING','IN_PROGRESS') ORDER BY e."createdAt" DESC LIMIT ${LIMIT}`,
      [actor.accountId],
    );
    const founder = isWorkOperator(actor.accountId)
      ? await tx.query<Row>(
          `SELECT e."id"::text AS id,e."state",t."snapshot"->>'title' AS title FROM "Engagement" e
           JOIN "RaidSlot" s ON s."id"=e."slotId" JOIN "WorkListing" l ON l."id"=s."listingId"
           JOIN "TermsVersion" t ON t."id"=e."termsVersionId"
           WHERE l."creatorAccountId"=$1 AND e."state" IN ('ACCESS_PENDING','IN_PROGRESS')
             AND NOT EXISTS (SELECT 1 FROM "EngagementMember" m JOIN "Participant" p ON p."id"=m."participantId" WHERE m."engagementId"=e."id" AND p."accountId"=$1)
           ORDER BY e."createdAt" DESC LIMIT ${LIMIT}`,
          [actor.accountId],
        )
      : [];
    const candidates = [
      ...members.map((row) => ({ row, role: 'MEMBER' as const })),
      ...founder.map((row) => ({ row, role: 'FOUNDER' as const })),
    ];
    const entries = await readAmendmentDeskEntries(
      tx,
      actor,
      candidates.map(({ row, role }) => ({ engagementId: row.id, role })),
      readHost,
      LIMIT,
    );
    const shown = new Map(entries.map((entry) => [`${entry.role}:${entry.engagementId}`, entry]));
    return candidates
      .flatMap(({ row, role }) => {
        const entry = shown.get(`${role}:${row.id}`);
        return entry
          ? [
              {
                engagementId: row.id,
                title: row.title,
                state: row.state,
                role,
                effectiveTerms: entry.effectiveTerms,
                amendments: entry.amendments,
              },
            ]
          : [];
      })
      .slice(0, LIMIT);
  });
  return { version: 'v1' as const, proposalsAvailable: workAmendmentsEnabled(), engagements };
}
