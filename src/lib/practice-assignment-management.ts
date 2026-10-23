import { practiceReviewAssignmentHttpHost } from './practice-review-assignment-http';
import { readPracticeAssignmentManagementFromHost } from './practice-review-assignments-host';
import { createPracticeAssignmentManagementHandlers } from '../skills/practice-assignment-management-http';
export const practiceAssignmentManagementHandlers = createPracticeAssignmentManagementHandlers({
  version: 'v1',
  requestId: practiceReviewAssignmentHttpHost.requestId,
  actor: practiceReviewAssignmentHttpHost.actor,
  rateLimit: practiceReviewAssignmentHttpHost.rateLimit,
  read: readPracticeAssignmentManagementFromHost,
});
