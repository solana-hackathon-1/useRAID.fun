import { z } from 'zod';
import { JsonBodyFailure } from '../http-contracts/json';
import {
  assertGuildHttpHost,
  GuildHttpAuthorityError,
  guildCorrelation,
  guildHttpFailure,
  guildHttpHeaders,
  guildStorageCodes,
  readGuildCommand,
} from './guild-http-shared';
import {
  GrantGuildRoleInputSchema,
  GuildRoleGrantViewSchema,
  GuildStorageError,
  OwnershipTransferViewSchema,
  ProposeOwnershipTransferInputSchema,
  type GuildActor,
  type GuildCommand,
} from './guild-storage-contracts';

export class GuildRolesHttpError extends GuildHttpAuthorityError {
  constructor(status: 401 | 403 | 429) {
    super(status);
    this.name = 'GuildRolesHttpError';
  }
}
/**
 * Transport-neutral host: authority comes from the host's own session, never from the request body. The commands are
 * the host's wiring of `grantGuildRole`, `revokeGuildRole`, `proposeOwnershipTransfer` and `respondOwnershipTransfer`
 * (the last with the host's own `authorizeOwnershipTransfer` policy). There are no reads here, so only the command
 * throttle scope is used.
 */
export interface GuildRolesHttpHost {
  readonly version: 'v1';
  requestId(): string;
  actor(): Promise<GuildActor>;
  checkOrigin(request: Request): Promise<void> | void;
  rateLimit(actor: GuildActor, scope: 'READ' | 'WRITE'): Promise<void>;
  grant(command: GuildCommand): Promise<unknown>;
  revoke(command: GuildCommand): Promise<unknown>;
  propose(command: GuildCommand): Promise<unknown>;
  respond(command: GuildCommand): Promise<unknown>;
}
const GrantResultSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  grant: GuildRoleGrantViewSchema,
});
const TransferResultSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  transfer: OwnershipTransferViewSchema,
});
const RevokeBodySchema = z.strictObject({ guildId: z.uuid() });
const RespondBodySchema = z.strictObject({
  guildId: z.uuid(),
  decision: z.enum(['ACCEPT', 'DECLINE', 'WITHDRAW']),
});
// A revoked grant, a changed transfer and a repeated revocation all mean "the record is no longer as it was".
const STORAGE_CODES = guildStorageCodes({
  GRANT_REVOKED: 'REVISION_CHANGED',
  GRANT_LIMIT: 'GUILD_GRANT_LIMIT_REACHED',
  TRANSFER_PENDING: 'GUILD_TRANSFER_PENDING',
});
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);
const FINAL_STATE = { ACCEPT: 'ACCEPTED', DECLINE: 'DECLINED', WITHDRAW: 'WITHDRAWN' } as const;
const contract = () => new GuildStorageError('STORAGE_CONTRACT');
export function createGuildRolesHandlers(host: GuildRolesHttpHost) {
  assertGuildHttpHost(host, [
    'requestId',
    'actor',
    'checkOrigin',
    'rateLimit',
    'grant',
    'revoke',
    'propose',
    'respond',
  ]);
  const correlation = () => guildCorrelation(host);
  /** Origin, then the session actor, then the command throttle; the body is read only after all three passed. */
  async function begin(request: Request) {
    await host.checkOrigin(request);
    const actor = await host.actor();
    await host.rateLimit(actor, 'WRITE');
    return actor;
  }
  const id = (value: string | Promise<string>) =>
    Promise.resolve(value).then((raw) => {
      const parsed = z.uuid().safeParse(raw);
      if (!parsed.success) throw new JsonBodyFailure(422);
      return parsed.data;
    });
  const ok = (value: unknown) => Response.json(value, { headers: guildHttpHeaders });
  return {
    async GRANT(request: Request) {
      const requestId = correlation();
      try {
        const actor = await begin(request);
        const { key, json } = await readGuildCommand(request);
        const input = GrantGuildRoleInputSchema.safeParse(json);
        if (!input.success) throw new JsonBodyFailure(422);
        const value = GrantResultSchema.safeParse(
          // The validated body goes on as sent: storage parses it again, and its normalized form is not valid input.
          await host.grant({ actor, input: json, idempotencyKey: key, requestId }),
        );
        const want = input.data;
        if (!value.success) throw contract();
        const { status, grant } = value.data;
        if (
          !same(grant.guildId, want.guildId) ||
          grant.granteeAccountId !== want.granteeAccountId ||
          grant.kind !== want.kind ||
          !sameList([...grant.fields].sort(), want.fields) ||
          grant.canDelegate !== want.canDelegate ||
          grant.expiresAt !== want.expiresAt ||
          // Only the issuer receives a grant result, and the issuer is the caller.
          grant.grantedByAccountId !== actor.accountId ||
          // A replay may find the grant revoked since; a fresh grant is live.
          (status === 'EXECUTED' && grant.revokedAt !== null)
        )
          throw contract();
        return ok(value.data);
      } catch (error) {
        return guildHttpFailure(error, requestId, STORAGE_CODES);
      }
    },
    async REVOKE(request: Request, grantId: string | Promise<string>) {
      const requestId = correlation();
      try {
        const actor = await begin(request);
        const target = await id(grantId);
        const { key, json } = await readGuildCommand(request);
        const body = RevokeBodySchema.safeParse(json);
        if (!body.success) throw new JsonBodyFailure(422);
        const value = GrantResultSchema.safeParse(
          await host.revoke({
            actor,
            input: { guildId: body.data.guildId, grantId: target },
            idempotencyKey: key,
            requestId,
          }),
        );
        if (
          !value.success ||
          !same(value.data.grant.id, target) ||
          !same(value.data.grant.guildId, body.data.guildId) ||
          // Revocation sticks, so a fresh result and a replay both show a revoked grant.
          value.data.grant.revokedAt === null
        )
          throw contract();
        // The issuer is already redacted by storage for callers without profile authority; it passes through as is.
        return ok(value.data);
      } catch (error) {
        return guildHttpFailure(error, requestId, STORAGE_CODES);
      }
    },
    async PROPOSE(request: Request) {
      const requestId = correlation();
      try {
        const actor = await begin(request);
        const { key, json } = await readGuildCommand(request);
        const input = ProposeOwnershipTransferInputSchema.safeParse(json);
        if (!input.success) throw new JsonBodyFailure(422);
        const value = TransferResultSchema.safeParse(
          await host.propose({ actor, input: input.data, idempotencyKey: key, requestId }),
        );
        if (!value.success) throw contract();
        const { status, transfer } = value.data;
        if (
          !same(transfer.guildId, input.data.guildId) ||
          transfer.toAccountId !== input.data.toAccountId ||
          transfer.fromAccountId !== actor.accountId ||
          transfer.expiresAt !== input.data.expiresAt ||
          transfer.applied !== (transfer.state === 'ACCEPTED') ||
          // A replay may find the proposal decided since; a fresh one is still open.
          (status === 'EXECUTED' && (transfer.state !== 'PROPOSED' || transfer.decidedAt !== null))
        )
          throw contract();
        return ok(value.data);
      } catch (error) {
        return guildHttpFailure(error, requestId, STORAGE_CODES);
      }
    },
    async RESPOND(request: Request, transferId: string | Promise<string>) {
      const requestId = correlation();
      try {
        const actor = await begin(request);
        const target = await id(transferId);
        const { key, json } = await readGuildCommand(request);
        const body = RespondBodySchema.safeParse(json);
        if (!body.success) throw new JsonBodyFailure(422);
        const value = TransferResultSchema.safeParse(
          await host.respond({
            actor,
            input: { guildId: body.data.guildId, transferId: target, decision: body.data.decision },
            idempotencyKey: key,
            requestId,
          }),
        );
        if (!value.success) throw contract();
        const { transfer } = value.data;
        const party =
          body.data.decision === 'WITHDRAW' ? transfer.fromAccountId : transfer.toAccountId;
        if (
          !same(transfer.id, target) ||
          !same(transfer.guildId, body.data.guildId) ||
          party !== actor.accountId ||
          // A decision is final, so a replay shows the same outcome as the fresh answer: the requested
          // decision, or the lapse that overtook it (which moves nothing).
          (transfer.state !== FINAL_STATE[body.data.decision] && transfer.state !== 'EXPIRED') ||
          transfer.applied !== (transfer.state === 'ACCEPTED') ||
          transfer.decidedAt === null
        )
          throw contract();
        return ok(value.data);
      } catch (error) {
        return guildHttpFailure(error, requestId, STORAGE_CODES);
      }
    },
  };
}
