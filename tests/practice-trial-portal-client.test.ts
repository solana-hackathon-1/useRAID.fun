import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { definition as fixture } from '../examples/skill-assessments/fixtures';
import type { PracticeTrialDefinition } from '../src/skills/practice-trial-contracts';
import {
  PracticePortalStartResultSchema,
  PracticePortalSubmitResultSchema,
  PracticePortalProgressSchema,
  buildSubmitInput,
  createPracticePortalTransport,
  describePracticeFailure,
  parseToolLines,
} from '../src/skills/practice-portal-client';
import { PracticePortalProgressSchema as ServerProgressSchema } from '../src/skills/practice-portal-http';
import { PracticePortalCatalogSchema } from '../src/skills/practice-portal-contracts';

const definition = fixture as unknown as PracticeTrialDefinition;
const startId = '44444444-4444-4444-8444-444444444444',
  participantId = '55555555-5555-4555-8555-555555555555';
const start = {
  version: 'v1',
  id: startId,
  state: 'STARTED',
  participantId,
  definition,
  taxonomyReference: { recordId: 'catalog', revision: 1 },
  accommodationReference: null,
  attemptNumber: 1,
  startedAt: '2026-10-15T23:00:00.000Z',
  persisted: true,
  verifiesSkill: false,
  isAuthorizationToken: false,
  createsPermissionGrant: false,
  consumesCapacity: false,
  createsFinancialObligation: false,
};
const submission = {
  version: 'v1',
  reference: { recordId: '66666666-6666-4666-8666-666666666666', revision: 1 },
  startId,
  participantId,
  skillId: definition.skillId,
  skillDomain: definition.skillDomain,
  definitionReference: definition.reference,
  rubricReference: definition.rubric.reference,
  state: 'SUBMITTED',
  submittedAt: '2026-10-15T23:01:00.000Z',
  answer: ' exact\r\nanswer ',
  explanation: 'why',
  toolsUsed: ['editor'],
  aiAssistanceUsed: false,
  assistanceDisclosure: 'No assistance.',
  ownership: 'UNCONFIRMED',
  persisted: true,
  verifiesSkill: false,
  isAuthorizationToken: false,
  createsPermissionGrant: false,
  consumesCapacity: false,
  createsFinancialObligation: false,
};
const config = {
  version: 'v1',
  status: 'EXECUTED',
  writesAvailable: true,
  unavailableReason: null,
};

describe('client contracts mirror the server boundary', () => {
  it('accepts exactly what the server schemas accept', () => {
    const progress = { version: 'v1', progress: 'SUBMITTED', start, submission };
    expect(ServerProgressSchema.safeParse(progress).success).toBe(true);
    expect(PracticePortalProgressSchema.safeParse(progress).success).toBe(true);
    expect(
      PracticePortalProgressSchema.safeParse({ ...progress, progress: 'STARTED', submission: null })
        .success,
    ).toBe(true);
    expect(PracticePortalStartResultSchema.safeParse({ ...config, start }).success).toBe(true);
    expect(PracticePortalSubmitResultSchema.safeParse({ ...config, submission }).success).toBe(
      true,
    );
    expect(
      PracticePortalCatalogSchema.safeParse({
        version: 'v1',
        taxonomyId: 'catalog',
        trials: [],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });
  it('fails closed on rank, grant, capacity, money or identity claims and unknown fields', () => {
    for (const patch of [
      { verifiesSkill: true },
      { createsPermissionGrant: true },
      { consumesCapacity: true },
      { createsFinancialObligation: true },
      { isAuthorizationToken: true },
      { extra: 1 },
    ])
      expect(
        PracticePortalStartResultSchema.safeParse({ ...config, start: { ...start, ...patch } })
          .success,
      ).toBe(false);
    expect(
      PracticePortalProgressSchema.safeParse({
        version: 'v1',
        progress: 'SUBMITTED',
        start,
        submission: null,
      }).success,
    ).toBe(false);
    expect(
      PracticePortalSubmitResultSchema.safeParse({
        ...config,
        writesAvailable: false,
        submission,
      }).success,
    ).toBe(false);
  });
  it('imports only portable modules (no Node crypto, no app alias, no environment)', async () => {
    const source = await readFile('src/skills/practice-portal-client.ts', 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g))
      expect(
        [
          'zod',
          '../contracts/ids',
          './contracts',
          './practice-trial-contracts',
          './practice-portal-contracts',
        ].includes(match[1]!),
        match[1],
      ).toBe(true);
    expect(source).not.toMatch(/process\.env|@\/|node:|localStorage|sessionStorage|console\./);
  });
});

describe('submission input builder', () => {
  const base = {
    startId,
    definition,
    answer: ' \n<b>exact</b>\r\n',
    explanation: 'Because.',
    toolsText: 'editor\n  linter \n\neditor',
    aiAssistanceUsed: false,
    assistanceDisclosure: 'None used.',
  };
  it('parses tool lines (trim, drop blanks, keep first duplicate)', () => {
    expect(parseToolLines('a\n b \n\na\r\nc')).toEqual(['a', 'b', 'c']);
  });
  it('binds the exact original definition and rubric and preserves answer bytes', () => {
    const out = buildSubmitInput(base);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toEqual({
      version: 'v1',
      startId,
      expectedDefinitionReference: definition.reference,
      expectedRubricReference: definition.rubric.reference,
      answer: base.answer,
      explanation: 'Because.',
      toolsUsed: ['editor', 'linter'],
      aiAssistanceUsed: false,
      assistanceDisclosure: 'None used.',
    });
  });
  it('rejects blank, oversized and unsupported-character fields before any request', () => {
    for (const patch of [
      { answer: '   ' },
      { answer: 'x'.repeat(40001) },
      { explanation: '' },
      { explanation: 'x'.repeat(4001) },
      { assistanceDisclosure: ' ' },
      { answer: 'bad\u0000nul' },
      { toolsText: Array.from({ length: 51 }, (_, i) => 't' + i).join('\n') },
    ])
      expect(buildSubmitInput({ ...base, ...patch }).ok).toBe(false);
  });
  it('refuses AI assistance when the original definition prohibits it', () => {
    const prohibited = {
      ...definition,
      tools: { ...definition.tools, aiAssistance: 'PROHIBITED' as const },
    };
    expect(buildSubmitInput({ ...base, definition: prohibited, aiAssistanceUsed: true }).ok).toBe(
      false,
    );
  });
});

describe('failure descriptions', () => {
  it('maps canonical codes to safe actionable text and never echoes server detail', () => {
    expect(describePracticeFailure(401, 'AUTHENTICATION_REQUIRED')).toMatch(/sign in/i);
    expect(describePracticeFailure(409, 'PRACTICE_ATTEMPT_LIMIT_REACHED')).toMatch(
      /attempt limit/i,
    );
    expect(describePracticeFailure(409, 'PRACTICE_COOLDOWN_ACTIVE')).toMatch(/waiting period/i);
    expect(describePracticeFailure(409, 'PRACTICE_ALREADY_SUBMITTED')).toMatch(/already/i);
    expect(describePracticeFailure(409, 'REVISION_CHANGED')).toMatch(/changed/i);
    expect(describePracticeFailure(409, 'IDEMPOTENCY_KEY_REUSED')).toMatch(/refresh/i);
    expect(describePracticeFailure(429, 'RATE_LIMITED')).toMatch(/wait/i);
    expect(describePracticeFailure(503, 'SERVICE_UNAVAILABLE')).toMatch(/unavailable/i);
    expect(describePracticeFailure(500, 'SQL select * from User')).toBe(
      describePracticeFailure(500, 'SERVICE_UNAVAILABLE'),
    );
  });
});

describe('default fetch transport', () => {
  function transportWith(response: Response) {
    const fetchImpl = vi.fn(async () => response);
    return { fetchImpl, transport: createPracticePortalTransport(fetchImpl as typeof fetch) };
  }
  it('lists with a validated cursor and private no-store GET', async () => {
    const { fetchImpl, transport } = transportWith(Response.json({}));
    await transport.list('after-id');
    await transport.list(null);
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe('/api/v1/practice?after=after-id');
    expect(calls[1]![0]).toBe('/api/v1/practice');
    expect(calls[0]![1]).toMatchObject({
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    expect(() => transport.list('bad/../cursor')).toThrow();
  });
  it('starts against the exact definition with no accommodation and a caller idempotency key', async () => {
    const { fetchImpl, transport } = transportWith(Response.json({}));
    await transport.start(definition.reference, 'key-1');
    const [url, init] = (fetchImpl.mock.calls as unknown as [string, RequestInit][])[0]!;
    expect(url).toBe('/api/v1/practice/starts');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('key-1');
    expect(JSON.parse(init.body as string)).toEqual({
      version: 'v1',
      definitionReference: definition.reference,
      accommodationReference: null,
    });
  });
  it('reads progress and submits to the start-bound routes only', async () => {
    const { fetchImpl, transport } = transportWith(Response.json({}));
    await transport.read(startId);
    await transport.submit(startId, { any: 'body' } as never, 'key-2');
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe('/api/v1/practice/starts/' + startId);
    expect(calls[1]![0]).toBe('/api/v1/practice/starts/' + startId + '/submission');
    expect((calls[1]![1].headers as Record<string, string>)['Idempotency-Key']).toBe('key-2');
    expect(() => transport.read('../x')).toThrow();
  });
});
