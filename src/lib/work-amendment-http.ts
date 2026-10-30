import { randomUUID } from 'node:crypto';
import { createAmendmentHandlers } from '../work-http/amendment-http';
import { requestActor, workAuthority } from './work-workspace-http';
import { checkOrigin, rateLimit } from './auth';
import {
  proposeAmendmentFromHost,
  readAmendmentDeskFromHost,
  respondToAmendmentFromHost,
  withdrawAmendmentFromHost,
} from './work-amendment-host';

export const amendmentHandlers = createAmendmentHandlers({
  version: 'v1',
  requestId: randomUUID,
  actor: requestActor,
  checkOrigin: (r) => workAuthority(() => checkOrigin(r)),
  // Separate budgets: refreshing the desk must not spend the allowance for proposing or consenting.
  rateLimit: (a, kind) =>
    workAuthority(() =>
      kind === 'read'
        ? rateLimit('work-amendment-read:' + a.accountId, 60, 60)
        : rateLimit('work-amendment:' + a.accountId, 30, 60),
    ),
  desk: readAmendmentDeskFromHost,
  propose: proposeAmendmentFromHost,
  respond: respondToAmendmentFromHost,
  withdraw: withdrawAmendmentFromHost,
});
