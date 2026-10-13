import { z } from 'zod';
import { GuildProfileDraftInputSchema } from './contracts';
export interface GuildDraftActor {
  accountId: string;
  actorAccountId: string;
  sessionHash: string;
}
export interface GuildDraftCommand {
  actor: GuildDraftActor;
  input: unknown;
  idempotencyKey: string;
  requestId: string;
}
export interface GuildDraftSaveOptions {
  allowNewWrites: boolean;
}
export const SaveGuildDraftInputSchema = z
  .strictObject({
    guildDraftId: z.uuid().nullable(),
    expectedRevision: z.number().int().min(0).max(2147483646),
    profile: GuildProfileDraftInputSchema,
  })
  .refine((input) =>
    input.guildDraftId === null ? input.expectedRevision === 0 : input.expectedRevision > 0,
  );
export const SavedGuildDraftSchema = z.strictObject({
  version: z.literal('v1'),
  id: z.uuid(),
  state: z.literal('DRAFT_UNVERIFIED'),
  revision: z.number().int().min(1).max(2147483647),
  recordedAt: z.iso.datetime(),
  founderControlVerified: z.literal(false),
  publicProfileApproved: z.literal(false),
  primaryToken: z.null(),
  profile: GuildProfileDraftInputSchema,
});
export type SavedGuildDraft = z.infer<typeof SavedGuildDraftSchema>;
export class GuildDraftStorageError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'WRONG_ACTOR'
      | 'UNAUTHENTICATED'
      | 'ACCOUNT_RESTRICTED'
      | 'NOT_FOUND'
      | 'WRITES_DISABLED'
      | 'REVISION_CONFLICT'
      | 'SLUG_IMMUTABLE'
      | 'SLUG_UNAVAILABLE'
      | 'STORAGE_CONTRACT'
      | 'STORAGE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'GuildDraftStorageError';
  }
}
