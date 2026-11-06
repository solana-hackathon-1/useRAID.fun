import type { Prisma } from '@prisma/client';
import { enqueue } from '../../src/lib/queue';

/**
 * Enqueue a job that is already due for the next `claimJob()`.
 *
 * `enqueue()` stamps `runAt` from the app clock but `claimJob()` compares it with Postgres `NOW()`. If the app clock
 * leads the database clock by even a few ms (Docker VM drift, cold start) a job enqueued with the default `runAt`
 * is not yet claimable. Tests that enqueue and then claim immediately use a past `runAt` to stay clock-independent.
 */
export const enqueueDue = (kind: string, key: string, payload: Prisma.InputJsonValue) =>
  enqueue(kind, key, payload, new Date(Date.now() - 60_000));
