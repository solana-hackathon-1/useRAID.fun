import { afterEach, describe, expect, it, vi } from 'vitest';
const port = vi.hoisted(() => ({ tx: {}, view: vi.fn(), record: vi.fn(), withdraw: vi.fn() }));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: async (_db: unknown, work: (tx: object) => unknown) => work(port.tx),
}));
vi.mock('../src/work-loop/evidence-snapshot-storage', () => ({
  readEvidenceSnapshot: port.view,
  recordEvidenceSnapshot: port.record,
  withdrawEvidenceSnapshot: port.withdraw,
}));
import { WorkError } from '../src/work-loop/contracts';
import { WorkHttpError } from '../src/work-http/workspace-http';
import {
  createEvidenceSnapshotHandlers,
  type EvidenceSnapshotHttpHost,
} from '../src/work-http/evidence-snapshot-http';
import {
  readEvidenceSnapshotFromHost,
  recordEvidenceSnapshotFromHost,
  withdrawEvidenceSnapshotFromHost,
} from '../src/lib/work-evidence-snapshot-host';

const actor = { accountId: 'founder-1', sessionHash: 'a'.repeat(64) };
const applicationId = '11111111-1111-4111-8111-111111111111';
const snapshot = {
  id: '22222222-2222-4222-8222-222222222222',
  applicationId,
  takenAt: '2026-11-14T00:00:00.000Z',
  skills: [
    { skillId: 'writing', rank: 'C', status: 'VERIFIED', assessedAt: '2026-10-01T00:00:00.000Z' },
  ],
};
const view = (over: Record<string, unknown> = {}) => ({
  version: 'v1',
  role: 'REVIEWER',
  applicationId,
  availability: 'SHARED',
  snapshot,
  ...over,
});
const host = (over: Partial<EvidenceSnapshotHttpHost> = {}): EvidenceSnapshotHttpHost => ({
  version: 'v1',
  requestId: () => 'request-1',
  actor: async () => actor,
  checkOrigin: () => undefined,
  rateLimit: () => undefined,
  view: async () => view(),
  record: async () => ({ status: 'EXECUTED', snapshot }),
  withdraw: async () => ({
    status: 'EXECUTED',
    applicationId,
    withdrawnAt: '2026-11-14T01:00:00.000Z',
  }),
  ...over,
});
const post = (payload: unknown, headers: Record<string, string> = {}, url = 'http://localhost/x') =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1', ...headers },
    body: JSON.stringify(payload),
  });
const get = (url = 'http://localhost/x') => new Request(url, { method: 'GET' });
const err = async (r: Response) => (await r.json()).error;
const consent = { sharedSkillIds: ['writing'], consent: true };

describe('#331 evidence snapshot HTTP boundary', () => {
  it('shows the snapshot privately with GET only and nothing else', async () => {
    const h = createEvidenceSnapshotHandlers(host());
    const r = await h.VIEW(get(), applicationId);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect((await r.json()).snapshot.skills).toHaveLength(1);
    expect((await h.VIEW(post({}), applicationId)).status).toBe(405);
    expect((await h.VIEW(get('http://localhost/x?applicationId=1'), applicationId)).status).toBe(
      422,
    );
    expect((await h.VIEW(get(), 'not-a-uuid')).status).toBe(422);
  });
  it('refuses a non-reviewer with a plain 403 and no content', async () => {
    const forbidden = createEvidenceSnapshotHandlers(
      host({
        view: async () => {
          throw new WorkError('FORBIDDEN');
        },
      }),
    );
    const r = await forbidden.VIEW(get(), applicationId);
    expect(r.status).toBe(403);
    expect(JSON.stringify(await r.json())).not.toContain('writing');
  });
  it('rejects a host view that leaks beyond the strict contract or names another application', async () => {
    for (const bad of [
      view({ snapshot: { ...snapshot, evidenceRefs: ['private'] } }),
      view({ availability: 'WITHDRAWN' }),
      view({ applicationId: '33333333-3333-4333-8333-333333333333' }),
      view({ snapshot: { ...snapshot, skills: [{ skillId: 'writing', rank: 'C' }] } }),
    ]) {
      const r = await createEvidenceSnapshotHandlers(host({ view: async () => bad })).VIEW(
        get(),
        applicationId,
      );
      expect(r.status).toBe(503);
      expect(JSON.stringify(await r.json())).not.toContain('private');
    }
  });
  it('records only with an explicit consent, the actor, a key and the path application', async () => {
    const record = vi.fn(async () => ({ status: 'EXECUTED', snapshot }));
    const h = createEvidenceSnapshotHandlers(host({ record }));
    expect((await h.RECORD(post(consent), applicationId)).status).toBe(200);
    expect(record).toHaveBeenCalledWith({
      actor,
      input: { applicationId, ...consent },
      idempotencyKey: 'key-1',
      requestId: 'request-1',
    });
    for (const body of [
      { sharedSkillIds: ['writing'] },
      { sharedSkillIds: ['writing'], consent: false },
      { ...consent, applicationId },
      { sharedSkillIds: [], consent: true },
    ])
      expect((await h.RECORD(post(body), applicationId)).status).toBe(422);
    expect((await h.RECORD(post(consent, { 'idempotency-key': '' }), applicationId)).status).toBe(
      422,
    );
    expect(record).toHaveBeenCalledTimes(1);
  });
  it('rejects a host result that shared different skills than the applicant chose', async () => {
    const other = { ...snapshot, skills: [{ ...snapshot.skills[0], skillId: 'design' }] };
    const r = await createEvidenceSnapshotHandlers(
      host({ record: async () => ({ status: 'EXECUTED', snapshot: other }) }),
    ).RECORD(post(consent), applicationId);
    expect(r.status).toBe(503);
  });
  it('maps a second snapshot to refresh and a closed or withdrawn one to no longer open', async () => {
    for (const [code, expected] of [
      ['EVIDENCE_SNAPSHOT_EXISTS', 'REVISION_CHANGED'],
      ['EVIDENCE_SNAPSHOT_UNAVAILABLE', 'NO_LONGER_OPEN'],
      ['WRITES_DISABLED', 'NOT_AVAILABLE'],
    ] as const) {
      const h = createEvidenceSnapshotHandlers(
        host({
          record: async () => {
            throw new WorkError(code);
          },
        }),
      );
      const r = await h.RECORD(post(consent), applicationId);
      expect(r.status).toBe(code === 'WRITES_DISABLED' ? 503 : 409);
      expect((await err(r)).code).toBe(expected);
    }
  });
  it('withdraws by path id with an empty body only', async () => {
    const withdraw = vi.fn(async () => ({
      status: 'EXECUTED',
      applicationId,
      withdrawnAt: '2026-11-14T01:00:00.000Z',
    }));
    const h = createEvidenceSnapshotHandlers(host({ withdraw }));
    expect((await h.WITHDRAW(post({}), applicationId)).status).toBe(200);
    expect(withdraw).toHaveBeenCalledWith({
      actor,
      input: { applicationId },
      idempotencyKey: 'key-1',
      requestId: 'request-1',
    });
    expect((await h.WITHDRAW(post({ extra: 1 }), applicationId)).status).toBe(422);
  });
  it('requires origin, authentication and the right throttle before any command', async () => {
    const record = vi.fn();
    for (const [status, code, over] of [
      [403, 'FORBIDDEN', { checkOrigin: () => Promise.reject(new WorkHttpError(403)) }],
      [401, 'AUTHENTICATION_REQUIRED', { actor: () => Promise.reject(new WorkHttpError(401)) }],
      [429, 'RATE_LIMITED', { rateLimit: () => Promise.reject(new WorkHttpError(429)) }],
    ] as const) {
      const r = await createEvidenceSnapshotHandlers(host({ record, ...over })).RECORD(
        post(consent),
        applicationId,
      );
      expect(r.status).toBe(status);
      expect((await err(r)).code).toBe(code);
    }
    expect(record).not.toHaveBeenCalled();
    const kinds: string[] = [];
    const h = createEvidenceSnapshotHandlers(
      host({ rateLimit: (_a, kind) => void kinds.push(kind) }),
    );
    await h.VIEW(get(), applicationId);
    await h.RECORD(post(consent), applicationId);
    expect(kinds).toEqual(['read', 'command']);
  });
});

describe('#331 Root host flags', () => {
  const command = { actor, input: {}, idempotencyKey: 'key-1', requestId: 'req-1' };
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });
  it('is off by default: nothing is read, shown or recorded', async () => {
    for (const value of [undefined, '', 'TRUE', 'false', '1']) {
      vi.stubEnv('WORK_EVIDENCE_SNAPSHOT_ENABLED', value);
      vi.stubEnv('WORK_WORKSPACE_READS_ENABLED', 'true');
      await expect(readEvidenceSnapshotFromHost(actor, applicationId)).rejects.toMatchObject({
        code: 'WRITES_DISABLED',
      });
      await expect(recordEvidenceSnapshotFromHost(command)).rejects.toMatchObject({
        code: 'WRITES_DISABLED',
      });
    }
    expect(port.view).not.toHaveBeenCalled();
    expect(port.record).not.toHaveBeenCalled();
  });
  it('needs the workspace read switch as well', async () => {
    vi.stubEnv('WORK_EVIDENCE_SNAPSHOT_ENABLED', 'true');
    await expect(readEvidenceSnapshotFromHost(actor, applicationId)).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    await expect(withdrawEvidenceSnapshotFromHost(command)).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
  });
  it('never lets the feature flag trap an applicant who wants to withdraw', async () => {
    vi.stubEnv('WORK_WORKSPACE_READS_ENABLED', 'true');
    port.withdraw.mockResolvedValue('withdrawn');
    expect(await withdrawEvidenceSnapshotFromHost(command)).toBe('withdrawn');
    expect(port.withdraw).toHaveBeenCalledWith(port.tx, command);
  });
  it('grants reviewer authority only to the explicit synthetic operator allowlist', async () => {
    vi.stubEnv('WORK_EVIDENCE_SNAPSHOT_ENABLED', 'true');
    vi.stubEnv('WORK_WORKSPACE_READS_ENABLED', 'true');
    port.view.mockResolvedValue('seen');
    const authorize = async () => {
      await readEvidenceSnapshotFromHost(actor, applicationId);
      return port.view.mock.calls.at(-1)![3].authorize(port.tx, actor, 'guild', 'MANAGE_LISTING');
    };
    expect(await authorize()).toBe(false);
    vi.stubEnv('RAID_WORK_OPERATOR_ACCOUNT_IDS', ' other , ,founder-1 ');
    expect(await authorize()).toBe(true);
    vi.stubEnv('RAID_WORK_OPERATOR_ACCOUNT_IDS', 'other');
    expect(await authorize()).toBe(false);
  });
});
