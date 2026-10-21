import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  IdentityLinkError,
  linkVerifiedWallet,
  type IdentityTransaction,
} from '../src/identity-link';
import { createPrismaIdentityTransaction } from '../src/lib/identity-storage-adapter';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import {
  fixtureAddress,
  fixtureLinkInput,
  fixtureSession,
  FIXTURE_NOW,
} from './helpers/wallet-link-fixtures';

const A = 'hook-alice';
const PRIMARY = fixtureAddress(61);
const EXTRA = fixtureAddress(62);
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

// `observeAuthority` is a public identity-link v1 contract: awaited after the wallet-subject and
// account locks, before the preflight; its observation replaces any `session`/`now` input.
integration('identity-link observeAuthority hook contract (real PostgreSQL)', () => {
  const db = new PrismaClient({ log: [] });
  const options = {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    timeout: 20000,
  };
  const base = () => {
    const { session: _session, now: _now, ...rest } = fixtureLinkInput(A, EXTRA);
    return rest;
  };
  const code = (work: Promise<unknown>) =>
    work.then(
      () => 'NO_ERROR',
      (e: unknown) => (e instanceof IdentityLinkError ? e.code : `OTHER:${String(e)}`),
    );
  const links = () => db.walletLink.count();
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    await truncateAll(db);
    await db.user.create({ data: { id: A, handle: A } });
    await db.walletIdentity.create({ data: { address: PRIMARY, userId: A } });
  });
  afterAll(async () => {
    await truncateAll(db);
    await db.$disconnect();
  });

  it('is awaited after the subject and account locks and before any other read', async () => {
    const seen: string[] = [];
    await db.$transaction(async (raw) => {
      const inner = createPrismaIdentityTransaction(raw);
      const tx: IdentityTransaction = {
        ...inner,
        async query<Row>(sql: string, bindings: readonly string[]) {
          seen.push(
            sql.includes('pg_advisory_xact_lock')
              ? 'subject-lock'
              : sql.includes('FOR NO KEY UPDATE')
                ? 'account-lock'
                : sql.includes('"Participant"')
                  ? 'participant'
                  : 'other',
          );
          return inner.query<Row>(sql, bindings);
        },
      };
      await linkVerifiedWallet(tx, {
        ...base(),
        observeAuthority: async () => {
          seen.push('HOOK');
          return { session: fixtureSession(A), now: FIXTURE_NOW };
        },
      });
    }, options);
    expect(seen.indexOf('subject-lock')).toBeLessThan(seen.indexOf('account-lock'));
    expect(seen.indexOf('account-lock')).toBeLessThan(seen.indexOf('HOOK'));
    expect(seen.lastIndexOf('participant')).toBeGreaterThan(seen.indexOf('HOOK')); // domain read after hook; pre-lock enumeration precedes it
    expect(await links()).toBe(1);
  });

  it('uses the hook observation instead of stale session and clock input', async () => {
    const stale = {
      session: fixtureSession(A, { state: 'EXPIRED' }),
      now: '2030-01-01T00:00:00.000Z',
    };
    await db.$transaction(
      (raw) =>
        linkVerifiedWallet(createPrismaIdentityTransaction(raw), {
          ...base(),
          ...stale,
          observeAuthority: async () => ({ session: fixtureSession(A), now: FIXTURE_NOW }),
        }),
      options,
    );
    expect(await links()).toBe(1);
  });

  it('denies with the IdentityLinkError the hook throws and writes nothing', async () => {
    const result = await code(
      db.$transaction(
        (raw) =>
          linkVerifiedWallet(createPrismaIdentityTransaction(raw), {
            ...base(),
            observeAuthority: async () => {
              throw new IdentityLinkError('FORBIDDEN');
            },
          }),
        options,
      ),
    );
    expect(result).toBe('FORBIDDEN');
    expect(await links()).toBe(0);
    expect(await db.participant.count()).toBe(0);
  });

  it('reports any other hook failure as STORAGE_UNAVAILABLE without its text', async () => {
    const error = await db
      .$transaction(
        (raw) =>
          linkVerifiedWallet(createPrismaIdentityTransaction(raw), {
            ...base(),
            observeAuthority: async () => {
              throw new Error(`secret ${EXTRA}`);
            },
          }),
        options,
      )
      .catch((e) => e);
    expect(error).toBeInstanceOf(IdentityLinkError);
    expect(error.message).toBe('STORAGE_UNAVAILABLE');
    expect(JSON.stringify(error)).not.toContain(EXTRA);
    expect(await links()).toBe(0);
  });

  it.each([null, {}, { session: fixtureSession(A) }, { session: 'x', now: FIXTURE_NOW }])(
    'rejects a malformed hook return %j as INVALID_INPUT',
    async (bad) => {
      const result = await code(
        db.$transaction(
          (raw) =>
            linkVerifiedWallet(createPrismaIdentityTransaction(raw), {
              ...base(),
              observeAuthority: async () => bad as never,
            }),
          options,
        ),
      );
      expect(result).toBe('INVALID_INPUT');
      expect(await links()).toBe(0);
    },
  );

  it('still requires a valid session and clock when no hook is supplied', async () => {
    const result = await code(
      db.$transaction(
        (raw) => linkVerifiedWallet(createPrismaIdentityTransaction(raw), base() as never),
        options,
      ),
    );
    expect(result).toBe('INVALID_INPUT');
  });
});
