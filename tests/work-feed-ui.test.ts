import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkDetail, WorkFeed, feedHref } from '../src/components/work-feed';
import type { ApplyMode } from '../src/lib/work-apply-mode';
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
const solKey = JSON.stringify(['SOLANA', 'synthetic-work', 'NATIVE_SOL']);
const tokenKey = JSON.stringify([
  'SOLANA',
  'synthetic-work',
  'TOKEN',
  token.mint,
  token.tokenProgram,
]);
const reward = {
  enabled: true,
  assets: [
    { assetKey: solKey, assetId: sol, decimals: 9 },
    { assetKey: tokenKey, assetId: token, decimals: 6 },
  ],
  amount: '',
  problem: null,
};
const input = (markup: string) => markup.match(/<input[^>]*minRewardAmount[^>]*>/)?.[0] ?? '';
const render = (props: { page?: unknown; query?: Record<string, unknown>; reward?: unknown }) =>
  renderToStaticMarkup(
    createElement(WorkFeed, {
      page: (props.page ?? page()) as never,
      query: (props.query ?? {}) as never,
      reward: (props.reward ?? reward) as never,
    }),
  );

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
  it('shows the minimum-reward control only while its flag is on', () => {
    expect(html()).not.toContain('minRewardAmount');
    expect(html()).not.toContain('name="minReward"');
    expect(render({ reward: { ...reward, enabled: false } })).not.toContain('minRewardAmount');
  });
  it('asks for the minimum in the selected asset display units, with labelled, described, mobile-friendly markup', () => {
    const out = render({ query: { assetKey: solKey }, reward: { ...reward, amount: '1.5' } });
    expect(out).toContain('name="minRewardAmount"');
    expect(out).toContain('value="1.5"');
    expect(out).toContain('Minimum reward in SOL');
    expect(out).toContain('at most 9 decimal places');
    // Decimal keypad on mobile, no autofill, no browser-side rewriting of what was typed.
    expect(input(out)).toMatch(/inputmode="decimal"/i);
    expect(input(out)).toMatch(/autocomplete="off"/i);
    expect(out).toContain('aria-describedby="raid-feed-min-reward-help"');
    expect(out).not.toContain('aria-invalid');
    expect(out).not.toContain('smallest units');
    expect(out).toContain('never compared or converted');
  });
  it('keeps the minimum-reward label short and puts the help and error in descriptions only (#385-2)', () => {
    const labelOf = (out: string) =>
      out.match(/<label[^>]*>(?:(?!<\/label>)[\s\S])*minRewardAmount[\s\S]*?<\/label>/)?.[0] ?? '';
    const asset = render({ query: { assetKey: solKey }, reward: { ...reward, amount: '1.5' } });
    expect(labelOf(asset).replace(/<input[^>]*>/, '')).toBe('<label>Minimum reward in SOL</label>');
    const none = render({});
    expect(labelOf(none).replace(/<input[^>]*>/, '')).toBe('<label>Minimum reward</label>');
    expect(none).toContain('Choose a reward asset first');
    expect(none).toMatch(/<[^>]*id="raid-feed-min-reward-help"[^>]*>Choose a reward asset first/);
    const bad = render({
      query: { assetKey: solKey },
      reward: { ...reward, amount: 'x', problem: 'Enter a number.' },
    });
    expect(labelOf(bad)).not.toContain('Enter a number.');
    expect(bad).toContain('id="raid-feed-min-reward-error"');
  });
  it('lets the minimum-reward help span the filter row instead of stretching its cells (#385-1)', () => {
    const out = render({ query: {} });
    expect(out).toContain('raid-feed-min');
    const css = readFileSync('src/app/globals.css', 'utf8');
    expect(css).toMatch(/\.raid-feed-min\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
    expect(css).toMatch(/\.raid-feed-filters\s*\{[^}]*align-items:\s*start/);
  });
  it('uses the token precision for a token and says when no asset is chosen yet', () => {
    expect(render({ query: { assetKey: tokenKey } })).toContain('at most 6 decimal places');
    const none = render({});
    expect(none).toContain('Minimum reward');
    expect(none).toContain('Choose a reward asset first');
  });
  it('keeps every live asset selectable even when the filter leaves no Raids', () => {
    const out = render({ page: page([]), query: { assetKey: solKey } });
    expect(out).toContain(`<option value="${solKey.replaceAll('"', '&quot;')}" selected`);
    expect(out).toContain('So11…1112');
  });
  it('names a problem in an alert tied to the field, keeps what was typed and lists no Raids', () => {
    const out = render({
      page: page([]),
      query: { assetKey: solKey },
      reward: {
        ...reward,
        amount: '0.00000000001',
        problem: 'SOL allows at most 9 decimal places.',
      },
    });
    expect(out).toContain('value="0.00000000001"');
    expect(out).toMatch(
      /<[^>]*id="raid-feed-min-reward-error"[^>]*role="alert"|<[^>]*role="alert"[^>]*id="raid-feed-min-reward-error"/,
    );
    expect(out).toContain('SOL allows at most 9 decimal places.');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain(
      'aria-describedby="raid-feed-min-reward-help raid-feed-min-reward-error"',
    );
    expect(input(out)).toMatch(/autofocus/i);
    expect(out).toContain('Fix the minimum reward');
    expect(out).not.toContain('No live Raids match');
    expect(out).not.toContain('Synthetic task');
  });
  it('announces an active minimum in a status region and explains an empty result without converting anything', () => {
    const active = { ...reward, amount: '1.5' };
    const some = render({ page: page([card(1)]), query: { assetKey: solKey }, reward: active });
    expect(some).toContain('role="status"');
    expect(some).toContain('at least 1.5 SOL');
    expect(some).toContain('other assets are not converted');
    const none = render({ page: page([]), query: { assetKey: solKey }, reward: active });
    expect(none).toContain('No live Raids pay at least 1.5 SOL');
    expect(none).toContain('href="/raids"');
  });
  it('keeps the typed display amount in the URL and on paging, never a base-unit value', () => {
    const out = render({
      page: page([card(1)], 'abc_-123'),
      query: { assetKey: solKey },
      reward: { ...reward, amount: '1.5' },
    });
    expect(out).toContain('minRewardAmount=1.5');
    expect(out).toContain('cursor=abc_-123');
    expect(out).not.toContain('minReward=');
    expect(feedHref({ assetKey: 'k', minRewardAmount: '1.5' })).toBe(
      '/raids?assetKey=k&minRewardAmount=1.5',
    );
    // A query carrying the converted base units (as the loader passes) never leaks them into a link.
    expect(feedHref({ assetKey: 'k', minReward: '1500000000' } as never)).toBe('/raids?assetKey=k');
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
    apply: ApplyMode = 'NOT_APPLICABLE',
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
    // Signing in from the brief comes back to this brief.
    const back = `/creator/account?returnTo=${encodeURIComponent(`/raids/work/${id(1)}`)}`;
    expect(out('SIGN_IN', { admission: 'APPLICATION' })).toContain(`href="${back}"`);
    expect(out('SIGN_IN', { admission: 'INSTANT' })).toContain(`href="${back}"`);
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
  it('shows the viewer’s existing application instead of the apply form', () => {
    const html = renderToStaticMarkup(
      createElement(WorkDetail, {
        detail: brief({ admission: 'APPLICATION' }),
        apply: 'FORM',
        applied: true,
      }),
    );
    expect(html).toContain('You already applied');
    expect(html).not.toContain('name="apply-form"');
  });
});
