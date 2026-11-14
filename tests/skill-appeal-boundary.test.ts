import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('documents the module, its host dependencies, provisional windows and unbuilt boundaries', async () => {
  const doc = await readFile('docs/raid-skill-assessment-appeals.md', 'utf8');
  for (const term of [
    'R15',
    'R16',
    'DEC-2026-11-14-11',
    'SKILL_ASSESSMENT_APPEALS_ENABLED',
    'SKILL_APPEAL_REVIEWER_ACCOUNT_IDS',
    'SKILL_APPEAL_FILING_WINDOW_DAYS',
    'SKILL_APPEAL_ADJUDICATION_DAYS',
    'Provisional',
    'NOT VERIFIED',
    'Reopening the assessment',
    'Adjudicator case view',
    'grants a rank automatically',
  ])
    expect(doc).toContain(term);
  expect(await readFile('docs/raid-module-reuse.md', 'utf8')).toContain(
    'raid-skill-assessment-appeals.md',
  );
  const env = await readFile('.env.example', 'utf8');
  for (const name of [
    'SKILL_ASSESSMENT_APPEALS_ENABLED=false',
    'SKILL_APPEAL_REVIEWER_ACCOUNT_IDS=',
    'SKILL_APPEAL_FILING_WINDOW_DAYS=14',
    'SKILL_APPEAL_ADJUDICATION_DAYS=14',
  ])
    expect(env).toContain(name);
});
it('provides an independent consumer of the pure rules with no application dependency', async () => {
  const example = await readFile('examples/skill-assessment-appeals/host.ts', 'utf8');
  expect(example).toContain('evaluateAppealAdjudicator');
  expect(example).toContain('appealFilingWindowOpen');
  expect(example).not.toMatch(/process\.env|from ['"].*(lib|storage)\//);
});
it('never writes the assessment tables, a rank, a grant or money', async () => {
  const storage = await readFile('src/skill-appeals/storage.ts', 'utf8');
  for (const forbidden of [
    /UPDATE\s+"SkillAssessment/i,
    /INSERT\s+INTO\s+"SkillAssessment"/i,
    /INSERT\s+INTO\s+"SkillAssessmentVersion"/i,
    /DELETE\s+FROM/i,
    /GuildRoleGrant"\s*\(/,
    /Ledger|Balance|Payout|Escrow/,
  ])
    expect(storage).not.toMatch(forbidden);
  expect(storage).toContain('INSERT INTO "SkillAssessmentAppeal"');
  expect(storage).toContain('INSERT INTO "SkillAssessmentAppealDecision"');
});
it('keeps the module free of host imports so a replacement host can consume it', async () => {
  for (const file of ['contracts', 'policy', 'storage', 'http']) {
    const source = await readFile(`src/skill-appeals/${file}.ts`, 'utf8');
    expect(source).not.toMatch(/from ['"][^'"]*\/lib\//);
    expect(source).not.toMatch(/from ['"]next/);
    expect(source).not.toMatch(/process\.env/);
  }
});
it('reads the filing window and the filing instant from one clock value', async () => {
  const storage = await readFile('src/skill-appeals/storage.ts', 'utf8');
  const select = storage.match(/`WITH "c" AS[^`]*"withinWindow"[^`]*`/)?.[0] ?? '';
  expect(select).not.toBe('');
  expect(select.match(/clock_timestamp\(\)/g)).toHaveLength(1);
});
