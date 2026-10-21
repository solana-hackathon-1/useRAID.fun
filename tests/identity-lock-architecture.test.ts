import { expect, it } from 'vitest';
import { globSync } from 'node:fs';
import path from 'node:path';
import { identityArchitecture } from '../scripts/identity-architecture';
it('every identity writer enters the shared protocol boundary', () => {
  const root = process.cwd();
  const files = globSync('src/**/*.ts').map((file) => path.join(root, file));
  expect(identityArchitecture(root, files)).toEqual([]);
});

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
  } finally {
    await unlink(file).catch(() => undefined);
  }
  expect(readFileSync(path.join(root, 'planning/identity-writer-fence.json'), 'utf8')).toContain(
    'trustedAdvisoryFunctions',
  );
}, 30000);
