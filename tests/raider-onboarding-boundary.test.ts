import { cp, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('orientation preparation has no application singleton, identity mutation or privileged SDK', async () => {
  for (const name of await readdir('src/raider-onboarding')) {
    const source = await readFile(join('src/raider-onboarding', name), 'utf8');
    expect(source).not.toMatch(
      /process\.env|globalThis|@prisma|next\/|from ['"].*lib\/|fetch\(|Date\.now/,
    );
  }
});
it('independent copied orientation host consumes declared interfaces and substitution failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'raid-onboarding-consumer-'));
  try {
    await cp('examples/raider-onboarding', directory, { recursive: true, dereference: true });
    await symlink(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
    const output = execFileSync(
      process.execPath,
      [join(directory, 'node_modules/tsx/dist/cli.mjs'), 'host.ts'],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 20000,
        env: { PATH: process.env.PATH, NODE_ENV: 'test' },
      },
    );
    expect(JSON.parse(output)).toEqual({
      synthetic: true,
      beginner: 'STARTER_TASKS',
      experienced: 'TRIAL',
      unavailableIsExplicit: true,
      noPersistedCompletion: true,
      noRankSlotOrPayment: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
it('same-change documentation declares the preparation-only host and protected-storage boundary', async () => {
  const doc = await readFile('docs/raid-raider-onboarding.md', 'utf8');
  for (const text of [
    'Purpose and non-goals',
    'Public API',
    'Host dependencies',
    'Permissions and privacy',
    'Consuming example',
    'Failure and recovery',
    'Migration and next phase',
    'R15',
    'R16',
    'PREPARED',
    'NOT VERIFIED',
  ])
    expect(doc).toContain(text);
});
