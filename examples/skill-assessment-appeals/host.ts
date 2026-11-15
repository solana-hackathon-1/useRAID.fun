import assert from 'node:assert/strict';
import {
  appealFilingWindowOpen,
  DEFAULT_APPEAL_ADJUDICATION_SECONDS,
  DEFAULT_APPEAL_FILING_WINDOW_SECONDS,
  evaluateAppealAdjudicator,
} from './skill-appeals/policy';

// An independent host supplies its own trusted case facts; nothing here reads a database, an environment variable or
// the RAID application. The module answers one question: may this person decide this appeal?
const base = {
  version: 'v1' as const,
  adjudicatorAccountId: 'synthetic-adjudicator',
  appellantAccountId: 'synthetic-appellant',
  originalReviewerAccountIds: ['synthetic-reviewer-1', 'synthetic-reviewer-2'],
  sharedGuildIds: [] as string[],
  onAllowlist: true,
};
assert.deepEqual(evaluateAppealAdjudicator(base), { allowed: true });

// The allowlist is necessary, never sufficient.
const listed = (patch: Partial<typeof base>) => evaluateAppealAdjudicator({ ...base, ...patch });
assert.deepEqual(listed({ onAllowlist: false }), { allowed: false, reason: 'NOT_AUTHORIZED' });
assert.deepEqual(listed({ adjudicatorAccountId: 'synthetic-appellant' }), {
  allowed: false,
  reason: 'SELF_ADJUDICATION',
});
assert.deepEqual(listed({ adjudicatorAccountId: 'synthetic-reviewer-2' }), {
  allowed: false,
  reason: 'ORIGINAL_REVIEWER',
});
assert.deepEqual(listed({ sharedGuildIds: ['synthetic-guild'] }), {
  allowed: false,
  reason: 'GUILD_RELATIONSHIP',
});
// A different host with a different list of original reviewers reaches the same rule.
assert.deepEqual(
  listed({ originalReviewerAccountIds: [], adjudicatorAccountId: 'synthetic-reviewer-1' }),
  {
    allowed: true,
  },
);
// Malformed facts fail closed.
assert.throws(() => evaluateAppealAdjudicator({ ...base, onAllowlist: 'yes' } as never));

// Provisional 14-day windows; the host may choose others.
assert.equal(DEFAULT_APPEAL_FILING_WINDOW_SECONDS, 14 * 86400);
assert.equal(DEFAULT_APPEAL_ADJUDICATION_SECONDS, 14 * 86400);
const decided = '2026-11-01T00:00:00.000Z';
assert.equal(appealFilingWindowOpen(decided, '2026-11-15T00:00:00.000Z', 14 * 86400), true);
assert.equal(appealFilingWindowOpen(decided, '2026-11-15T00:00:00.001Z', 14 * 86400), false);
assert.equal(appealFilingWindowOpen(decided, '2026-11-08T00:00:00.001Z', 7 * 86400), false);

console.log(
  JSON.stringify({
    synthetic: true,
    allowlistNecessaryNotSufficient: true,
    selfAdjudicationRefused: true,
    originalReviewerRefused: true,
    guildRelationshipRefused: true,
    malformedFactsFailClosed: true,
    windowsProvisionalAndConfigurable: true,
    noPersistenceOrAuthorityToken: true,
  }),
);
