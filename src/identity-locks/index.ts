/** PostgreSQL transaction lock protocol. No ORM, app configuration or global database dependency. */
export interface LockTransaction {
  readonly dialect: 'POSTGRESQL';
  readonly isolation: 'READ_COMMITTED';
  /** Trusted host schema declaration; omitted means the complete RAID identity schema. */
  readonly identityLayout?: {
    readonly xKeyColumn: 'xId' | null;
    readonly children: readonly ChildTable[];
  };
  query<Row>(sql: string, bindings: readonly string[]): Promise<Row[]>;
}
export const LOCK_PROTOCOL_VERSION = 'v1' as const;
// A1: observed reward→tracking→post and 729103→tracking→balance prefixes are preserved.
export const LOCK_CLASSES = [
  'global',
  'finance',
  'reward',
  'x-endpoint',
  'tracking',
  'post',
  'balance',
  'wallet-subject',
  'x-auth',
] as const;
export type LockClass = (typeof LOCK_CLASSES)[number];
export const FIXED_LOCK_KEYS = ['729102', '729103', '729104'] as const;
export type RootMode = 'KEY SHARE' | 'SHARE' | 'NO KEY UPDATE' | 'UPDATE';
const strength: Record<RootMode, number> = {
  'KEY SHARE': 0,
  SHARE: 1,
  'NO KEY UPDATE': 2,
  UPDATE: 3,
};
export type LockResource = Readonly<{ kind: LockClass; id: string }>;
export const lockResource = (kind: LockClass, id: string): LockResource => {
  if (
    !LOCK_CLASSES.includes(kind) ||
    !id ||
    /[\x00-\x1f\x7f]/.test(id) ||
    (kind === 'global' && !FIXED_LOCK_KEYS.includes(id as (typeof FIXED_LOCK_KEYS)[number]))
  )
    throw new IdentityLockError('STORAGE_CONTRACT');
  return Object.freeze({ kind, id });
};
export const lockLabel = (resource: LockResource) =>
  resource.kind === 'global' ? resource.id : `${resource.kind}:${resource.id}`;
const order = (a: LockResource, b: LockResource) =>
  LOCK_CLASSES.indexOf(a.kind) - LOCK_CLASSES.indexOf(b.kind) || compare(a.id, b.id);
export const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export class IdentityLockError extends Error {
  constructor(readonly code: 'PLAN_CHANGED' | 'STORAGE_CONTRACT') {
    super(code);
  }
}
export const replanIdentity = (): never => {
  throw new IdentityLockError('PLAN_CHANGED');
};
type State = {
  resources: Map<string, { resource: LockResource; key: string }>;
  roots: Map<string, RootMode>;
  newAccounts: Set<string>;
  children: Map<string, Map<string, 'SHARE' | 'UPDATE'>>;
  last?: LockResource;
  rooted: boolean;
  sealed: boolean;
  transactionId?: string;
};
const states = new WeakMap<LockTransaction, State>();
function state(tx: LockTransaction) {
  if (tx.dialect !== 'POSTGRESQL' || tx.isolation !== 'READ_COMMITTED')
    throw new IdentityLockError('STORAGE_CONTRACT');
  let value = states.get(tx);
  if (!value) {
    value = {
      resources: new Map(),
      roots: new Map(),
      newAccounts: new Set(),
      children: new Map(),
      rooted: false,
      sealed: false,
    };
    states.set(tx, value);
  }
  return value;
}
export async function advisoryKey(tx: LockTransaction, resource: LockResource) {
  if (resource.kind === 'global') return resource.id;
  const rows = await tx.query<{ key: string }>('SELECT hashtextextended($1, 0)::text AS "key"', [
    lockLabel(resource),
  ]);
  if (rows.length !== 1 || !/^-?\d+$/.test(rows[0].key))
    throw new IdentityLockError('STORAGE_CONTRACT');
  return rows[0].key;
}
export async function acquireAdvisories(tx: LockTransaction, resources: readonly LockResource[]) {
  const s = state(tx);
  const unique = [...new Map(resources.map((r) => [lockLabel(r), r])).values()].sort(order);
  const keys = await Promise.all(
    unique.map(async (resource) => ({ resource, key: await advisoryKey(tx, resource) })),
  );
  const owners = new Map([...s.resources.values()].map((r) => [r.key, lockLabel(r.resource)]));
  for (const { resource, key } of keys) {
    const label = lockLabel(resource),
      alias = owners.get(key);
    if (
      (alias && alias !== label) ||
      (resource.kind !== 'global' &&
        FIXED_LOCK_KEYS.includes(key as (typeof FIXED_LOCK_KEYS)[number]))
    )
      throw new IdentityLockError('STORAGE_CONTRACT');
    owners.set(key, label);
    if (
      !s.resources.has(label) &&
      (s.rooted || s.sealed || (s.last && order(resource, s.last) < 0))
    )
      throw new IdentityLockError('STORAGE_CONTRACT');
  }
  // Key reads above take no advisory locks. Actual acquisitions are sequential, never Promise.all.
  for (const { resource, key } of keys) {
    const label = lockLabel(resource);
    if (s.resources.has(label)) continue;
    await tx.query(
      'SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock($1::bigint)) AS "lock"',
      [key],
    );
    s.resources.set(label, { resource, key });
    s.last = resource;
  }
}
export async function acquireAccountRoots(
  tx: LockTransaction,
  roots: readonly { id: string; mode: RootMode; create?: boolean }[],
) {
  const s = state(tx),
    planned = new Map<string, { id: string; mode: RootMode; create?: boolean }>();
  for (const root of roots) {
    if (!root.id || !Object.hasOwn(strength, root.mode))
      throw new IdentityLockError('STORAGE_CONTRACT');
    const old = planned.get(root.id);
    if (old && old.create !== root.create) throw new IdentityLockError('STORAGE_CONTRACT');
    if (!old || strength[root.mode] > strength[old.mode]) planned.set(root.id, root);
  }
  if (
    s.rooted &&
    [...planned.values()].some(
      (r) => !s.roots.has(r.id) || strength[s.roots.get(r.id)!] < strength[r.mode],
    )
  )
    throw new IdentityLockError('STORAGE_CONTRACT');
  for (const root of [...planned.values()].sort((a, b) => compare(a.id, b.id))) {
    if (s.roots.has(root.id)) continue;
    // Modes are closed constants; values stay parameterized. No database-collation acquisition.
    const rows = await tx.query<{ id: string }>(
      `SELECT "id" FROM "User" WHERE "id" = $1${root.create ? '' : ` FOR ${root.mode}`}`,
      [root.id],
    );
    if (root.create ? rows.length !== 0 : rows.length !== 1) replanIdentity();
    s.roots.set(root.id, root.mode);
    if (root.create) s.newAccounts.add(root.id);
  }
  s.rooted = true;
}
export const CHILDREN = [
  { table: 'OAuthAttempt', pk: 'stateHash', owner: 'userId' },
  { table: 'XAccount', pk: 'userId', owner: 'userId' },
  { table: 'Session', pk: 'tokenHash', owner: 'userId' },
  { table: 'WalletIdentity', pk: 'address', owner: 'userId' },
  { table: 'Participant', pk: 'id', owner: 'accountId' },
  { table: 'WalletLink', pk: 'id', owner: 'accountId' },
] as const;
export type ChildTable = (typeof CHILDREN)[number]['table'];
export async function acquireIdentityChildren(
  tx: LockTransaction,
  mode: (table: ChildTable, accountId: string) => 'SHARE' | 'UPDATE',
  extra: Partial<Record<ChildTable, readonly string[]>> = {},
  tables: readonly ChildTable[] = CHILDREN.map((c) => c.table),
) {
  const s = state(tx);
  if (!s.rooted || s.sealed) throw new IdentityLockError('STORAGE_CONTRACT');
  for (const { table, pk, owner } of CHILDREN.filter((c) => tables.includes(c.table))) {
    const rows: { id: string; accountId: string }[] = [];
    for (const id of [...s.roots.keys()].sort(compare)) {
      rows.push(
        ...(await tx.query<{ id: string; accountId: string }>(
          `SELECT "${pk}"::text AS "id", "${owner}" AS "accountId" FROM "${table}" WHERE "${owner}" = $1`,
          [id],
        )),
      );
    }
    for (const id of extra[table] || [])
      if (!rows.some((row) => row.id === id)) rows.push({ id, accountId: '' });
    const held = new Map<string, 'SHARE' | 'UPDATE'>();
    for (const row of rows.sort((a, b) => compare(a.id, b.id))) {
      await tx.query(
        `SELECT "${pk}" FROM "${table}" WHERE "${pk}" = $1${table === 'Participant' || table === 'WalletLink' ? '::uuid' : ''} FOR ${mode(table, row.accountId)}`,
        [row.id],
      );
      held.set(row.id, mode(table, row.accountId));
    }
    s.children.set(table, held);
  }
}
declare const capability: unique symbol;
export type IdentityLockCapability = Readonly<{
  version: typeof LOCK_PROTOCOL_VERSION;
  [capability]: true;
}>;
const capabilities = new WeakMap<
  IdentityLockCapability,
  { tx: LockTransaction; state: State; transactionId: string }
>();
export async function sealIdentityLocks(tx: LockTransaction): Promise<IdentityLockCapability> {
  const s = state(tx);
  if (!s.rooted || s.sealed) throw new IdentityLockError('STORAGE_CONTRACT');
  const rows = await tx.query<{ id: string }>('SELECT txid_current()::text AS "id"', []);
  if (rows.length !== 1 || !/^\d+$/.test(rows[0].id))
    throw new IdentityLockError('STORAGE_CONTRACT');
  s.sealed = true;
  s.transactionId = rows[0].id;
  const value = Object.freeze({ version: LOCK_PROTOCOL_VERSION }) as IdentityLockCapability;
  capabilities.set(value, { tx, state: s, transactionId: rows[0].id });
  return value;
}
export async function requireIdentityLocks(
  tx: LockTransaction,
  value: IdentityLockCapability,
  required: {
    accounts?: readonly { id: string; mode: RootMode }[];
    subjects?: readonly string[];
    children?: readonly ChildTable[];
    childMode?: 'SHARE' | 'UPDATE';
    xIds?: readonly string[];
  } = {},
) {
  const c = capabilities.get(value);
  if (!c || c.tx !== tx || !c.state.sealed || states.get(tx) !== c.state)
    throw new IdentityLockError('STORAGE_CONTRACT');
  for (const { id, mode } of required.accounts || [])
    if (!c.state.roots.has(id) || strength[c.state.roots.get(id)!] < strength[mode])
      throw new IdentityLockError('STORAGE_CONTRACT');
  for (const address of required.subjects || [])
    if (!c.state.resources.has(`wallet-subject:${address}`))
      throw new IdentityLockError('STORAGE_CONTRACT');
  for (const xId of required.xIds || [])
    if (!c.state.resources.has(`x-auth:${xId}`)) throw new IdentityLockError('STORAGE_CONTRACT');
  for (const table of required.children || []) {
    const rows = c.state.children.get(table);
    if (
      !rows ||
      (required.childMode === 'UPDATE' && [...rows.values()].some((mode) => mode !== 'UPDATE'))
    )
      throw new IdentityLockError('STORAGE_CONTRACT');
  }
  // A reused port, foreign/ended transaction or stale opaque value must not authorize a write.
  try {
    const rows = await tx.query<{ id: string }>('SELECT txid_current()::text AS "id"', []);
    if (rows.length !== 1 || rows[0].id !== c.transactionId)
      throw new IdentityLockError('STORAGE_CONTRACT');
  } catch {
    throw new IdentityLockError('STORAGE_CONTRACT');
  }
}
export function lockCoverage(tx: LockTransaction, value: IdentityLockCapability) {
  const c = capabilities.get(value);
  if (!c || c.tx !== tx) throw new IdentityLockError('STORAGE_CONTRACT');
  return {
    accounts: new Map(c.state.roots),
    subjects: new Set(
      [...c.state.resources.keys()]
        .filter((x) => x.startsWith('wallet-subject:'))
        .map((x) => x.slice(15)),
    ),
    children: new Map([...c.state.children].map(([k, v]) => [k, new Set(v.keys())])),
    newAccounts: new Set(c.state.newAccounts),
  };
}
export function endIdentityLocks(tx: LockTransaction) {
  const s = states.get(tx);
  if (s) s.sealed = false;
  states.delete(tx);
}

/** Standalone reusable-module plan. Observations are hints, rechecked after final root acquisition. */
export async function prepareModuleIdentity(
  tx: LockTransaction,
  accountId: string,
  mode: RootMode,
  subjects: readonly string[] = [],
) {
  const observe = async () => ({
    users: await tx.query<{ id: string; xId: string | null }>(
      tx.identityLayout?.xKeyColumn === null
        ? 'SELECT "id", NULL::text AS "xId" FROM "User" WHERE "id" = $1'
        : 'SELECT "id", "xId" FROM "User" WHERE "id" = $1',
      [accountId],
    ),
    wallets: await tx.query<{ address: string }>(
      'SELECT "address" FROM "WalletIdentity" WHERE "userId" = $1',
      [accountId],
    ),
    links: await tx.query<{ address: string }>(
      'SELECT "address" FROM "WalletLink" WHERE "accountId" = $1',
      [accountId],
    ),
  });
  const observed = await observe();
  const fingerprint = (value: Awaited<ReturnType<typeof observe>>) =>
    JSON.stringify(
      Object.entries(value).map(([key, rows]) => [
        key,
        rows.map((row) => JSON.stringify(row)).sort(),
      ]),
    );
  await acquireAdvisories(tx, [
    ...[
      ...new Set([
        ...subjects,
        ...observed.wallets.map((row) => row.address),
        ...observed.links.map((row) => row.address),
      ]),
    ].map((id) => lockResource('wallet-subject', id)),
    ...observed.users.flatMap((row) => (row.xId ? [lockResource('x-auth', row.xId)] : [])),
  ]);
  await acquireAccountRoots(tx, [{ id: accountId, mode }]);
  if (fingerprint(await observe()) !== fingerprint(observed)) replanIdentity();
  await acquireIdentityChildren(
    tx,
    () => (mode === 'NO KEY UPDATE' || mode === 'UPDATE' ? 'UPDATE' : 'SHARE'),
    {},
    tx.identityLayout?.children,
  );
  return sealIdentityLocks(tx);
}
/** Nonblocking tracking rehome probe is an explicit exception; it never adds a wait edge. */
export async function tryAdvisory(tx: LockTransaction, resource: LockResource) {
  const s = state(tx);
  if (resource.kind !== 'tracking' || s.rooted || s.sealed)
    throw new IdentityLockError('STORAGE_CONTRACT');
  const key = await advisoryKey(tx, resource);
  if (
    FIXED_LOCK_KEYS.includes(key as (typeof FIXED_LOCK_KEYS)[number]) ||
    [...s.resources.values()].some(
      (r) => r.key === key && lockLabel(r.resource) !== lockLabel(resource),
    )
  )
    throw new IdentityLockError('STORAGE_CONTRACT');
  const [row] = await tx.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_xact_lock($1::bigint) AS "locked"',
    [key],
  );
  if (typeof row?.locked !== 'boolean') throw new IdentityLockError('STORAGE_CONTRACT');
  if (row.locked) s.resources.set(lockLabel(resource), { resource, key });
  return row.locked;
}
