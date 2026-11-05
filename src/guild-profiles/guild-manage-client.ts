import { z } from 'zod';
import {
  EditGuildProfileInputSchema,
  ManagedGuildSchema,
  ManagedGuildUpdateSchema,
  type ManagedGuild,
  type ManagedGuildUpdate,
} from './guild-storage-contracts';

/**
 * Portable browser half of the Guild management HTTP routes (`/api/v1/guild-profile`, `/api/v1/guild-updates`). It
 * imports only zod and owned pure contracts, parses every success with the server's strict schemas, checks the result
 * is the command that was sent, and keeps one idempotency key per unchanged intent so an unconfirmed request can be
 * retried safely. The server, not this client, is the authority; messages are fixed copy, never server text.
 */
export type ManageFailure =
  | 'UNCERTAIN'
  | 'SIGN_IN'
  | 'DENIED'
  | 'GONE'
  | 'STALE'
  | 'LIMIT'
  | 'INVALID'
  | 'THROTTLED'
  | 'UNAVAILABLE';
export type ManageOutcome<T> =
  | { kind: 'DONE'; value: T }
  | { kind: 'BUSY' }
  | { kind: ManageFailure; message: string; retrySame: boolean };

const MESSAGES: Record<ManageFailure, string> = {
  UNCERTAIN:
    'The change could not be confirmed. Keep this page open and retry; the same request is sent again.',
  SIGN_IN: 'Sign in again to continue. Your text is kept on this page.',
  DENIED: 'This is not permitted for your account in this Guild, or your authority has changed.',
  GONE: 'This is no longer available. Reload the page.',
  STALE: 'The saved details changed since you opened this page. Reload them, then review and save.',
  LIMIT: 'The limit for saved updates has been reached. Withdraw an unpublished update first.',
  INVALID: 'Check the fields and try again.',
  THROTTLED: 'Too many requests. Wait a moment, then try again.',
  UNAVAILABLE: 'This change is not available right now. Existing content stays readable.',
};
export const manageMessage = (kind: ManageFailure) => MESSAGES[kind];

function classify(status: number, code: string | undefined): ManageFailure {
  if (code === 'IDEMPOTENCY_KEY_REUSED') return 'UNCERTAIN';
  if (code === 'NOT_AVAILABLE') return 'UNAVAILABLE';
  if (code === 'REVISION_CHANGED') return 'STALE';
  if (code === 'GUILD_UPDATE_LIMIT_REACHED') return 'LIMIT';
  if (status >= 500 || status < 400) return 'UNCERTAIN';
  if (status === 401) return 'SIGN_IN';
  if (status === 403) return 'DENIED';
  if (status === 404) return 'GONE';
  if (status === 429) return 'THROTTLED';
  return 'INVALID';
}
const Envelope = z.object({ error: z.object({ code: z.string() }) });
/** Failures that say nothing about whether an earlier unconfirmed attempt was applied. */
const TEMPORARY: ReadonlySet<ManageFailure> = new Set(['SIGN_IN', 'DENIED', 'THROTTLED']);

export function createManageRunner(newKey: () => string = () => crypto.randomUUID()) {
  let pending: { intent: string; key: string; unconfirmed: boolean } | null = null;
  let inFlight = false;
  return {
    async run<T>(
      intent: unknown,
      send: (key: string) => Promise<Response>,
      parse: (body: unknown) => T | null,
    ): Promise<ManageOutcome<T>> {
      if (inFlight) return { kind: 'BUSY' };
      inFlight = true;
      const serialized = JSON.stringify(intent);
      // A key belongs to one unchanged intent: changed input must never reuse it (IDEMPOTENCY_KEY_REUSED).
      if (pending?.intent !== serialized)
        pending = { intent: serialized, key: newKey(), unconfirmed: false };
      const attempt = pending;
      const uncertain = (): ManageOutcome<T> => {
        attempt.unconfirmed = true;
        return { kind: 'UNCERTAIN', message: MESSAGES.UNCERTAIN, retrySame: true };
      };
      try {
        let response: Response, body: unknown;
        try {
          response = await send(attempt.key);
          body = await response.json().catch(() => null);
        } catch {
          return uncertain();
        }
        if (response.ok) {
          const value = parse(body);
          if (value === null) return uncertain();
          pending = null;
          return { kind: 'DONE', value };
        }
        const envelope = Envelope.safeParse(body);
        const kind = classify(
          response.status,
          envelope.success ? envelope.data.error.code : undefined,
        );
        if (kind === 'UNCERTAIN') return uncertain();
        const retrySame = attempt.unconfirmed && TEMPORARY.has(kind);
        if (!retrySame) pending = null;
        return { kind, message: MESSAGES[kind], retrySame };
      } finally {
        inFlight = false;
      }
    },
  };
}

export interface GuildManageApi {
  readProfile(guildId: string): Promise<Response>;
  editProfile(input: ProfileEdit, key: string): Promise<Response>;
  draftUpdate(
    input: { guildId: string; title: string; body: string },
    key: string,
  ): Promise<Response>;
  stepUpdate(
    updateId: string,
    input: { guildId: string; action: 'PUBLISH' | 'WITHDRAW' },
    key: string,
  ): Promise<Response>;
}
export type ProfileEdit = z.input<typeof EditGuildProfileInputSchema>;
const post = (path: string, body: unknown, key: string) =>
  fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
export const fetchGuildManageApi: GuildManageApi = {
  readProfile: (guildId) =>
    fetch('/api/v1/guild-profile?guildId=' + encodeURIComponent(guildId), {
      credentials: 'same-origin',
      cache: 'no-store',
    }),
  editProfile: (input, key) => post('/api/v1/guild-profile', input, key),
  draftUpdate: (input, key) => post('/api/v1/guild-updates', input, key),
  stepUpdate: (updateId, input, key) =>
    post('/api/v1/guild-updates/' + encodeURIComponent(updateId), input, key),
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ProfileResult = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  guild: ManagedGuildSchema.extend({ founderAccountId: z.string().min(1).max(200) }),
});
/** The result must be this Guild at the next revision carrying exactly the fields that were sent. */
export function parseProfileResult(body: unknown, sent: ProfileEdit): ManagedGuild | null {
  const parsed = ProfileResult.safeParse(body);
  if (!parsed.success) return null;
  const { guild } = parsed.data;
  const { name, description } = sent.profile;
  if (
    !same(guild.id, sent.guildId) ||
    guild.revision !== sent.expectedRevision + 1 ||
    (name !== undefined && guild.name !== name.trim()) ||
    (description !== undefined && guild.description !== description.trim())
  )
    return null;
  return guild;
}
const UpdateResult = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  update: ManagedGuildUpdateSchema,
});
export type UpdateExpectation =
  | { kind: 'DRAFT'; guildId: string; title: string; body: string }
  | { kind: 'PUBLISH' | 'WITHDRAW'; guildId: string; updateId: string };
/** A fresh step lands exactly; a replay may find a publication already withdrawn since, never backwards. */
export function parseUpdateResult(
  body: unknown,
  expected: UpdateExpectation,
): ManagedGuildUpdate | null {
  const parsed = UpdateResult.safeParse(body);
  if (!parsed.success) return null;
  const { status, update } = parsed.data;
  if (!same(update.guildId, expected.guildId)) return null;
  if (expected.kind === 'DRAFT') {
    if (
      update.title !== expected.title.trim() ||
      update.body !== expected.body.trim() ||
      (status === 'EXECUTED' && update.state !== 'DRAFT')
    )
      return null;
    return update;
  }
  if (!same(update.id, expected.updateId)) return null;
  const exact = expected.kind === 'PUBLISH' ? 'PUBLISHED' : 'WITHDRAWN';
  const allowed =
    update.state === exact ||
    (status === 'REPLAYED' && expected.kind === 'PUBLISH' && update.state === 'WITHDRAWN');
  return allowed ? update : null;
}
