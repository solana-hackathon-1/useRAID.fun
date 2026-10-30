import { expect, it } from 'vitest';
import { globSync } from 'node:fs';
import path from 'node:path';
import { identityArchitecture } from '../scripts/identity-architecture';
it('every identity writer enters the shared protocol boundary', () => {
  const root = process.cwd();
  const files = globSync('src/**/*.ts').map((file) => path.join(root, file));
  expect(identityArchitecture(root, files)).toEqual([]);
}, 30000);

it('rejects direct, aliased, destructured, nested, raw, and type-erased bypasses', async () => {
  const { writeFile, unlink } = await import('node:fs/promises');
  const root = process.cwd(),
    file = path.join(root, 'src/identity-fence-negative-probe.ts');
  await writeFile(
    file,
    `import type { Prisma } from '@prisma/client';
    const tx = {} as Prisma.TransactionClient;
    tx.user.create({ data: { handle: 'unconverted' } });
    const { user: people } = tx; people.create({ data: { handle: 'alias' } });
    const { create: insert } = tx.user; insert({ data: { handle: 'method alias' } });
    tx.raid.create({ data: { creator: { create: { handle: 'nested' } } } });
    tx.$executeRawUnsafe('DELETE FROM "User"');
    (tx.user as unknown as { create: (...args: unknown[]) => unknown }).create({ data: {} });
  `,
  );
  try {
    const errors = identityArchitecture(root, [file]);
    for (const line of [3, 4, 5, 6, 7, 8])
      expect(
        errors.some((error) => error.startsWith(`src/identity-fence-negative-probe.ts:${line}:`)),
        `bypass at line ${line}`,
      ).toBe(true);
  } finally {
    await unlink(file);
  }
}, 15000);

it('allows only reviewed, hash-pinned domain-seed advisory locks outside the shared builder', async () => {
  const { writeFile, unlink } = await import('node:fs/promises');
  const { readFileSync } = await import('node:fs');
  const { default: ts } = await import('typescript');
  const { astHash } = await import('../scripts/identity-architecture');
  const root = process.cwd(),
    rel = 'src/identity-fence-advisory-probe.ts',
    file = path.join(root, rel);
  const body = (
    seed: string,
  ) => `export async function domainLock(tx: { q(sql: string): Promise<void> }) {
  await tx.q('SELECT pg_advisory_xact_lock(hashtextextended($1, ${seed}))');
}
`;
  const hashOf = (text: string) => {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const fn = source.statements.find(ts.isFunctionDeclaration)!;
    return astHash(fn, source);
  };
  const advisory = (errors: string[]) => errors.filter((e) => e.includes('advisory'));
  try {
    await writeFile(file, body('12012'));
    expect(advisory(identityArchitecture(root, [file])), 'unregistered').not.toEqual([]);
    const registry = (text: string) => ({
      trustedAdvisoryFunctions: { [`${rel}#domainLock`]: hashOf(text) },
    });
    expect(
      advisory(identityArchitecture(root, [file], registry(body('12012')))),
      'registered, hash matches',
    ).toEqual([]);
    expect(
      advisory(identityArchitecture(root, [file], registry(body('12013')))),
      'registered, function changed after review',
    ).not.toEqual([]);
    for (const seed of ['0', '729103', '12011', '12100']) {
      await writeFile(file, body(seed));
      expect(
        advisory(identityArchitecture(root, [file], registry(body(seed)))),
        `registered but seed ${seed} is outside the domain range`,
      ).not.toEqual([]);
    }
    // The funding-reference key is fixed by the database triggers (seed 0): only that exact prefixed shape is reviewed.
    const funding = (
      key: string,
    ) => `export async function domainLock(tx: { q(sql: string): Promise<void> }) {
  await tx.q("SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))");
}
`;
    const reference = `'raid:funding-reference:'||$1`;
    await writeFile(file, funding(reference));
    expect(
      advisory(identityArchitecture(root, [file])),
      'funding-reference key, unregistered',
    ).not.toEqual([]);
    expect(
      advisory(identityArchitecture(root, [file], registry(funding(reference)))),
      'funding-reference key, registered',
    ).toEqual([]);
    for (const key of [`'raid:other:'||$1`, `'raid:funding-reference'||$1`, '$1']) {
      await writeFile(file, funding(key));
      expect(
        advisory(identityArchitecture(root, [file], registry(funding(key)))),
        `registered but ${key} is not the trigger's funding-reference key`,
      ).not.toEqual([]);
    }
  } finally {
    await unlink(file).catch(() => undefined);
  }
  expect(readFileSync(path.join(root, 'planning/identity-writer-fence.json'), 'utf8')).toContain(
    'trustedAdvisoryFunctions',
  );
}, 30000);

it('rejects near-miss, extra-lock and commented advisory shapes even when the function is registered', async () => {
  const { writeFile, unlink } = await import('node:fs/promises');
  const { default: ts } = await import('typescript');
  const { astHash } = await import('../scripts/identity-architecture');
  const root = process.cwd(),
    rel = 'src/identity-fence-advisory-near-miss-probe.ts',
    file = path.join(root, rel);
  const body = (
    call: string,
  ) => `export async function domainLock(tx: { q(sql: string, args?: string[]): Promise<void> }) {
  ${call}
}
`;
  const reviewed = `"SELECT pg_advisory_xact_lock(hashtextextended('raid:funding-reference:'||$1,0))"`;
  const domain = `'SELECT pg_advisory_xact_lock(hashtextextended($1,12012))'`;
  const advisory = (errors: string[]) => errors.filter((e) => e.includes('advisory'));
  const registered = (text: string) => {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const fn = source.statements.find(ts.isFunctionDeclaration)!;
    return { trustedAdvisoryFunctions: { [`${rel}#domainLock`]: astHash(fn, source) } };
  };
  const accepted = [
    ['funding-reference key', `await tx.q(${reviewed}, [ref]);`],
    ['domain seed', `await tx.q(${domain}, [id]);`],
  ];
  const rejected = [
    [
      'funding seed other than 0',
      `await tx.q("SELECT pg_advisory_xact_lock(hashtextextended('raid:funding-reference:'||$1,1))", [ref]);`,
    ],
    [
      'funding key from $2',
      `await tx.q("SELECT pg_advisory_xact_lock(hashtextextended('raid:funding-reference:'||$2,0))", [ref]);`,
    ],
    [
      'funding swapped operands',
      `await tx.q("SELECT pg_advisory_xact_lock(hashtextextended($1||'raid:funding-reference:',0))", [ref]);`,
    ],
    [
      'funding try variant',
      `await tx.q("SELECT pg_try_advisory_xact_lock(hashtextextended('raid:funding-reference:'||$1,0))", [ref]);`,
    ],
    [
      'domain try variant',
      `await tx.q('SELECT pg_try_advisory_xact_lock(hashtextextended($1,12012))', [id]);`,
    ],
    [
      'domain seed swapped',
      `await tx.q('SELECT pg_advisory_xact_lock(hashtextextended(12012,$1))', [id]);`,
    ],
    [
      'funding plus an identity-range lock in one string',
      `await tx.q("SELECT pg_advisory_xact_lock(hashtextextended('raid:funding-reference:'||$1,0)), pg_advisory_xact_lock(hashtextextended($1,729103))", [ref]);`,
    ],
    [
      'domain plus a second lock in one string',
      `await tx.q('SELECT pg_advisory_xact_lock(hashtextextended($1,12012)), pg_advisory_xact_lock($2)', [id]);`,
    ],
    [
      'funding shape in a comment beside another lock',
      `await tx.q('SELECT pg_advisory_xact_lock($1)' /* pg_advisory_xact_lock(hashtextextended('raid:funding-reference:'||$1,0)) */, [ref]);`,
    ],
    [
      'domain shape in a comment beside another lock',
      `await tx.q('SELECT pg_advisory_xact_lock($1)' /* pg_advisory_xact_lock(hashtextextended($1,12012)) */, [id]);`,
    ],
  ];
  try {
    for (const [name, call] of accepted) {
      await writeFile(file, body(call));
      expect(advisory(identityArchitecture(root, [file], registered(body(call)))), name).toEqual(
        [],
      );
    }
    for (const [name, call] of rejected) {
      await writeFile(file, body(call));
      expect(
        advisory(identityArchitecture(root, [file], registered(body(call)))),
        `registered but rejected: ${name}`,
      ).not.toEqual([]);
    }
  } finally {
    await unlink(file).catch(() => undefined);
  }
}, 30000);
