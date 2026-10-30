import { describe, expect, it, vi } from 'vitest';
import { canonicalRequestDigest, CommandReceiptError } from '../src/command-receipts';
import { WorkError } from '../src/work-loop/contracts';
import { createPartyHandlers, PartyHttpError } from '../src/parties/party-http';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = { accountId: 'account-leader', sessionHash: 'a'.repeat(64) };
const ids = {
  party: uuid(1),
  slot: uuid(2),
  terms: uuid(3),
  proposal: uuid(4),
  leader: uuid(10),
  ana: uuid(11),
  consent: uuid(20),
};
const termsDigest = 'b'.repeat(64);
const created = '2026-10-30T00:00:00.000Z';
const members = [
  { participantId: ids.leader, role: 'Lead', allocations: [{ amount: '600' }] },
  { participantId: ids.ana, role: 'Frontend', allocations: [{ amount: '400' }] },
];
const proposeBody = { slotId: ids.slot, termsVersionId: ids.terms, termsDigest, members };
const snapshotDigest = canonicalRequestDigest({
  partyId: ids.party,
  slotId: ids.slot,
  termsVersionId: ids.terms,
  termsDigest,
  members,
});
const proposal = (overrides: Record<string, unknown> = {}) => ({
  id: ids.proposal,
  partyId: ids.party,
  leaderParticipantId: ids.leader,
  slotId: ids.slot,
  termsVersionId: ids.terms,
  termsDigest,
  snapshotDigest,
  members: members.map((m) => ({ ...m, consentedAt: null })),
  allConsented: false,
  createdAt: created,
  ...overrides,
});
const consentResult = (overrides: Record<string, unknown> = {}) => ({
  status: 'EXECUTED',
  consent: {
    id: ids.consent,
    proposalId: ids.proposal,
    participantId: ids.ana,
    snapshotDigest,
    consentedAt: created,
    ...overrides,
  },
});

function harness(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const host = {
    version: 'v1' as const,
    requestId: () => uuid(99),
    actor: vi.fn(async () => {
      calls.push('actor');
      return actor;
    }),
    checkOrigin: vi.fn(() => {
      calls.push('origin');
    }),
    rateLimit: vi.fn(async (_actor: unknown, scope: string) => {
      calls.push('throttle:' + scope);
    }),
    create: vi.fn(async (command: { input: unknown }) => ({
      status: 'EXECUTED',
      party: {
        id: ids.party,
        name: (command.input as { name: string }).name,
        leaderParticipantId: ids.leader,
        createdAt: created,
      },
    })),
    propose: vi.fn(async () => ({ status: 'EXECUTED', proposal: proposal() })),
    consent: vi.fn(async () => consentResult()),
    read: vi.fn(async () => proposal()),
    ...overrides,
  };
  return { host, calls, handlers: createPartyHandlers(host) };
}
const post = (
  body: unknown,
  headers: Record<string, string> = {},
  url = 'http://x/api/v1/parties',
) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': uuid(50), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const get = (url = 'http://x/api/v1/party-proposals/' + ids.proposal) => new Request(url);
const errorOf = async (response: Response) => (await response.json()).error;

describe('T056 Party HTTP transport', () => {
  it('creates a Party: origin, session, write throttle, then key and strict JSON; private headers', async () => {
    const { host, calls, handlers } = harness();
    const response = await handlers.CREATE(post({ name: 'Synthetic Party' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
    expect(calls).toEqual(['origin', 'actor', 'throttle:WRITE']);
    expect(host.create).toHaveBeenCalledWith({
      actor,
      input: { name: 'Synthetic Party' },
      idempotencyKey: uuid(50),
      requestId: uuid(99),
    });
    expect((await response.json()).party.id).toBe(ids.party);
  });

  it.each([
    ['a leader smuggled in the body', { name: 'P', leaderParticipantId: ids.ana }],
    ['an unknown field', { name: 'P', extra: 1 }],
    ['a padded name', { name: ' P ' }],
    ['an empty name', { name: '' }],
  ])('refuses %s before the host runs', async (_label, body) => {
    const { host, handlers } = harness();
    const response = await handlers.CREATE(post(body));
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe('INVALID_COMMAND');
    expect(host.create).not.toHaveBeenCalled();
  });

  it('requires a valid Idempotency-Key, JSON content type and a bounded body', async () => {
    const { host, handlers } = harness();
    expect(
      (await handlers.CREATE(post({ name: 'P' }, { 'idempotency-key': 'bad key!' }))).status,
    ).toBe(422);
    expect(
      (await handlers.CREATE(post({ name: 'P' }, { 'content-type': 'text/plain' }))).status,
    ).toBe(415);
    expect((await handlers.CREATE(post('x'.repeat(70000)))).status).toBe(413);
    expect((await handlers.CREATE(post('{"name":'))).status).toBe(422);
    expect(host.create).not.toHaveBeenCalled();
  });

  it('maps host authority failures without running the command', async () => {
    for (const [status, code] of [
      [401, 'AUTHENTICATION_REQUIRED'],
      [403, 'FORBIDDEN'],
      [429, 'RATE_LIMITED'],
    ] as const) {
      const origin = harness({
        checkOrigin: () => {
          throw new PartyHttpError(status);
        },
      });
      const denied = await origin.handlers.CREATE(post({ name: 'P' }));
      expect(denied.status).toBe(status);
      expect((await errorOf(denied)).code).toBe(code);
      expect(origin.host.actor).not.toHaveBeenCalled();
      const throttled = harness({
        rateLimit: async () => {
          throw new PartyHttpError(status);
        },
      });
      expect((await throttled.handlers.CREATE(post({ name: 'P' }))).status).toBe(status);
      expect(throttled.host.create).not.toHaveBeenCalled();
    }
  });

  it('proposes a roster bound to the path Party and returns the exact snapshot', async () => {
    const { host, calls, handlers } = harness();
    const response = await handlers.PROPOSE(
      post(proposeBody, {}, 'http://x/api/v1/parties/' + ids.party + '/proposals'),
      Promise.resolve(ids.party.toUpperCase()),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual(['origin', 'actor', 'throttle:WRITE']);
    expect(host.propose).toHaveBeenCalledWith({
      actor,
      input: { partyId: ids.party, ...proposeBody },
      idempotencyKey: uuid(50),
      requestId: uuid(99),
    });
    expect((await response.json()).proposal.snapshotDigest).toBe(snapshotDigest);
  });

  it('rejects a Party id in the body, a malformed path id and uppercase member ids', async () => {
    const { host, handlers } = harness();
    const url = 'http://x/api/v1/parties/' + ids.party + '/proposals';
    expect(
      (await handlers.PROPOSE(post({ ...proposeBody, partyId: uuid(7) }, {}, url), ids.party))
        .status,
    ).toBe(422);
    expect((await handlers.PROPOSE(post(proposeBody, {}, url), 'not-a-uuid')).status).toBe(422);
    expect(
      (
        await handlers.PROPOSE(
          post(
            {
              ...proposeBody,
              members: [{ ...members[0], participantId: ids.leader.toUpperCase() }, members[1]],
            },
            {},
            url,
          ),
          ids.party,
        )
      ).status,
    ).toBe(200);
    // Uppercase ids are canonicalized before the host sees them, so the digest cannot depend on spelling.
    expect(
      (
        host.propose.mock.calls[0] as unknown as [
          { input: { members: { participantId: string }[] } },
        ]
      )[0].input.members[0].participantId,
    ).toBe(ids.leader);
    expect(
      (await handlers.PROPOSE(post({ ...proposeBody, members: [] }, {}, url), ids.party)).status,
    ).toBe(422);
    expect(
      (
        await handlers.PROPOSE(
          post(
            { ...proposeBody, members: [{ ...members[0], allocations: [{ amount: '1.5' }] }] },
            {},
            url,
          ),
          ids.party,
        )
      ).status,
    ).toBe(422);
    expect(host.propose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another Party', proposal({ partyId: uuid(7) })],
    ['another slot', proposal({ slotId: uuid(7) })],
    [
      'a substituted split',
      proposal({
        members: [
          { ...members[0], allocations: [{ amount: '1000' }], consentedAt: null },
          { ...members[1], allocations: [{ amount: '0' }], consentedAt: null },
        ],
      }),
    ],
    ['a digest that does not bind the members', proposal({ snapshotDigest: 'c'.repeat(64) })],
    ['a leaked field', { ...proposal(), receiptId: uuid(5) }],
  ])('treats a host result with %s as a storage contract failure', async (_label, bad) => {
    const { handlers } = harness({ propose: async () => ({ status: 'EXECUTED', proposal: bad }) });
    const response = await handlers.PROPOSE(
      post(proposeBody, {}, 'http://x/api/v1/parties/' + ids.party + '/proposals'),
      ids.party,
    );
    expect(response.status).toBe(503);
    const body = await errorOf(response);
    expect(body.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(body)).not.toContain(uuid(7));
  });

  it('accepts a replay after consents landed, because a replay returns the proposal as it stands now', async () => {
    const consented = proposal({
      members: members.map((m) => ({ ...m, consentedAt: created })),
      allConsented: true,
    });
    const { handlers } = harness({
      propose: async () => ({ status: 'REPLAYED', proposal: consented }),
    });
    const response = await handlers.PROPOSE(
      post(proposeBody, {}, 'http://x/api/v1/parties/' + ids.party + '/proposals'),
      ids.party,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('REPLAYED');
  });

  it('records consent for the path proposal and digest only; the member comes from the session', async () => {
    const { host, calls, handlers } = harness();
    const url = 'http://x/api/v1/party-proposals/' + ids.proposal + '/consents';
    const response = await handlers.CONSENT(post({ snapshotDigest }, {}, url), ids.proposal);
    expect(response.status).toBe(200);
    expect(calls).toEqual(['origin', 'actor', 'throttle:WRITE']);
    expect(host.consent).toHaveBeenCalledWith({
      actor,
      input: { proposalId: ids.proposal, snapshotDigest },
      idempotencyKey: uuid(50),
      requestId: uuid(99),
    });
    for (const body of [
      { snapshotDigest, participantId: ids.ana },
      { snapshotDigest, proposalId: uuid(7) },
      { snapshotDigest: 'short' },
      {},
    ])
      expect((await handlers.CONSENT(post(body, {}, url), ids.proposal)).status).toBe(422);
    expect((await handlers.CONSENT(post({ snapshotDigest }, {}, url), 'nope')).status).toBe(422);
    expect(host.consent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another proposal', consentResult({ proposalId: uuid(7) })],
    ['another digest', consentResult({ snapshotDigest: 'd'.repeat(64) })],
    ['a leaked field', { ...consentResult(), receiptId: uuid(5) }],
  ])('treats a consent result with %s as a storage contract failure', async (_label, bad) => {
    const { handlers } = harness({ consent: async () => bad });
    const url = 'http://x/api/v1/party-proposals/' + ids.proposal + '/consents';
    expect((await handlers.CONSENT(post({ snapshotDigest }, {}, url), ids.proposal)).status).toBe(
      503,
    );
  });

  it('reads one proposal with the read throttle, no origin check and no query string', async () => {
    const { host, calls, handlers } = harness();
    const response = await handlers.READ(get(), ids.proposal);
    expect(response.status).toBe(200);
    expect(calls).toEqual(['actor', 'throttle:READ']);
    expect(host.read).toHaveBeenCalledWith(actor, ids.proposal);
    expect(
      (
        await handlers.READ(
          get('http://x/api/v1/party-proposals/' + ids.proposal + '?x=1'),
          ids.proposal,
        )
      ).status,
    ).toBe(422);
    expect((await handlers.READ(get(), 'nope')).status).toBe(422);
    expect(host.read).toHaveBeenCalledTimes(1);
    const other = harness({ read: async () => proposal({ id: uuid(7) }) });
    expect((await other.handlers.READ(get(), ids.proposal)).status).toBe(503);
  });

  it('maps typed storage errors to stable public codes and never leaks internals', async () => {
    const cases: [string, number, string][] = [
      ['UNAUTHENTICATED', 401, 'AUTHENTICATION_REQUIRED'],
      ['ACCOUNT_RESTRICTED', 403, 'ACCOUNT_RESTRICTED'],
      ['FORBIDDEN', 403, 'FORBIDDEN'],
      ['NOT_FOUND', 404, 'NOT_FOUND'],
      ['INVALID_INPUT', 422, 'INVALID_COMMAND'],
      ['WRITES_DISABLED', 503, 'NOT_AVAILABLE'],
      ['REVISION_CONFLICT', 409, 'REVISION_CHANGED'],
      ['SLOT_FILLED', 409, 'SLOT_FILLED'],
      ['TERMS_VERSION_CHANGED', 409, 'TERMS_VERSION_CHANGED'],
      ['PUBLICATION_BLOCKED', 409, 'NO_LONGER_OPEN'],
      ['DEADLINE_PASSED', 409, 'NO_LONGER_OPEN'],
      ['STORAGE_CONTRACT', 503, 'SERVICE_UNAVAILABLE'],
      ['CAPACITY_CONFLICT', 503, 'SERVICE_UNAVAILABLE'],
    ];
    for (const [storage, status, code] of cases) {
      const { handlers } = harness({
        consent: async () => {
          throw new WorkError(storage as never);
        },
      });
      const url = 'http://x/api/v1/party-proposals/' + ids.proposal + '/consents';
      const response = await handlers.CONSENT(post({ snapshotDigest }, {}, url), ids.proposal);
      expect([storage, response.status]).toEqual([storage, status]);
      const body = await errorOf(response);
      expect(body.code).toBe(code);
      expect(body.requestId).toBe(uuid(99));
      expect(JSON.stringify(body)).not.toContain(
        storage === 'STORAGE_CONTRACT' ? 'STORAGE' : 'zzz',
      );
    }
    for (const boom of [
      new Error('select * from "PartyProposal" secret-row'),
      new CommandReceiptError('STORAGE_UNAVAILABLE'),
    ]) {
      const { handlers } = harness({
        read: async () => {
          throw boom;
        },
      });
      const response = await handlers.READ(get(), ids.proposal);
      expect(response.status).toBe(503);
      expect(JSON.stringify(await response.json())).not.toContain('secret-row');
    }
    const reused = harness({
      create: async () => {
        throw new CommandReceiptError('IDEMPOTENCY_KEY_REUSED');
      },
    });
    const response = await reused.handlers.CREATE(post({ name: 'P' }));
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('fails closed when the host does not satisfy the contract', () => {
    const { host } = harness();
    for (const name of [
      'requestId',
      'actor',
      'checkOrigin',
      'rateLimit',
      'create',
      'propose',
      'consent',
      'read',
    ])
      expect(() => createPartyHandlers({ ...host, [name]: undefined } as never)).toThrow();
    expect(() => createPartyHandlers({ ...host, version: 'v2' } as never)).toThrow();
  });
});
