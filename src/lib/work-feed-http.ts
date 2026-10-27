import { randomUUID } from 'node:crypto';
import { publicRateLimit, HttpError } from './auth';
import { createFeedHandlers, FeedHttpError } from '../work-http/feed-http';
import { readFeedFromHost, workFeedAvailable } from './work-feed-host';

export const feedHandlers = createFeedHandlers({
  version: 'v1',
  requestId: randomUUID,
  available: workFeedAvailable,
  rateLimit: async (request) => {
    try {
      await publicRateLimit(request, 'work-feed', 120, 60, 600);
    } catch (error) {
      if (error instanceof HttpError && error.status === 429) throw new FeedHttpError(429);
      throw error;
    }
  },
  feed: readFeedFromHost,
});
