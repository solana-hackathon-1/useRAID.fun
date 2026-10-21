import type { Prisma } from '@prisma/client';
import {
  acquireAdvisories,
  acquireAccountRoots,
  acquireIdentityChildren,
  sealIdentityLocks,
  requireIdentityLocks,
  lockCoverage,
  lockResource,
  replanIdentity,
  IdentityLockError,
  type IdentityLockCapability,
  type RootMode,
  type LockResource,
} from '../identity-locks';
import { createPrismaIdentityTransaction } from './identity-storage-adapter';

export async function lockAdvisory(tx: Prisma.TransactionClient, resource: LockResource) {
  await acquireAdvisories(createPrismaIdentityTransaction(tx), [resource]);
}
export async function lockAccountReferences(
  tx: Prisma.TransactionClient,
  ids: readonly string[],
  authorityIds: readonly string[] = [],
) {
  await acquireAccountRoots(
    createPrismaIdentityTransaction(tx),
    [...new Set([...ids, ...authorityIds])].map((id) => ({
      id,
      mode: authorityIds.includes(id) ? ('SHARE' as const) : ('KEY SHARE' as const),
    })),
  );
}
export async function prepareIdentity(
  tx: Prisma.TransactionClient,
  options: {
    accounts: readonly { id: string; mode: RootMode; create?: boolean }[];
    subjects?: readonly string[];
    xIds?: readonly string[];
    balances?: readonly string[];
    attemptHashes?: readonly string[];
  },
) {
  const ids = [...new Set(options.accounts.map((a) => a.id))];
  const observe = async () => {
    const [users, wallets, links] = await Promise.all([
      tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, xId: true } }),
      tx.walletIdentity.findMany({
        where: { userId: { in: ids } },
        select: { address: true, userId: true },
      }),
      tx.walletLink.findMany({
        where: { accountId: { in: ids } },
        select: { address: true, accountId: true },
      }),
    ]);
    return { users, wallets, links };
  };
  const observed = await observe(),
    fingerprint = (value: Awaited<ReturnType<typeof observe>>) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(value).map(([key, rows]) => [
            key,
            rows.map((row) => JSON.stringify(row)).sort(),
          ]),
        ),
      );
  const port = createPrismaIdentityTransaction(tx);
  await acquireAdvisories(port, [
    ...(options.balances || []).map((id) => lockResource('balance', id)),
    ...[
      ...new Set([
        ...(options.subjects || []),
        ...observed.wallets.map((w) => w.address),
        ...observed.links.map((w) => w.address),
      ]),
    ].map((id) => lockResource('wallet-subject', id)),
    ...[
      ...new Set([
        ...(options.xIds || []),
        ...observed.users.flatMap((u) => (u.xId ? [u.xId] : [])),
      ]),
    ].map((id) => lockResource('x-auth', id)),
  ]);
  await acquireAccountRoots(port, options.accounts);
  if (fingerprint(await observe()) !== fingerprint(observed)) replanIdentity();
  const modes = new Map(options.accounts.map((a) => [a.id, a.mode]));
  await acquireIdentityChildren(
    port,
    (table, id) =>
      table === 'Session' ||
      table === 'OAuthAttempt' ||
      ['UPDATE', 'NO KEY UPDATE'].includes(modes.get(id)!)
        ? 'UPDATE'
        : 'SHARE',
    { OAuthAttempt: options.attemptHashes },
  );
  return sealIdentityLocks(port);
}
const MUTATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);
type OwnedModel = 'user' | 'session' | 'xAccount' | 'walletIdentity' | 'oAuthAttempt';
export type IdentityWriter = Pick<Prisma.TransactionClient, OwnedModel>;
/** Scoped mutation facade. The capability is issued only after final roots/children are held. */
export function identityWriter(
  tx: Prisma.TransactionClient,
  locks: IdentityLockCapability,
): IdentityWriter {
  const port = createPrismaIdentityTransaction(tx);
  const writer = {} as IdentityWriter;
  for (const model of ['user', 'session', 'xAccount', 'walletIdentity', 'oAuthAttempt'] as const) {
    Object.defineProperty(writer, model, {
      value: new Proxy(tx[model], {
        get(delegate, method) {
          const fn = Reflect.get(delegate, method);
          if (typeof fn !== 'function') return fn;
          if (!MUTATIONS.has(String(method))) throw new IdentityLockError('STORAGE_CONTRACT');
          return async (input: {
            where?: Record<string, unknown>;
            data?: Record<string, unknown>;
            create?: Record<string, unknown>;
            update?: Record<string, unknown>;
          }) => {
            await requireIdentityLocks(port, locks);
            const coverage = lockCoverage(port, locks);
            const data = input.data || input.create || {},
              where = input.where || {};
            if (model === 'user' && method !== 'create' && Object.hasOwn(data, 'id'))
              throw new IdentityLockError('STORAGE_CONTRACT');
            if (Array.isArray(input.data)) throw new IdentityLockError('STORAGE_CONTRACT');
            // No nested relation writes or unchecked relation envelopes through this facade.
            for (const value of Object.values({ ...data, ...input.update })) {
              if (value && typeof value === 'object' && !(value instanceof Date))
                throw new IdentityLockError('STORAGE_CONTRACT');
            }
            const id = model === 'user' ? where.id || data.id : data.userId || where.userId;
            const mode =
              model === 'user'
                ? method === 'delete' ||
                  method === 'deleteMany' ||
                  Object.hasOwn(data, 'xId') ||
                  Object.hasOwn(input.update || {}, 'xId')
                  ? 'UPDATE'
                  : 'NO KEY UPDATE'
                : model === 'session' || model === 'oAuthAttempt'
                  ? 'SHARE'
                  : 'NO KEY UPDATE';
            if (typeof id === 'string')
              await requireIdentityLocks(port, locks, { accounts: [{ id, mode }] });
            else if (model === 'session' && typeof where.tokenHash === 'string') {
              if (!coverage.children.get('Session')?.has(where.tokenHash))
                throw new IdentityLockError('STORAGE_CONTRACT');
            } else if (model === 'oAuthAttempt' && typeof where.stateHash === 'string') {
              if (!coverage.children.get('OAuthAttempt')?.has(where.stateHash))
                throw new IdentityLockError('STORAGE_CONTRACT');
            } else if (!(model === 'oAuthAttempt' && method === 'create' && !data.userId))
              throw new IdentityLockError('STORAGE_CONTRACT');
            if (model !== 'user')
              await requireIdentityLocks(port, locks, {
                children: [
                  model === 'xAccount'
                    ? 'XAccount'
                    : model === 'walletIdentity'
                      ? 'WalletIdentity'
                      : model === 'session'
                        ? 'Session'
                        : 'OAuthAttempt',
                ],
                childMode: 'UPDATE',
              });
            if (model !== 'user' && typeof where.userId === 'string')
              await requireIdentityLocks(port, locks, {
                accounts: [
                  {
                    id: where.userId,
                    mode: model === 'session' || model === 'oAuthAttempt' ? 'NO KEY UPDATE' : mode,
                  },
                ],
              });
            if (model === 'xAccount' && typeof data.xUserId === 'string')
              await requireIdentityLocks(port, locks, { xIds: [data.xUserId] });
            if (model === 'user' && typeof data.xId === 'string')
              await requireIdentityLocks(port, locks, { xIds: [data.xId] });
            if (model === 'walletIdentity' && typeof data.address === 'string')
              await requireIdentityLocks(port, locks, { subjects: [data.address] });
            return fn.call(delegate, input);
          };
        },
      }),
    });
  }
  return writer;
}
export async function identityClock(tx: Prisma.TransactionClient) {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS "now"`;
  return now;
}
