import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MyRaidsWorkspace, WorkDesk } from '../src/components/work-workspace';
import {
  ApplicantQueueSchema,
  MyRaidsSchema,
  ReviewQueueSchema,
} from '../src/work-loop/workspace-contracts';
import { raidTerms } from './helpers/raid-terms-fixture';
const id = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const deadlines = {
  submission: '2026-11-04T00:00:00.000Z',
  review: '2026-11-05T00:00:00.000Z',
  operationalClosure: '2026-11-06T00:00:00.000Z',
};
const card = (patch: Record<string, unknown> = {}) => ({
  engagementId: id(1),
  title: 'Synthetic documentation task',
  state: 'IN_PROGRESS',
  capacityHeld: true,
  acceptedTerms: {
    termsVersionId: id(2),
    revision: 1,
    scope: 'Write the installation guide.',
    requiredSkills: [],
    roster: [{ participantId: id(3), responsibility: 'Author' }],
    rewards: [],
    deadlines: { preparation: '2026-11-03T00:00:00.000Z', ...deadlines },
  },
  setup: { status: 'READY', preparationDeadline: '2026-11-03T00:00:00.000Z' },
  nextStep: 'SUBMIT_WORK',
  deadlines,
  submissionCount: 0,
  maxSubmissions: 2,
  criteria: [{ index: 0, text: 'A clean installation completes.', result: null, evidence: null }],
  latestReview: null,
  closure: null,
  claims: [],
  ...patch,
});
const mine = (engagements: unknown[] = [], applications: unknown[] = []) =>
  MyRaidsSchema.parse({
    version: 'v1',
    capacity: { limit: 1, held: false, engagementId: null, title: null },
    engagements,
    applications,
  });
const render = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const workspace = (initial: ReturnType<typeof mine>, flags = {}) =>
  render(
    createElement(MyRaidsWorkspace, {
      initial,
      submissionsAvailable: true,
      applicationsAvailable: true,
      ...flags,
    }),
  );
describe('T022 My Raid workspace markup', () => {
  it('explains empty states', () => {
    const html = workspace(mine());
    expect(html).toContain('You have no accepted Raids yet');
    expect(html).toContain('You have no applications');
  });
  it('renders progress, criteria and a submission form that stays disabled before hydration', () => {
    const html = workspace(mine([card()]));
    expect(html).toContain('In progress');
    expect(html).toContain('holds your one active Raid slot');
    expect(html).toContain('A clean installation completes.');
    expect(html).toContain('Submission 1 of at most 2');
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    expect(html).toContain('Loading controls');
  });
  it('shows the accepted terms, setup readiness and capacity summary', () => {
    const html = workspace(
      mine([
        card({
          state: 'ACCESS_PENDING',
          nextStep: 'WAIT_FOR_START',
          setup: { status: 'PENDING', preparationDeadline: '2026-11-03T00:00:00.000Z' },
        }),
      ]),
    );
    expect(html).toContain('Accepted terms');
    expect(html).toContain('Write the installation guide.');
    expect(html).toContain('Author');
    expect(html).toContain('Setup is not finished');
    const held = MyRaidsSchema.parse({
      ...mine([card()]),
      capacity: {
        limit: 1,
        held: true,
        engagementId: id(1),
        title: 'Synthetic documentation task',
      },
    });
    expect(workspace(held)).toContain('Active Raid capacity: 1 of 1 in use');
  });
  it('shows a plain unavailable notice instead of an enabled form when writes are off', () => {
    const html = workspace(mine([card()]), { submissionsAvailable: false });
    expect(html).toContain('Submitting is currently unavailable');
  });
  it('shows reviewer feedback and the revision deadline', () => {
    const html = workspace(
      mine([
        card({
          state: 'REVISION_REQUESTED',
          nextStep: 'REVISE_AND_RESUBMIT',
          submissionCount: 1,
          criteria: [
            { index: 0, text: 'Criterion A', result: 'UNMET', evidence: 'Step three fails.' },
          ],
          latestReview: {
            decision: 'REQUEST_REVISION',
            reason: 'Please fix step three.',
            revisionDeadline: '2026-11-03T12:00:00.000Z',
          },
        }),
      ]),
    );
    expect(html).toContain('Not met');
    expect(html).toContain('Step three fails.');
    expect(html).toContain('Please fix step three.');
    expect(html).toContain('Revision due');
    expect(html).toContain('Resubmit your work');
    expect(html).toContain('Submission 2 of at most 2');
  });
  it('shows a closed Raid with its unsettled claim and no submission form', () => {
    const policy = raidTerms().rewards[0].policy;
    const html = workspace(
      mine([
        card({
          state: 'ACCEPTED',
          capacityHeld: false,
          nextStep: 'CLOSED',
          closure: {
            engagementId: id(1),
            finalState: 'ACCEPTED',
            reason: 'ACCEPTED',
            financialResolution: 'OPEN',
            closedAt: '2026-11-01T00:00:00.000Z',
          },
          claims: [
            {
              policy,
              amount: '1500000000',
              beneficiaryParticipantId: id(2),
              status: 'UNSETTLED',
            },
          ],
        }),
      ]),
    );
    expect(html).toContain('no longer holds your active Raid slot');
    expect(html).toContain('Reward claim: 1.5 (NATIVE_SOL)');
    expect(html).toContain('unsettled');
    expect(html).toContain('does not');
    expect(html).not.toContain('Submit work');
  });
  it('explains timeout closures without blaming anyone or deciding payment', () => {
    const html = workspace(
      mine([
        card({
          state: 'TERMINATED',
          capacityHeld: false,
          nextStep: 'CLOSED',
          closure: {
            engagementId: id(1),
            finalState: 'TERMINATED',
            reason: 'REVIEW_TIMEOUT',
            financialResolution: 'OPEN',
            closedAt: '2026-11-07T00:00:00.000Z',
          },
          claims: [
            {
              policy: raidTerms().rewards[0].policy,
              amount: '1000000000',
              beneficiaryParticipantId: id(2),
              status: 'UNSETTLED',
            },
          ],
        }),
      ]),
    );
    expect(html).toContain('no review decision by the operational deadline');
    expect(html).toContain('does not');
    expect(html).toContain('unsettled');
  });
  it('states honestly that closure released capacity, left the money question open and settled nothing', () => {
    const closure = {
      engagementId: id(1),
      finalState: 'TERMINATED',
      reason: 'SUBMISSION_TIMEOUT',
      financialResolution: 'OPEN',
      closedAt: '2026-11-07T00:00:00.000Z',
    };
    const claims = [
      {
        policy: raidTerms().rewards[0].policy,
        amount: '1000000000',
        beneficiaryParticipantId: id(2),
        status: 'UNSETTLED',
      },
    ];
    const released = workspace(
      mine([
        card({ state: 'TERMINATED', capacityHeld: false, nextStep: 'CLOSED', closure, claims }),
      ]),
    );
    expect(released).toContain('Capacity released');
    expect(released).toContain('Financial resolution: open');
    expect(released).toContain('no payout, refund or fault');
    expect(released).toContain('Simulated funds');
    // Never claim a release the server did not report, and never imply a decision for an open Raid.
    const held = workspace(
      mine([
        card({ state: 'TERMINATED', capacityHeld: true, nextStep: 'CLOSED', closure, claims }),
      ]),
    );
    expect(held).not.toContain('Capacity released');
    expect(held).toContain('Financial resolution: open');
    const open = workspace(mine([card()]));
    expect(open).not.toContain('Capacity released');
    expect(open).not.toContain('Financial resolution');
  });
  it('lists applications and offers without offering unsupported acceptance, and escapes text', () => {
    const html = workspace(
      mine(
        [],
        [
          {
            applicationId: id(3),
            slotId: id(4),
            termsVersionId: id(5),
            title: '<script>alert(1)</script>',
            state: 'SUBMITTED',
            offer: {
              offerId: id(6),
              state: 'PENDING',
              expiresAt: '2026-11-02T00:00:00.000Z',
              expired: false,
            },
          },
        ],
      ),
    );
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Offer waiting until');
    expect(html).toContain('acceptance is not offered here');
    expect(html).toContain('Withdraw application');
    expect(html).not.toContain('Accept offer');
  });
  it('labels expired and revoked offers truthfully', () => {
    const base = {
      applicationId: id(3),
      slotId: id(4),
      termsVersionId: id(5),
      title: 'T',
      state: 'SUBMITTED',
    };
    const expired = workspace(
      mine(
        [],
        [
          {
            ...base,
            offer: {
              offerId: id(6),
              state: 'PENDING',
              expiresAt: '2026-10-01T00:00:00.000Z',
              expired: true,
            },
          },
        ],
      ),
    );
    expect(expired).toContain('Offer expired');
    expect(expired).not.toContain('acceptance is not offered here');
    const revoked = workspace(
      mine(
        [],
        [
          {
            ...base,
            state: 'CLOSED',
            offer: {
              offerId: id(6),
              state: 'REVOKED',
              expiresAt: '2026-11-01T00:00:00.000Z',
              expired: false,
            },
          },
        ],
      ),
    );
    expect(revoked).toContain('withdrawn by the founder');
    expect(revoked).not.toContain('Withdraw application');
  });
});
describe('T022 review and applicant desk markup', () => {
  const item = (patch = {}) => ({
    engagementId: id(1),
    submissionId: id(7),
    submissionNumber: 1,
    title: 'Synthetic documentation task',
    explanation: 'Guide written.',
    artifacts: [
      { kind: 'COMMIT', ref: 'synthetic://repo/setup.md', immutableVersion: 'a'.repeat(40) },
    ],
    dependencies: ['Public repo'],
    aiUsage: null,
    submittedAt: '2026-11-01T00:00:00.000Z',
    reviewDue: '2026-11-05T00:00:00.000Z',
    operationalClosure: '2026-11-06T00:00:00.000Z',
    revisionsRemaining: 1,
    criteria: [{ index: 0, text: 'A clean installation completes.' }],
    ...patch,
  });
  const desk = (reviews: unknown[] = [], listings: unknown[] = [], flags = {}) =>
    render(
      createElement(WorkDesk, {
        initialReviews: ReviewQueueSchema.parse({ version: 'v1', items: reviews }),
        initialApplicants: ApplicantQueueSchema.parse({ version: 'v1', listings }),
        reviewsAvailable: true,
        offersAvailable: true,
        ...flags,
      }),
    );
  it('explains empty queues', () => {
    const html = desk();
    expect(html).toContain('No submissions are waiting for you');
    expect(html).toContain('No applicants on listings you manage');
  });
  it('shows the submission, criteria and a decision form, with revisions disabled when exhausted', () => {
    const html = desk([item({ revisionsRemaining: 0 })]);
    expect(html).toContain('Guide written.');
    expect(html).toContain('COMMIT: synthetic://repo/setup.md @');
    expect(html).toContain('Criterion 1: A clean installation completes.');
    expect(html).toContain('AI assistance: none disclosed');
    expect(html).toMatch(/<option value="REQUEST_REVISION" disabled/);
    expect(html).toMatch(/<fieldset[^>]*disabled/);
  });
  it('shows the offer form for a fresh applicant and revocation for a live offer', () => {
    const listing = (offer: unknown) => ({
      slotId: id(4),
      termsVersionId: id(5),
      title: 'Listing',
      applicants: [
        {
          applicationId: id(3),
          evidenceRefs: ['synthetic:portfolio'],
          state: 'SUBMITTED',
          appliedAt: '2026-11-01T00:00:00.000Z',
          offer,
        },
      ],
    });
    const fresh = desk([], [listing(null)]);
    expect(fresh).toContain('Issue offer');
    expect(fresh).toContain('synthetic:portfolio');
    const live = desk(
      [],
      [
        listing({
          offerId: id(6),
          state: 'PENDING',
          expiresAt: '2026-11-02T00:00:00.000Z',
          expired: false,
        }),
      ],
    );
    expect(live).toContain('Revoke offer');
    expect(live).not.toContain('Offer expires (UTC)');
    const expired = desk(
      [],
      [
        listing({
          offerId: id(6),
          state: 'PENDING',
          expiresAt: '2026-10-01T00:00:00.000Z',
          expired: true,
        }),
      ],
    );
    expect(expired).toContain('(expired)');
    expect(expired).toContain('Issue offer');
  });
  it('shows unavailable notices when management writes are off', () => {
    const html = desk([item()], [], { reviewsAvailable: false });
    expect(html).toContain('Recording decisions is currently unavailable');
  });
  it('offers Start work only for a pending engagement while starts are open', () => {
    const pending = mine([card({ state: 'ACCESS_PENDING', nextStep: 'WAIT_FOR_START' })]);
    const open = workspace(pending, { startAvailable: true });
    expect(open).toContain('Start work');
    expect(open).not.toContain('Nothing is due from you');
    expect(open).toMatch(/<button[^>]*disabled[^>]*>Start work/);
    const closed = workspace(pending, { startAvailable: false });
    expect(closed).not.toContain('Start work');
    expect(closed).toContain('Setup is not finished yet');
    expect(workspace(mine([card()]), { startAvailable: true })).not.toContain('Start work');
  });
});
