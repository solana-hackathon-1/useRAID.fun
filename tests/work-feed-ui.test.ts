import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkDetail, WorkFeed, feedHref } from '../src/components/work-feed';
import { DetailSchema, FeedPageSchema } from '../src/work-loop/feed-contracts';

const id = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const sol = { chain: 'SOLANA', networkIdentity: 'synthetic-work', kind: 'NATIVE_SOL' } as const;
const token = {
  chain: 'SOLANA',
  networkIdentity: 'synthetic-work',
  kind: 'TOKEN',
  mint: 'So11111111111111111111111111111111111111112',
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
} as const;
const card = (n: number, patch: Record<string, unknown> = {}) => ({
  listingId: id(n),
  termsVersionId: id(n + 1),
  guildId: 'synthetic-guild',
  title: `Synthetic task ${n}`,
  publicSummary: 'Write a verified setup guide <b>bold</b>.',
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
    {
      assetKey: JSON.stringify([
        'SOLANA',
        'synthetic-work',
        'TOKEN',
        token.mint,
        token.tokenProgram,
      ]),
      assetId: token,
      decimals: 6,
      amount: '2500000',
    },
  ],
  commitmentDeadline: '2026-11-04T09:30:00.000Z',
  submissionDeadline: '2026-11-08T00:00:00.000Z',
  availableSlots: 1,
  funding: { mode: 'SIMULATED' },
  confidentiality: 'PUBLIC',
  ...patch,
});
const page = (
  items: unknown[] = [card(1), card(3, { admission: 'APPLICATION', difficulty: 'B' })],
  next: string | null = null,
) => FeedPageSchema.parse({ items, nextCursor: next, sort: 'newest', rewardComparable: false });
const html = (p = page(), query = {}) =>
  renderToStaticMarkup(createElement(WorkFeed, { page: p, query }));

describe('R08 public Raid feed markup', () => {
  it('shows safe cards with exact rewards, honest simulated funding and escaped text', () => {
    const out = html();
    expect(out).toContain('Synthetic task 1');
    expect(out).toContain('1.5 SOL');
    expect(out).toContain('2.5 So11…1112');
    expect(out).toContain('Apply by 4 Nov 2026');
    expect(out).toContain('Simulated funding');
    expect(out).toContain('no real funds');
    expect(out).toContain('Application required');
    expect(out).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(out).not.toContain('<b>bold</b>');
  });
  it('offers a plain GET filter form that keeps no-JavaScript use working and explains eligibility honestly', () => {
    const out = html(page(), { category: 'design', sort: 'deadline' });
    expect(out).toContain('method="get"');
    expect(out).toContain('name="category"');
    expect(out).toContain('value="design"');
    expect(out).toContain('name="sort"');
    expect(out).toContain('Eligibility is checked when you apply');
    expect(out).not.toContain('Eligible for me');
  });
  it('explains reward order is only comparable within one asset and lists assets to choose', () => {
    const out = html();
    expect(out).toContain('Reward order needs one asset');
    expect(out).toContain('name="assetKey"');
    expect(out).toContain('SOL');
  });
  it('links to the next page with the cursor and the current filters, and to a cleared feed when empty', () => {
    const out = html(page([card(1)], 'abc_-123'), { category: 'design' });
    expect(out).toContain('cursor=abc_-123');
    expect(out).toContain('category=design');
    const empty = html(page([]), { category: 'design' });
    expect(empty).toContain('No live Raids match');
    expect(empty).toContain('href="/raids"');
    expect(feedHref({ category: 'a b', sort: 'newest', limit: 20 })).toBe('/raids?category=a+b');
  });
  it('links each card to its own brief', () => {
    expect(html()).toContain(`href="/raids/work/${id(1)}"`);
    expect(feedHref({ category: 'a' })).toBe('/raids?category=a');
  });
});
const brief = (patch: Record<string, unknown> = {}) =>
  DetailSchema.parse({
    ...card(1),
    openSlotIds: [id(7)],
    termsDigest: 'a'.repeat(64),
    outcome: 'A guide a newcomer can follow. <i>x</i>',
    deliverables: ['setup.md at a pinned commit'],
    acceptanceCriteria: ['A clean install completes.'],
    exclusions: ['No production changes'],
    dependencies: [],
    allowedToolsPolicy: 'Public tools allowed; disclose AI assistance.',
    startCondition: 'Verified binding and required resources ready.',
    deadlines: {
      commitment: '2026-11-04T09:30:00.000Z',
      preparation: '2026-11-05T09:30:00.000Z',
      submission: '2026-11-08T00:00:00.000Z',
      review: '2026-11-09T00:00:00.000Z',
      operationalClosure: '2026-11-10T00:00:00.000Z',
    },
    review: { evidence: 'Pinned commit plus install output.', maxRevisionRounds: 1 },
    rightsPolicy: 'Contributor keeps prior IP.',
    portfolioPolicy: 'May be shown.',
    withdrawalPolicy: 'May withdraw.',
    terminationPolicy: 'Finite closure.',
    disputePolicy: 'Manual review.',
    finalityPolicy: 'Simulated only.',
    ...patch,
  });
describe('R08 public Raid detail markup', () => {
  const out = (
    apply: 'FORM' | 'SIGN_IN' | 'CLOSED' | 'NOT_APPLICABLE' | 'ACCEPT' = 'NOT_APPLICABLE',
    patch: Record<string, unknown> = {},
    offer?: { offerId: string; slotId: string },
  ) => renderToStaticMarkup(createElement(WorkDetail, { detail: brief(patch), apply, offer }));
  it('shows what a person commits to: outcome, criteria, every deadline, review rules and policies', () => {
    const html = out();
    for (const text of [
      'Synthetic task 1',
      'Outcome',
      'setup.md at a pinned commit',
      'A clean install completes.',
      'No production changes',
      'Pinned commit plus install output.',
      '1 revision round',
      'Contributor keeps prior IP.',
      'Operational closure',
      '10 Nov 2026',
      '1.5 SOL',
      'Simulated funding',
    ])
      expect(html, text).toContain(text);
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;');
    expect(html).not.toContain('<i>x</i>');
  });
  it('is honest that taking this Raid is not available here and never claims eligibility and never claims eligibility', () => {
    const html = out();
    expect(html).toContain('not available in the browser');
    expect(html).toContain('Eligibility is checked');
    expect(html).toContain('href="/raids"');
    expect(html).not.toContain('Eligible for me');
  });
  it('shows the matching apply state: form, sign-in, closed or not applicable', () => {
    expect(out('FORM')).toContain('Apply to this Raid');
    expect(out('FORM')).toContain('name="apply-form"');
    expect(out('SIGN_IN', { admission: 'APPLICATION' })).toContain('Sign in to apply');
    expect(out('SIGN_IN', { admission: 'APPLICATION' })).toContain('href="/creator/account"');
    expect(out('CLOSED', { admission: 'APPLICATION' })).toContain('Applications are not open yet');
    expect(out('NOT_APPLICABLE')).toContain('not available in the browser');
    for (const mode of ['SIGN_IN', 'CLOSED', 'NOT_APPLICABLE', 'ACCEPT'] as const)
      expect(out(mode)).not.toContain('Apply to this Raid');
  });
  it('shows consent and Accept for an instant-start Raid on its first open slot, never an Apply form', () => {
    const html = out('ACCEPT', { admission: 'INSTANT' });
    expect(html).toContain('name="accept-form"');
    expect(html).toContain('Accept this Raid');
    expect(html).not.toContain('Apply to this Raid');
    expect(html).not.toContain('Eligible for me');
  });
  it('shows Accept through the Founder offer for an application Raid when the viewer holds a usable offer', () => {
    const html = out('FORM', {}, { offerId: id(8), slotId: id(9) });
    expect(html).toContain('name="accept-form"');
    expect(html).not.toContain('Apply to this Raid');
  });
  it('asks an instant-start visitor to sign in to take the Raid, not to apply', () => {
    const html = out('SIGN_IN', { admission: 'INSTANT' });
    expect(html).toContain('Sign in to take this Raid');
    expect(html).not.toContain('Sign in to apply');
  });
});
