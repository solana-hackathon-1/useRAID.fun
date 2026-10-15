import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import type { CommandReceiptTransaction } from '../src/command-receipts';
import { publishSkillTaxonomy, type SkillTaxonomyActor } from '../src/skills/taxonomy-storage';
import {
  PublishPracticeTrialInputSchema,
  PracticeTrialDraftSchema,
  publishPracticeTrialDefinition,
} from '../src/skills/practice-trial-storage';
import { definition as fixture } from '../examples/skill-assessments/fixtures';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
function input() {
  const draft = structuredClone(fixture);
  for (const field of ['reference', 'state', 'publishedAt']) Reflect.deleteProperty(draft, field);
  return {
    trialId: 'synthetic-unicode-trial',
    expectedRevision: 0,
    taxonomyReference: { recordId: 'synthetic-unicode-catalog', revision: 1 },
    availability: 'AVAILABLE',
    draft: {
      ...draft,
      rubric: { ...draft.rubric, reference: { recordId: 'synthetic-unicode-rubric', revision: 1 } },
    },
  };
}
type Input = ReturnType<typeof input>;
const fields: { name: string; maximum: number; set: (value: Input, text: string) => void }[] = [
  {
    name: 'title',
    maximum: 200,
    set: (v, s) => {
      v.draft.title = s;
    },
  },
  {
    name: 'brief',
    maximum: 4000,
    set: (v, s) => {
      v.draft.brief = s;
    },
  },
  {
    name: 'input label',
    maximum: 200,
    set: (v, s) => {
      v.draft.inputs[0].label = s;
    },
  },
  {
    name: 'input content',
    maximum: 4000,
    set: (v, s) => {
      v.draft.inputs[0].content = s;
    },
  },
  {
    name: 'permitted tool',
    maximum: 200,
    set: (v, s) => {
      v.draft.tools.permitted = [s];
    },
  },
  {
    name: 'tool disclosure',
    maximum: 4000,
    set: (v, s) => {
      v.draft.tools.disclosure = s;
    },
  },
  {
    name: 'rubric criterion',
    maximum: 4000,
    set: (v, s) => {
      v.draft.rubric.criteria[0].description = s;
    },
  },
  {
    name: 'pass conditions',
    maximum: 4000,
    set: (v, s) => {
      v.draft.passConditions = s;
    },
  },
  {
    name: 'accommodation policy',
    maximum: 4000,
    set: (v, s) => {
      v.draft.accommodationPolicy = s;
    },
  },
];
it.each(fields)(
  'enforces normalized stored UTF16 bounds for $name while preserving pure contracts',
  ({ maximum, set }) => {
    const valid = input();
    set(valid, '😀'.repeat(maximum / 2));
    expect(PublishPracticeTrialInputSchema.safeParse(valid).success).toBe(true);
    const overflow = input();
    set(overflow, '😀'.repeat(maximum / 2 + 1));
    expect(PracticeTrialDraftSchema.safeParse(overflow.draft).success).toBe(true);
    expect(PublishPracticeTrialInputSchema.safeParse(overflow).success).toBe(false);
  },
);
it('normalizes whitespace before checking the stored text bound', () => {
  const value = input(),
    title = '😀'.repeat(100);
  value.draft.title = ' ' + title + ' ';
  const parsed = PublishPracticeTrialInputSchema.parse(value);
  expect(parsed.draft.title).toBe(title);
});
it('rejects out-of-bound stored text before receipt or SQL queries', async () => {
  let calls = 0;
  const tx: CommandReceiptTransaction = {
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    async query() {
      calls++;
      return [];
    },
  };
  for (const field of fields) {
    const value = input();
    field.set(value, '😀'.repeat(field.maximum / 2 + 1));
    await expect(
      publishPracticeTrialDefinition(
        tx,
        {
          actor: { accountId: 'publisher', sessionHash: 'a'.repeat(64) },
          input: value,
          idempotencyKey: 'k',
          requestId: 'r',
        },
        { allowNewWrites: true, canPublish: () => true },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }
  expect(calls).toBe(0);
});
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
integration('T013C1 stored Unicode error parity on actual PostgreSQL', () => {
  let publisher: SkillTaxonomyActor, xId: string;
  const options = (enabled = true) => ({
    allowNewWrites: enabled,
    canPublish: (value: { xId: string }) => value.xId === xId,
  });
  const save = (value: unknown = input(), key = randomUUID(), enabled = true) =>
    runCommandTransaction(db, (tx) =>
      publishPracticeTrialDefinition(
        tx,
        { actor: publisher, input: value, idempotencyKey: key, requestId: 'synthetic-unicode' },
        options(enabled),
      ),
    );
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    await truncateAll(db);
    xId = 'synthetic-' + randomUUID();
    const user = await db.user.create({ data: { handle: 'synthetic', role: 'ADMIN', xId } });
    publisher = { accountId: user.id, sessionHash: hash(randomUUID()) };
    await db.session.create({
      data: {
        tokenHash: publisher.sessionHash,
        userId: user.id,
        via: 'x',
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    await runCommandTransaction(db, (tx) =>
      publishSkillTaxonomy(
        tx,
        {
          actor: publisher,
          input: {
            taxonomyId: 'synthetic-unicode-catalog',
            expectedRevision: 0,
            skills: [
              {
                id: 'frontend',
                domain: 'web',
                name: 'Frontend',
                status: 'ACTIVE',
                aliases: ['frontend'],
              },
            ],
          },
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-catalog',
        },
        options(),
      ),
    );
  });
  afterAll(() => db.$disconnect());
  it('returns INVALID_INPUT for supplementary stored overflow without querying or leaving receipt/version/rubric/audit effects', async () => {
    const value = input();
    value.draft.title = '😀'.repeat(101);
    let calls = 0;
    await expect(
      runCommandTransaction(db, (port) =>
        publishPracticeTrialDefinition(
          {
            ...port,
            async query<Row>(sql: string, bindings: readonly (string | null)[]) {
              calls++;
              return port.query<Row>(sql, bindings);
            },
          },
          {
            actor: publisher,
            input: value,
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-overflow',
          },
          options(),
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls).toBe(0);
    const rows = await db.$queryRawUnsafe(
      `SELECT (SELECT count(*)::int FROM "PracticeTrialVersion") versions,(SELECT count(*)::int FROM "SkillRubricVersion") rubrics,(SELECT count(*)::int FROM "CommandReceipt") receipts,(SELECT count(*)::int FROM "AuditEvent") audits,(SELECT count(*)::int FROM "OutboxEvent") outbox`,
    );
    expect(rows).toEqual([{ versions: 0, rubrics: 0, receipts: 1, audits: 1, outbox: 0 }]);
  });
  it('preserves exact-bound normalized Unicode and original authorized receipt with writes disabled', async () => {
    const value = input(),
      key = randomUUID(),
      title = '😀'.repeat(100);
    value.draft.title = ' ' + title + ' ';
    const saved = await save(value, key);
    expect(saved.trial.definition.title).toBe(title);
    value.draft.title = title;
    const replay = await save(value, key, false);
    expect(replay).toEqual({ status: 'REPLAYED', trial: saved.trial });
  });
});
