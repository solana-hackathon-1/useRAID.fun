import assert from 'node:assert/strict';
import { prepareRaiderOrientation } from './module/index';
// A synthetic host owns its route registry/catalog; it provides no account, SQL or secrets.
const registered = new Set(['/starter-tasks', '/trials']);
const capability = (href: string) =>
  registered.has(href)
    ? { available: true as const, href }
    : { available: false as const, reason: 'NOT_CONFIGURED' as const };
const host = {
  version: 'v1',
  interestIds: ['frontend', 'qa'],
  nextActions: {
    starterTasks: capability('/starter-tasks'),
    portfolio: capability('/portfolio'),
    trial: capability('/trials'),
  },
};
const preferences = {
  experience: 'BEGINNER',
  workInterests: ['qa'],
  timezone: 'UTC',
  orientationAcknowledged: true,
};
const beginner = prepareRaiderOrientation(preferences, host);
const experienced = prepareRaiderOrientation(
  { ...preferences, experience: 'EXPERIENCED', evidencePath: 'TRIAL' },
  host,
);
assert.equal(beginner.nextAction.kind, 'STARTER_TASKS');
assert.equal(experienced.nextAction.kind, 'TRIAL');
const unavailable = prepareRaiderOrientation({ ...preferences, experience: 'EXPERIENCED' }, host);
assert.equal(unavailable.nextAction.available, false);
assert.equal(unavailable.nextAction.href, null);
for (const plan of [beginner, experienced, unavailable]) {
  assert.equal(plan.state, 'PREPARED');
  assert.equal(plan.persisted, false);
  assert.equal(plan.assignsVerifiedSkill, false);
  assert.equal(plan.reservesCapacity, false);
  assert.equal(plan.authorizesPaidCommitment, false);
}
console.log(
  JSON.stringify({
    synthetic: true,
    beginner: beginner.nextAction.kind,
    experienced: experienced.nextAction.kind,
    unavailableIsExplicit: true,
    noPersistedCompletion: true,
    noRankSlotOrPayment: true,
  }),
);
