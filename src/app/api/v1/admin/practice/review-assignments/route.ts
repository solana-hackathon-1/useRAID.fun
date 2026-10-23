import { practiceReviewAssignmentHandlers } from '../../../../../../lib/practice-review-assignment-http';
import { practiceAssignmentManagementHandlers } from '../../../../../../lib/practice-assignment-management';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const POST = practiceReviewAssignmentHandlers.issue;
export const GET = practiceAssignmentManagementHandlers.GET;
export const HEAD = practiceAssignmentManagementHandlers.HEAD;
