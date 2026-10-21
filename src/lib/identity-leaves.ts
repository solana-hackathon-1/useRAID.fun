import { db } from './db';
/** Exact-PK autocommit leaves. They acquire no other lock or perform another write. */
export async function discardSession(tokenHash: string) {
  return db.session.deleteMany({ where: { tokenHash } });
}
export async function discardAttempt(stateHash: string) {
  return db.oAuthAttempt.deleteMany({ where: { stateHash } });
}
export async function claimOAuthAttempt(stateHash: string, sessionHash: string | null, now: Date) {
  return db.oAuthAttempt.updateMany({
    where: { stateHash, sessionHash, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
}
