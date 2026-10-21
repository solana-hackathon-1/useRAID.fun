import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PracticeTrialCatalog, PracticeTrialWorkspace } from './components/practice-trial-portal';
import {
  PracticePortalCatalogSchema,
  PracticePortalProgressSchema,
  buildSubmitInput,
  createPracticePortalTransport,
  type PracticePortalTransport,
} from './skills/practice-portal-client';

// Synthetic host: no network, no RAID app, no environment. The host supplies already-authorized
// server data and a transport; SSR must never dispatch.
const definition = {
  version: 'v1',
  reference: { recordId: 'synthetic-trial', revision: 1 },
  state: 'PUBLISHED',
  publishedAt: '2026-10-13T00:00:00.000Z',
  purpose: 'UNPAID_PLATFORM_PRACTICE',
  skillId: 'frontend',
  skillDomain: 'web',
  targetRank: 'C',
  title: 'Synthetic exercise',
  brief: 'Build an invented component.',
  variantId: 'synthetic-variant',
  inputs: [{ label: 'Fixture', material: 'SYNTHETIC', content: 'Invented records only.' }],
  tools: { permitted: ['editor'], aiAssistance: 'PROHIBITED', disclosure: 'Disclose any help.' },
  expectedMinutes: 30,
  rubric: {
    reference: { recordId: 'synthetic-rubric', revision: 1 },
    criteria: [{ id: 'works', description: 'It works.', required: true }],
  },
  evaluatorMethod: 'MANUAL',
  passConditions: 'A reviewer applies each required criterion.',
  maximumAttempts: 2,
  cooldownSeconds: 0,
  accommodationPolicy: 'Ask for an approved accommodation.',
};
const catalog = PracticePortalCatalogSchema.parse({
  version: 'v1',
  taxonomyId: 'synthetic-catalog',
  nextCursor: null,
  trials: [
    {
      version: 'v1',
      definition,
      availability: 'AVAILABLE',
      taxonomyReference: { recordId: 'synthetic-catalog', revision: 1 },
      persisted: true,
      verifiesSkill: false,
      createsPermissionGrant: false,
      consumesCapacity: false,
      createsFinancialObligation: false,
    },
  ],
});
let calls = 0;
const api: PracticePortalTransport = {
  list: async () => (calls++, Promise.reject(Error('SSR must not list'))),
  start: async () => (calls++, Promise.reject(Error('SSR must not start'))),
  read: async () => (calls++, Promise.reject(Error('SSR must not read'))),
  submit: async () => (calls++, Promise.reject(Error('SSR must not submit'))),
};
const enabled = renderToStaticMarkup(
  createElement(PracticeTrialCatalog, {
    initial: catalog,
    readsAvailable: true,
    writesAvailable: true,
    api,
  }),
);
const disabled = renderToStaticMarkup(
  createElement(PracticeTrialCatalog, {
    initial: null,
    readsAvailable: false,
    writesAvailable: false,
    api,
  }),
);
const started = PracticePortalProgressSchema.parse({
  version: 'v1',
  progress: 'STARTED',
  start: {
    version: 'v1',
    id: '44444444-4444-4444-8444-444444444444',
    state: 'STARTED',
    participantId: 'synthetic-participant',
    definition,
    taxonomyReference: { recordId: 'synthetic-catalog', revision: 1 },
    accommodationReference: null,
    attemptNumber: 1,
    startedAt: '2026-10-20T00:00:00.000Z',
    persisted: true,
    verifiesSkill: false,
    isAuthorizationToken: false,
    createsPermissionGrant: false,
    consumesCapacity: false,
    createsFinancialObligation: false,
  },
  submission: null,
});
const workspace = renderToStaticMarkup(
  createElement(PracticeTrialWorkspace, { initial: started, writesAvailable: true, api }),
);
const aiRefused = buildSubmitInput({
  startId: started.start.id,
  definition: started.start.definition,
  answer: 'x',
  explanation: 'y',
  toolsText: '',
  aiAssistanceUsed: true,
  assistanceDisclosure: 'z',
}).ok;
let invalidHostDenied = false;
try {
  renderToStaticMarkup(
    createElement(PracticeTrialCatalog, {
      initial: {
        ...catalog,
        trials: [{ ...catalog.trials[0]!, taxonomyReference: { recordId: 'other', revision: 1 } }],
      },
      readsAvailable: true,
      writesAvailable: true,
      api,
    }),
  );
} catch (error) {
  invalidHostDenied = (error as Error).message === 'INVALID_HOST_CONTRACT';
}
assert.equal(typeof createPracticePortalTransport(async () => new Response('{}')).list, 'function');
console.log(
  JSON.stringify({
    synthetic: true,
    catalogRenders: enabled.includes('Synthetic exercise') && enabled.includes('not a deadline'),
    unavailableHonest:
      disabled.includes('currently unavailable') && !disabled.includes('Start practice'),
    workspaceForm:
      workspace.includes('Submit answer') && workspace.includes('AI assistance is prohibited'),
    aiProhibitedRefused: aiRefused === false,
    noDispatchDuringSsr: calls === 0,
    invalidHostDenied,
  }),
);
