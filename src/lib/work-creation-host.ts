import { z } from 'zod';
import { assetKey } from '../contracts/assets';
import { WorkError, type WorkActor, type WorkCommand, type WorkHost } from '../work-loop/contracts';
import { saveRaidTerms, publishRaid } from '../work-loop/storage';
import { readCreationDrafts } from '../work-loop/creation-storage';
import { createSimulatedReservations } from '../work-loop/simulated-reservation';
import { RewardAssetSchema, toDraftView } from '../work-loop/creation-contracts';
import { RubricSchema } from '../work-loop/recommendation-contracts';
import { recommend } from '../work-loop/recommendation';
import { hasGuildAuthority } from '../guild-profiles/guild-storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';

const flag = (name: string) => process.env[name] === 'true';
export function workCreationConfiguration() {
  return {
    readsAvailable: flag('WORK_CREATION_READS_ENABLED'),
    savesAvailable: flag('WORK_CREATION_SAVE_ENABLED'),
    publishAvailable: flag('WORK_CREATION_PUBLISH_ENABLED'),
    recommendationsAvailable: flag('WORK_RECOMMENDATIONS_ENABLED'),
  };
}
/** Synthetic-only authority, as for the work workspace: the shared Root has no recognized Guild role. */
function operators() {
  return new Set(
    (process.env.RAID_WORK_OPERATOR_ACCOUNT_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}
const guildId = () => process.env.RAID_WORK_GUILD_ID?.trim() || 'synthetic-guild';
/** Host-declared synthetic reward assets. Unset or malformed means nothing can be rewarded or reserved. */
export function rewardCatalog() {
  try {
    const parsed = z
      .array(RewardAssetSchema)
      .max(20)
      .safeParse(JSON.parse(process.env.WORK_REWARD_ASSETS_JSON ?? '[]'));
    if (!parsed.success) return [];
    const keys = parsed.data.map((asset) => assetKey(asset.policy.assetId));
    // Ambiguous duplicates fail closed: nothing can be offered or reserved from an inconsistent catalog.
    return new Set(keys).size === keys.length ? parsed.data : [];
  } catch {
    return [];
  }
}
function workHost(allowNewWrites: boolean): WorkHost {
  return {
    allowNewWrites,
    authorize: async (_tx, actor, guild, action) =>
      action === 'MANAGE_LISTING' && guild === guildId() && operators().has(actor.accountId),
    reserveSimulatedFunding: createSimulatedReservations(rewardCatalog()),
  };
}
function requireReads() {
  if (!workCreationConfiguration().readsAvailable) throw new WorkError('STORAGE_CONTRACT');
}
/** Labels that keep the synthetic catalog open on a hosted (NODE_ENV=production) deployment. */
const HOSTED_NON_PRODUCTION_LABELS = ['staging', 'pilot', 'alpha'];
/**
 * DEC-2026-11-13-15 (2): fail closed. `RAID_ENVIRONMENT=production` always restricts, even beside a demo flag. Under
 * NODE_ENV=production (every hosted deployment) only an affirmatively declared staging, pilot or alpha label keeps
 * the synthetic catalog open; `demo`, `local`, a mistyped label such as `prod` and a missing label all restrict, so a
 * hosted non-production deployment must declare RAID_ENVIRONMENT. Outside NODE_ENV=production (development, tests)
 * the synthetic catalog stays open.
 */
function catalogRestricted(env: Record<string, string | undefined> = process.env) {
  const label = (env.RAID_ENVIRONMENT ?? '').trim().toLowerCase();
  if (label === 'production') return true;
  return env.NODE_ENV === 'production' && !HOSTED_NON_PRODUCTION_LABELS.includes(label);
}
export async function creationStateFromHost(actor: WorkActor) {
  requireReads();
  const config = workCreationConfiguration();
  const catalog = rewardCatalog();
  const drafts = await runCommandTransaction(db, async (tx) => {
    // Production catalog: the Guild's Founder or a live WORK grantee only, recomputed here by the Guild host. Anyone
    // else, and any answer that is not exactly `true`, gets the settled not-found shape so existence does not leak.
    if (
      catalogRestricted() &&
      (await hasGuildAuthority(tx, actor.accountId, guildId(), 'WORK')) !== true
    )
      throw new WorkError('NOT_FOUND');
    return readCreationDrafts(tx, actor, workHost(false));
  });
  return {
    version: 'v1' as const,
    assets: catalog,
    drafts: drafts.map((draft) => toDraftView(draft, catalog)),
    savesAvailable: config.savesAvailable,
    publishAvailable: config.publishAvailable,
    recommendationsAvailable: config.recommendationsAvailable && rubric() !== null,
  };
}
export async function saveDraftFromHost(command: WorkCommand) {
  requireReads();
  const host = workHost(workCreationConfiguration().savesAvailable);
  const input = command.input as {
    listingId: string | null;
    expectedRevision: number;
    terms: unknown;
  };
  return runCommandTransaction(db, async (tx) => {
    const saved = await saveRaidTerms(
      tx,
      { ...command, input: { ...input, guildId: guildId() } },
      host,
    );
    const draft = (
      await readCreationDrafts(tx, command.actor, host, {
        listingId: saved.listingId,
        termsVersionId: saved.termsVersionId,
      })
    ).find((d) => d.listingId === saved.listingId);
    if (!draft) throw new WorkError('STORAGE_CONTRACT');
    return { status: saved.status, draft: toDraftView(draft, rewardCatalog()) };
  });
}
export async function publishDraftFromHost(command: WorkCommand) {
  requireReads();
  const host = workHost(workCreationConfiguration().publishAvailable);
  return runCommandTransaction(db, (tx) => publishRaid(tx, command, host));
}
function rubric() {
  try {
    const parsed = RubricSchema.safeParse(
      JSON.parse(process.env.WORK_RECOMMENDATION_RUBRIC_JSON ?? 'null'),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
/** Advice only. With no configured rubric there is no recommendation; the Founder simply chooses. */
export async function recommendFromHost(_actor: WorkActor, input: unknown) {
  requireReads();
  const configured = rubric();
  if (!workCreationConfiguration().recommendationsAvailable || !configured)
    throw new WorkError('STORAGE_CONTRACT');
  return recommend(input, configured);
}
