import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkDetail, WorkFeed, feedHref, type FeedViewerState } from '../src/components/work-feed';
import { DetailSchema, FeedCardSchema, FeedPageSchema } from '../src/work-loop/feed-contracts';

/** Guild link and "Eligible for me" markup of the public Raid feed (T097, blueprint §18.1–18.2, R08). */
const id = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const sol = { chain: 'SOLANA', networkIdentity: 'synthetic-work', kind: 'NATIVE_SOL' } as const;
const card = (n: number, patch: Record<string, unknown> = {}) => ({
  listingId: id(n),
  termsVersionId: id(n + 1),
  guildId: '7f3a9c1e-2b4d-4e6f-8a0b-1c2d3e4f5a6b',
  title: `Synthetic task ${n}`,
  publicSummary: 'Write a verified setup guide.',
  category: 'documentation',
  difficulty: 'E',
  requiredSkills: [{ skillId: 'writing', minimumRank: 'E' }],
  participantKinds: ['HUMAN'],
  execution: 'SOLO',
  admission: 'INSTANT',
  rewards: [
    {
      assetKey: JSON.stringify(['SOLANA', 'synthetic-work', 'NATIVE_SOL']),
      assetId: sol,
      decimals: 9,
      amount: '1500000000',
    },
  ],
  commitmentDeadline: '2026-11-04T09:30:00.000Z',
  submissionDeadline: '2026-11-08T00:00:00.000Z',
  availableSlots: 1,
  funding: { mode: 'SIMULATED' },
  confidentiality: 'PUBLIC',
  ...patch,
});
const guild = { slug: 'acme-guild', name: 'Acme <Guild>' };
const page = (items: unknown[]) =>
  FeedPageSchema.parse({ items, nextCursor: null, sort: 'newest', rewardComparable: false });
const html = (items: unknown[], viewer?: FeedViewerState, query = {}) =>
  renderToStaticMarkup(createElement(WorkFeed, { page: page(items), query, viewer }));

describe('Guild name and link on feed cards', () => {
  it('shows the public Guild name linking to its page, escaped, and never the internal Guild id', () => {
    const out = html([card(1, { guild })]);
    expect(out).toContain('href="/guilds/acme-guild"');
    expect(out).toContain('Acme &lt;Guild&gt;');
    expect(out).not.toContain('Acme <Guild>');
    expect(out).not.toContain('7f3a9c1e');
    expect(out).not.toContain('Guild 7f3a');
  });
  it('shows no link and no id when the Guild has no public page', () => {
    const out = html([card(1)]);
    expect(out).not.toContain('/guilds/');
    expect(out).not.toContain('7f3a9c1e');
    expect(out).toContain('Posted by a Guild');
  });
  it('keeps the public card contract strict: only slug and name may describe the Guild', () => {
    expect(FeedCardSchema.safeParse(card(1, { guild })).success).toBe(true);
    expect(
      FeedCardSchema.safeParse(card(1, { guild: { ...guild, founderAccountId: 'x' } })).success,
    ).toBe(false);
    expect(
      FeedCardSchema.safeParse(card(1, { guild: { slug: 'Bad Slug', name: 'x' } })).success,
    ).toBe(false);
  });
  it('shows the same link on the brief', () => {
    const detail = DetailSchema.parse({
      ...card(1, { guild }),
      openSlotIds: [id(7)],
      termsDigest: 'a'.repeat(64),
      outcome: 'A guide.',
      deliverables: ['d'],
      acceptanceCriteria: ['c'],
      exclusions: [],
      dependencies: [],
      allowedToolsPolicy: 'p',
      startCondition: 's',
      deadlines: {
        commitment: '2026-11-04T09:30:00.000Z',
        preparation: '2026-11-05T09:30:00.000Z',
        submission: '2026-11-08T00:00:00.000Z',
        review: '2026-11-09T00:00:00.000Z',
        operationalClosure: '2026-11-10T00:00:00.000Z',
      },
      review: { evidence: 'e', maxRevisionRounds: 1 },
      rightsPolicy: 'r',
      portfolioPolicy: 'p',
      withdrawalPolicy: 'w',
      terminationPolicy: 't',
      disputePolicy: 'd',
      finalityPolicy: 'f',
    });
    const out = renderToStaticMarkup(createElement(WorkDetail, { detail }));
    expect(out).toContain('href="/guilds/acme-guild"');
    expect(out).not.toContain('7f3a9c1e');
  });
});

describe('Eligible for me', () => {
  const items = [card(1), card(3), card(5)];
  const ready = (
    over: Partial<Extract<FeedViewerState, { status: 'READY' }>> = {},
  ): FeedViewerState => ({
    status: 'READY',
    eligibleOnly: false,
    eligibility: { [id(1)]: 'ELIGIBLE', [id(3)]: 'NOT_ELIGIBLE', [id(5)]: 'UNKNOWN' },
    ...over,
  });
  it('is absent entirely while the feature is off', () => {
    const out = html(items, { status: 'OFF' });
    expect(out).not.toContain('Eligible for me');
    expect(out).not.toContain('name="eligible"');
  });
  it('labels each card in words, not colour alone, and explains unknown', () => {
    const out = html(items, ready());
    expect(out).toContain('Eligible for me');
    expect(out).toContain('Not eligible yet');
    expect(out).toContain('Eligibility unknown');
    expect(out).toContain('data-eligibility="ELIGIBLE"');
    expect(out).toContain('data-eligibility="NOT_ELIGIBLE"');
    expect(out).toContain('data-eligibility="UNKNOWN"');
    // Informational only: the server rechecks at the moment of the action.
    expect(out).toContain('rechecked');
  });
  it('offers a keyboard-reachable GET checkbox that keeps its state and survives paging', () => {
    const off = html(items, ready());
    expect(off).toContain('type="checkbox"');
    expect(off).toContain('name="eligible"');
    expect(off).toContain('value="1"');
    expect(off).not.toMatch(/name="eligible"[^>]*checked/);
    expect(html(items, ready({ eligibleOnly: true }))).toMatch(/checked/);
    expect(feedHref({ category: 'a', eligible: true })).toBe('/raids?category=a&eligible=1');
    expect(feedHref({ eligible: false })).toBe('/raids');
  });
  it('says what an empty eligible-only result means and how to widen it', () => {
    const out = html([], ready({ eligibleOnly: true, eligibility: {} }));
    expect(out).toContain('role="status"');
    expect(out).toContain('none match your verified skills');
    expect(out).toContain('href="/raids"');
  });
  it('asks a signed-out visitor to sign in and shows no badges', () => {
    const out = html(items, { status: 'SIGNED_OUT' });
    expect(out).toContain('Sign in to see which Raids fit your verified skills');
    expect(out).toContain('href="/creator/account"');
    expect(out).not.toContain('data-eligibility');
    expect(out).not.toContain('name="eligible"');
  });
  it('says plainly when the check is unavailable and still lists every Raid', () => {
    const out = html(items, { status: 'UNAVAILABLE' });
    expect(out).toContain('could not check your skills');
    expect(out).toContain('Synthetic task 1');
    expect(out).not.toContain('data-eligibility');
  });
});
