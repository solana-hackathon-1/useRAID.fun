import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import { createAssetRegistry } from '../src/asset-registry';
import {
  MINT_ONE,
  MINT_TWO,
  NETWORK_A,
  NETWORK_B,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  fixtureAddress,
} from './helpers/asset-fixtures';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient({ log: [] });
const options = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 };

type Client = Pick<PrismaClient, '$executeRawUnsafe' | '$queryRawUnsafe'>;
const insertAsset = (
  client: Client,
  network: string,
  kind: 'TOKEN' | 'NATIVE_SOL',
  mint = '',
  program = '',
  chain = 'SOLANA',
) =>
  client.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "Asset" ("chain","networkIdentity","kind","mint","tokenProgram") VALUES ($1,$2,$3,$4,$5) RETURNING "id"::text AS id`,
    chain,
    network,
    kind,
    mint,
    program,
  );
const insertPolicy = (
  client: Client,
  assetId: string,
  version: string,
  decimals = 6,
  slot = '100',
  profile = 'plain-spl',
) =>
  client.$executeRawUnsafe(
    `INSERT INTO "AssetPolicySnapshot" ("assetId","registryVersion","verifiedDecimals","observedAuthorities","supportedExtensionProfile","observedAt","observedSlot") VALUES ($1::uuid,$2,$3,ARRAY[]::text[],$4,NOW(),$5::numeric)`,
    assetId,
    version,
    decimals,
    profile,
    slot,
  );
async function sqlState(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    const meta = (error as { meta?: { code?: string }; code?: string }).meta;
    const message = String((error as Error).message);
    return meta?.code ?? /code: "?(\w{5})"?/.exec(message)?.[1] ?? message.slice(0, 120);
  }
  return 'OK';
}
const count = async (table: string) =>
  Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM "${table}"`))[0].n);
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function pidOf(tx: Prisma.TransactionClient) {
  return (await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0].pid;
}
async function observeBlocked(waiter: number, blocker: number) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows = await db.$queryRawUnsafe<{ blockers: number[] }[]>(
      'SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = $1',
      waiter,
    );
    // Evidence comes from the database lock graph, never from elapsed sleep.
    if (rows[0]?.blockers.includes(blocker)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('competing transaction never blocked on the first');
}

integration('T029 asset registry persistence on real PostgreSQL', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(async () => {
    if (process.env.RUN_DB_TESTS === 'true') {
      assertTestDatabase();
      await truncateAll(db);
    }
    await db.$disconnect();
  });

  it('enforces exact identity uniqueness: network, mint and token program all matter', async () => {
    await insertAsset(db, NETWORK_A, 'TOKEN', MINT_ONE, SPL_TOKEN_PROGRAM_ID);
    expect(
      await sqlState(insertAsset(db, NETWORK_A, 'TOKEN', MINT_ONE, SPL_TOKEN_PROGRAM_ID)),
    ).toBe('23505');
    // Same mint on another network, or under another token program, is another instrument.
    expect(
      await sqlState(insertAsset(db, NETWORK_B, 'TOKEN', MINT_ONE, SPL_TOKEN_PROGRAM_ID)),
    ).toBe('OK');
    expect(
      await sqlState(insertAsset(db, NETWORK_A, 'TOKEN', MINT_ONE, TOKEN_2022_PROGRAM_ID)),
    ).toBe('OK');
    expect(
      await sqlState(insertAsset(db, NETWORK_A, 'TOKEN', MINT_TWO, SPL_TOKEN_PROGRAM_ID)),
    ).toBe('OK');
    expect(await count('Asset')).toBe(4);
  });

  it('allows one native SOL asset per network and rejects a second', async () => {
    await insertAsset(db, NETWORK_A, 'NATIVE_SOL');
    expect(await sqlState(insertAsset(db, NETWORK_A, 'NATIVE_SOL'))).toBe('23505');
    expect(await sqlState(insertAsset(db, NETWORK_B, 'NATIVE_SOL'))).toBe('OK');
  });

  it('rejects malformed identities by check constraint', async () => {
    const bad = [
      insertAsset(db, NETWORK_A, 'NATIVE_SOL', MINT_ONE, ''), // native with a mint
      insertAsset(db, NETWORK_A, 'NATIVE_SOL', '', SPL_TOKEN_PROGRAM_ID),
      insertAsset(db, NETWORK_A, 'TOKEN', '', SPL_TOKEN_PROGRAM_ID), // token without a mint
      insertAsset(db, NETWORK_A, 'TOKEN', MINT_ONE, ''), // token without a program
      insertAsset(db, NETWORK_A, 'TOKEN', 'USDC', SPL_TOKEN_PROGRAM_ID), // ticker is not an address
      insertAsset(db, NETWORK_A, 'TOKEN', `0${MINT_ONE.slice(1)}`, SPL_TOKEN_PROGRAM_ID), // non-base58
      insertAsset(db, NETWORK_A, 'TOKEN', MINT_ONE, SPL_TOKEN_PROGRAM_ID, 'ETHEREUM'),
      insertAsset(db, NETWORK_A, 'MYSTERY' as never, MINT_ONE, SPL_TOKEN_PROGRAM_ID),
      insertAsset(db, '', 'NATIVE_SOL'),
      insertAsset(db, 'has space', 'NATIVE_SOL'),
    ];
    for (const attempt of bad) expect(await sqlState(attempt)).toBe('23514');
    expect(await count('Asset')).toBe(0);
  });

  it('keeps one asset row across policy versions and never splits identity (AC30)', async () => {
    const [{ id }] = await insertAsset(db, NETWORK_A, 'TOKEN', MINT_ONE, SPL_TOKEN_PROGRAM_ID);
    await insertPolicy(db, id, 'v1');
    await insertPolicy(db, id, 'v2', 6, '200');
    await insertPolicy(db, id, 'v3', 6, '200', 'metadata-only');
    expect(await count('Asset')).toBe(1);
    expect(await count('AssetPolicySnapshot')).toBe(3);
    expect(await sqlState(insertPolicy(db, id, 'v2', 6, '300'))).toBe('23505');
  });

  it('rejects a decimals change or an older observation for the same asset', async () => {
    const [{ id }] = await insertAsset(db, NETWORK_A, 'TOKEN', MINT_ONE, SPL_TOKEN_PROGRAM_ID);
    await insertPolicy(db, id, 'v1', 6, '100');
    expect(await sqlState(insertPolicy(db, id, 'v2', 9, '200'))).toBe('23000');
    expect(await sqlState(insertPolicy(db, id, 'v2', 6, '99'))).toBe('23000');
    expect(await count('AssetPolicySnapshot')).toBe(1);
    // A different asset is free to use other decimals.
    const [{ id: other }] = await insertAsset(
      db,
      NETWORK_A,
      'TOKEN',
      MINT_TWO,
      SPL_TOKEN_PROGRAM_ID,
    );
    expect(await sqlState(insertPolicy(db, other, 'v1', 9))).toBe('OK');
  });

  it('bounds decimals and observed slot, and requires an existing asset', async () => {
    const [{ id }] = await insertAsset(db, NETWORK_A, 'TOKEN', MINT_ONE, SPL_TOKEN_PROGRAM_ID);
    expect(await sqlState(insertPolicy(db, id, 'v1', 256))).toBe('23514');
    expect(await sqlState(insertPolicy(db, id, 'v1', -1))).toBe('23514');
    expect(await sqlState(insertPolicy(db, id, 'v1', 6, '18446744073709551616'))).toBe('23514');
    expect(await sqlState(insertPolicy(db, id, 'v1', 6, '-1'))).toBe('23514');
    expect(await sqlState(insertPolicy(db, id, 'v1', 6, '18446744073709551615'))).toBe('OK');
    expect(await sqlState(insertPolicy(db, id, 'bad version!', 6, '18446744073709551615'))).toBe(
      '23514',
    );
    expect(await sqlState(insertPolicy(db, '00000000-0000-4000-8000-000000000000', 'v1'))).toBe(
      '23503',
    );
  });

  it('makes identities and snapshots immutable, while no-op updates stay possible', async () => {
    const [{ id }] = await insertAsset(db, NETWORK_A, 'TOKEN', MINT_ONE, SPL_TOKEN_PROGRAM_ID);
    await insertPolicy(db, id, 'v1');
    expect(
      await sqlState(
        db.$executeRawUnsafe(`UPDATE "Asset" SET "mint" = $1 WHERE "id" = $2::uuid`, MINT_TWO, id),
      ),
    ).toBe('23000');
    expect(
      await sqlState(db.$executeRawUnsafe(`DELETE FROM "Asset" WHERE "id" = $1::uuid`, id)),
    ).toBe('23000');
    expect(
      await sqlState(
        db.$executeRawUnsafe(
          `UPDATE "AssetPolicySnapshot" SET "verifiedDecimals" = 9 WHERE "assetId" = $1::uuid`,
          id,
        ),
      ),
    ).toBe('23000');
    expect(
      await sqlState(
        db.$executeRawUnsafe(`DELETE FROM "AssetPolicySnapshot" WHERE "assetId" = $1::uuid`, id),
      ),
    ).toBe('23000');
    expect(
      await sqlState(
        db.$executeRawUnsafe(`UPDATE "Asset" SET "mint" = "mint" WHERE "id" = $1::uuid`, id),
      ),
    ).toBe('OK');
  });

  it('serializes two concurrent creations of the same instrument to one winner', async () => {
    const holding = deferred<number>();
    const release = deferred();
    const waiter = deferred<number>();
    const first = db.$transaction(async (tx) => {
      await insertAsset(tx, NETWORK_A, 'TOKEN', MINT_ONE, SPL_TOKEN_PROGRAM_ID);
      holding.resolve(await pidOf(tx));
      await release.promise;
    }, options);
    const holderPid = await holding.promise;
    const second = db.$transaction(async (tx) => {
      waiter.resolve(await pidOf(tx));
      await insertAsset(tx, NETWORK_A, 'TOKEN', MINT_ONE, SPL_TOKEN_PROGRAM_ID);
    }, options);
    second.catch(() => undefined);
    await observeBlocked(await waiter.promise, holderPid);
    release.resolve();
    await first;
    expect(await sqlState(second)).toBe('23505');
    expect(await count('Asset')).toBe(1);
  });

  it('serializes competing policy versions so decimals cannot diverge', async () => {
    const [{ id }] = await insertAsset(db, NETWORK_A, 'TOKEN', MINT_ONE, SPL_TOKEN_PROGRAM_ID);
    const holding = deferred<number>();
    const release = deferred();
    const waiter = deferred<number>();
    const first = db.$transaction(async (tx) => {
      await insertPolicy(tx, id, 'v1', 6, '100');
      holding.resolve(await pidOf(tx));
      await release.promise;
    }, options);
    const holderPid = await holding.promise;
    const second = db.$transaction(async (tx) => {
      waiter.resolve(await pidOf(tx));
      await insertPolicy(tx, id, 'v2', 9, '100');
    }, options);
    second.catch(() => undefined);
    await observeBlocked(await waiter.promise, holderPid);
    release.resolve();
    await first;
    // The loser re-evaluates against the committed winner and is rejected, not both committed.
    expect(await sqlState(second)).toBe('23000');
    const rows = await db.$queryRawUnsafe<{ d: number }[]>(
      `SELECT DISTINCT "verifiedDecimals" AS d FROM "AssetPolicySnapshot"`,
    );
    expect(rows).toEqual([{ d: 6 }]);
  });

  it('feeds the in-process registry from stored rows without changing decisions (adapter substitution)', async () => {
    await insertAsset(db, NETWORK_A, 'TOKEN', MINT_ONE, SPL_TOKEN_PROGRAM_ID);
    await insertAsset(db, NETWORK_A, 'NATIVE_SOL');
    const rows = await db.$queryRawUnsafe<
      { chain: string; networkIdentity: string; kind: string; mint: string; tokenProgram: string }[]
    >(`SELECT "chain","networkIdentity","kind","mint","tokenProgram" FROM "Asset"`);
    const registry = createAssetRegistry({
      networks: [{ networkIdentity: NETWORK_A, cluster: 'SYNTHETIC' }],
      assets: rows.map((row) => ({
        assetId:
          row.kind === 'TOKEN'
            ? ({
                chain: 'SOLANA',
                networkIdentity: row.networkIdentity,
                kind: 'TOKEN',
                mint: row.mint,
                tokenProgram: row.tokenProgram,
              } as const)
            : ({
                chain: 'SOLANA',
                networkIdentity: row.networkIdentity,
                kind: 'NATIVE_SOL',
              } as const),
        display: { symbol: row.kind === 'TOKEN' ? 'TOK' : 'SOL' },
        origin: 'TEST_FIXTURE' as const,
      })),
      profiles: [],
      policies: [],
    });
    expect(registry.assets()).toHaveLength(2);
    expect(
      registry.has({
        chain: 'SOLANA',
        networkIdentity: NETWORK_A,
        kind: 'TOKEN',
        mint: fixtureAddress(1),
        tokenProgram: SPL_TOKEN_PROGRAM_ID,
      }),
    ).toBe(true);
    expect(
      registry.has({
        chain: 'SOLANA',
        networkIdentity: NETWORK_B,
        kind: 'TOKEN',
        mint: fixtureAddress(1),
        tokenProgram: SPL_TOKEN_PROGRAM_ID,
      }),
    ).toBe(false);
  });
});
