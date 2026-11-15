/**
 * Party roster advisory lock (class 12023): the leaf lock that serializes "is this roster formed?" readers against
 * the writes that can form one. Recording a member's consent (the only act that can complete a roster) takes it SHARED,
 * so consents never wait for each other; a reader that decides something on the rosters already formed (the skill-appeal
 * adjudicator conflict check) takes it EXCLUSIVE, so a consent either commits before that read or waits until the
 * reader's transaction ends. A consent therefore cannot slip in between the check and the decision it guards.
 *
 * Lock order: this is always the LAST lock a transaction takes (after the listing/slot rows, identity locks and any
 * 12017-12022 advisory lock) and nothing is awaited under it but the statements that finish the transaction, so it can
 * never take part in a cycle. One fixed key (rosters are not partitioned): readers are rare and holders are short.
 * Both sides must use these helpers; a unit test fails on a copied literal.
 */
export const PARTY_ROSTER_LOCK_CLASS = 12023;
export const PARTY_ROSTER_LOCK_KEY = 'party-roster';
/** Taken by a consent before it is written. Bind `$1` to {@link PARTY_ROSTER_LOCK_KEY}. */
export const PARTY_ROSTER_LOCK_SHARED_SQL = `SELECT pg_advisory_xact_lock_shared(hashtextextended($1,${PARTY_ROSTER_LOCK_CLASS}))::text`;
/** Taken by a reader that must not race a roster being formed. Bind `$1` to {@link PARTY_ROSTER_LOCK_KEY}. */
export const PARTY_ROSTER_LOCK_EXCLUSIVE_SQL = `SELECT pg_advisory_xact_lock(hashtextextended($1,${PARTY_ROSTER_LOCK_CLASS}))::text`;
