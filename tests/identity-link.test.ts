import { describe, expect, it } from 'vitest';
import {
  IdentityLinkError,
  linkVerifiedWallet,
  listWalletLinks,
  publicWalletLink,
  type IdentityTransaction,
} from '../src/identity-link';
import {
  FIXTURE_LIMITS,
  fixtureAddress,
  fixtureLinkInput,
  fixtureProof,
  fixtureSession,
} from './helpers/wallet-link-fixtures';

const ACCOUNT = 'account-alice';
const OTHER = 'account-bob';
const PARTICIPANT = 'd4bbeef1-55a8-4d8e-8d03-f3b012f92401';
const LINK_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const NEW_ADDRESS = fixtureAddress(2);
const PRIMARY = fixtureAddress(1);

type World = {
  user?: { id: string; suspended: boolean } | null;
  participant?: boolean;
  primary?: string | null;
  owner?: {
    source: 'PRIMARY' | 'LINK';
    accountId: string;
    status: string | null;
    networkIdentity: string | null;
  } | null;
  counts?: { active: string; total: string; revoked: string };
  insertEmpty?: boolean;
  conflictRows?: unknown[];
};
const TAGS: [string, RegExp][] = [
  ['lock', /pg_advisory_xact_lock/],
  ['user', /FROM "User".*FOR NO KEY UPDATE/s],
  ['participant-find', /FROM "Participant" WHERE "accountId"/],
  ['participant-share', /FROM "User" WHERE "id" = \$1 FOR KEY SHARE/],
  ['participant-insert', /INSERT INTO "Participant"/],
  ['primary', /FROM "WalletIdentity" WHERE "userId"/],
  ['ownership', /UNION ALL/],
  ['counts', /count\(\*\)/],
  ['link-insert', /INSERT INTO "WalletLink"/],
  ['link-conflict-read', /FROM "WalletLink" WHERE "address" = \$1 OR "proofRef"/],
  ['list', /FROM "WalletLink" WHERE "accountId" = \$1 ORDER BY/],
];
function tagOf(sql: string) {
  return TAGS.find(([, pattern]) => pattern.test(sql))?.[0] ?? 'UNKNOWN';
}
function fakePort(world: World = {}, overrides: Partial<IdentityTransaction> = {}) {
  const calls: { sql: string; bindings: readonly string[]; tag: string }[] = [];
  let participant = world.participant ?? false;
  const tx: IdentityTransaction = {
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    async query<Row>(sql: string, bindings: readonly string[]): Promise<Row[]> {
      const tag = tagOf(sql);
      calls.push({ sql, bindings, tag });
      const human = [{ id: PARTICIPANT, kind: 'HUMAN', accountId: ACCOUNT }];
      const rows: unknown[] = (() => {
        switch (tag) {
          case 'lock':
            return [{ locked: 1 }];
          case 'user':
            return world.user === null ? [] : [world.user ?? { id: ACCOUNT, suspended: false }];
          case 'participant-find':
            return participant ? human : [];
          case 'participant-share':
            return [{ id: ACCOUNT }];
          case 'participant-insert':
            participant = true;
            return human;
          case 'primary':
            return world.primary === null ? [] : [{ address: world.primary ?? PRIMARY }];
          case 'ownership':
            return world.owner ? [world.owner] : [];
          case 'counts':
            return [world.counts ?? { active: '0', total: '0', revoked: '0' }];
          case 'link-insert':
            return world.insertEmpty ? [] : [{ id: LINK_ID }];
          case 'link-conflict-read':
            return world.conflictRows ?? [];
          case 'list':
            return [];
          default:
            throw Error(`unexpected SQL ${sql}`);
        }
      })();
      return rows as Row[];
    },
    ...overrides,
  };
  return { tx, calls, tags: () => calls.map((call) => call.tag) };
}
const input = (address = NEW_ADDRESS, overrides: Record<string, unknown> = {}) =>
  fixtureLinkInput(ACCOUNT, address, overrides);
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'NO_ERROR',
    (error: unknown) => (error instanceof IdentityLinkError ? error.code : `OTHER:${error}`),
  );

describe('wallet link command v1 (fake port)', () => {
  it('links a new address in the documented lock order and returns the existing participant', async () => {
    const { tx, calls, tags } = fakePort({ participant: true });
    const result = await linkVerifiedWallet(tx, input());
    expect(result).toEqual({
      outcome: 'LINKED',
      source: 'LINK',
      linkId: LINK_ID,
      participantId: PARTICIPANT,
      networkIdentity: 'mainnet',
      address: NEW_ADDRESS,
      status: 'ACTIVE',
    });
    // WR12: subject advisory lock, then User row lock, then reads, then participant ensure, then insert.
    expect(tags()).toEqual([
      'lock',
      'user',
      'participant-find',
      'primary',
      'ownership',
      'counts',
      'link-insert',
    ]);
    expect(calls[0].bindings).toEqual([`wallet-subject:${NEW_ADDRESS}`]);
    // Every dynamic value is bound; none is interpolated into SQL text.
    expect(calls.every(({ sql }) => !sql.includes(NEW_ADDRESS) && !sql.includes(ACCOUNT))).toBe(
      true,
    );
    const insert = calls.find(({ tag }) => tag === 'link-insert')!;
    expect(insert.sql).toContain('ON CONFLICT DO NOTHING');
    expect(insert.bindings).toEqual([
      ACCOUNT,
      PARTICIPANT,
      'mainnet',
      NEW_ADDRESS,
      `proof-${NEW_ADDRESS}`,
      ACCOUNT,
      'request-link-1',
    ]);
  });

  it('creates the participant mapping only inside a fresh link', async () => {
    const { tx, calls } = fakePort({ participant: false });
    const result = await linkVerifiedWallet(tx, input());
    expect(result.participantId).toBe(PARTICIPANT);
    expect(calls.map(({ tag }) => tag).slice(-3)).toEqual([
      'participant-share',
      'participant-insert',
      'link-insert',
    ]);
    const created = calls.find(({ tag }) => tag === 'participant-insert')!;
    expect(created.bindings).toEqual([ACCOUNT, ACCOUNT, 'request-link-1']);
  });

  it('denies a foreign actor and malformed inputs before any SQL', async () => {
    const cases: Record<string, unknown>[] = [
      { actorAccountId: OTHER },
      { accountId: "alice'; DROP", actorAccountId: "alice'; DROP" },
      { requestId: '' },
      { subject: { networkIdentity: 'mainnet', address: 'not-an-address' } },
      { subject: { networkIdentity: 'bad network', address: NEW_ADDRESS } },
      { limits: { maxActiveLinks: 0, maxTotalLinks: 20 } },
      { limits: { maxActiveLinks: 5, maxTotalLinks: 4 } },
      { limits: { maxActiveLinks: 1.5, maxTotalLinks: 20 } },
      { proof: { not: 'a proof' } },
      { session: { not: 'a session' } },
      { policy: { not: 'a policy' } },
      { now: 'yesterday' },
    ];
    const expected = ['WRONG_ACTOR', 'INVALID_INPUT'];
    for (const overrides of cases) {
      const { tx, calls } = fakePort();
      const outcome = await code(linkVerifiedWallet(tx, input(NEW_ADDRESS, overrides)));
      expect(expected, JSON.stringify(overrides)).toContain(outcome);
      expect(calls).toHaveLength(0);
    }
    expect(
      await code(linkVerifiedWallet(fakePort().tx, input(NEW_ADDRESS, { actorAccountId: OTHER }))),
    ).toBe('WRONG_ACTOR');
  });

  it.each([
    ['SERIALIZABLE', 'POSTGRESQL'],
    ['REPEATABLE_READ', 'POSTGRESQL'],
    ['READ_COMMITTED', 'SQLITE'],
  ])('denies isolation %s / dialect %s before SQL', async (isolation, dialect) => {
    const { tx, calls } = fakePort();
    const bad = { ...tx, isolation, dialect } as unknown as IdentityTransaction;
    expect(await code(linkVerifiedWallet(bad, input()))).toBe('STORAGE_CONTRACT');
    expect(calls).toHaveLength(0);
  });

  it('missing account rejects without participant or link writes', async () => {
    const { tx, tags } = fakePort({ user: null });
    expect(await code(linkVerifiedWallet(tx, input()))).toBe('ACCOUNT_NOT_FOUND');
    expect(tags()).toEqual(['lock', 'user']);
  });

  const blockedCases: [string, World, Record<string, unknown>, string][] = [
    [
      'revoked session',
      {},
      { session: fixtureSession(ACCOUNT, { state: 'REVOKED' }) },
      'AUTHENTICATION_REQUIRED',
    ],
    [
      'expired session',
      {},
      { session: fixtureSession(ACCOUNT, { expiresAt: '2026-10-09T08:00:00.000Z' }) },
      'AUTHENTICATION_REQUIRED',
    ],
    ['session of another account', {}, { session: fixtureSession(OTHER) }, 'FORBIDDEN'],
    ['suspended account', { user: { id: ACCOUNT, suspended: true } }, {}, 'ACCOUNT_RESTRICTED'],
    [
      'proof for another account',
      {},
      { proof: fixtureProof(OTHER, NEW_ADDRESS, 'proof-x') },
      'PROOF_INVALID',
    ],
    [
      'wrong domain',
      {},
      { proof: fixtureProof(ACCOUNT, NEW_ADDRESS, 'proof-x', { domain: 'evil.example' }) },
      'PROOF_INVALID',
    ],
    [
      'wrong uri',
      {},
      { proof: fixtureProof(ACCOUNT, NEW_ADDRESS, 'proof-x', { uri: 'https://evil.example' }) },
      'PROOF_INVALID',
    ],
    [
      'consumed proof',
      {},
      { proof: fixtureProof(ACCOUNT, NEW_ADDRESS, 'proof-x', { consumed: true }) },
      'PROOF_INVALID',
    ],
    [
      'expired proof',
      {},
      {
        proof: fixtureProof(ACCOUNT, NEW_ADDRESS, 'proof-x', {
          expiresAt: '2026-10-09T08:30:00.000Z',
        }),
      },
      'PROOF_INVALID',
    ],
    [
      'unverified proof',
      {},
      { proof: fixtureProof(ACCOUNT, NEW_ADDRESS, 'proof-x', { state: 'UNVERIFIED' }) },
      'PROOF_INVALID',
    ],
    [
      'proof for another wallet',
      {},
      { proof: fixtureProof(ACCOUNT, fixtureAddress(9), 'proof-x') },
      'PROOF_INVALID',
    ],
    [
      'sign-in intent proof',
      {},
      { proof: fixtureProof(ACCOUNT, NEW_ADDRESS, 'proof-x', { intent: 'SIGNIN' }) },
      'PROOF_INVALID',
    ],
    [
      'unsupported network',
      {},
      {
        subject: { networkIdentity: 'devnet', address: NEW_ADDRESS },
        proof: fixtureProof(ACCOUNT, NEW_ADDRESS, 'proof-x', {
          subject: { kind: 'WALLET', networkIdentity: 'devnet', address: NEW_ADDRESS },
        }),
      },
      'UNSUPPORTED_IDENTITY',
    ],
  ];
  it.each(blockedCases)(
    '%s maps to its typed code and writes nothing',
    async (_name, world, overrides, expected) => {
      const { tx, tags } = fakePort(world);
      expect(await code(linkVerifiedWallet(tx, input(NEW_ADDRESS, overrides)))).toBe(expected);
      expect(tags()).not.toContain('link-insert');
      expect(tags()).not.toContain('participant-insert');
    },
  );

  it('foreign primary or link (active or revoked) is one conflict; own revoked is a distinct code', async () => {
    const outcomes: unknown[] = [];
    for (const owner of [
      { source: 'PRIMARY', accountId: OTHER, status: null, networkIdentity: null },
      { source: 'LINK', accountId: OTHER, status: 'ACTIVE', networkIdentity: 'mainnet' },
      { source: 'LINK', accountId: OTHER, status: 'REVOKED', networkIdentity: 'mainnet' },
    ] as const) {
      const { tx, tags } = fakePort({ owner });
      let error: unknown;
      await linkVerifiedWallet(tx, input()).catch((e: unknown) => (error = e));
      expect(error).toBeInstanceOf(IdentityLinkError);
      expect(tags()).not.toContain('link-insert');
      outcomes.push([(error as IdentityLinkError).code, (error as IdentityLinkError).message]);
    }
    expect(new Set(outcomes.map((o) => JSON.stringify(o))).size).toBe(1);
    expect(outcomes[0]).toEqual(['IDENTITY_CONFLICT', 'IDENTITY_CONFLICT']);
    const own = fakePort({
      owner: { source: 'LINK', accountId: ACCOUNT, status: 'REVOKED', networkIdentity: 'mainnet' },
    });
    expect(await code(linkVerifiedWallet(own.tx, input()))).toBe('IDENTITY_REVOKED');
    const otherNetwork = fakePort({
      owner: { source: 'LINK', accountId: ACCOUNT, status: 'ACTIVE', networkIdentity: 'devnet' },
    });
    expect(await code(linkVerifiedWallet(otherNetwork.tx, input()))).toBe('IDENTITY_CONFLICT');
  });

  it('own active link or own primary is an idempotent no-op that creates nothing', async () => {
    const ownLink = fakePort({
      participant: true,
      owner: { source: 'LINK', accountId: ACCOUNT, status: 'ACTIVE', networkIdentity: 'mainnet' },
    });
    expect(await linkVerifiedWallet(ownLink.tx, input())).toMatchObject({
      outcome: 'ALREADY_LINKED',
      source: 'LINK',
      participantId: PARTICIPANT,
      address: NEW_ADDRESS,
    });
    const ownPrimary = fakePort({
      participant: false,
      owner: { source: 'PRIMARY', accountId: ACCOUNT, status: null, networkIdentity: null },
    });
    expect(await linkVerifiedWallet(ownPrimary.tx, input(PRIMARY))).toMatchObject({
      outcome: 'ALREADY_LINKED',
      source: 'PRIMARY',
      linkId: null,
      participantId: null,
    });
    for (const { tags } of [ownLink, ownPrimary]) {
      expect(tags()).not.toContain('link-insert');
      expect(tags()).not.toContain('participant-insert');
    }
  });

  // WR08: restriction, session and proof checks come before the ALREADY_LINKED short circuit.
  it.each([
    ['suspended', { user: { id: ACCOUNT, suspended: true } }, {}, 'ACCOUNT_RESTRICTED'],
    [
      'revoked session',
      {},
      { session: fixtureSession(ACCOUNT, { state: 'REVOKED' }) },
      'AUTHENTICATION_REQUIRED',
    ],
    [
      'bad proof',
      {},
      { proof: fixtureProof(ACCOUNT, NEW_ADDRESS, 'proof-x', { domain: 'evil.example' }) },
      'PROOF_INVALID',
    ],
  ] as const)(
    '%s account re-linking its own wallet is not ALREADY_LINKED',
    async (_n, world, overrides, expected) => {
      const { tx } = fakePort({
        ...world,
        participant: true,
        owner: { source: 'LINK', accountId: ACCOUNT, status: 'ACTIVE', networkIdentity: 'mainnet' },
      });
      expect(await code(linkVerifiedWallet(tx, input(NEW_ADDRESS, overrides)))).toBe(expected);
    },
  );

  it('requires an existing primary wallet and creates no participant otherwise (WR05)', async () => {
    const { tx, tags } = fakePort({ primary: null, participant: false });
    expect(await code(linkVerifiedWallet(tx, input()))).toBe('PRIMARY_WALLET_REQUIRED');
    expect(tags()).not.toContain('participant-insert');
    expect(tags()).not.toContain('link-insert');
  });

  it('enforces the active and total caps at their boundaries', async () => {
    const at = (active: number, total: number) =>
      fakePort({
        participant: true,
        counts: { active: String(active), total: String(total), revoked: String(total - active) },
      });
    expect(await code(linkVerifiedWallet(at(FIXTURE_LIMITS.maxActiveLinks, 5).tx, input()))).toBe(
      'LINK_LIMIT_REACHED',
    );
    expect(await code(linkVerifiedWallet(at(0, FIXTURE_LIMITS.maxTotalLinks).tx, input()))).toBe(
      'LINK_LIMIT_REACHED',
    );
    expect(
      await code(linkVerifiedWallet(at(FIXTURE_LIMITS.maxActiveLinks - 1, 19).tx, input())),
    ).toBe('NO_ERROR');
    const full = at(FIXTURE_LIMITS.maxActiveLinks, 5);
    await linkVerifiedWallet(full.tx, input()).catch(() => undefined);
    expect(full.tags()).not.toContain('participant-insert');
    expect(full.tags()).not.toContain('link-insert');
  });

  it('empty RETURNING after ON CONFLICT: same account/address/proof is idempotent, anything else a conflict', async () => {
    const proofRef = `proof-${NEW_ADDRESS}`;
    const same = fakePort({
      participant: true,
      insertEmpty: true,
      conflictRows: [
        {
          id: LINK_ID,
          accountId: ACCOUNT,
          address: NEW_ADDRESS,
          proofRef,
          networkIdentity: 'mainnet',
          status: 'ACTIVE',
        },
      ],
    });
    expect(await linkVerifiedWallet(same.tx, input())).toMatchObject({
      outcome: 'ALREADY_LINKED',
      linkId: LINK_ID,
    });
    const reused = fakePort({
      participant: true,
      insertEmpty: true,
      conflictRows: [
        {
          id: LINK_ID,
          accountId: ACCOUNT,
          address: fixtureAddress(9),
          proofRef,
          networkIdentity: 'mainnet',
          status: 'ACTIVE',
        },
      ],
    });
    expect(await code(linkVerifiedWallet(reused.tx, input()))).toBe('IDENTITY_CONFLICT');
    const foreign = fakePort({
      participant: true,
      insertEmpty: true,
      conflictRows: [
        {
          id: LINK_ID,
          accountId: OTHER,
          address: NEW_ADDRESS,
          proofRef: 'other',
          networkIdentity: 'mainnet',
          status: 'ACTIVE',
        },
      ],
    });
    expect(await code(linkVerifiedWallet(foreign.tx, input()))).toBe('IDENTITY_CONFLICT');
    const vanished = fakePort({ participant: true, insertEmpty: true, conflictRows: [] });
    expect(await code(linkVerifiedWallet(vanished.tx, input()))).toBe('STORAGE_CONTRACT');
  });

  it('classifies storage failures by code only, never by message or constraint name (WR01)', async () => {
    const throwing = (cause: unknown) =>
      fakePort(
        {},
        {
          async query() {
            throw cause;
          },
        },
      ).tx;
    const { IdentityStorageError } = await import('../src/identity-storage');
    expect(
      await code(
        linkVerifiedWallet(throwing(new IdentityStorageError('RETRY_TRANSACTION')), input()),
      ),
    ).toBe('RETRY_TRANSACTION');
    expect(
      await code(
        linkVerifiedWallet(throwing(new IdentityStorageError('UNIQUE_CONFLICT')), input()),
      ),
    ).toBe('IDENTITY_CONFLICT');
    expect(
      await code(
        linkVerifiedWallet(throwing(new IdentityStorageError('STORAGE_CONTRACT')), input()),
      ),
    ).toBe('STORAGE_CONTRACT');
    // A raw driver error whose message contains an address and constraint name stays opaque.
    const raw = new Error(
      `Key (address)=(${NEW_ADDRESS}) already exists. raid_wallet_subject_exclusive_v1 ${OTHER}`,
    );
    let caught: unknown;
    await linkVerifiedWallet(throwing(raw), input()).catch((e: unknown) => (caught = e));
    expect(caught).toBeInstanceOf(IdentityLinkError);
    expect((caught as IdentityLinkError).code).toBe('STORAGE_UNAVAILABLE');
    const serialized = [
      String(caught),
      (caught as Error).message,
      JSON.stringify(caught),
      (caught as Error).stack ?? '',
    ].join('|');
    for (const secret of [
      NEW_ADDRESS,
      OTHER,
      ACCOUNT,
      'raid_wallet_subject_exclusive_v1',
      'proof-',
    ])
      expect(serialized).not.toContain(secret);
  });

  it('public link DTO omits internal identifiers; listing returns only own links', async () => {
    const dto = publicWalletLink({
      outcome: 'LINKED',
      source: 'LINK',
      linkId: LINK_ID,
      participantId: PARTICIPANT,
      networkIdentity: 'mainnet',
      address: NEW_ADDRESS,
      status: 'ACTIVE',
    });
    expect(dto).toEqual({
      address: NEW_ADDRESS,
      networkIdentity: 'mainnet',
      status: 'ACTIVE',
      alreadyLinked: false,
    });
    expect(JSON.stringify(dto)).not.toContain(PARTICIPANT);
    expect(JSON.stringify(dto)).not.toContain(LINK_ID);
    const { tx, calls } = fakePort();
    expect(await listWalletLinks(tx, ACCOUNT)).toEqual([]);
    expect(calls[0].bindings).toEqual([ACCOUNT]);
    await expect(listWalletLinks(tx, "x'; DROP")).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('a deterministic alternate port yields identical outcomes and errors (adapter substitution)', async () => {
    const base = fakePort({ participant: true });
    const wrapped: IdentityTransaction = {
      dialect: 'POSTGRESQL',
      isolation: 'READ_COMMITTED',
      query: (sql, bindings) => base.tx.query(sql, bindings),
    };
    const direct = fakePort({ participant: true });
    expect(await linkVerifiedWallet(wrapped, input())).toEqual(
      await linkVerifiedWallet(direct.tx, input()),
    );
    const a = fakePort({
      owner: { source: 'LINK', accountId: OTHER, status: 'ACTIVE', networkIdentity: 'mainnet' },
    });
    const b = fakePort({
      owner: { source: 'LINK', accountId: OTHER, status: 'ACTIVE', networkIdentity: 'mainnet' },
    });
    expect(await code(linkVerifiedWallet(a.tx, input()))).toBe(
      await code(linkVerifiedWallet({ ...b.tx, query: b.tx.query }, input())),
    );
  });
});
