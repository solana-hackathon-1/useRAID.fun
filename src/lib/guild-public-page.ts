import { cache } from 'react';
import { z } from 'zod';
import { PublicGuildSchema } from '../contracts/entities';
import {
  GuildStorageError,
  PublicGuildUpdatesPageSchema,
  type PublicGuildUpdate,
} from '../guild-profiles/guild-storage-contracts';
import {
  guildPublicAvailable,
  readGuildFromHost,
  readGuildUpdatesFromHost,
} from './guild-public-host';

/** Updates shown per page; within the public API's page maximum. */
export const GUILD_PUBLIC_PAGE_SIZE = 10;
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
/**
 * Same flag, storage reads and strict re-parse as `GET /api/v1/guilds/{slug}`. Deduplicated per
 * request so metadata and the page share one read; never cached across requests.
 */
export const loadGuildPublicProfile = cache(
  async (slug: string): Promise<GuildPublicPageProfile | null> => {
    if (!guildPublicAvailable() || !slugSchema.safeParse(slug).success) return null;
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
