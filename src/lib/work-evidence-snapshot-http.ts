import { randomUUID } from 'node:crypto';
import { createEvidenceSnapshotHandlers } from '../work-http/evidence-snapshot-http';
import { requestActor, workAuthority } from './work-workspace-http';
import { checkOrigin, rateLimit } from './auth';
import {
  readEvidenceSnapshotFromHost,
  recordEvidenceSnapshotFromHost,
  withdrawEvidenceSnapshotFromHost,
} from './work-evidence-snapshot-host';

export const evidenceSnapshotHandlers = createEvidenceSnapshotHandlers({
  version: 'v1',
  requestId: randomUUID,
  actor: requestActor,
  checkOrigin: (r) => workAuthority(() => checkOrigin(r)),
  // Separate budgets: refreshing the view must not spend the allowance for sharing or withdrawing.
  rateLimit: (a, kind) =>
    workAuthority(() =>
      kind === 'read'
        ? rateLimit('work-evidence-read:' + a.accountId, 60, 60)
        : rateLimit('work-evidence:' + a.accountId, 20, 60),
    ),
  view: readEvidenceSnapshotFromHost,
  record: recordEvidenceSnapshotFromHost,
  withdraw: withdrawEvidenceSnapshotFromHost,
});
