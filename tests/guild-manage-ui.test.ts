import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { GuildProfileEditor, GuildUpdatesManager } from '../src/components/guild-manage';
import type { GuildManageApi } from '../src/guild-profiles/guild-manage-client';

const guildId = '11111111-1111-4111-8111-111111111111';
const api: GuildManageApi = {
  readProfile: vi.fn(async () => {
    throw Error('SSR must not read');
  }),
  editProfile: vi.fn(async () => {
    throw Error('SSR must not submit');
  }),
  draftUpdate: vi.fn(async () => {
    throw Error('SSR must not submit');
  }),
  stepUpdate: vi.fn(async () => {
    throw Error('SSR must not submit');
  }),
};
const guild = {
  version: 'v1' as const,
  id: guildId,
  slug: 'synthetic-guild',
  name: 'Synthetic <b>Guild</b>',
  description: 'Fish & chips',
  founderAccountId: null,
  revision: 3,
  state: 'ACTIVE' as const,
  primaryToken: null,
};
const profile = (writesAvailable = true) =>
  renderToStaticMarkup(createElement(GuildProfileEditor, { guild, writesAvailable, api }));
const update = (id: string, state: 'DRAFT' | 'PUBLISHED', title = 'Update ' + id) => ({
  version: 'v1' as const,
  id: `${id.repeat(8)}-2222-4222-8222-222222222222`,
  guildId,
  title,
  body: 'Body <i>text</i>',
  state,
  authorAccountId: 'author',
  createdAt: '2026-10-30T00:00:00.000Z',
  publishedAt: state === 'PUBLISHED' ? '2026-10-30T01:00:00.000Z' : null,
});
const updates = (props: {
  founder?: boolean;
  writesAvailable?: boolean;
  list?: ReturnType<typeof update>[];
}) =>
  renderToStaticMarkup(
    createElement(GuildUpdatesManager, {
      guildId,
      updates: props.list ?? [],
      founder: props.founder ?? true,
      writesAvailable: props.writesAvailable ?? true,
      api,
    }),
  );

describe('Guild profile editor', () => {
  it('renders labelled fields with the saved revision, escaped, and never submits during render', () => {
    const html = profile();
    expect(html).toContain('Guild name');
    expect(html).toContain('Description');
    expect(html).toContain('Save profile');
    expect(html).toContain('Saved revision 3');
    expect(html).toContain('Synthetic &lt;b&gt;Guild&lt;/b&gt;');
    expect(html).not.toContain('<b>Guild');
    expect(html).toContain('/guilds/synthetic-guild');
    expect(html).not.toContain('founder');
    expect(api.editProfile).not.toHaveBeenCalled();
  });
  it('is honest and disabled while profile edits are off, still showing saved details', () => {
    const html = profile(false);
    expect(html).toContain('Editing the profile is currently unavailable');
    expect(html).toContain('Synthetic &lt;b&gt;Guild&lt;/b&gt;');
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save profile/);
  });
});

describe('Guild updates manager', () => {
  it('shows an honest empty state and the new-draft form', () => {
    const html = updates({});
    expect(html).toContain('No updates yet.');
    expect(html).toContain('Title');
    expect(html).toContain('Update text');
    expect(html).toContain('Save draft');
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
  });
  it('lets the Founder publish a draft and withdraw either state, with accessible per-update names', () => {
    const html = updates({ list: [update('a', 'DRAFT'), update('b', 'PUBLISHED')] });
    expect(html).toContain('Body &lt;i&gt;text&lt;/i&gt;');
    expect(html).not.toContain('<i>text');
    expect(html).toContain('aria-label="Publish update: Update a"');
    expect(html).not.toContain('aria-label="Publish update: Update b"');
    expect(html).toContain('aria-label="Withdraw update: Update a"');
    expect(html).toContain('aria-label="Withdraw update: Update b"');
    expect(html).toContain('Draft');
    expect(html).toContain('Published');
  });
  it('never offers delegates a publish action and says why; they may withdraw only their drafts', () => {
    const html = updates({
      founder: false,
      list: [update('a', 'DRAFT'), update('b', 'PUBLISHED')],
    });
    expect(html).toContain('Only the Founder can publish');
    expect(html).not.toContain('Publish update:');
    expect(html).toContain('aria-label="Withdraw update: Update a"');
    expect(html).not.toContain('aria-label="Withdraw update: Update b"');
  });
  it('keeps withdrawal available while new drafts and publishing are off, and says so', () => {
    const html = updates({
      writesAvailable: false,
      list: [update('a', 'DRAFT'), update('b', 'PUBLISHED')],
    });
    expect(html).toContain('New drafts and publishing are currently unavailable');
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    expect(html).toMatch(
      /<button[^>]*disabled[^>]*aria-label="Publish update: Update a"|<button[^>]*aria-label="Publish update: Update a"[^>]*disabled/,
    );
    expect(html).not.toMatch(/<button[^>]*aria-label="Withdraw update: Update b"[^>]*disabled/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*aria-label="Withdraw update: Update b"/);
  });
});
