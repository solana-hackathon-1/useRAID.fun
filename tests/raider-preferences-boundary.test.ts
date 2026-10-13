import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
it('declares the protected storage host, owned migration and independent consuming example', async () => {
  const doc = await readFile('docs/raid-raider-preferences.md', 'utf8');
  for (const term of [
    'READ COMMITTED',
    'SaveRaiderOrientation',
    'OrientationActor',
    'RaiderPreferenceVersion',
    'R15',
    'R16',
    'NOT VERIFIED',
    'orientationVersionId',
    'clock_timestamp',
    'expectedRevision',
  ])
    expect(doc).toContain(term);
  const consumer = await readFile('examples/raider-preferences/host.ts', 'utf8');
  expect(consumer).toContain('saveRaiderOrientation');
  expect(consumer).toContain('readRaiderOrientation');
  expect(consumer).not.toMatch(/from ['"].*lib\//);
});
