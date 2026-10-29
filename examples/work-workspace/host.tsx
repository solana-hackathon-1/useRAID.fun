import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MyRaidsWorkspace, WorkDesk } from './components/work-workspace';
import {
  WorkClientError,
  createWorkClient,
  describeWorkFailure,
  type WorkTransport,
} from './work-http/workspace-client';
import {
  ApplicantQueueSchema,
  MyRaidsSchema,
  ReviewQueueSchema,
} from './work-loop/workspace-contracts';

// Synthetic host: no network, no RAID app, no database, no environment. The host supplies already-authorized
// server data and a transport; server rendering must never dispatch.
const engagementId = '11111111-1111-4111-8111-111111111111';
const view = MyRaidsSchema.parse({
  version: 'v1',
  capacity: { limit: 1, held: true, engagementId, title: 'Synthetic task' },
  engagements: [
    {
      engagementId,
      title: 'Synthetic task',
      state: 'IN_PROGRESS',
      capacityHeld: true,
      acceptedTerms: {
        termsVersionId: '22222222-2222-4222-8222-222222222222',
        revision: 1,
        scope: 'Synthetic scope.',
        requiredSkills: [],
        roster: [
          { participantId: '33333333-3333-4333-8333-333333333333', responsibility: 'Author' },
        ],
        rewards: [],
        deadlines: {
          preparation: '2026-11-03T00:00:00.000Z',
          submission: '2026-11-04T00:00:00.000Z',
          review: '2026-11-05T00:00:00.000Z',
          operationalClosure: '2026-11-06T00:00:00.000Z',
        },
      },
      setup: { status: 'READY', preparationDeadline: '2026-11-03T00:00:00.000Z' },
      nextStep: 'SUBMIT_WORK',
      deadlines: {
        submission: '2026-11-04T00:00:00.000Z',
        review: '2026-11-05T00:00:00.000Z',
        operationalClosure: '2026-11-06T00:00:00.000Z',
      },
      submissionCount: 0,
      maxSubmissions: 2,
      criteria: [{ index: 0, text: 'It works.', result: null, evidence: null }],
      latestReview: null,
      closure: null,
      claims: [],
    },
  ],
  applications: [],
});
const queue = ReviewQueueSchema.parse({ version: 'v1', items: [] });
const applicants = ApplicantQueueSchema.parse({ version: 'v1', listings: [] });
let dispatched = 0;
const transport: WorkTransport = {
  request: async (method, path, init) => {
    dispatched++;
    if (method === 'POST' && path === '/api/v1/work/submissions')
      return {
        status: 409,
        body: {
          error: { code: 'REVISION_CHANGED', message: 'x', retryable: false, requestId: 'r' },
        },
      };
    throw new TypeError('network ' + (init ? 'with body' : ''));
  },
};
const api = createWorkClient(transport);
const mine = renderToStaticMarkup(
  createElement(MyRaidsWorkspace, {
    initial: view,
    submissionsAvailable: true,
    applicationsAvailable: false,
    api,
  }),
);
const off = renderToStaticMarkup(
  createElement(MyRaidsWorkspace, {
    initial: view,
    submissionsAvailable: false,
    applicationsAvailable: false,
    api,
  }),
);
const desk = renderToStaticMarkup(
  createElement(WorkDesk, {
    initialReviews: queue,
    initialApplicants: applicants,
    reviewsAvailable: true,
    offersAvailable: true,
    api,
  }),
);
assert.equal(dispatched, 0, 'Server rendering must not dispatch.');
const ssrDispatches = dispatched;
const conflict = await api
  .submitWork(
    {
      engagementId,
      expectedSubmissionNumber: 1,
      explanation: 'Done.',
      artifacts: [{ kind: 'COMMIT', ref: 'synthetic://r', immutableVersion: 'a'.repeat(40) }],
      dependencies: [],
      aiUsage: null,
    },
    'synthetic-key',
  )
  .catch((e: unknown) => e);
const unreachable = await api.me().catch((e: unknown) => e);
console.log(
  JSON.stringify({
    synthetic: true,
    workspaceRenders:
      mine.includes('Synthetic task') &&
      mine.includes('Submit work') &&
      mine.includes('Synthetic scope.') &&
      mine.includes('Setup finished.') &&
      mine.includes('Active Raid capacity: 1 of 1 in use'),
    unavailableHonest: off.includes('Submitting is currently unavailable'),
    deskRenders: desk.includes('No submissions are waiting for you'),
    noDispatchDuringSsr: ssrDispatches === 0,
    conflictRefreshes:
      conflict instanceof WorkClientError && describeWorkFailure(conflict).kind === 'REFRESH',
    unreachableRetriesSameRequest: describeWorkFailure(unreachable).kind === 'RETRY_SAME_REQUEST',
  }),
);
