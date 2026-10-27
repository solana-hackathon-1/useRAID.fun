import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkFeed, feedHref } from '../src/components/work-feed';
import { FeedPageSchema } from '../src/work-loop/feed-contracts';

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
});
