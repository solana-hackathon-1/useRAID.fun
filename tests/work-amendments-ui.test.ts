import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AmendmentPanel } from '../src/components/work-amendments';
import { MyRaidsWorkspace, WorkDesk } from '../src/components/work-workspace';
import {
  buildProposal,
  canAnswer,
  describeChanges,
  formFrom,
  isLapsed,
  termsKey,
  type ProposalForm,
} from '../src/work-http/amendment-form';
import { describeAmendmentFailure } from '../src/work-http/amendment-client';
import { WorkClientError } from '../src/work-http/workspace-client';
import { AmendmentDeskSchema } from '../src/work-loop/amendment-desk-contracts';
import { TermsSnapshotSchema } from '../src/contracts/entities';
import { canonicalRequestDigest } from '../src/command-receipts';
import {
  MyRaidsSchema,
  ReviewQueueSchema,
  ApplicantQueueSchema,
} from '../src/work-loop/workspace-contracts';
import { raidTerms } from './helpers/raid-terms-fixture';

const id = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const member = id(5);
const terms = (over: Record<string, unknown> = {}) =>
  TermsSnapshotSchema.parse({
    id: id(4),
    guildId: 'synthetic-guild',
    revision: 1,
    scope: 'Write the installation guide.',
    acceptanceCriteria: ['A clean installation completes.', 'Screenshots are current.'],
    requiredSkills: [],
    roster: [{ participantId: member, responsibility: 'Author', consentRef: 'consent-1' }],
    rewards: [
      {
        policy: raidTerms().rewards[0].policy,
        amount: '1000000000',
        beneficiaryParticipantId: member,
        beneficiaryRef: 'beneficiary-1',
      },
    ],
    deadlines: {
      preparation: '2026-11-02T00:00:00.000Z',
      submission: '2026-11-10T00:00:00.000Z',
      review: '2026-11-15T00:00:00.000Z',
      operationalClosure: '2026-11-20T00:00:00.000Z',
    },
    eligibilityPolicyVersion: 'e1',
    allowedToolsPolicyVersion: 't1',
    revisionPolicyVersion: 'r1',
    withdrawalPolicyVersion: 'w1',
    terminationPolicyVersion: 'x1',
    rubricVersion: null,
    rightsPolicyVersion: 'g1',
    reviewPolicyVersion: 'v1',
    disputePolicyVersion: 'd1',
    finalityPolicyVersion: 'f1',
    createdAt: '2026-10-30T00:00:00.000Z',
    ...over,
  });
const current = terms();
const raised = terms({
  scope: 'Write the installation and upgrade guide.',
  rewards: [{ ...current.rewards[0], amount: '1500000000' }],
  deadlines: { ...current.deadlines, submission: '2026-11-12T00:00:00.000Z' },
});
const amendment = (state: string, over: Record<string, unknown> = {}, t = raised) => ({
  id: id(7),
  engagementId: id(1),
  sequence: 1,
  state,
  digest: canonicalRequestDigest(t),
  terms: t,
  expiresAt: '2026-11-05T00:00:00.000Z',
  requiresFunding: true,
  ...over,
});
const desk = (
  engagements: { role: 'MEMBER' | 'FOUNDER'; amendments?: unknown[] }[],
  proposalsAvailable = true,
) =>
  AmendmentDeskSchema.parse({
    version: 'v1',
    proposalsAvailable,
    engagements: engagements.map((e) => ({
      engagementId: id(1),
      title: 'Synthetic documentation task',
      state: 'IN_PROGRESS',
      role: e.role,
      effectiveTerms: current,
      amendments: e.amendments ?? [],
    })),
  });
const panel = (
  role: 'MEMBER' | 'FOUNDER',
  initial?: ReturnType<typeof desk>,
  extra: { now?: number; initialNotice?: { intent: string; kind: 'REFRESH'; text: string } } = {},
) => renderToStaticMarkup(createElement(AmendmentPanel, { role, initial, ...extra }));
/** The synthetic proposal expires 2026-11-05T00:00Z. */
const BEFORE = Date.parse('2026-11-04T00:00:00.000Z');
const AFTER = Date.parse('2026-11-06T00:00:00.000Z');

describe('T025 amendment change description', () => {
  it('lists only what changed, with exact amounts and direction', () => {
    const lines = describeChanges(current, raised);
    expect(lines.map((l) => l.kind)).toEqual(['scope', 'reward', 'deadline']);
    const reward = lines.find((l) => l.kind === 'reward')!;
    expect(reward).toMatchObject({ before: '1 SOL', after: '1.5 SOL', direction: 'UP' });
    expect(lines.find((l) => l.kind === 'deadline')).toMatchObject({
      label: 'Submission due',
      before: '2026-11-10T00:00:00.000Z',
      after: '2026-11-12T00:00:00.000Z',
    });
    expect(describeChanges(current, current)).toEqual([]);
    const lower = describeChanges(
      current,
      terms({ rewards: [{ ...current.rewards[0], amount: '500000000' }] }),
    );
    expect(lower[0]).toMatchObject({ direction: 'DOWN', after: '0.5 SOL' });
  });
});

describe('T025 proposal form', () => {
  const now = Date.parse('2026-11-01T00:00:00.000Z');
  const base = (): ProposalForm => ({ ...formFrom(current), expiresAt: '2026-11-05T00:00' });
  it('sends only the terms the Founder actually changed, in exact base units', () => {
    const form = { ...base(), rewards: ['1.5'], scope: 'Write the upgrade guide too.' };
    const built = buildProposal(id(1), current, form, now);
    expect(built).toEqual({
      ok: true,
      input: {
        engagementId: id(1),
        changes: { scope: 'Write the upgrade guide too.', rewards: [{ amount: '1500000000' }] },
        expiresAt: '2026-11-05T00:00:00.000Z',
      },
    });
  });
  it('sends criteria and deadlines only when edited, and explains every refusal', () => {
    const edited = {
      ...base(),
      criteria: 'First\n\n  Second  ',
      deadlines: { ...base().deadlines, submission: '2026-11-12T00:00' },
    };
    const built = buildProposal(id(1), current, edited, now);
    expect(built).toMatchObject({
      ok: true,
      input: {
        changes: {
          acceptanceCriteria: ['First', 'Second'],
          deadlines: { submission: '2026-11-12T00:00:00.000Z' },
        },
      },
    });
    const problem = (form: ProposalForm) => {
      const r = buildProposal(id(1), current, form, now);
      return r.ok ? null : r.problem;
    };
    expect(problem(base())).toMatch(/Change at least one term/);
    expect(problem({ ...base(), scope: 'x', expiresAt: '' })).toMatch(/valid until/);
    expect(problem({ ...base(), scope: 'x', expiresAt: '2026-10-01T00:00' })).toMatch(/future/);
    expect(problem({ ...base(), scope: 'x', expiresAt: '2026-11-11T00:00' })).toMatch(
      /before the current submission deadline/,
    );
    expect(problem({ ...base(), rewards: ['abc'] })).toMatch(/reward/i);
    expect(problem({ ...base(), rewards: ['1.0000000001'] })).toMatch(/reward/i);
    expect(problem({ ...base(), rewards: ['0'] })).toMatch(/reward/i);
    expect(problem({ ...base(), scope: '   ' })).toMatch(/scope/i);
  });
});

describe('T025 failure wording', () => {
  it('states funding, stale and already-answered outcomes plainly, without server text', () => {
    const say = (code: string) => describeAmendmentFailure(new WorkClientError(code, 409));
    expect(say('FUNDING_NOT_VERIFIED').message).toMatch(/simulated funding.*No money has moved/);
    expect(say('NO_LONGER_OPEN')).toMatchObject({ kind: 'REFRESH' });
    expect(say('NO_LONGER_OPEN').message).toMatch(/already answered, withdrawn or has expired/);
    expect(say('REVISION_CHANGED').kind).toBe('REFRESH');
    expect(say('CONSENT_REQUIRED').message).toMatch(/exactly these terms/);
    expect(say('NOT_AVAILABLE').message).toMatch(/not open right now/);
    expect(say('FORBIDDEN').message).toMatch(/not permitted/);
    expect(say('SERVICE_UNAVAILABLE').kind).toBe('RETRY_SAME_REQUEST');
    expect(describeAmendmentFailure(new Error('boom')).kind).toBe('RETRY_SAME_REQUEST');
  });
});

describe('T025 member consent card markup', () => {
  it('shows loading before the desk arrives and nothing that implies a decision', () => {
    const html = panel('MEMBER');
    expect(html).toContain('Loading');
    expect(html).not.toContain('Agree to this change');
  });
  it('says nothing is proposed and the accepted terms stay in force', () => {
    const html = panel('MEMBER', desk([{ role: 'MEMBER' }]));
    expect(html).toContain('No change has been proposed');
    expect(html).toContain('stay in force');
  });
  it('shows the exact change, what stays in force, funding honesty and disabled-until-hydrated controls', () => {
    const html = panel('MEMBER', desk([{ role: 'MEMBER', amendments: [amendment('PROPOSED')] }]));
    expect(html).toContain('Proposed change: Synthetic documentation task');
    expect(html).toContain('Your current terms stay in force until you agree');
    expect(html).toContain('Write the installation and upgrade guide.');
    expect(html).toContain('1 SOL');
    expect(html).toContain('1.5 SOL');
    expect(html).toContain('Submission due');
    expect(html).toContain('simulated');
    expect(html).toContain('no money has moved');
    expect(html).toContain('Agree to this change');
    expect(html).toContain('Decline');
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    expect(html).toContain('Answer by');
  });
  it('shows a plain unavailable notice when the write switch is off', () => {
    const html = panel(
      'MEMBER',
      desk([{ role: 'MEMBER', amendments: [amendment('PROPOSED')] }], false),
    );
    expect(html).toContain('Responding to a proposed change is currently unavailable');
  });
  it('lists decided proposals without offering to answer them again', () => {
    const html = panel(
      'MEMBER',
      desk([
        {
          role: 'MEMBER',
          amendments: [
            amendment('ACCEPTED', { sequence: 1 }),
            amendment('DECLINED', { id: id(8), sequence: 2 }),
            amendment('WITHDRAWN', { id: id(9), sequence: 3 }),
          ],
        },
      ]),
    );
    expect(html).toContain('Agreed');
    expect(html).toContain('Declined');
    expect(html).toContain('Withdrawn by the Founder');
    expect(html).not.toContain('Agree to this change');
    expect(html).toContain('No change is waiting for your answer');
  });
  it('ignores engagements the caller only manages when asked for the member view', () => {
    const html = panel('MEMBER', desk([{ role: 'FOUNDER', amendments: [amendment('PROPOSED')] }]));
    expect(html).not.toContain('Agree to this change');
  });
});

describe('T025 Founder proposal form markup', () => {
  it('explains an empty desk', () => {
    expect(panel('FOUNDER', desk([]))).toContain('no accepted work that can be changed');
  });
  it('offers the current terms and a labelled form, disabled until hydrated, with honest funding text', () => {
    const html = panel('FOUNDER', desk([{ role: 'FOUNDER' }]));
    expect(html).toContain('Propose change: Synthetic documentation task');
    expect(html).toContain('New scope');
    expect(html).toContain('Acceptance criteria (one per line)');
    expect(html).toContain('Reward 1 (SOL)');
    expect(html).toContain('Proposal valid until (UTC)');
    expect(html).toContain('Propose change');
    expect(html).toContain('takes effect only if');
    expect(html).toContain('simulated');
    expect(html).toMatch(/<fieldset[^>]*disabled/);
  });
  it('shows a plain unavailable notice when proposals are off', () => {
    const html = panel('FOUNDER', desk([{ role: 'FOUNDER' }], false));
    expect(html).toContain('Proposing a change is currently unavailable');
  });
  it('shows the waiting proposal with a withdraw control instead of a second form', () => {
    const html = panel('FOUNDER', desk([{ role: 'FOUNDER', amendments: [amendment('PROPOSED')] }]));
    expect(html).toContain('waiting for the member');
    expect(html).toContain('Withdraw proposal');
    expect(html).not.toContain('New scope');
  });
  it('does not show Founder forms in the member view', () => {
    expect(panel('MEMBER', desk([{ role: 'FOUNDER' }]))).not.toContain('New scope');
  });
});

describe('T025 workspace embedding', () => {
  const empty = MyRaidsSchema.parse({
    version: 'v1',
    capacity: { limit: 1, held: false, engagementId: null, title: null },
    engagements: [],
    applications: [],
  });
  it('mounts the member consent area in My Raid and the Founder area in the work desk', () => {
    const mineHtml = renderToStaticMarkup(
      createElement(MyRaidsWorkspace, {
        initial: empty,
        submissionsAvailable: true,
        applicationsAvailable: true,
      }),
    );
    expect(mineHtml).toContain('Changes to your accepted terms');
    const deskHtml = renderToStaticMarkup(
      createElement(WorkDesk, {
        initialReviews: ReviewQueueSchema.parse({ version: 'v1', items: [] }),
        initialApplicants: ApplicantQueueSchema.parse({ version: 'v1', listings: [] }),
        reviewsAvailable: true,
        offersAvailable: true,
      }),
    );
    expect(deskHtml).toContain('Propose a change to accepted terms');
  });
});

describe('T025 fix pass: lapsed proposals (M2)', () => {
  it('treats a proposal as lapsed only at or after its expiry, and never before the clock is known', () => {
    const at = '2026-11-05T00:00:00.000Z';
    expect(isLapsed(at, BEFORE)).toBe(false);
    expect(isLapsed(at, Date.parse(at))).toBe(true);
    expect(isLapsed(at, AFTER)).toBe(true);
    expect(isLapsed(at, null)).toBe(false);
  });
  it('allows an answer only when ready, available, idle and not lapsed', () => {
    const base = { ready: true, available: true, busy: false, lapsed: false };
    expect(canAnswer(base)).toBe(true);
    for (const off of ['ready', 'available', 'lapsed'] as const)
      expect(canAnswer({ ...base, [off]: off === 'lapsed' })).toBe(false);
    expect(canAnswer({ ...base, busy: true })).toBe(false);
  });
  it('tells the member a past-expiry proposal lapsed and offers no live answer window', () => {
    const d = desk([{ role: 'MEMBER', amendments: [amendment('PROPOSED')] }]);
    const live = panel('MEMBER', d, { now: BEFORE });
    expect(live).toContain('Answer by');
    expect(live).not.toContain('has lapsed');
    const html = panel('MEMBER', d, { now: AFTER });
    expect(html).toContain('This proposal has lapsed');
    expect(html).toContain('Nothing changed');
    expect(html).not.toContain('Answer by');
  });
  it('tells the Founder a past-expiry proposal lapsed and to withdraw it before proposing again', () => {
    const d = desk([{ role: 'FOUNDER', amendments: [amendment('PROPOSED')] }]);
    const html = panel('FOUNDER', d, { now: AFTER });
    expect(html).toContain('has lapsed');
    expect(html).toMatch(/Withdraw it to propose/);
    expect(html).not.toContain('lapses on');
    expect(html).toContain('Withdraw proposal');
    expect(panel('FOUNDER', d, { now: BEFORE })).toContain('lapses on');
  });
});

describe('T025 fix pass: Founder form follows the agreed terms (M1)', () => {
  it('changes the form key when the effective terms change and keeps it for identical terms', () => {
    expect(termsKey(current)).toBe(termsKey(terms()));
    expect(termsKey(current)).not.toBe(termsKey(raised));
  });
});

describe('T025 fix pass: the explanation outlives the reload (D0)', () => {
  const stale = {
    intent: 'agree:' + id(7),
    kind: 'REFRESH' as const,
    text: 'This proposal is no longer open: it was already answered, withdrawn or has expired. Nothing changed.',
  };
  it('keeps the alert and a Refresh control after the card has gone, for member and Founder', () => {
    for (const role of ['MEMBER', 'FOUNDER'] as const) {
      const gone = desk([{ role }]); // the reload removed the proposal, so no card owns the notice any more
      const html = panel(role, gone, { initialNotice: stale });
      expect(html).toContain('no longer open');
      expect(html).toContain('Nothing changed');
      expect(html).toMatch(/role="alert"/);
      expect(html).toContain('Refresh');
    }
  });
  it('shows a refresh notice once, above the cards, not again inside a card that is still present', () => {
    const d = desk([{ role: 'MEMBER', amendments: [amendment('PROPOSED')] }]);
    const html = panel('MEMBER', d, { initialNotice: stale });
    expect(html.match(/no longer open/g)).toHaveLength(1);
  });
});
