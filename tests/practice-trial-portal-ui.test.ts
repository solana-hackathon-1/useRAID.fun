import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { definition as fixture } from '../examples/skill-assessments/fixtures';
import type { PracticeTrialDefinition } from '../src/skills/practice-trial-contracts';
import type {
  PracticePortalCatalog,
  PracticePortalProgress,
} from '../src/skills/practice-portal-client';
import {
  PracticeTrialCatalog,
  PracticeTrialWorkspace,
} from '../src/components/practice-trial-portal';

const definition = fixture as unknown as PracticeTrialDefinition;
const startId = '44444444-4444-4444-8444-444444444444',
  participantId = '55555555-5555-4555-8555-555555555555';
const trial = (patch: Record<string, unknown> = {}) => ({
  version: 'v1' as const,
  definition: { ...definition, ...patch },
  availability: 'AVAILABLE' as const,
  taxonomyReference: { recordId: 'catalog', revision: 1 },
  persisted: true as const,
  verifiesSkill: false as const,
  createsPermissionGrant: false as const,
  consumesCapacity: false as const,
  createsFinancialObligation: false as const,
});
const catalog = (trials: unknown[] = [trial()], nextCursor: string | null = null) =>
  ({
    version: 'v1',
    taxonomyId: 'catalog',
    trials,
    nextCursor,
  }) as unknown as PracticePortalCatalog;
const progress = (value: unknown) => value as PracticePortalProgress;
const start = {
  version: 'v1' as const,
  id: startId,
  state: 'STARTED' as const,
  participantId,
  definition,
  taxonomyReference: { recordId: 'catalog', revision: 1 },
  accommodationReference: null,
  attemptNumber: 2,
  startedAt: '2026-10-15T23:00:00.000Z',
  persisted: true as const,
  verifiesSkill: false as const,
  isAuthorizationToken: false as const,
  createsPermissionGrant: false as const,
  consumesCapacity: false as const,
  createsFinancialObligation: false as const,
};
const submission = {
  version: 'v1' as const,
  reference: { recordId: '66666666-6666-4666-8666-666666666666', revision: 1 as const },
  startId,
  participantId,
  skillId: definition.skillId,
  skillDomain: definition.skillDomain,
  definitionReference: definition.reference,
  rubricReference: definition.rubric.reference,
  state: 'SUBMITTED' as const,
  submittedAt: '2026-10-15T23:01:00.000Z',
  answer: '<script>alert(1)</script>\nsecond line',
  explanation: 'My <b>reasoning</b>',
  toolsUsed: ['editor'],
  aiAssistanceUsed: true,
  assistanceDisclosure: 'Used an assistant for syntax.',
  ownership: 'UNCONFIRMED' as const,
  persisted: true as const,
  verifiesSkill: false as const,
  isAuthorizationToken: false as const,
  createsPermissionGrant: false as const,
  consumesCapacity: false as const,
  createsFinancialObligation: false as const,
};
const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element);

describe('PracticeTrialCatalog', () => {
  it('shows the saved terms exactly and states what practice does not do', () => {
    const html = render(
      createElement(PracticeTrialCatalog, {
        initial: catalog(),
        readsAvailable: true,
        writesAvailable: true,
      }),
    );
    for (const value of [
      definition.title,
      definition.brief,
      definition.passConditions,
      definition.accommodationPolicy,
      definition.tools.disclosure,
      definition.rubric.criteria[0]!.description,
      'not a deadline',
      'does not verify a skill',
    ])
      expect(html).toContain(String(value).replace(/&/g, '&amp;'));
    for (const input of definition.inputs) expect(html).toContain(input.label);
    expect(html).toMatch(/Start (this )?practice/);
    expect(html).toContain('Loading practice controls');
    expect(html).toContain('disabled=""');
    expect(html).not.toMatch(/verified rank|you passed|earn|reward|payout/i);
  });
  it('escapes hostile saved text and never renders it as markup', () => {
    const html = render(
      createElement(PracticeTrialCatalog, {
        initial: catalog([trial({ title: '<img src=x onerror=1>', brief: '<script>x</script>' })]),
        readsAvailable: true,
        writesAvailable: true,
      }),
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
  });
  it('is honest when empty, unavailable, or read-only', () => {
    const empty = render(
      createElement(PracticeTrialCatalog, {
        initial: catalog([]),
        readsAvailable: true,
        writesAvailable: true,
      }),
    );
    expect(empty).toContain('No practice trials are available');
    const down = render(
      createElement(PracticeTrialCatalog, {
        initial: null,
        readsAvailable: false,
        writesAvailable: false,
      }),
    );
    expect(down).toContain('Practice trials are currently unavailable');
    expect(down).not.toContain('Start practice');
    const readOnly = render(
      createElement(PracticeTrialCatalog, {
        initial: catalog(),
        readsAvailable: true,
        writesAvailable: false,
      }),
    );
    expect(readOnly).toContain('Starting practice is currently unavailable');
    expect(readOnly).toContain(definition.title);
  });
  it('shows a load-more control only when the server supplied a cursor', () => {
    const more = render(
      createElement(PracticeTrialCatalog, {
        initial: catalog([trial()], definition.reference.recordId),
        readsAvailable: true,
        writesAvailable: true,
      }),
    );
    expect(more).toContain('Load more');
    const none = render(
      createElement(PracticeTrialCatalog, {
        initial: catalog(),
        readsAvailable: true,
        writesAvailable: true,
      }),
    );
    expect(none).not.toContain('Load more');
  });
  it('rejects a host record that mixes taxonomies before rendering', () => {
    const mixed = catalog([{ ...trial(), taxonomyReference: { recordId: 'other', revision: 1 } }]);
    expect(() =>
      render(
        createElement(PracticeTrialCatalog, {
          initial: mixed,
          readsAvailable: true,
          writesAvailable: true,
        }),
      ),
    ).toThrow('INVALID_HOST_CONTRACT');
  });
});

describe('PracticeTrialWorkspace', () => {
  it('shows original terms and a labelled private submission form while STARTED', () => {
    const html = render(
      createElement(PracticeTrialWorkspace, {
        initial: progress({ version: 'v1', progress: 'STARTED', start, submission: null }),
        writesAvailable: true,
      }),
    );
    for (const value of [
      'Attempt 2',
      definition.title,
      'Answer',
      'Explanation',
      'Tools used',
      'AI assistance',
      'Assistance disclosure',
      'Submit answer',
      'not a deadline',
    ])
      expect(html).toContain(value);
    expect(html).toContain('<textarea');
    expect(html).toContain('Loading practice controls');
    expect(html).toContain('private');
  });
  it('disables AI declaration when the original definition prohibits it', () => {
    const prohibited = {
      ...definition,
      tools: { ...definition.tools, aiAssistance: 'PROHIBITED' as const },
    };
    const html = render(
      createElement(PracticeTrialWorkspace, {
        initial: progress({
          version: 'v1',
          progress: 'STARTED',
          start: { ...start, definition: prohibited },
          submission: null,
        }),
        writesAvailable: true,
      }),
    );
    expect(html).toContain('AI assistance is prohibited');
    expect(html).toMatch(/type="checkbox"[^>]*disabled=""|disabled=""[^>]*type="checkbox"/);
  });
  it('shows the exact submitted work read-only and makes no pass, rank or ownership claim', () => {
    const html = render(
      createElement(PracticeTrialWorkspace, {
        initial: progress({ version: 'v1', progress: 'SUBMITTED', start, submission }),
        writesAvailable: true,
      }),
    );
    expect(html).toContain('Submitted');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('Used an assistant for syntax.');
    expect(html).toContain('not been reviewed');
    expect(html).toContain('ownership is unconfirmed');
    expect(html).not.toContain('<form');
    expect(html).not.toMatch(/Submit answer|you passed|verified|rank earned/i);
  });
  it('remains submittable-looking never when writes are off, and says so', () => {
    const html = render(
      createElement(PracticeTrialWorkspace, {
        initial: progress({ version: 'v1', progress: 'STARTED', start, submission: null }),
        writesAvailable: false,
      }),
    );
    expect(html).toContain('Submitting is currently unavailable');
  });
  it('rejects an incoherent progress record before rendering', () => {
    expect(() =>
      render(
        createElement(PracticeTrialWorkspace, {
          initial: progress({ version: 'v1', progress: 'SUBMITTED', start, submission: null }),
          writesAvailable: true,
        }),
      ),
    ).toThrow('INVALID_HOST_CONTRACT');
  });
});

describe('component boundary', () => {
  it('imports only React and owned portable contracts, with no app alias, environment or storage', async () => {
    const source = await readFile('src/components/practice-trial-portal.tsx', 'utf8');
    const allowed = new Set([
      'react',
      '../skills/practice-portal-client',
      '../skills/practice-trial-contracts',
    ]);
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g))
      expect(allowed.has(match[1]!), match[1]).toBe(true);
    expect(source).not.toMatch(
      /@\/|process\.env|localStorage|sessionStorage|\bconsole\.|\brequire\s*\(|\bimport\s*\(|dangerouslySetInnerHTML/,
    );
  });
});
