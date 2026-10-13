import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { readBoundedJson, JsonBodyFailure } from '../http-contracts/json';
import {
  SaveGuildDraftInputSchema,
  GuildDraftStorageError,
  type GuildDraftActor,
  type GuildDraftCommand,
} from './draft-storage-contracts';
export { GuildDraftHttpStateSchema, GuildDraftHttpSavedSchema } from './http-contracts';
import { GuildDraftHttpStateSchema, GuildDraftHttpSavedSchema } from './http-contracts';
export interface GuildDraftHttpHost {
  version: 'v1';
  actor(): Promise<GuildDraftActor>;
  checkOrigin(request: Request): Promise<void> | void;
  rateLimit(actor: GuildDraftActor): Promise<void>;
  read(actor: GuildDraftActor, id: string): Promise<unknown>;
  save(command: GuildDraftCommand): Promise<unknown>;
  requestId(): string;
}
export { GuildDraftHttpError } from './http-errors';
import {
  guildPreparationHeaders as headers,
  guildPreparationFailure as failure,
  guildPreparationRequestId,
} from './http-errors';
/** Portable Request/Response adapter. Host authority is rebuilt from trusted current state. */
export function createGuildDraftHandlers(host: GuildDraftHttpHost) {
  if (host.version !== 'v1') throw new GuildDraftStorageError('STORAGE_CONTRACT');
  const requestId = () => guildPreparationRequestId(host);
  return {
    async POST(request: Request) {
      const id = requestId();
      try {
        await host.checkOrigin(request);
        const actor = await host.actor();
        await host.rateLimit(actor);
        const key = InternalId.safeParse(request.headers.get('idempotency-key'));
        if (!key.success) throw new JsonBodyFailure(422);
        const input = SaveGuildDraftInputSchema.safeParse(await readBoundedJson(request));
        if (!input.success) throw new JsonBodyFailure(422);
        const value = GuildDraftHttpSavedSchema.safeParse(
          await host.save({ actor, input: input.data, idempotencyKey: key.data, requestId: id }),
        );
        if (!value.success) throw new GuildDraftStorageError('STORAGE_CONTRACT');
        const snapshot = value.data.draft;
        if (
          snapshot.revision !== input.data.expectedRevision + 1 ||
          (input.data.guildDraftId !== null &&
            snapshot.id.toLowerCase() !== input.data.guildDraftId.toLowerCase()) ||
          snapshot.profile.name !== input.data.profile.name ||
          snapshot.profile.slug !== input.data.profile.slug ||
          snapshot.profile.description !== input.data.profile.description
        )
          throw new GuildDraftStorageError('STORAGE_CONTRACT');
        return Response.json(value.data, { headers });
      } catch (error) {
        return failure(error, id);
      }
    },
    async GET(_request: Request, draftId: string | Promise<string>) {
      const id = requestId();
      try {
        const actor = await host.actor();
        const parsed = z.uuid().safeParse(await draftId);
        if (!parsed.success) throw new JsonBodyFailure(422);
        const value = GuildDraftHttpStateSchema.safeParse(await host.read(actor, parsed.data));
        if (!value.success) throw new GuildDraftStorageError('STORAGE_CONTRACT');
        if (value.data.draft.id.toLowerCase() !== parsed.data.toLowerCase())
          throw new GuildDraftStorageError('STORAGE_CONTRACT');
        return Response.json(value.data, { headers });
      } catch (error) {
        return failure(error, id);
      }
    },
  };
}
