import { randomUUID } from 'node:crypto';
import { createClosureHandlers } from '../work-http/closure-http';
import { requestActor, workAuthority } from './work-workspace-http';
import { checkOrigin, rateLimit } from './auth';
import { closeEngagementFromHost } from './work-closure-host';

export const closureHandlers = createClosureHandlers({
  version: 'v1',
  requestId: randomUUID,
  actor: requestActor,
  checkOrigin: (r) => workAuthority(() => checkOrigin(r)),
  rateLimit: (a) => workAuthority(() => rateLimit('work-closure:' + a.accountId, 30, 60)),
  closeEngagement: closeEngagementFromHost,
});
