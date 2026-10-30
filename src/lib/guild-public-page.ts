import { headers } from 'next/headers';
import { cache } from 'react';
import { z } from 'zod';
import { PublicGuildSchema } from '../contracts/entities';
import {
  GuildStorageError,
  PublicGuildDirectoryPageSchema,
  PublicGuildUpdatesPageSchema,
  type PublicGuildDirectoryEntry,
  type PublicGuildUpdate,
} from '../guild-profiles/guild-storage-contracts';
import { HttpError, publicRateLimit } from './auth';
import {
  guildPublicAvailable,
  readGuildDirectoryFromHost,
  readGuildFromHost,
  readGuildUpdatesFromHost,
} from './guild-public-host';

/** Updates shown per page; within the public API's page maximum. */
export const GUILD_PUBLIC_PAGE_SIZE = 10;
/** Guilds shown per directory page; within the public API's page maximum. */
export const GUILD_DIRECTORY_PAGE_SIZE = 12;
/** What the page may render: the approved projection minus the internal Guild id. */
export interface GuildPublicPageProfile {
  slug: string;
  name: string;
  description: string;
  primaryTokenMint: string | null;
}
export interface GuildPublicPageView {
  guild: GuildPublicPageProfile;
  updates: PublicGuildUpdate[];
  nextCursor: string | null;
  before: string | null;
}
const slugSchema = PublicGuildSchema.shape.slug;
const beforeSchema = z.uuid().optional();
/** NOT_FOUND and INVALID_INPUT become an ordinary not-found page; anything else is a server error. */
async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof GuildStorageError && ['NOT_FOUND', 'INVALID_INPUT'].includes(error.code))
      return null;
    throw error;
  }
}
/** Thrown instead of reading storage when the client is over the page's request budget. */
export class GuildPublicPageThrottled extends Error {
  constructor() {
    super('GUILD_PUBLIC_PAGE_THROTTLED');
  }
}
/**
 * Same budget and client key as `GET /api/v1/guilds/{slug}` (120 per 60 s per client). Spent once
 * per request: metadata and the page share this result.
 */
export const spendPageBudget = cache(async (): Promise<boolean> => {
  const request = new Request('http://guild-page.invalid/', { headers: await headers() });
  try {
    await publicRateLimit(request, 'guild-public', 120, 60, 600);
    return false;
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) return true;
    throw error;
  }
});
/**
 * Same flag, storage reads and strict re-parse as `GET /api/v1/guilds/{slug}`. Deduplicated per
 * request so metadata and the page share one read; never cached across requests.
 */
export const loadGuildPublicProfile = cache(
  async (slug: string): Promise<GuildPublicPageProfile | null> => {
    if (!guildPublicAvailable() || !slugSchema.safeParse(slug).success) return null;
    if (await spendPageBudget()) throw new GuildPublicPageThrottled();
    const raw = await orNull(() => readGuildFromHost(slug));
    if (raw === null) return null;
    const profile = PublicGuildSchema.safeParse(raw);
    if (!profile.success || profile.data.slug !== slug) throw new Error('GUILD_PUBLIC_CONTRACT');
    const { name, description, primaryToken } = profile.data;
    return { slug, name, description, primaryTokenMint: primaryToken?.mint ?? null };
  },
);
/** Profile plus one page of published updates, older than `before` when given. */
export async function loadGuildPublicPage(
  slug: string,
  before: unknown,
): Promise<GuildPublicPageView | null> {
  const cursor = beforeSchema.safeParse(before);
  if (!cursor.success) return null;
  const guild = await loadGuildPublicProfile(slug);
  if (!guild) return null;
  const raw = await orNull(() =>
    readGuildUpdatesFromHost(slug, { limit: GUILD_PUBLIC_PAGE_SIZE, before: cursor.data }),
  );
  if (raw === null) return null;
  const page = PublicGuildUpdatesPageSchema.safeParse(raw);
  if (!page.success) throw new Error('GUILD_PUBLIC_CONTRACT');
  return { guild, ...page.data, before: cursor.data ?? null };
}
export interface GuildDirectoryView {
  guilds: PublicGuildDirectoryEntry[];
  nextCursor: string | null;
  after: string | null;
}
const afterSchema = slugSchema.optional();
/**
 * One page of the Guild directory after the `after` slug cursor: same flag, budget, storage read and strict
 * re-parse as `GET /api/v1/guilds`. Null for a malformed cursor. The caller checks the flag first to tell
 * "not enabled" apart from "not found".
 */
export async function loadGuildDirectory(after: unknown): Promise<GuildDirectoryView | null> {
  const cursor = afterSchema.safeParse(after);
  if (!cursor.success || !guildPublicAvailable()) return null;
  if (await spendPageBudget()) throw new GuildPublicPageThrottled();
  const raw = await readGuildDirectoryFromHost({
    limit: GUILD_DIRECTORY_PAGE_SIZE,
    ...(cursor.data ? { after: cursor.data } : {}),
  });
  const page = PublicGuildDirectoryPageSchema.safeParse(raw);
  if (!page.success) throw new Error('GUILD_PUBLIC_CONTRACT');
  return { ...page.data, after: cursor.data ?? null };
}
