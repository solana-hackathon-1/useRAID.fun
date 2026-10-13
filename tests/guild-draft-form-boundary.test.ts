import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { GuildDraftFormStateSchema } from '../src/guild-profiles/http-contracts';
it('documents the reusable owner form, temporary-denial retry identity and independent React consumer', async () => {
  const doc = await readFile('docs/raid-guild-draft-form.md', 'utf8');
  for (const text of [
    'R15',
    'R16',
    'GuildDraftTransport',
    'NOT VERIFIED',
    'unknown',
    '429',
    'revision',
    'same key',
    'Keep this page open',
    'React',
  ])
    expect(doc).toContain(text);
  const example = await readFile('examples/guild-drafts/form-example.tsx', 'utf8');
  expect(example).toContain('GuildDraftForm');
  expect(example).toContain('renderToStaticMarkup');
  expect(example).not.toMatch(/from ['"].*lib\//);
});
it('keeps form state private and unverified with explicit current write availability', () => {
  const state = {
    version: 'v1',
    draft: null,
    writesAvailable: false,
    unavailableReason: 'DISABLED',
  };
  expect(GuildDraftFormStateSchema.safeParse(state).success).toBe(true);
  expect(
    GuildDraftFormStateSchema.safeParse({ ...state, founderControlVerified: true }).success,
  ).toBe(false);
  expect(GuildDraftFormStateSchema.safeParse({ ...state, writesAvailable: true }).success).toBe(
    false,
  );
});
