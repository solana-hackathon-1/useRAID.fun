import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
it('keeps the control-proof module independent of app authority, storage, sign-in and provider SDKs', async () => {
  const domain = await Promise.all(
    ['control-attestation.ts', 'control-attestation-contracts.ts'].map((file) =>
      readFile('src/guild-profiles/' + file, 'utf8'),
    ),
  );
  const adapter = await readFile('src/guild-profiles/ed25519-control-verifier.ts', 'utf8');
  const allowed = new Set([
    'zod',
    'bs58',
    '../contracts/assets',
    '../contracts/ids',
    './control-attestation-contracts',
  ]);
  for (const source of domain) {
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    for (const name of imports) expect(allowed.has(name), name).toBe(true);
    expect(source).not.toMatch(
      /process\.env|\bfetch\s*\(|\brequire\s*\(|\bimport\s*\(|\bconsole\./,
    );
  }
  expect(adapter).not.toMatch(/lib\/|@solana|prisma|next\/|process\.env|\bfetch\s*\(|\bconsole\./);
});
