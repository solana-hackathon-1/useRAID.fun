import { InternalId } from '../contracts/ids';
import {
  readSkillClaim,
  saveSkillClaim,
  type SkillClaimActor,
  type SaveSkillClaimCommand,
} from '../skills/claim-storage';
import { readPublishedSkillTaxonomy } from '../skills/taxonomy-storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';
export function skillClaimCatalogConfiguration(): string | null {
  const parsed = InternalId.safeParse(process.env.SKILL_TAXONOMY_ID);
  return parsed.success ? parsed.data : null;
}
export function skillClaimWriteConfiguration() {
  const writesAvailable = process.env.SKILL_CLAIMS_ENABLED === 'true';
  return { writesAvailable, unavailableReason: writesAvailable ? null : ('DISABLED' as const) };
}
export async function readSkillClaimState(actor: SkillClaimActor, skillId: string) {
  const claim = await runCommandTransaction(db, (tx) => readSkillClaim(tx, actor, skillId));
  return { version: 'v1' as const, skillId, claim, ...skillClaimWriteConfiguration() };
}
export async function readSkillCatalogState(actor: SkillClaimActor, id: string) {
  const taxonomy = await runCommandTransaction(db, (tx) =>
    readPublishedSkillTaxonomy(tx, actor, id),
  );
  return { version: 'v1' as const, taxonomyId: id, taxonomy };
}
export async function saveSkillClaimFromHost(command: SaveSkillClaimCommand) {
  const result = await runCommandTransaction(db, (tx) =>
    saveSkillClaim(tx, command, { allowNewWrites: skillClaimWriteConfiguration().writesAvailable }),
  );
  return { version: 'v1' as const, ...result, ...skillClaimWriteConfiguration() };
}
