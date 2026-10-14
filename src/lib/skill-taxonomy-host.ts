import {
  publishSkillTaxonomy,
  readSkillTaxonomyForPublisher,
  type PublishSkillTaxonomyCommand,
  type SkillTaxonomyActor,
} from '../skills/taxonomy-storage';
import { adminXIds } from './admins';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';
import { SkillTaxonomyEditorStateSchema } from '../skills/taxonomy-http-contracts';
export function skillTaxonomyWriteConfiguration() {
  const writesAvailable = process.env.SKILL_TAXONOMY_PUBLICATION_ENABLED === 'true';
  return { writesAvailable, unavailableReason: writesAvailable ? null : ('DISABLED' as const) };
}
export async function publishSkillTaxonomyFromHost(command: PublishSkillTaxonomyCommand) {
  const result = await runCommandTransaction(db, (tx) =>
    publishSkillTaxonomy(tx, command, {
      allowNewWrites: skillTaxonomyWriteConfiguration().writesAvailable,
      // Read actual current allowlist on every locked authorization/replay boundary.
      canPublish: ({ xId }) => adminXIds().includes(xId),
    }),
  );
  return { version: 'v1' as const, ...result, ...skillTaxonomyWriteConfiguration() };
}
export async function readSkillTaxonomyEditorState(actor: SkillTaxonomyActor, id: string) {
  const taxonomy = await runCommandTransaction(db, (tx) =>
    readSkillTaxonomyForPublisher(tx, actor, id, {
      canPublish: ({ xId }) => adminXIds().includes(xId),
    }),
  );
  return SkillTaxonomyEditorStateSchema.parse({
    version: 'v1' as const,
    taxonomyId: id,
    publisherAccountId: actor.accountId,
    taxonomy,
    ...skillTaxonomyWriteConfiguration(),
  });
}
