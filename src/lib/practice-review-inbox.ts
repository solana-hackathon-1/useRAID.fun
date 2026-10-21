import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { requireUser, rateLimit, hash, HttpError } from './auth';
import { sessionCookie } from './studio-mode';
import { createPracticeReviewInboxHandlers } from '../skills/practice-review-inbox-http';
import { PracticeReviewHttpError } from '../skills/practice-review-http';
import { listPracticeReviewInbox } from '../skills/practice-review-inbox-storage';
import { practiceReviewReadConfiguration } from './practice-review-reads-host';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';
import type { SkillTaxonomyActor } from '../skills/taxonomy-storage-contracts';
export async function listPracticeReviewInboxFromHost(actor: SkillTaxonomyActor, input: unknown) {
  const result = await runCommandTransaction(db, (tx) =>
    listPracticeReviewInbox(
      tx,
      actor,
      input,
      () => practiceReviewReadConfiguration().readsAvailable,
    ),
  );
  const config = practiceReviewReadConfiguration();
  return { version: 'v1' as const, ...config, result: config.readsAvailable ? result : null };
}
async function authority<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError && [401, 403, 429].includes(error.status))
      throw new PracticeReviewHttpError(error.status as 401 | 403 | 429);
    throw error;
  }
}
export const practiceReviewInboxHandlers = createPracticeReviewInboxHandlers({
  version: 'v1',
  requestId: randomUUID,
  actor: () =>
    authority(async () => {
      const user = await requireUser();
      const cookie = (await cookies()).get(sessionCookie())?.value;
      if (!cookie) throw new PracticeReviewHttpError(401);
      return { accountId: user.id, sessionHash: hash(cookie) };
    }),
  rateLimit: (actor) => authority(() => rateLimit('practice-review:' + actor.accountId, 30, 60)),
  list: listPracticeReviewInboxFromHost,
});
