import { randomUUID } from 'node:crypto';
import { publicRateLimit, HttpError } from './auth';
import {
  createGuildPublicHandlers,
  GuildPublicHttpError,
} from '../guild-profiles/guild-public-http';
import {
  guildPublicAvailable,
  readGuildDirectoryFromHost,
  readGuildFromHost,
  readGuildUpdatesFromHost,
} from './guild-public-host';

export const guildPublicHandlers = createGuildPublicHandlers({
  version: 'v1',
  requestId: randomUUID,
  available: guildPublicAvailable,
  rateLimit: async (request) => {
    try {
      await publicRateLimit(request, 'guild-public', 120, 60, 600);
    } catch (error) {
      if (error instanceof HttpError && error.status === 429) throw new GuildPublicHttpError(429);
      throw error;
    }
  },
  guild: readGuildFromHost,
  updates: readGuildUpdatesFromHost,
  guilds: readGuildDirectoryFromHost,
});
