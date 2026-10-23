import { afterEach, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({
  actor: vi.fn(),
  rate: vi.fn(),
  read: vi.fn(),
  xIds: vi.fn(),
  port: {},
  issue: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/admins', () => ({ adminXIds: ports.xIds }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: vi.fn(async (_db, fn) => fn(ports.port)),
}));
vi.mock('../src/lib/practice-review-assignment-http', () => ({
  practiceReviewAssignmentHttpHost: {
    requestId: () => 'root-request',
    actor: ports.actor,
    rateLimit: ports.rate,
  },
  practiceReviewAssignmentHandlers: { issue: ports.issue, revoke: ports.revoke },
}));
vi.mock('../src/skills/practice-review-assignment-storage', async (original) => ({
  ...(await original<object>()),
  readPracticeAssignmentManagement: ports.read,
}));
import { readPracticeAssignmentManagementFromHost } from '../src/lib/practice-review-assignments-host';
import { practiceAssignmentManagementHandlers } from '../src/lib/practice-assignment-management';
import {
  GET,
  HEAD,
  POST,
  dynamic,
  runtime,
} from '../src/app/api/v1/admin/practice/review-assignments/route';
import { managementContext as context } from './helpers/practice-assignment-management-view-fixture';
const actor = { accountId: context.page.actorAccountId, sessionHash: 'a'.repeat(64) },
  input = { version: 'v1', submissionId: context.page.submissionId, after: null };
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
it('uses real guarded transaction and current allowlist callbacks, with read history retained while writes off', async () => {
  ports.xIds.mockReturnValue(['allowed-x']);
  ports.read.mockResolvedValue({ managerXId: 'allowed-x', page: context.page });
  vi.stubEnv('PRACTICE_REVIEW_ASSIGNMENTS_ENABLED', 'false');
  expect(await readPracticeAssignmentManagementFromHost(actor, input)).toMatchObject({
    version: 'v1',
    writesAvailable: false,
    unavailableReason: 'DISABLED',
    result: { page: context.page },
  });
  const [tx, a, i, opts] = ports.read.mock.calls[0];
  expect(tx).toBe(ports.port);
  expect(a).toBe(actor);
  expect(i).toBe(input);
  expect(opts.canInspect({ xId: 'allowed-x' })).toBe(true);
  expect(opts.canManage({ xId: 'other-x' })).toBe(false);
  ports.xIds.mockReturnValue([]);
  expect(opts.canInspect({ xId: 'allowed-x' })).toBe(false);
});
it('drops private metadata if current allowlist closes after commit', async () => {
  ports.xIds.mockReturnValue(['allowed-x']);
  ports.read.mockImplementationOnce(async () => {
    ports.xIds.mockReturnValue([]);
    return { managerXId: 'allowed-x', page: context.page };
  });
  await expect(readPracticeAssignmentManagementFromHost(actor, input)).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
});
it('shares the actual X-admin actor/account quota and retains original POST export', async () => {
  ports.xIds.mockReturnValue(['allowed-x']);
  ports.actor.mockResolvedValue(actor);
  ports.read.mockResolvedValue({
    managerXId: 'allowed-x',
    page: { ...context.page, submissionId: null, entries: [] },
  });
  const response = await GET(new Request('http://raid.test'));
  expect(response.status).toBe(200);
  expect(ports.actor).toHaveBeenCalledOnce();
  expect(ports.rate).toHaveBeenCalledWith(actor);
  expect(POST).toBe(ports.issue);
  expect(GET).toBe(practiceAssignmentManagementHandlers.GET);
  expect(HEAD).toBe(practiceAssignmentManagementHandlers.HEAD);
  expect(dynamic).toBe('force-dynamic');
  expect(runtime).toBe('nodejs');
});
