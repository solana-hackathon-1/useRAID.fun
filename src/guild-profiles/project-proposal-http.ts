import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { assetKey } from '../contracts/assets';
import { readBoundedJson, JsonBodyFailure } from '../http-contracts/json';
import {
  GuildDraftStorageError,
  type GuildDraftActor,
  type GuildDraftCommand,
} from './draft-storage-contracts';
import {
  GuildProjectProposalHttpInputSchema,
  GuildProjectProposalHttpStateSchema,
  GuildProjectProposalHttpSavedSchema,
} from './project-proposal-http-contracts';
import {
  guildPreparationHeaders,
  guildPreparationFailure,
  guildPreparationRequestId,
} from './http-errors';
export { GuildDraftHttpError as GuildProjectProposalHttpError } from './http-errors';
export * from './project-proposal-http-contracts';
export interface GuildProjectProposalHttpHost {
  version: 'v1';
  actor(): Promise<GuildDraftActor>;
  checkOrigin(request: Request): Promise<void> | void;
  rateLimit(actor: GuildDraftActor): Promise<void>;
  read(actor: GuildDraftActor, id: string): Promise<unknown>;
  save(command: GuildDraftCommand): Promise<unknown>;
  requestId(): string;
}
const target = async (id: string | Promise<string>) => {
  const parsed = z.uuid().safeParse(await id);
  if (!parsed.success) throw new JsonBodyFailure(422);
  return parsed.data.toLowerCase();
};
/** Portable private preparation adapter. Host supplies current actor/transaction/origin/rate authority. */
export function createGuildProjectProposalHandlers(host: GuildProjectProposalHttpHost) {
  if (host.version !== 'v1') throw new GuildDraftStorageError('STORAGE_CONTRACT');
  return {
    async GET(_request: Request, id: string | Promise<string>) {
      const requestId = guildPreparationRequestId(host);
      try {
        const actor = await host.actor(),
          guildDraftId = await target(id);
        const value = GuildProjectProposalHttpStateSchema.safeParse(
          await host.read(actor, guildDraftId),
        );
        if (!value.success || value.data.guildDraftId !== guildDraftId)
          throw new GuildDraftStorageError('STORAGE_CONTRACT');
        return Response.json(value.data, { headers: guildPreparationHeaders });
      } catch (error) {
        return guildPreparationFailure(error, requestId);
      }
    },
    async POST(request: Request, id: string | Promise<string>) {
      const requestId = guildPreparationRequestId(host);
      try {
        await host.checkOrigin(request);
        const actor = await host.actor();
        await host.rateLimit(actor);
        const guildDraftId = await target(id);
        const key = InternalId.safeParse(request.headers.get('idempotency-key'));
        if (!key.success) throw new JsonBodyFailure(422);
        const input = GuildProjectProposalHttpInputSchema.safeParse(await readBoundedJson(request));
        if (!input.success) throw new JsonBodyFailure(422);
        const value = GuildProjectProposalHttpSavedSchema.safeParse(
          await host.save({
            actor,
            input: { guildDraftId, ...input.data },
            idempotencyKey: key.data,
            requestId,
          }),
        );
        if (!value.success) throw new GuildDraftStorageError('STORAGE_CONTRACT');
        const p = value.data.proposal;
        if (
          value.data.guildDraftId !== guildDraftId ||
          p.revision !== input.data.expectedProposalRevision + 1 ||
          p.draftRevision !== input.data.expectedDraftRevision ||
          assetKey(p.candidateToken) !== assetKey(input.data.candidateToken) ||
          JSON.stringify(p.publicEvidenceRefs) !== JSON.stringify(input.data.publicEvidenceRefs)
        )
          throw new GuildDraftStorageError('STORAGE_CONTRACT');
        return Response.json(value.data, { headers: guildPreparationHeaders });
      } catch (error) {
        return guildPreparationFailure(error, requestId);
      }
    },
  };
}
